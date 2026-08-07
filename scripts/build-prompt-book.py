"""Build the shareable prompt book: the asks and the ideas, nothing else.

The full transcript was the wrong shape for this. What is worth passing to
somebody else is what was ASKED FOR — the long build specs, and the short
course-corrections that actually changed the thing being built. Everything
else in that conversation was this particular app: its URLs, its database, its
API keys, its bugs, whose inbox was whose. None of that travels.

Selection is by hand, by index into the extracted prompt list, because "is this
a reusable idea or is this Tuesday's bug" is a judgement no regex makes.
"""

import json
import re
import sys

SRC = "/root/.claude/projects/-home-user-V2/97a4479c-ffae-5c12-a4a1-944852715c09.jsonl"
UPLOADS = "/root/.claude/uploads/97a4479c-ffae-5c12-a4a1-944852715c09"
OUT = sys.argv[1]

# ---------------------------------------------------------------------------
# what still comes out, even from a prompt
# ---------------------------------------------------------------------------
#
# A build spec is generic enough to hand to anybody, right up until the line
# where it names the deployment or the person. Those lines get generalised
# rather than deleted, so the prompt still reads as a prompt.

SCRUB = [
    (re.compile(r"https?://[A-Za-z0-9.-]+\.vercel\.app[A-Za-z0-9._/-]*"), "[the app URL]"),
    (re.compile(r"\b[A-Za-z0-9-]+\.vercel\.app\b"), "[the app URL]"),
    (re.compile(r"\b[a-z0-9-]{15,}\.supabase\.co\b"), "[the database host]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"), "[key removed]"),
    (re.compile(r"\bAIza[A-Za-z0-9_-]{20,}\b"), "[key removed]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"), "[key removed]"),
    # Real addresses, real numbers, real people.
    (re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"), "[an address]"),
    (re.compile(r"(?<![\w-])(?:\+1[ -]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w-])"), "[a number]"),
    (re.compile(r"(?i)\bthe one jack has\b"), "the one a caller has"),
    (re.compile(r"(?i)\bI \(Peyton\)\b"), "I"),
    (re.compile(r"(?i)\b(jack|keith|philip|peyton|airynhamilton)\b"), "[name]"),
]


def scrub(text: str) -> str:
    for pattern, replacement in SCRUB:
        text = pattern.sub(replacement, text)
    return text.strip()


# ---------------------------------------------------------------------------
# the selection
# ---------------------------------------------------------------------------

BIG = [
    (2, "A lead enrichment and decision-maker discovery system",
     "The first big one. Note how much of it is constraints on what NOT to do — "
     "which providers are off limits, what must never be fabricated, what has to "
     "keep working. That is the part that made it usable."),
    (8, "Sourcing: build the pipeline, do not import the old data",
     "Written after an empty database looked like a bug. Says plainly what the "
     "empty state means and what to build instead of guessing."),
    (9, "Run the heavy work as server-side jobs",
     "A short structural correction that changed the whole architecture: move "
     "lead generation and enrichment off the request path."),
    (33, "The caller dialer, for an AI receptionist campaign",
     "Most of this is context about who is being called and why — the part that "
     "decides whether the output is any good."),
    (35, "Organizational memory and adaptive analytics — plan first",
     "\"Do not begin coding immediately.\" The instruction that produced a design "
     "instead of a pile of code."),
    (40, "The complete memory, analytics, experimentation and optimization system",
     "The longest one. Built on top of the plan the previous prompt produced."),
    (71, "A call intelligence add-on: record, transcribe, assist, learn",
     "Recording, consent and transcription, with the legal constraints stated as "
     "requirements rather than left to the model."),
    (75, "The cheap version of call recording",
     "Rejecting the expensive architecture and naming the MVP: a laptop "
     "microphone and a phone on speaker."),
    (77, "Redesign the dialer to be less bloated",
     "A whole feature removed rather than added. The reasoning is about the "
     "caller's attention during a live call."),
    (92, "Owner-enriched leads with direct telephone numbers",
     "Opens with the two things not to do, before saying what to do."),
    (95, "Packet, trial and script testing",
     "Deliberately the lean version. The scope limit is in the title."),
    (103, "A team updates panel",
     "Small, sharply specified, one job."),
]

# The short ones. Grouped by what they are about rather than when they happened,
# because that is how somebody would go looking for them.
SHORT = [
    ("Lead quality and sourcing", [
        13, 16, 17, 28, 120, 144,
    ]),
    ("The dialer and the callers", [
        64, 34, 88, 59, 145,
    ]),
    ("Packets", [
        15, 66, 134,
    ]),
    ("Consent and recording", [
        106, 117, 118, 150,
    ]),
    ("Email automation", [
        121, 125, 126, 142, 153, 154,
    ]),
    ("Learning, testing and analytics", [
        39, 60, 65, 79, 131, 132, 133,
    ]),
    ("How to work with the thing building it", [
        45, 55, 67, 104, 112, 116, 141, 147,
    ]),
]

UPLOADED = [
    ("5dd39a8d-VA_Accountability_Master_Prompt.md",
     "VA accountability, performance and decision system",
     "Written as a standalone document and handed over whole. The opening line "
     "is the one that matters: the outcome is not better reports, it is "
     "decision-grade visibility."),
    ("82f66729-AI_System_Manager_Implementation_Directive.md",
     "AI system manager — implementation directive",
     "The follow-up, and a sharper instrument: build it, do not describe it. "
     "Contains the single most useful sentence in this whole file — \"Do not "
     "report built when logic exists but is not wired into the real workflow.\""),
]


def fenced(body: str) -> str:
    """Wrap a prompt in a fence longer than any fence inside it.

    Several of these prompts contain their own ``` blocks — schema sketches,
    example output. A three-backtick wrapper around them closes early and the
    second half of the prompt renders as prose with the formatting mangled,
    which is the sort of thing nobody notices until somebody tries to copy it.
    """
    longest = 0
    run = 0
    for ch in body:
        run = run + 1 if ch == "`" else 0
        longest = max(longest, run)
    fence = "`" * max(3, longest + 1)
    return f"{fence}\n{body}\n{fence}\n"


def load_prompts() -> list:
    out = []
    for line in open(SRC, encoding="utf-8", errors="replace"):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("type") != "user":
            continue
        message = entry.get("message") or {}
        content = message.get("content")
        blocks = (
            [{"type": "text", "text": content}]
            if isinstance(content, str)
            else content if isinstance(content, list) else []
        )
        for block in blocks:
            if not isinstance(block, dict) or block.get("type") != "text":
                continue
            text = re.sub(
                r"<system-reminder>.*?</system-reminder>", "", block.get("text") or "", flags=re.S
            ).strip()
            if text and (not out or out[-1] != text):
                out.append(text)
    return out


def main() -> None:
    prompts = load_prompts()
    get = lambda n: scrub(prompts[n - 1])

    parts = []
    w = parts.append

    w("# Prompts and ideas from building a cold-calling system\n")
    w(
        "These are the instructions I actually gave, building a lead-sourcing, "
        "cold-calling and cold-email system with an AI agent over about two weeks. "
        "The long ones are build specs. The short ones are the corrections — which "
        "is where most of the real work happened, because the first answer is "
        "rarely the one you want.\n"
    )
    w(
        "Everything specific to my setup is out: no URLs, no keys, no database, no "
        "names, no debugging. What is left should transfer to anything similar.\n"
    )
    w(
        "**The one pattern worth stealing before you read any of it:** the prompts "
        "that worked open by saying what NOT to do. Which tools are off limits, "
        "what must never be invented, what already works and has to keep working. "
        "An agent with no constraints will happily rebuild something you were "
        "happy with, or invent an integration that does not exist.\n"
    )
    w("---\n")

    w("## The build prompts\n")
    for n, title, note in BIG:
        body = get(n)
        w(f"### {title}\n")
        w(f"*{note}*\n")
        w(fenced(body))

    w("---\n")
    w("## Two standalone prompt documents\n")
    w(
        "These were written as files and handed over whole rather than typed into "
        "a chat. For anything big, this works considerably better — you can edit "
        "it before sending, and the agent gets the whole shape at once.\n"
    )
    for filename, title, note in UPLOADED:
        try:
            body = scrub(open(f"{UPLOADS}/{filename}", encoding="utf-8").read())
        except OSError:
            continue
        w(f"### {title}\n")
        w(f"*{note}*\n")
        w(fenced(body))

    w("---\n")
    w("## The short ones\n")
    w(
        "Verbatim, typos and all. These are worth more than they look: almost "
        "every one of them is a case where what got built was technically what I "
        "asked for and still not what I wanted.\n"
    )
    for heading, indices in SHORT:
        w(f"### {heading}\n")
        for n in indices:
            body = get(n)
            quoted = "\n".join(f"> {line}" if line.strip() else ">" for line in body.splitlines())
            w(quoted + "\n")

    text = "\n".join(parts)
    open(OUT, "w", encoding="utf-8").write(text)
    print(f"{len(text.split()):,} words -> {OUT}")


if __name__ == "__main__":
    main()
