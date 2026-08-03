// The three gatekeeper openers under test.
//
// One job: get past whoever answers, to the owner. They differ in exactly one
// dimension so the result means something —
//
//   A states the reason,  B assumes the right to be put through,
//   C leads with something specific about that business.
//
// The text is the same for every caller and every lead apart from the merge
// fields, because a script that each caller rewrites is not a script under
// test, it is three callers' instincts wearing a label.

export const SCRIPT_VERSIONS = ["A", "B", "C"] as const;
export type ScriptVersion = (typeof SCRIPT_VERSIONS)[number];

export type GatekeeperScript = {
  version: ScriptVersion;
  name: string;
  /** What it is testing, in one line, so a caller knows why it differs. */
  premise: string;
  opener: string;
  /** What to say when the gatekeeper pushes back. */
  ifPushed: string;
};

export type ScriptFill = {
  ownerName?: string | null;
  businessName: string;
  callerName?: string | null;
  /** Only used by C, and only when the count is actually known. */
  reviewCount?: number | null;
};

/** He/she is unknowable from a name, and guessing it in front of a gatekeeper
 *  is a fast way to be caught out. "them" is always safe and never wrong. */
function pronoun(): string {
  return "them";
}

function owner(fill: ScriptFill): string {
  return (fill.ownerName || "").trim() || "the owner";
}

export function buildScript(version: ScriptVersion, fill: ScriptFill): GatekeeperScript {
  const who = owner(fill);
  const business = fill.businessName;
  const caller = (fill.callerName || "").trim();

  if (version === "A") {
    return {
      version: "A",
      name: "Stated reason",
      premise: "Say what the call is about up front and ask for the owner by name.",
      opener: `"Hey, quick one — I'm calling about missed calls turning into missed jobs. Is ${who} around for a sec?"`,
      ifPushed: `"Just seeing how ${business} handles calls that come in when no one can pick up — takes two minutes, I just need a quick word with the owner."`,
    };
  }

  if (version === "B") {
    return {
      version: "B",
      name: "Assumptive brevity",
      premise: "Give no reason at all. Ask as though you are expected.",
      opener: caller
        ? `"Hi, this is ${caller} — is ${who} available?"`
        : `"Hi — is ${who} available?"`,
      ifPushed: `"It's a quick business question for ${pronoun()} directly, shouldn't take more than a minute."`,
    };
  }

  return {
    version: "C",
    name: "Specific hook",
    premise: "Lead with something true about this business so it cannot read as a mail-out.",
    // The review claim is only made when the number is actually on the record.
    opener:
      typeof fill.reviewCount === "number" && fill.reviewCount > 0
        ? `"Hi, quick question — I noticed ${business} has ${fill.reviewCount} reviews online, and I wanted to ask the owner something specific about how new customers reach you. Is ${pronoun()} around?"`
        : `"Hi, quick question — I noticed ${business} has a lot of reviews online, and I wanted to ask the owner something specific about how new customers reach you. Is ${pronoun()} around?"`,
    ifPushed: `"It's specifically about your review page and call handling — just a couple minutes with the owner."`,
  };
}

/**
 * Put the chosen opener into the lines the dialer is already showing.
 *
 * The first two lines of the pre-owner guide are "how you open" and "what you
 * say when pushed", which is exactly what a gatekeeper script is. So the test
 * replaces those two and leaves everything after them — the voicemail line,
 * getting a direct route — alone, because none of that is under test and
 * replacing it would change more than one thing at a time.
 *
 * Returns the lines untouched once the owner is on the phone. The scripts are
 * about getting past reception; swapping the pitch as well would mean the
 * result could not be attributed to the opener.
 */
export function applyScript<T extends { heading: string; line: string }>(
  lines: T[],
  script: GatekeeperScript | null,
  speakingWithOwner: boolean
): { heading: string; line: string }[] {
  if (!script || speakingWithOwner) return lines;
  return [
    { heading: `Script ${script.version} — open with this`, line: script.opener },
    { heading: "If they push back", line: script.ifPushed },
    ...lines.slice(2),
  ];
}

export function isScriptVersion(v: unknown): v is ScriptVersion {
  return typeof v === "string" && (SCRIPT_VERSIONS as readonly string[]).includes(v);
}

export const SCRIPT_NAME: Record<ScriptVersion, string> = {
  A: "Stated reason",
  B: "Assumptive brevity",
  C: "Specific hook",
};
