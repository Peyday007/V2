// What the system does after each call, before the next lead opens.
//
// This is the real-time control layer. Not a report written after a shift is
// wasted — a decision taken between one call and the next, while there is still
// something to protect.
//
// THE FAILURE IT EXISTS TO PREVENT, stated as the brief stated it:
//
//   "Never permit a situation where 80 calls have zero captured information.
//    The workflow should have stopped after the first few failures."
//
// Everything here is pure, because this decides whether somebody can keep
// working and that decision has to be readable, testable and arguable without
// a database.
//
// ---------------------------------------------------------------------------
// FOUR RULES THIS MUST NEVER BREAK
// ---------------------------------------------------------------------------
//
// 1. A SYSTEM FAILURE IS NEVER A CALLER'S FAULT. If the records are empty
//    because saving failed, that is an incident, not misconduct, and it
//    escalates to an engineer rather than restricting a caller. This codebase
//    already made the opposite mistake once: `no_transcript` — a fact about
//    recording being switched off — was treated as a reason a human needed to
//    intervene, and the review queue filled with thirty identical rows nobody
//    could action. A gate that fires on system state is worse than no gate.
//
// 2. THE SMALLEST CAPABILITY. Missing notes pauses NEW DIALLING and nothing
//    else: the caller keeps the ability to write those notes, take callbacks,
//    and reach a manager. A control that blocks remediation guarantees the
//    problem stays.
//
// 3. NO EMPLOYMENT, PAY OR FRAUD CONCLUSIONS. This stops work. It never
//    decides what somebody is owed, whether they lied, or whether they keep
//    their job. Those need a person with the whole file.
//
// 4. IT SAYS WHY, EVERY TIME. Trigger, the records at fault, what to do, what
//    happens next, and who can lift it.

/* -------------------------------------------------------------------------- */
/* what a finished call has to carry                                          */
/* -------------------------------------------------------------------------- */

/**
 * Outcomes that assert a human conversation happened.
 *
 * These carry a higher bar because they are the ones that move a lead forward
 * and the ones worth misreporting. A no-answer needs nothing but a timestamp.
 */
export const CONVERSATION_OUTCOMES = [
  "dm_conversation",
  "gatekeeper",
  "appointment_set",
  "callback",
  "not_interested",
  "transferred",
] as const;

export type CallRecord = {
  id: string;
  outcome: string | null;
  notes: string | null;
  nextStep: string | null;
  durationSeconds: number | null;
  createdAt: string;
  /**
   * The record could not be saved for a reason that is not the caller's.
   *
   * Set by the outcome API when a write fails. Rule 1 lives or dies on this
   * field being honest: an incomplete record caused by a failed save must
   * never count toward a restriction.
   */
  saveFailed?: boolean;
};

/** Why a specific call is incomplete, or null when it is fine. */
export function whatIsMissing(call: CallRecord): string | null {
  if (call.saveFailed) return null; // not the caller's doing — see rule 1
  if (!call.outcome) return "no outcome chosen";

  const conversational = (CONVERSATION_OUTCOMES as readonly string[]).includes(call.outcome);
  if (!conversational) return null;

  const notes = (call.notes || "").trim();
  if (notes.length < MIN_NOTE_CHARS) {
    return notes.length === 0 ? "no notes" : "notes too thin to be useful";
  }
  if (call.outcome === "callback" && !(call.nextStep || "").trim()) {
    return "a callback with no time agreed";
  }
  return null;
}

/**
 * Short enough to be a placeholder, long enough that a real sentence passes.
 *
 * Deliberately low. This catches "." and "n/a", not brevity. A gate that
 * demands paragraphs teaches people to paste paragraphs.
 */
export const MIN_NOTE_CHARS = 12;

/**
 * Notes repeated verbatim across calls.
 *
 * Copy-paste is the cheapest way to satisfy a notes requirement without
 * capturing anything, so a gate on note LENGTH alone creates it. Compared
 * case-insensitively on trimmed text.
 */
export function repeatedNotes(calls: CallRecord[]): string[] {
  const seen = new Map<string, string[]>();
  for (const c of calls) {
    /*
     * Only where notes are REQUIRED.
     *
     * A caller who leaves three voicemails will write "left a voicemail" three
     * times, and that is the truth rather than a shortcut. Scoping this to
     * conversation outcomes is the difference between catching a caller who
     * pasted the same sentence over three real conversations and punishing one
     * who accurately described three identical non-events.
     */
    if (!c.outcome || !(CONVERSATION_OUTCOMES as readonly string[]).includes(c.outcome)) continue;
    const n = (c.notes || "").trim().toLowerCase();
    if (n.length < MIN_NOTE_CHARS) continue;
    seen.set(n, [...(seen.get(n) || []), c.id]);
  }
  return [...seen.values()].filter((ids) => ids.length >= REPEAT_LIMIT).flat();
}

/** Three identical notes is a pattern; two is a coincidence. */
export const REPEAT_LIMIT = 3;

/* -------------------------------------------------------------------------- */
/* the ladder                                                                 */
/* -------------------------------------------------------------------------- */

export type GateLevel =
  /** Nothing wrong. Carry on. */
  | "clear"
  /** Say something before the next lead. Nothing is blocked. */
  | "remind"
  /** This record must be finished before another lead opens. */
  | "require_correction"
  /** The pattern continued. Caller and manager both told; still not blocked. */
  | "warn_manager"
  /** New dialling stops. Correction, callbacks and messaging stay open. */
  | "pause_dialling"
  /** A person decides. The system has gone as far as it should. */
  | "manager_review";

export type GateDecision = {
  level: GateLevel;
  /** May the caller open another lead right now? */
  mayDial: boolean;
  /** What the caller is told. Plain, specific, and never accusatory. */
  message: string;
  /** The exact records at fault, so nothing is asserted without evidence. */
  callIds: string[];
  /** What happens if this continues. Stated up front, never a surprise. */
  next: string | null;
  /** Who can lift it, when it is not the caller. */
  liftedBy: "caller" | "manager" | null;
  /** True when the cause is the system, not the person. */
  systemFault: boolean;
};

export type GateInput = {
  /** This shift's calls, newest last. */
  calls: CallRecord[];
  /** Off for a caller in training, or when an admin has suspended the gate. */
  enabled: boolean;
};

/** Consecutive incomplete calls that stop new dialling. */
export const CONSECUTIVE_LIMIT = 2;
/** Total incomplete calls in a shift that stop new dialling. */
export const TOTAL_LIMIT = 3;
/** Share of the shift incomplete that escalates to a person. */
export const SHIFT_INCOMPLETE_SHARE = 0.1;
/** Below this many calls the share is meaningless. */
export const MIN_SHIFT_SAMPLE = 10;

const clear = (): GateDecision => ({
  level: "clear",
  mayDial: true,
  message: "",
  callIds: [],
  next: null,
  liftedBy: null,
  systemFault: false,
});

export function decideGate(input: GateInput): GateDecision {
  if (!input.enabled) return clear();

  const calls = input.calls;
  if (calls.length === 0) return clear();

  /*
   * The system's own failures, first and separately.
   *
   * Checked before anything else so a caller is never restricted for an
   * outage. This escalates — somebody has to fix it — but it escalates to an
   * engineer and it does not stop the phone, because a caller who can still
   * work and whose notes are being held locally is better off than one sitting
   * idle waiting for a deploy.
   */
  const failed = calls.filter((c) => c.saveFailed);
  if (failed.length >= CONSECUTIVE_LIMIT) {
    return {
      level: "manager_review",
      mayDial: true,
      message:
        `${failed.length} of your call records could not be saved. This is a fault in the ` +
        `system, not something you did. Your notes are being kept and a manager has been told.`,
      callIds: failed.map((c) => c.id),
      next: "An engineer has to fix this. Keep working if you can.",
      liftedBy: "manager",
      systemFault: true,
    };
  }

  const incomplete = calls.filter((c) => whatIsMissing(c) !== null);
  const copied = repeatedNotes(calls);

  /* ------------------------- the share of the shift ---------------------- */
  if (
    calls.length >= MIN_SHIFT_SAMPLE &&
    incomplete.length / calls.length > SHIFT_INCOMPLETE_SHARE
  ) {
    return {
      level: "manager_review",
      mayDial: false,
      message:
        `${incomplete.length} of your ${calls.length} calls this shift are missing information. ` +
        `New leads are paused while this is sorted out. You can still finish these records, ` +
        `take callbacks and message your manager.`,
      callIds: incomplete.map((c) => c.id),
      next: "A manager will look at these with you.",
      liftedBy: "manager",
      systemFault: false,
    };
  }

  /* ------------------------------ copy-paste ----------------------------- */
  if (copied.length >= REPEAT_LIMIT) {
    return {
      level: "pause_dialling",
      mayDial: false,
      message:
        `The same note appears on ${copied.length} calls. Notes are what the next person ` +
        `reads before they ring — identical text on different businesses tells them nothing. ` +
        `Please write what actually happened on each.`,
      callIds: copied,
      next: "New leads open again as soon as these are different.",
      liftedBy: "caller",
      systemFault: false,
    };
  }

  /* ------------------------- consecutive, then total --------------------- */
  const trailing: CallRecord[] = [];
  for (let i = calls.length - 1; i >= 0; i--) {
    if (whatIsMissing(calls[i]) === null) break;
    trailing.unshift(calls[i]);
  }

  if (trailing.length >= CONSECUTIVE_LIMIT || incomplete.length >= TOTAL_LIMIT) {
    const at = trailing.length >= CONSECUTIVE_LIMIT ? trailing : incomplete;
    return {
      level: "pause_dialling",
      mayDial: false,
      message:
        `${at.length} calls in a row are missing information, so no new lead will open until ` +
        `they are finished. If the app is not saving what you type, use "Report a problem" ` +
        `instead — that is a fault, not your mistake.`,
      callIds: at.map((c) => c.id),
      next: "Finish these and dialling starts again straight away.",
      liftedBy: "caller",
      systemFault: false,
    };
  }

  /* --------------------------- the most recent one ----------------------- */
  const last = calls[calls.length - 1];
  const missing = whatIsMissing(last);
  if (missing) {
    return {
      level: "require_correction",
      mayDial: false,
      message: `That call has ${missing}. Finish it and the next lead will open.`,
      callIds: [last.id],
      next: `If another call is left incomplete, new dialling pauses until they are all done.`,
      liftedBy: "caller",
      systemFault: false,
    };
  }

  return clear();
}

/**
 * What a caller may still do while dialling is paused.
 *
 * Returned rather than assumed so the dialler cannot quietly disable more than
 * the gate intended. Rule 2: the smallest capability, and never the one needed
 * to fix the problem.
 */
export function stillAllowed(decision: GateDecision): string[] {
  const always = ["finish call records", "take scheduled callbacks", "message a manager"];
  return decision.mayDial ? [...always, "open new leads"] : always;
}
