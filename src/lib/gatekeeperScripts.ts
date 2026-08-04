// The gatekeeper openers under test.
//
// One job: get past whoever answers, to the owner.
//
// TWO THINGS CHANGED HERE, AND BOTH WERE MEASUREMENT BUGS.
//
//   1. THE CALLER USED TO CHOOSE. There was a toggle in the dialer, so the
//      script under test was picked by the person whose performance it was
//      measuring — on a lead they had already looked at. A caller who fancies
//      script B on the promising-looking leads and falls back to A on the
//      rough ones will produce a beautiful result for B that means nothing.
//      That is selection bias, and it is fatal to the whole exercise.
//
//      Assignment is now made FROM THE LEAD, before anybody sees it, by
//      hashing the lead's id. Deterministic, so the same lead always gets the
//      same script on a callback, and uniform, so the arms stay balanced
//      without anybody managing them.
//
//   2. THERE WERE ONLY THREE. Three was never a principle, it was just where
//      it started. The list below is open-ended: adding a variant is adding an
//      entry, and the stats, the assignment and the admin page all size
//      themselves from it.
//
// Each variant still differs in exactly ONE dimension, because a variant that
// changes three things at once cannot tell you which of the three worked.

export const SCRIPT_VERSIONS = ["A", "B", "C", "D", "E", "F", "G"] as const;
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
  city?: string | null;
  /** Only used by C, and only when the count is actually known. */
  reviewCount?: number | null;
  /**
   * The strongest thing the diagnostic found about THIS business, if any.
   * Used by C so the specific hook is genuinely specific rather than a
   * template with a number dropped into it.
   */
  hook?: string | null;
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
  const city = (fill.city || "").trim();

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
      opener: caller ? `"Hi, this is ${caller} — is ${who} available?"` : `"Hi — is ${who} available?"`,
      ifPushed: `"It's a quick business question for ${pronoun()} directly, shouldn't take more than a minute."`,
    };
  }

  if (version === "C") {
    // The hook comes from the diagnostic when there is one, so this arm is
    // genuinely about THIS business rather than a template with a number in
    // it. Falls back through review count to a generic line, and the fallback
    // never asserts anything the record does not support.
    const hook = (fill.hook || "").trim();
    const opener = hook
      ? `"Hi, quick question — I was looking at ${business} and noticed ${lowerFirst(hook)}. I wanted to ask the owner about it. Is ${pronoun()} around?"`
      : typeof fill.reviewCount === "number" && fill.reviewCount > 0
        ? `"Hi, quick question — I noticed ${business} has ${fill.reviewCount} reviews online, and I wanted to ask the owner something specific about how new customers reach you. Is ${pronoun()} around?"`
        : `"Hi, quick question — I was looking at ${business} online and wanted to ask the owner something specific about how new customers reach you. Is ${pronoun()} around?"`;
    return {
      version: "C",
      name: "Specific hook",
      premise: "Lead with something true about this business so it cannot read as a mail-out.",
      opener,
      ifPushed: `"It's specifically about what I found on your listing — just a couple of minutes with whoever handles that."`,
    };
  }

  if (version === "D") {
    return {
      version: "D",
      name: "Permission first",
      premise: "Ask for permission before asking for anything. Tests whether disarming beats brevity.",
      opener: `"Hi — I know you're busy, did I catch you at a terrible moment? … Appreciate it. Is ${who} the person who'd handle how calls come into the business?"`,
      ifPushed: `"Totally fair. When's a better time to catch ${pronoun()} — morning or afternoon?"`,
    };
  }

  if (version === "E") {
    return {
      version: "E",
      name: "Local and plural",
      premise:
        "Position as already working with businesses like theirs nearby. Tests social proof over specificity.",
      opener: city
        ? `"Hi — I've been speaking to a few ${city} companies this week about the calls they're missing after hours. Is ${who} about?"`
        : `"Hi — I've been speaking to a few companies in your area this week about the calls they're missing after hours. Is ${who} about?"`,
      ifPushed: `"Same thing I asked the others — what happens to a call at seven in the evening. Two minutes with the owner and I'll leave you alone."`,
    };
  }

  if (version === "F") {
    return {
      version: "F",
      name: "Question first",
      premise:
        "Open with a question the gatekeeper can answer themselves. Tests engaging them rather than going around them.",
      opener: `"Hi — quick question, and you might actually be the right person. When someone rings ${business} after hours, where does that call go?"`,
      ifPushed: `"That's helpful, thank you. Is ${who} the one who decides on that side of things? I'd only need a minute."`,
    };
  }

  return {
    version: "G",
    name: "Named cold call",
    premise:
      "Admit it is a cold call and ask for a fixed, tiny amount of time. Tests honesty against every form of framing.",
    opener: caller
      ? `"Hi, this is ${caller} — I'll be straight with you, this is a cold call. Give me twenty seconds and you can tell me to get lost. Is ${who} there?"`
      : `"Hi — I'll be straight with you, this is a cold call. Twenty seconds and you can tell me to get lost. Is ${who} there?"`,
    ifPushed: `"Fair enough — it's about what happens to calls nobody picks up. If that's not a problem for you I'll leave it there."`,
  };
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/* -------------------------------------------------------------------------- */
/* who gets which                                                             */
/* -------------------------------------------------------------------------- */

/**
 * FNV-1a. Small, fast, no dependency, and spreads adjacent inputs well.
 *
 * The last part matters here more than usual: lead ids are UUIDs generated in
 * sequence, so a weak hash would put runs of consecutive leads into the same
 * arm and the arms would drift apart on whatever the leads were sorted by.
 */
export function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Which script this lead gets.
 *
 * Deterministic on purpose, not random-per-call. Two reasons:
 *
 *   - a callback must use the same opener as the first attempt, or the second
 *     conversation contradicts the first and the result is unattributable;
 *   - the same assignment can be recomputed anywhere — the dialer, the API,
 *     the stats page — without storing it or passing it around.
 *
 * `salt` restarts the experiment. Changing it reshuffles every lead into a new
 * arm, which is what you want when a variant is added or the copy changes, and
 * is exactly what you do NOT want to happen by accident — hence it being an
 * explicit argument rather than something derived from the variant list.
 */
export function assignScript(
  leadId: string,
  salt = "",
  versions: readonly ScriptVersion[] = SCRIPT_VERSIONS
): ScriptVersion {
  if (versions.length === 0) return "A";
  return versions[hashString(`${salt}:${leadId}`) % versions.length];
}

/**
 * The same assignment, but weighted by what the house has learned.
 *
 * An even split is the right thing to do while nothing is known, and the wrong
 * thing to do once something is: continuing to send a seventh of the calls to
 * an opener that demonstrably loses is paying for information you already
 * have. So once an arm clears the sample floor the split shifts toward it.
 *
 * What does NOT happen is winner-takes-all. `weights` carries an exploration
 * floor, so every arm keeps a share forever — a router that sends everything
 * to today's winner cannot notice when the market moves, because the data it
 * would need is data it stopped collecting.
 *
 * Still deterministic on the lead, so a callback opens the way the first call
 * did. The weights change the shape of the split, not its stability.
 */
export function assignScriptWeighted(
  leadId: string,
  weights: Record<string, number>,
  salt = "",
  versions: readonly ScriptVersion[] = SCRIPT_VERSIONS
): ScriptVersion {
  const usable = Object.entries(weights).filter(([k]) => (versions as readonly string[]).includes(k));
  if (usable.length === 0) return assignScript(leadId, salt, versions);

  const hash = hashString(`${salt}:${leadId}`);
  const point = (hash % 10000) / 10000;
  const total = usable.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return assignScript(leadId, salt, versions);

  let running = 0;
  for (const [version, weight] of usable) {
    running += weight / total;
    if (point < running) return version as ScriptVersion;
  }
  return usable[usable.length - 1][0] as ScriptVersion;
}

/**
 * How evenly a set of leads would actually be split.
 *
 * Exported because "it is a hash, it will be fine" is a claim worth checking
 * against real ids rather than trusting — a skewed split silently weakens
 * every comparison drawn from it.
 */
export function assignmentSpread(
  leadIds: string[],
  salt = "",
  versions: readonly ScriptVersion[] = SCRIPT_VERSIONS
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of versions) counts[v] = 0;
  for (const id of leadIds) counts[assignScript(id, salt, versions)] += 1;
  return counts;
}

export function isScriptVersion(v: unknown): v is ScriptVersion {
  return typeof v === "string" && (SCRIPT_VERSIONS as readonly string[]).includes(v);
}

export const SCRIPT_NAME: Record<ScriptVersion, string> = {
  A: "Stated reason",
  B: "Assumptive brevity",
  C: "Specific hook",
  D: "Permission first",
  E: "Local and plural",
  F: "Question first",
  G: "Named cold call",
};

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
