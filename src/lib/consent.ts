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
   * True only where a single party's consent is legally sufficient AND the
   * policy has been set to skip two-party states entirely. There is nothing
   * for the caller to decide in that situation: no announcement to read, no
   * agreement to capture, no judgement call. So the recorder starts itself
   * rather than waiting for somebody to remember.
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
      mandatory: false,
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
    mandatory: false,
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
