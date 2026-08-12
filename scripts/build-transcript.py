"""Every word of the build conversation, both sides, minus what must not travel.

THE THIRD AND LAST OF THESE, and they are deliberately different shapes:

  build-prompt-book.py  — a selection, generalised, for handing to a stranger.
  build-handbook.py     — every instruction plus the rules and the lessons,
                          for rebuilding from.
  this one              — literally everything said, both sides, in order.

The redaction list is IMPORTED from build-handbook rather than copied. Two
scripts with their own copies of "what counts as sensitive" is the same drift
that put a different definition of "already pushed" in two places in the app
and cost a week; a rule added in one place and missed in the other is a leak.

What is left out: tool calls, tool output, screenshots and file attachments.
Not for brevity — tool output is where credentials and customer records
actually live, and none of it is conversation.
"""

import importlib.util
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = "/root/.claude/projects/-home-user-V2/97a4479c-ffae-5c12-a4a1-944852715c09.jsonl"
OUT = Path(sys.argv[1])

# One definition of sensitive, shared. See the module docstring.
spec = importlib.util.spec_from_file_location("handbook", HERE / "build-handbook.py")
handbook = importlib.util.module_from_spec(spec)
sys.argv = [sys.argv[0], "/dev/null"]  # the handbook reads argv at import
spec.loader.exec_module(handbook)

# ---------------------------------------------------------------------------
# what else comes out of a full transcript that a prompt list never contained
# ---------------------------------------------------------------------------
#
# The handbook only ever carried the user's own words, and those hold very few
# addresses or numbers. A full transcript carries every query result quoted
# back, every inbox named while debugging, every business discussed — so it
# needs the contact-detail rules the prompt book had and the handbook did not.

EXTRA = [
    # Real addresses: the sending inboxes, the leads' contacts, the operator's.
    # The SHAPE is kept because whether an address was a role address or a
    # named person is the subject of several of these conversations.
    (
        re.compile(
            r"\b(info|office|contact|admin|hello|sales|support|service|enquiries|inquiries|team|mail|book|bookings|dispatch|scheduling)"
            r"@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
            re.I,
        ),
        "[ROLE ADDRESS REMOVED]",
    ),
    (
        re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
        "[EMAIL REMOVED]",
    ),
    # Leads' telephone numbers.
    (
        re.compile(r"(?<![\w-])(?:\+1[ -]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w-])"),
        "[PHONE REMOVED]",
    ),
    # A home directory carries its owner's name.
    (re.compile(r"(/(?:Users|home)/)(?!(?:user|root|runner|ubuntu|node|app|admin|claude)\b)[A-Za-z0-9._-]+"), r"\1[NAME REMOVED]"),
]

# Addresses that are examples rather than anybody's inbox, protected from the
# rule above by being restored afterwards would be fragile — so they are
# matched first and passed through untouched.
SAFE = re.compile(
    r"\b[A-Za-z0-9._%+-]+@(example\.(com|org|net)|test\.com|x\.com|ours\.com|foo\.com|"
    r"bar\.com|acme\.com|company\.com|domain\.com|localhost|anthropic\.com)\b",
    re.I,
)


def scrub(text: str) -> str:
    # Park the example addresses so the broad email rule cannot eat them.
    parked: list[str] = []

    def park(m: "re.Match[str]") -> str:
        parked.append(m.group(0))
        return f"\x00{len(parked) - 1}\x00"

    text = SAFE.sub(park, text)
    text = handbook.scrub(text)
    for pattern, replacement in EXTRA:
        text = pattern.sub(replacement, text)
    for i, original in enumerate(parked):
        text = text.replace(f"\x00{i}\x00", original)
    return text.strip()


HEADING = re.compile(r"^(#{1,6})(\s+\S)")
FENCE = re.compile(r"^(`{3,}|~{3,})(.*)$")


def nest_headings(body: str, floor: int = 3) -> str:
    """Push any heading in a message BELOW the turn heading it sits under.

    Several prompts were whole documents with their own `#` and `##` structure,
    and pasted straight in they sit at the same level as the turn headings — so
    a table of contents for a 133,000-word transcript comes out as a shuffled
    mix of "17. Operator" and "Phase 1: MVP" with no way to tell which is which.

    Only the number of # characters changes. Not one word moves, which is the
    whole point of this file. Fenced blocks are left completely alone: a # at
    the start of a line inside a code block is a comment, not a heading.

    `floor` is the shallowest a body heading may sit. It is a parameter because
    the topical file puts speakers at level 3 rather than 2, and a body heading
    landing on the same level as a speaker heading is the same collision this
    function exists to prevent.
    """
    out = []
    fence: str | None = None  # the OPENING marker, when inside a block
    for line in body.split("\n"):
        m = FENCE.match(line.rstrip())
        if m:
            marker, info = m.group(1), m.group(2).strip()
            if fence is None:
                # An opening fence may carry a language tag: ```ts
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence) and not info:
                # A closing fence is the same character, at least as long, and
                # carries no info string. Comparing the whole line instead —
                # which is what this did first — never matches ```ts against
                # its bare ``` and leaves the block open for the rest of the
                # turn, so every heading after it silently escapes.
                fence = None
            out.append(line)
            continue
        if fence is None:
            m = HEADING.match(line)
            if m:
                level = min(6, max(floor, len(m.group(1)) + floor - 1))
                out.append("#" * level + m.group(2) + line[m.end():])
                continue
        out.append(line)
    return "\n".join(out)


def blocks_of(entry: dict) -> list:
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return content if isinstance(content, list) else []


def main() -> None:
    turns: list[list] = []
    for line in open(SRC, encoding="utf-8", errors="replace"):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        role = entry.get("type")
        if role not in ("user", "assistant"):
            continue
        # A "user" record carrying only tool results is the harness answering a
        # tool call, not the person typing.
        for block in blocks_of(entry):
            if not isinstance(block, dict) or block.get("type") != "text":
                continue
            text = re.sub(
                r"<system-reminder>.*?</system-reminder>", "", block.get("text") or "", flags=re.S
            )
            text = re.sub(r"<local-command-[a-z-]+>.*?</local-command-[a-z-]+>", "", text, flags=re.S)
            text = scrub(text)
            if not text:
                continue
            if turns and turns[-1][0] == role:
                turns[-1][1].append(text)
            else:
                turns.append([role, [text]])

    words = 0
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("# Dispatch Board — the complete conversation\n\n")
        f.write(
            "Every word said while building this, both sides, in order. What was asked "
            "and what was answered, including the wrong turns, the corrections and the "
            "arguments about what was actually true.\n\n"
            "Not here: tool calls, tool output, screenshots and file attachments. Not "
            "for brevity — tool output is where credentials and customer records "
            "actually live, and none of it is conversation.\n\n"
            "Removed on the way through: API keys and tokens; environment variable "
            "values, though the variable NAMES are kept because which one is missing "
            "is half of every configuration conversation here; the database host; "
            "telephone numbers; personal account names; and email addresses belonging "
            "to somebody — the sending inboxes, the leads' contacts, the operator's "
            "own. Where an address was a role address rather than a named person that "
            "distinction survives, because it is the subject of several of these "
            "conversations. Notes about the live app's current auth state are removed "
            "too.\n\n"
            "---\n\n"
        )
        for i, (role, parts) in enumerate(turns, 1):
            speaker = "Operator" if role == "user" else "Claude"
            body = nest_headings("\n\n".join(parts))
            words += len(body.split())
            f.write(f"## {i}. {speaker}\n\n{body}\n\n")

    print(f"{len(turns)} turns, {words:,} words -> {OUT}")


if __name__ == "__main__":
    main()
