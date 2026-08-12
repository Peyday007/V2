"""Build the complete build record: every prompt, every rule, every lesson.

DIFFERENT FROM scripts/build-prompt-book.py, on purpose. That one is curated
for handing to somebody else — everything specific to this deployment stripped
out, a selected subset of prompts, no operational detail. This one is the
opposite: it is for the person who built this, starting another platform, and
it needs to be complete enough to rebuild from.

So it carries every prompt in order rather than a selection, the standing
rules that shaped every decision, the migration ledger as a build history, and
the bugs — because on a second build the bugs are worth more than the
successes. They are the things that were not obvious the first time.

Still strips credentials. A key is wrong to write down whoever the reader is.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path("/home/user/V2")
SRC = "/root/.claude/projects/-home-user-V2/97a4479c-ffae-5c12-a4a1-944852715c09.jsonl"
UPLOADS = Path("/root/.claude/uploads/97a4479c-ffae-5c12-a4a1-944852715c09")
OUT = Path(sys.argv[1])

# ---------------------------------------------------------------------------
# what never goes in, whoever is reading
# ---------------------------------------------------------------------------
#
# Narrower than the prompt book's list. That one generalised URLs and project
# names because it was going to a stranger; this is the owner's own record, so
# the only things removed are the ones that are wrong to write down anywhere —
# live credentials, and a third party's name.

SCRUB = [
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"), "[KEY REMOVED]"),
    (re.compile(r"\bAIza[A-Za-z0-9_-]{20,}\b"), "[KEY REMOVED]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"), "[KEY REMOVED]"),
    (re.compile(r"\bsbp_[A-Za-z0-9]{16,}\b"), "[KEY REMOVED]"),
    (re.compile(r"\bghp_[A-Za-z0-9]{20,}\b"), "[KEY REMOVED]"),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._-]{20,}"), "Bearer [KEY REMOVED]"),
    (
        re.compile(
            r"\b([A-Z][A-Z0-9_]{3,}(?:KEY|SECRET|TOKEN|PASSWORD|PIN))\s*[=:]\s*['\"]?([A-Za-z0-9_\-./+]{12,})['\"]?"
        ),
        r"\1=[REMOVED]",
    ),
    (re.compile(r"\bhttps?://[a-z0-9-]{15,}\.supabase\.co\b"), "[SUPABASE URL REMOVED]"),
    # A third party's account name, which turned up in an early context dump.
    (re.compile(r"(?i)\bairynhamilton(-byte)?\b"), "[NAME REMOVED]"),
    # The live app's own security posture.
    #
    # Describing the auth DESIGN is useful on a second build — PIN auth for
    # callers, a password for the console, and why. Publishing which door is
    # currently unlocked is not, and it survives into a public repo.
    #
    # DOTALL and no dependence on a sentence ending: the first version of this
    # required a full stop on the same line, and the one occurrence that
    # mattered wrapped across three lines and sailed through. Matching a clause
    # rather than a sentence is what makes it reliable.
    (
        re.compile(
            r"(?is)[^.\n]{0,120}\b(?:no auth on admin(?:\s+routes)?"
            r"|admin console is (?:currently )?open"
            r"|anyone with the URL (?:can|has)"
            r"|intentionally left fully open)\b.{0,200}?(?:\)|\.)",
        ),
        "[A note about the live app's current auth state has been removed here.]",
    ),
]


def scrub(text: str) -> str:
    for pattern, replacement in SCRUB:
        text = pattern.sub(replacement, text)
    return text


def fenced(body: str) -> str:
    """A fence longer than any fence inside the body, so nothing closes early."""
    longest = run = 0
    for ch in body:
        run = run + 1 if ch == "`" else 0
        longest = max(longest, run)
    fence = "`" * max(3, longest + 1)
    return f"{fence}\n{body}\n{fence}\n"


# ---------------------------------------------------------------------------
# reading the record
# ---------------------------------------------------------------------------


def load_prompts() -> list:
    out = []
    for line in open(SRC, encoding="utf-8", errors="replace"):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("type") != "user":
            continue
        content = (entry.get("message") or {}).get("content")
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


NOISE = re.compile(
    r"^(\[Request interrupted|Continue from where you left off\.?$|This session'?s worker process was restarted"
    r"|This session is being continued from a previous conversation|\[Image:|@\"/root/)",
    re.I,
)


def is_noise(text: str) -> bool:
    """Harness chatter and context dumps, which are not instructions."""
    return bool(NOISE.match(text.strip()))


def migrations() -> list:
    out = []
    for path in sorted((REPO / "supabase/migrations").glob("*.sql")):
        head = path.read_text(encoding="utf-8", errors="replace").splitlines()[:8]
        desc = ""
        for line in head:
            m = re.match(r"^--\s*(?:\d{4}\s*—\s*)?(.{12,})$", line.strip())
            if m and not set(m.group(1)) <= {"-"}:
                desc = m.group(1).strip()
                break
        out.append((path.stem, desc))
    return out


def git_log() -> list:
    try:
        raw = subprocess.run(
            ["git", "-C", str(REPO), "log", "--reverse", "--format=%s"],
            capture_output=True, text=True, timeout=60,
        ).stdout
        return [l for l in raw.splitlines() if l.strip()]
    except Exception:
        return []


# ---------------------------------------------------------------------------
# the standing rules, quoted from where they were actually said
# ---------------------------------------------------------------------------

RULES = [
    ("Never fabricate", [
        "Do not fabricate provider integrations or claim that direct numbers are verified when they are not.",
        "Never fabricate a connector, event, transcript, metric, legal conclusion, or employee claim. When data is missing, say Unknown and explain how to obtain it.",
        "Do not use placeholder data in the completed workflow.",
        "Use only data sources and providers that the application is permitted to access. Preserve source attribution and retrieval dates.",
    ]),
    ("Nothing autonomous without an explicit switch", [
        "Do not send messages automatically unless that capability is explicitly enabled by an administrator.",
        "Prices, discounts, legal language, consent behavior, autonomous communications, and firing recommendations must never be changed automatically.",
        "It must not permanently rewrite its production instructions after individual calls.",
    ]),
    ("Never overwrite a person", [
        "Do not overwrite human-entered information silently.",
        "Never expose recordings across teams or organizations.",
    ]),
    ("Fail honestly", [
        "On failure, leave status as not_sent. Don't silently mark it sent.",
        "Do not report 'built' when logic exists but is not wired into the real workflow.",
    ]),
    ("Preserve what works", [
        "Preserve existing platform behavior and avoid unrelated redesigns.",
        "Do not add Apify and do not replace the existing Google business collection process.",
        "Do not automatically call a discovered number merely because enrichment found it. The existing calling system must continue applying its compliance and suppression rules before assignment or dialing.",
    ]),
]

# ---------------------------------------------------------------------------
# the bugs, which are the most valuable part on a second build
# ---------------------------------------------------------------------------

LESSONS = [
    (
        "Written but never wired",
        "The single most common failure, by a wide margin. Logic written correctly, "
        "tested in isolation, and never called by anything real.",
        [
            "An after-call gate whose decision engine was pure, tested and enforced only in the browser — so refreshing the page walked past it.",
            "A push-ordering function that was written, exported and never called, so the campaign filled with info@ while named owners sat unpushed.",
            "A retry rule for failed pushes that existed in one of the two places that decide what 'already pushed' means.",
            "Migration 0037 added three columns so the top-up's decision would be readable. The worker wrote them for weeks. Nothing selected them and no page rendered them.",
            "The name columns were missing from the eligibility SELECT, so any count of 'how many can we greet by name' would have read zero however many names were on record.",
        ],
        "Write a test that reads the PRODUCTION file and asserts it calls the thing. "
        "Then reintroduce the bug and confirm the test fails — twice this caught a "
        "guard that asserted a constant existed rather than that it was used, which "
        "is the same class of bug one level up.",
    ),
    (
        "A 200 is not proof",
        "An accepted request and a correct one are different facts.",
        [
            "Four emails published to the campaign with every subject present and every body blank. The PATCH returned 200, so the app reported 'Published' and nothing anywhere disagreed.",
            "Fixing that by switching format stored the words but collapsed every line break, because the editor renders HTML and plain \\n is whitespace. The read-back passed it: the body was not empty, it was fused.",
        ],
        "After any write to a system you do not own, read it back and check the "
        "SHAPE, not just presence. 'Is it empty' was too weak a check and shipped "
        "the second bug.",
    ),
    (
        "The constraint is never where you are looking",
        "Every screen reported on itself accurately and the answer was on none of them.",
        [
            "'Why is only 4 emails being sent per inbox' — the per-account limits were 90. The campaign had its own daily limit of 60, spread across every inbox.",
            "'Why are more leads not being fed in' — the top-up was correct every minute. A sourcing campaign runs to its target and then completes forever, and nothing ever started another one.",
            "Our own capacity number summed the inbox limits and ignored the campaign cap entirely, so every figure derived from it was wrong by the same factor.",
        ],
        "Build one view that walks the whole chain in order and names only the "
        "FIRST break. Fixing stage four while stage one is dry is how a fortnight "
        "goes by.",
    ),
    (
        "Silence is a decision that nobody can act on",
        "Correct behaviour that reports nothing is indistinguishable from a broken system.",
        [
            "The refill ran every minute, correctly declined to push, and logged to a server console nobody reads. The campaign stayed empty for days with every switch correctly on.",
            "'Switched off' returned above the line that wrote the note — so the one state an owner is most likely to be wrong about produced exactly the silence the note existed to remove.",
        ],
        "Write the reason down on EVERY exit path, including the quiet ones, and "
        "especially 'it is switched off'. Put it where somebody looks, not in a log.",
    ),
    (
        "The schema and the code drift, and it is always silent",
        "A TypeScript enum and a SQL check constraint have no relationship the compiler can see.",
        [
            "Callers lost entire call outcomes because the code assigned script versions A-G and the constraint allowed A/B/C. The whole INSERT was rejected.",
            "A radio button read as 'glitched' was a check-constraint violation from an unrun migration, surfaced as a raw Postgres message.",
        ],
        "Test that every value the code can produce is accepted by the column. "
        "Select columns in TIERS so an unrun migration degrades the page instead of "
        "failing the whole query.",
    ),
    (
        "Guessing costs more than checking",
        "Twice in this build a hypothesis was presented as a diagnosis and sent somebody chasing the wrong thing.",
        [
            "A claimed 'migration backlog' that turned out to be already run — unconfirmed had quietly become 'not run'.",
            "A claimed ~91 failed pushes when the query returned zero errors. Nothing had failed.",
        ],
        "Say 'I do not know yet, here is the query that settles it'. Then run it.",
    ),
]


def main() -> None:
    prompts = [scrub(p) for p in load_prompts()]
    real = [(i + 1, p) for i, p in enumerate(prompts) if not is_noise(p)]
    parts = []
    w = parts.append

    # ---------------------------------------------------------------- header
    w("# Dispatch Board — the complete build record\n")
    w(
        "Everything used to build this platform: every instruction given, the rules "
        "that shaped every decision, the schema as it grew, and — most usefully for a "
        "second build — the bugs and what they cost.\n"
    )
    w(
        "Written for starting the next one. It assumes the reader is the person who "
        "built this, so nothing is generalised away: the specifics are the point. "
        "Live credentials are the only thing removed.\n"
    )

    counts = {
        "instructions given": len(real),
        "words of instruction": sum(len(p.split()) for _, p in real),
        "database migrations": len(migrations()),
        "library modules": len(list((REPO / "src/lib").glob("*.ts"))),
        "API routes": len(list((REPO / "src/app/api").rglob("route.ts"))),
        "admin pages": len([p for p in (REPO / "src/app/(admin)/admin").iterdir() if p.is_dir()]),
        "test files": len(list((REPO / "tests").glob("*.ts"))),
    }
    w("## What it came to\n")
    for k, v in counts.items():
        w(f"- **{v:,}** {k}")
    w("")

    # ----------------------------------------------------------------- rules
    w("---\n")
    w("## 1. The standing rules\n")
    w(
        "These were said once and then applied to everything afterwards. On a new "
        "build, paste this section into the first prompt — it is the part that stops "
        "an agent inventing an integration, sending something nobody approved, or "
        "reporting a feature as finished because the code exists.\n"
    )
    for heading, rules in RULES:
        w(f"### {heading}\n")
        for r in rules:
            w(f"> {r}\n")

    # --------------------------------------------------------------- lessons
    w("---\n")
    w("## 2. What went wrong, and what it taught\n")
    w(
        "The most valuable section here. Every one of these was expensive to find and "
        "cheap to prevent, and none of them were obvious in advance.\n"
    )
    for title, summary, examples, fix in LESSONS:
        w(f"### {title}\n")
        w(f"{summary}\n")
        for e in examples:
            w(f"- {e}")
        w("")
        w(f"**What to do instead:** {fix}\n")

    # ---------------------------------------------------------------- schema
    w("---\n")
    w("## 3. The schema, in the order it grew\n")
    w(
        "Each migration is a decision with a date on it. Read top to bottom and it is "
        "the shape of the problem being understood in real time.\n"
    )
    for name, desc in migrations():
        w(f"- `{name}` — {desc}" if desc else f"- `{name}`")
    w("")

    # ------------------------------------------------------------ the engine
    w("---\n")
    w("## 4. How the machine actually runs\n")
    w(
        "One worker endpoint, called every minute by pg_cron. It claims jobs from a "
        "Postgres table with `FOR UPDATE SKIP LOCKED`, so two workers never take the "
        "same job, and every job carries an idempotency key so a retry is a no-op.\n"
    )
    w("The chain, in order — and every stage can stop independently:\n")
    w(
        "```\n"
        "sourcing (Google Places)\n"
        "  -> normalise -> qualify\n"
        "     -> enrich_lead            finds the decision-maker's NAME\n"
        "        -> enrich_owner_contact finds the EMAIL, diagnoses the site\n"
        "           -> refill_email_campaign  pushes to the email tool\n"
        "              -> the email tool sends\n"
        "\n"
        "and running alongside, hourly or daily:\n"
        "  keep_funnel_full      sources more when the pool runs low\n"
        "  auto_reenrich         catches up leads enriched by older code\n"
        "  sync_sending_accounts reads inbox limits, ramps them safely\n"
        "  recompute_house_knowledge  rebuilds what the priors say\n"
        "```\n"
    )
    w(
        "**The lesson that cost the most:** every stage reported on itself honestly "
        "and it was still impossible to tell where it had stopped. Build the "
        "whole-chain view on day one.\n"
    )

    # -------------------------------------------------------- the build order
    log = git_log()
    if log:
        w("---\n")
        w("## 5. The build, commit by commit\n")
        w(f"{len(log)} commits, oldest first. The titles were written to say WHY.\n")
        for line in log:
            w(f"- {scrub(line)}")
        w("")

    # -------------------------------------------------- the standalone specs
    w("---\n")
    w("## 6. The standalone specification documents\n")
    w(
        "Written as files and handed over whole rather than typed into a chat. For "
        "anything large this works considerably better — it can be edited before "
        "sending, and the agent gets the whole shape at once.\n"
    )
    for filename, title in [
        ("5dd39a8d-VA_Accountability_Master_Prompt.md", "VA accountability, performance and decision system"),
        ("82f66729-AI_System_Manager_Implementation_Directive.md", "AI system manager — implementation directive"),
    ]:
        path = UPLOADS / filename
        if not path.exists():
            continue
        w(f"### {title}\n")
        w(fenced(scrub(path.read_text(encoding="utf-8", errors="replace")).strip()))

    # --------------------------------------------------------- every prompt
    w("---\n")
    w("## 7. Every instruction, in order\n")
    w(
        f"All {len(real)} of them, verbatim, typos included. Harness noise, interrupt "
        "markers and context re-dumps are the only things left out.\n"
    )
    w(
        "The short ones matter as much as the long ones. Most of this build was "
        "course-correction, and almost every correction is a case where what got "
        "built was technically what was asked for and still not what was wanted.\n"
    )
    for n, body in real:
        words = len(body.split())
        first = " ".join(body.split())[:70]
        w(f"### {n}. {first}{'…' if len(first) >= 70 else ''}\n")
        w(f"*{words} words*\n")
        w(fenced(body))

    text = "\n".join(parts)
    OUT.write_text(text, encoding="utf-8")
    print(f"{len(text.split()):,} words, {len(text):,} chars -> {OUT}")


if __name__ == "__main__":
    main()
