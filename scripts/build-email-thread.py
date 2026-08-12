"""Everything said about the cold-email side, and nothing else.

THE UNIT IS AN EXCHANGE, NOT A TURN, and that is the whole design.

Half the email conversation does not contain the word "email". "okay so why
cant you just make it so it auto refills?" is squarely about the email
programme and mentions nothing; "still not working, i redeployed" could be
about anything on its own. Scoring turns individually splits questions from
their answers and drops every short follow-up, which is most of the useful
back-and-forth.

So a user turn plus the replies that follow it are scored together, and a
short follow-up immediately after an included exchange is carried in with it —
that is what a follow-up IS.

Redaction is imported from build-transcript, which imports it from
build-handbook. One definition of sensitive, three files.
"""

import importlib.util
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = "/root/.claude/projects/-home-user-V2/97a4479c-ffae-5c12-a4a1-944852715c09.jsonl"
OUT = Path(sys.argv[1])
REPORT = len(sys.argv) > 2 and sys.argv[2] == "--report"

_argv = sys.argv
sys.argv = [_argv[0], "/dev/null"]
spec = importlib.util.spec_from_file_location("transcript", HERE / "build-transcript.py")
transcript = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transcript)
sys.argv = _argv

# ---------------------------------------------------------------------------
# what counts as the email side
# ---------------------------------------------------------------------------
#
# Weighted rather than a flat list. "instantly" or "deliverability" is decisive
# on its own; "campaign" and "push" are ambiguous — a SOURCING campaign and a
# lead push are the calling side — so they only count alongside something else.

#
# BARE "email" IS NOT DECISIVE, and leaving it in was the first version's
# mistake. It matches "email/password login", "outside of my email", and every
# enrichment conversation about finding an email ADDRESS — so a report of the
# selection had the kanban bug, the caller login and the dialer redesign all
# marked as email work. Only terms that belong to the sending programme count.
# Case matters here, so these are NOT compiled case-insensitively as a block.
# The first version did exactly that and silently destroyed the one pattern
# that depended on case — `Instantly` the product versus "instantly revocable"
# the adverb — which pulled the founding context dump and the caller-login
# exchange in as email work. Patterns that want case-insensitivity say so.
DECISIVE = [
    # The product, capitalised, or lowercase next to something it owns.
    r"Instantly\b",
    r"(?i)\binstantly (api|campaign|account|dashboard|inbox|editor|settings)",
    r"(?i)\bcold[- ]?email",
    r"(?i)\bemail (campaign|programme|program|sequence|tool|side|page|scoring)",
    # Plural is the sending accounts; singular is also a Dispatch Board inbox
    # item, an email inbox, a figure of speech. Only the plural is decisive.
    r"(?i)\binboxes\b", r"(?i)\b(sending|general|generic) inbox\b",
    # "deliverability", never "deliverables" — the bare stem dragged in two
    # large specs that had nothing to do with email.
    r"(?i)\bdeliverabilit",
    r"(?i)\bwarm[- ]?up\b", r"(?i)\bwarmup\b", r"(?i)\bmailbox",
    r"(?i)\bsending account",
    # Only the email senses of "sequence" — "sequence of steps" in the dialer
    # rewrite was clearing the bar on its own.
    r"(?i)\bemail sequence", r"(?i)\bsequence (writer|editor|steps)",
    r"(?i)\bactive sequence\b", r"(?i)\bpublish(ed|ing)? (the |a )?sequence",
    r"(?i)\bsubject line", r"(?i)\bopen rate\b",
    # "bounce" alone matched "bounces them back to the PIN screen".
    r"(?i)\bbounce rate\b", r"(?i)\b(email|hard|soft)[- ]bounce", r"(?i)\bbounced (email|lead|address)",
    r"(?i)\bunsubscrib", r"(?i)\bspam\b", r"(?i)\bsmtp\b", r"(?i)\bdomain reputation",
    r"(?i)\bemail_threads\b", r"(?i)\bemail_events\b", r"(?i)\bmerge field",
    r"(?i)\bgap_list\b", r"(?i)\bpersonal email", r"\binfo@", r"\boffice@",
    r"(?i)\bdaily limit\b", r"(?i)\bnamed people\b",
    r"\bemailPush\b", r"\bemailHealth\b", r"\bemailEligibility\b",
    r"\bsequenceWriter\b", r"\bsendingCapacity\b", r"\brefillPlan\b",
    r"\binstantlyStore\b", r"\bemailCompose\b", r"\bemailDraft\b",
    # "top up" alone is packet management — topping up a caller's packet.
    r"(?i)\brefill_email_campaign\b", r"(?i)\btop(s|ping)? (the campaign|it back) up",
    r"(?i)\btop the campaign up", r"(?i)\bauto[- ]?push\b",
    r"(?i)\bpush(ed|ing)? to (the )?campaign",
    r"(?i)\bsend(ing)? (emails|limit)", r"(?i)\bemails? (are|is|go|going|being) (sent|out)",
]

# Only count alongside something decisive. A sourcing campaign, a lead push and
# a packet top-up are all the CALLING side, so none of these can carry an
# exchange on their own.
SUPPORTING = [
    r"\bcampaign\b", r"\bpush(ed|ing)?\b", r"\bcap\b", r"\bschedule\b", r"\breply\b",
    r"\breplies\b", r"\bopened\b", r"\bsent\b", r"\bleads eligible\b", r"\benrich",
    r"\bemail\b", r"\bemails\b", r"\baddress(es)?\b", r"\bgreeting\b",
    r"\binbox\b", r"\btop[- ]?up\b", r"\bbounce[sd]?\b", r"\bsequence[sd]?\b",
]

# No blanket re.I — see the note above DECISIVE. Supporting terms are all
# ordinary words and are matched case-insensitively.
DECISIVE_RE = [re.compile(p) for p in DECISIVE]
SUPPORTING_RE = [re.compile(p, re.I) for p in SUPPORTING]

# Harness bookkeeping, not conversation. A context re-dump quotes half the
# session back and would drag a duplicate of everything into a topical file.
#
# NOT in this list: "[Image: ...]" and "[Request interrupted]". They look like
# noise and are not — a screenshot of the Instantly dashboard with no words is
# still a question, and the answer under it is the substance. Excluding them
# threw away the analysis of the campaign screenshots.
NOISE = re.compile(
    r"^(This session is being continued from a previous conversation"
    r"|This session'?s worker process was restarted"
    r"|<command-name>)",
    re.I,
)

# A follow-up short enough that it cannot carry its own topic.
SHORT_FOLLOWUP_WORDS = 25


def score(text: str) -> tuple[int, int]:
    decisive = sum(1 for r in DECISIVE_RE if r.search(text))
    supporting = sum(1 for r in SUPPORTING_RE if r.search(text))
    return decisive, supporting


def blocks_of(entry: dict) -> list:
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return content if isinstance(content, list) else []


def load_turns() -> list:
    turns: list[list] = []
    for line in open(SRC, encoding="utf-8", errors="replace"):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        role = entry.get("type")
        if role not in ("user", "assistant"):
            continue
        for block in blocks_of(entry):
            if not isinstance(block, dict) or block.get("type") != "text":
                continue
            text = re.sub(
                r"<system-reminder>.*?</system-reminder>", "", block.get("text") or "", flags=re.S
            )
            text = re.sub(r"<local-command-[a-z-]+>.*?</local-command-[a-z-]+>", "", text, flags=re.S)
            text = transcript.scrub(text)
            if not text:
                continue
            if turns and turns[-1][0] == role:
                turns[-1][1].append(text)
            else:
                turns.append([role, [text]])
    return turns


def main() -> None:
    turns = load_turns()

    # ------------------------------------------------------------ exchanges
    # A user turn opens an exchange; the replies that follow belong to it.
    exchanges: list[dict] = []
    for role, parts in turns:
        body = "\n\n".join(parts)
        if role == "user" or not exchanges:
            exchanges.append({"ask": body if role == "user" else "", "replies": [], "n": len(exchanges) + 1})
            if role == "assistant":
                exchanges[-1]["replies"].append(body)
        else:
            exchanges[-1]["replies"].append(body)

    # --------------------------------------------------------------- scoring
    for x in exchanges:
        whole = "\n\n".join([x["ask"], *x["replies"]])
        d, s = score(whole)
        x["decisive"], x["supporting"] = d, s
        # Two decisive terms, or one backed by real context. Raised from
        # (d>=1 and s>=2) after reading the selection: one stray "sequence" in
        # a long reply about calling was clearing the old bar.
        x["noise"] = bool(NOISE.match(x["ask"].strip()))
        x["hit"] = (d >= 2 or (d >= 1 and s >= 4)) and not x["noise"]
        x["ask_words"] = len(x["ask"].split())

    # --------------------------------------------------- carry the follow-up
    #
    # A short question straight after an email exchange is part of it. "still
    # not working" and "so just redeploy?" carry no topic of their own, and
    # dropping them leaves an answer with no question in front of it.
    for i, x in enumerate(exchanges):
        if x["hit"] or i == 0:
            continue
        prev = exchanges[i - 1]
        if prev.get("included") and x["ask_words"] <= SHORT_FOLLOWUP_WORDS and x["decisive"] == 0:
            # Only when it raises no competing topic of its own.
            x["carried"] = True
        x["included"] = x["hit"] or x.get("carried", False)
    for x in exchanges:
        x.setdefault("included", x["hit"])

    kept = [x for x in exchanges if x["included"]]

    if REPORT:
        for x in exchanges:
            mark = "KEEP" if x["included"] else "    "
            why = "carried" if x.get("carried") else f"d{x['decisive']} s{x['supporting']}"
            first = " ".join(x["ask"].split())[:74] or "(reply only)"
            print(f"{mark} [{x['n']:3}] {why:>9} | {first}")
        print(f"\n{len(kept)} of {len(exchanges)} exchanges kept")
        return

    words = 0
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("# Dispatch Board — everything about the cold email side\n\n")
        f.write(
            "Every exchange that touched the email programme: Instantly, the sending "
            "inboxes, deliverability, the sequence writer, who gets emailed and who "
            "does not, and the long argument about why nothing was going out.\n\n"
            f"{len(kept)} exchanges out of {len(exchanges)}, in order, with the original "
            "numbering kept so anything here can be found in the full transcript.\n\n"
            "Selected by keyword across the whole exchange rather than per message — "
            "half of this conversation is about email without using the word, and "
            "scoring messages one at a time separates questions from their answers. A "
            "short follow-up straight after an email exchange is carried in with it, "
            "because that is what a follow-up is.\n\n"
            "Same redactions as the full transcript: keys, tokens, the database host, "
            "telephone numbers, personal names, and real addresses — though whether an "
            "address was a role address or a named person survives, since that is the "
            "subject of several of these.\n\n"
            "---\n\n"
        )
        for x in kept:
            if x["ask"]:
                body = transcript.nest_headings(x["ask"], floor=4)
                words += len(body.split())
                f.write(f"## {x['n']}. Operator\n\n{body}\n\n")
            for reply in x["replies"]:
                body = transcript.nest_headings(reply, floor=4)
                words += len(body.split())
                f.write(f"### Claude\n\n{body}\n\n")

    print(f"{len(kept)} of {len(exchanges)} exchanges, {words:,} words -> {OUT}")


if __name__ == "__main__":
    main()
