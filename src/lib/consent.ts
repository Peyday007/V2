// Recording consent.
//
// Recording a call without the consent the law requires is a criminal offence
// in several states, not a policy breach. So this module decides, per call,
// whether recording is permitted — and the default answer when anything is
// unknown is NO.
//
// Pure functions with no I/O, because this is the rule that most needs to be
// readable and testable.

/**
 * States requiring ALL parties to consent. Recording a business in one of
 * these without an announcement they accept is unlawful.
 *
 * Sources differ on a few borderline states; where they differ this list takes
 * the stricter reading, because the cost of being wrong is asymmetric.
 */
export const ALL_PARTY_CONSENT_STATES = [
  "CA", "CT", "DE", "FL", "IL", "MD", "MA", "MI", "MT",
  "NV", "NH", "OR", "PA", "WA",
] as const;

export type ConsentPolicy =
  | "all_party"
  | "one_party"
  | "per_state"
  | "one_party_only"
  | "disabled";

export type ConsentDecision = {
  /** May recording start at all? */
  allowed: boolean;
  /** Must the announcement be played and accepted first? */
  announcementRequired: boolean;
  /** Must the prospect actively agree, not merely be told? */
  affirmativeConsentRequired: boolean;
  /** What to store on the recording row. */
  status: "pending" | "not_required" | "blocked";
  /**
   * Recording is REQUIRED here, not offered.
   *
   * True wherever recording is lawful on the caller's consent alone — no
   * announcement to read, no agreement to capture, no judgement call. There is
   * nothing for a caller to decide, so the recorder starts itself and the
   * dialler refuses to place the call until it is actually capturing.
   *
   * This used to be set only by the one_party_only policy, which meant the
   * same lawful, nothing-to-ask call was mandatory under one policy and
   * optional under another. The law does not change with the setting: if a
   * single party's consent is sufficient and the caller is that party, there
   * was never a decision to make.
   *
   * It is NEVER true where an announcement or an agreement is required, and
   * never where recording is not allowed at all. Widening this can only make
   * recording happen where `allowed` was already true and nobody had to be
   * asked — it can never authorise a recording that was not already lawful.
   */
  mandatory: boolean;
  /** Why, in words a non-lawyer can act on. */
  reason: string;
  policyApplied: ConsentPolicy;
};

export function isAllPartyState(state: string | null | undefined): boolean {
  if (!state) return false;
  return (ALL_PARTY_CONSENT_STATES as readonly string[]).includes(
    state.trim().toUpperCase()
  );
}

export type ConsentInput = {
  policy: ConsentPolicy;
  recordingEnabled: boolean;
  /** The business's state. Unknown is treated as strictly as all-party. */
  leadState?: string | null;
};

export function decideConsent(input: ConsentInput): ConsentDecision {
  const { policy, recordingEnabled, leadState } = input;

  if (!recordingEnabled || policy === "disabled") {
    return {
      allowed: false,
      announcementRequired: false,
      affirmativeConsentRequired: false,
      status: "blocked",
      mandatory: false,
      reason: "Recording is switched off for this deployment.",
      policyApplied: policy,
    };
  }

  if (policy === "all_party") {
    return {
      allowed: true,
      announcementRequired: true,
      affirmativeConsentRequired: true,
      status: "pending",
      mandatory: false,
      reason:
        "Every call is announced and needs the prospect's agreement before recording starts.",
      policyApplied: policy,
    };
  }

  /**
   * Record where one-party consent is lawful, and DO NOT RECORD AT ALL where
   * it is not.
   *
   * The other policies handle an all-party state by announcing and asking. This
   * one handles it by walking away — no announcement, no script change, no
   * agreement to capture, just no recording on that call. Callers never have to
   * remember to say anything, at the cost of no recordings from fourteen
   * states.
   *
   * Legally the most conservative option here: it can only ever record where a
   * single party's consent is sufficient, and the caller is always that party.
   */
  if (policy === "one_party_only") {
    if (!leadState) {
      return {
        allowed: false,
        announcementRequired: false,
        affirmativeConsentRequired: false,
        status: "blocked",
        mandatory: false,
        reason:
          "No state on file for this business, so the law that applies is unknown. Not recorded.",
        policyApplied: policy,
      };
    }
    if (isAllPartyState(leadState)) {
      return {
        allowed: false,
        announcementRequired: false,
        affirmativeConsentRequired: false,
        status: "blocked",
        mandatory: false,
        reason: `${leadState} needs everyone on the call to agree, so this call is not recorded.`,
        policyApplied: policy,
      };
    }
    return {
      allowed: true,
      announcementRequired: false,
      affirmativeConsentRequired: false,
      status: "not_required",
      // The caller is not asked whether to record. Forgetting is the only
      // failure mode left once the unlawful case is impossible, so it is
      // designed out rather than trained out.
      mandatory: true,
      reason: `${leadState} allows one-party consent, so this call is recorded automatically.`,
      policyApplied: policy,
    };
  }

  if (policy === "one_party") {
    // Even under a one-party policy, an all-party state overrides it. The
    // policy is a business preference; the state's law is not.
    if (isAllPartyState(leadState)) {
      return {
        allowed: true,
        announcementRequired: true,
        affirmativeConsentRequired: true,
        status: "pending",
        mandatory: false,
        reason: `${leadState} requires everyone on the call to consent, which overrides the one-party setting.`,
        policyApplied: policy,
      };
    }
    if (!leadState) {
      return {
        allowed: false,
        announcementRequired: true,
        affirmativeConsentRequired: true,
        status: "blocked",
        mandatory: false,
        reason:
          "No state on file for this business, so the law that applies is unknown. Recording is blocked rather than guessed.",
        policyApplied: policy,
      };
    }
    return {
      allowed: true,
      announcementRequired: false,
      affirmativeConsentRequired: false,
      status: "not_required",
      // Lawful, and there is nobody to ask. See the note on `mandatory`.
      mandatory: true,
      reason: `${leadState} allows one-party consent, and the caller is a party to the call.`,
      policyApplied: policy,
    };
  }

  // per_state: same as one_party but announces where required, rather than
  // blocking when the state is unknown... except it still blocks, because an
  // unknown state cannot be assessed either way.
  if (!leadState) {
    return {
      allowed: false,
      announcementRequired: true,
      affirmativeConsentRequired: true,
      status: "blocked",
      mandatory: false,
      reason:
        "No state on file for this business, so the law that applies is unknown. Recording is blocked rather than guessed.",
      policyApplied: policy,
    };
  }
  if (isAllPartyState(leadState)) {
    return {
      allowed: true,
      announcementRequired: true,
      affirmativeConsentRequired: true,
      status: "pending",
      mandatory: false,
      reason: `${leadState} requires everyone on the call to consent.`,
      policyApplied: policy,
    };
  }
  return {
    allowed: true,
    announcementRequired: false,
    affirmativeConsentRequired: false,
    status: "not_required",
    // Lawful, and there is nobody to ask. See the note on `mandatory`.
    mandatory: true,
    reason: `${leadState} allows one-party consent.`,
    policyApplied: policy,
  };
}

/** May a recording actually begin, given what consent was captured? */
export function mayStartRecording(
  decision: ConsentDecision,
  capturedConsent: "granted" | "refused" | "pending" | "not_required" | null
): { start: boolean; reason: string } {
  if (!decision.allowed) return { start: false, reason: decision.reason };
  if (capturedConsent === "refused") {
    return { start: false, reason: "The prospect refused to be recorded." };
  }
  if (decision.affirmativeConsentRequired && capturedConsent !== "granted") {
    return {
      start: false,
      reason: "Waiting for the prospect to agree to being recorded.",
    };
  }
  return { start: true, reason: decision.reason };
}

/** How long a recording may be kept, from the settings. */
export function retentionExpiry(createdAt: Date, retentionDays: number): Date {
  const d = new Date(createdAt);
  d.setDate(d.getDate() + Math.max(1, retentionDays));
  return d;
}

/* -------------------------------------------------------------------------- */
/* the dial gate                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Whether the number may be dialled yet.
 *
 * The brief was "recording has to be mandatory so they cannot call until the
 * mic is on". This is that rule, and it is deliberately narrow: it blocks ONLY
 * where recording is required, which is only where recording is lawful on the
 * caller's consent alone.
 *
 * Two things it must never do, because either would be worse than the problem
 * it solves:
 *
 *   It must never block a call it cannot record. In the fourteen all-party
 *   states recording is refused outright — gating the dial on a recording that
 *   is never going to start would leave a caller stuck on a lead they can
 *   neither ring nor get past. Those calls go ahead unrecorded, labelled.
 *
 *   It must never block when recording is switched off for the whole
 *   deployment. Turning the feature off must not stop the phones.
 *
 * `capturing` is whether audio is genuinely being taken right now — not
 * whether a button was pressed, and not whether permission was granted. A
 * microphone that is permitted but silent is the failure this exists to catch.
 */
export type DialGate = { blocked: boolean; reason: string };

export function dialGate(input: {
  decision: ConsentDecision;
  capturing: boolean;
}): DialGate {
  const { decision, capturing } = input;

  if (!decision.mandatory) {
    return {
      blocked: false,
      reason: decision.allowed
        ? ""
        : `Not recorded — ${decision.reason} You can still make the call.`,
    };
  }
  if (capturing) return { blocked: false, reason: "" };

  return {
    blocked: true,
    reason:
      "Start the recording before you dial. " +
      "This call is recordable and every recordable call gets recorded.",
  };
}

/**
 * The label for the lead, so a caller knows which kind of call this is before
 * they pick the phone up rather than after.
 */
export function recordabilityLabel(decision: ConsentDecision): string {
  if (decision.mandatory) return "RECORDED";
  if (!decision.allowed) return "NOT RECORDABLE";
  if (decision.affirmativeConsentRequired) return "ASK FIRST";
  return "OPTIONAL";
}
