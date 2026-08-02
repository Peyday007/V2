// The direct-number waterfall, and the budget that stops it.
//
// Pure. Providers are passed in, so provider failure, budget exhaustion and
// confidence gating are all testable without a network or a bill.
//
// Three rules the waterfall never breaks:
//
//   Stop at the first sufficiently confident direct number. Every further
//   provider costs money for an answer already in hand.
//
//   Never spend past a cap. A runaway enrichment loop is the one bug in this
//   feature that costs real money, so the check happens BEFORE each call, not
//   after, and a provider that would exceed the per-lead cap is not tried.
//
//   Never return the main business number. That is the failure this whole
//   pipeline exists to prevent, and it is checked again here even though each
//   adapter also filters it.

import {
  classifyNumber,
  isDirectOwnerLine,
  PHONE_CLASS_RANK,
  toE164,
  type PhoneClass,
} from "./phoneIntel";
import {
  MIN_USABLE_CONFIDENCE,
  STOP_AT_CONFIDENCE,
  type ContactProvider,
  type LookupResult,
  type LookupSubject,
} from "./contactProviders/types";

/* -------------------------------------------------------------------------- */
/* budget                                                                     */
/* -------------------------------------------------------------------------- */

export type BudgetLimits = {
  /** Hard ceiling for one lead, in cents. */
  maxCostPerLeadCents: number;
  /** Providers tried for one lead, however cheap. */
  maxProviderAttempts: number;
  /** Whole-month ceiling, in cents. */
  monthlyBudgetCents: number;
  /** One enrichment run's ceiling, in cents. */
  perRunBudgetCents: number;
  /** Below this, a provider result is not stored at all. */
  minConfidence: number;
  /** Re-enrich only after this many days. */
  dataExpiryDays: number;
  /** Attempts before a lead is left alone. */
  maxRetries: number;
};

export const DEFAULT_LIMITS: BudgetLimits = {
  maxCostPerLeadCents: 50,
  maxProviderAttempts: 2,
  monthlyBudgetCents: 25_000,
  perRunBudgetCents: 5_000,
  minConfidence: MIN_USABLE_CONFIDENCE,
  dataExpiryDays: 90,
  maxRetries: 2,
};

export type Spend = {
  monthToDateCents: number;
  thisRunCents: number;
};

export type BudgetVerdict = { allowed: boolean; reason?: string };

/**
 * Checked before every paid call. A provider whose cost would breach a cap is
 * not tried at all — stopping after the spend is not stopping.
 */
export function maySpend(
  provider: Pick<ContactProvider, "costPerHitCents" | "label">,
  spentOnLeadCents: number,
  spend: Spend,
  limits: BudgetLimits
): BudgetVerdict {
  const cost = provider.costPerHitCents;
  if (spentOnLeadCents + cost > limits.maxCostPerLeadCents) {
    return {
      allowed: false,
      reason: `${provider.label} would take this lead past the ${limits.maxCostPerLeadCents}c per-lead cap.`,
    };
  }
  if (spend.thisRunCents + cost > limits.perRunBudgetCents) {
    return { allowed: false, reason: "This run has reached its budget." };
  }
  if (spend.monthToDateCents + cost > limits.monthlyBudgetCents) {
    return { allowed: false, reason: "The monthly enrichment budget is spent." };
  }
  return { allowed: true };
}

/* -------------------------------------------------------------------------- */
/* re-enrichment                                                              */
/* -------------------------------------------------------------------------- */

export type RefreshReason =
  | "never_enriched"
  | "expired"
  | "caller_reported_wrong"
  | "business_changed"
  | "admin_requested"
  | "new_provider_available";

export type RefreshInput = {
  enrichedAt: string | null;
  attempts: number;
  callerReportedWrong: boolean;
  businessChangedAt: string | null;
  adminRequested: boolean;
  newProviderSince: string | null;
  limits: BudgetLimits;
  now?: Date;
};

/**
 * Paying twice for an unchanged record is the easiest money to waste, so
 * re-enrichment needs a named reason.
 */
export function shouldReEnrich(
  input: RefreshInput
): { yes: boolean; reason: RefreshReason | null; detail: string } {
  const now = input.now ?? new Date();

  if (!input.enrichedAt) {
    return { yes: true, reason: "never_enriched", detail: "This lead has never been enriched." };
  }
  if (input.attempts >= input.limits.maxRetries + 1 && !input.adminRequested) {
    return {
      yes: false,
      reason: null,
      detail: `Already tried ${input.attempts} times; the retry limit is ${input.limits.maxRetries}.`,
    };
  }
  // A caller who reached the wrong person is the strongest signal there is.
  if (input.callerReportedWrong) {
    return {
      yes: true,
      reason: "caller_reported_wrong",
      detail: "A caller reported the contact details as wrong.",
    };
  }
  if (input.adminRequested) {
    return { yes: true, reason: "admin_requested", detail: "An admin asked for a refresh." };
  }
  if (input.businessChangedAt && Date.parse(input.businessChangedAt) > Date.parse(input.enrichedAt)) {
    return {
      yes: true,
      reason: "business_changed",
      detail: "The business record changed after the last enrichment.",
    };
  }
  if (input.newProviderSince && Date.parse(input.newProviderSince) > Date.parse(input.enrichedAt)) {
    return {
      yes: true,
      reason: "new_provider_available",
      detail: "A provider was added after the last attempt.",
    };
  }

  const ageDays = (now.getTime() - Date.parse(input.enrichedAt)) / 86_400_000;
  if (ageDays >= input.limits.dataExpiryDays) {
    return {
      yes: true,
      reason: "expired",
      detail: `Last enriched ${Math.round(ageDays)} days ago; data expires at ${input.limits.dataExpiryDays}.`,
    };
  }
  return {
    yes: false,
    reason: null,
    detail: `Enriched ${Math.round(ageDays)} days ago and nothing has changed.`,
  };
}

/* -------------------------------------------------------------------------- */
/* the waterfall                                                              */
/* -------------------------------------------------------------------------- */

export type WaterfallAttempt = {
  provider: string;
  tried: boolean;
  skippedReason?: string;
  error?: string;
  phonesReturned: number;
  costCents: number;
};

export type WaterfallOutcome = {
  /** The best direct number found, or null. */
  phone: string | null;
  phoneClass: PhoneClass;
  lineType: string;
  confidence: number;
  provider: string | null;
  sourceRef: string | null;
  validatedAt: string | null;
  reason: string;
  email: string | null;
  profileUrl: string | null;
  attempts: WaterfallAttempt[];
  totalCostCents: number;
  /** True when a cap ended the search rather than the providers doing so. */
  stoppedByBudget: boolean;
};

export type WaterfallInput = {
  subject: LookupSubject;
  providers: ContactProvider[];
  spend: Spend;
  limits: BudgetLimits;
  /** Numbers other sources already gave for this person, to spot conflicts. */
  knownNumbers?: string[];
};

export async function runWaterfall(input: WaterfallInput): Promise<WaterfallOutcome> {
  const { subject, providers, spend, limits } = input;
  const attempts: WaterfallAttempt[] = [];
  let spentOnLead = 0;
  let stoppedByBudget = false;

  let best: {
    phone: string;
    phoneClass: PhoneClass;
    lineType: string;
    confidence: number;
    provider: string;
    sourceRef: string | null;
    reason: string;
  } | null = null;
  let email: string | null = null;
  let profileUrl: string | null = null;

  const known = new Set((input.knownNumbers || []).map((n) => toE164(n)).filter(Boolean) as string[]);

  for (const provider of providers) {
    if (attempts.filter((a) => a.tried).length >= limits.maxProviderAttempts) {
      attempts.push({
        provider: provider.key,
        tried: false,
        skippedReason: `Provider-attempt limit of ${limits.maxProviderAttempts} reached.`,
        phonesReturned: 0,
        costCents: 0,
      });
      break;
    }

    if (!provider.isAvailable()) {
      attempts.push({
        provider: provider.key,
        tried: false,
        skippedReason: provider.unavailableReason() ?? "Not configured.",
        phonesReturned: 0,
        costCents: 0,
      });
      continue;
    }

    // Checked BEFORE the call. Stopping after the spend is not stopping.
    const verdict = maySpend(provider, spentOnLead, spend, limits);
    if (!verdict.allowed) {
      stoppedByBudget = true;
      attempts.push({
        provider: provider.key,
        tried: false,
        skippedReason: verdict.reason,
        phonesReturned: 0,
        costCents: 0,
      });
      break;
    }

    let result: LookupResult;
    try {
      result = await provider.lookup(subject);
    } catch (e) {
      // A provider throwing must not end the waterfall — the next one may work.
      attempts.push({
        provider: provider.key,
        tried: true,
        error: e instanceof Error ? e.message : String(e),
        phonesReturned: 0,
        costCents: 0,
      });
      continue;
    }

    spentOnLead += result.costCents;
    spend.thisRunCents += result.costCents;
    spend.monthToDateCents += result.costCents;

    attempts.push({
      provider: provider.key,
      tried: !result.skipped,
      skippedReason: result.skipped,
      error: result.error,
      phonesReturned: result.phones.length,
      costCents: result.costCents,
    });

    if (!email && result.email) email = result.email;
    if (!profileUrl && result.profileUrl) profileUrl = result.profileUrl;

    for (const p of result.phones) {
      if (p.confidence < limits.minConfidence) continue;

      const conflicting = known.size > 0 && !known.has(p.phone);
      const classification = classifyNumber({
        candidate: p.phone,
        mainBusinessPhone: subject.mainBusinessPhone,
        lineType: p.lineType,
        confidence: p.confidence,
        providerVerified: p.providerVerified,
        // The provider matched on name plus company domain; the identity link
        // is the provider's claim, recorded as such.
        identityMatched: true,
        conflicting,
      });
      if (!classification.usable || !isDirectOwnerLine(classification.phoneClass)) continue;

      const better =
        !best ||
        PHONE_CLASS_RANK[classification.phoneClass] < PHONE_CLASS_RANK[best.phoneClass] ||
        (PHONE_CLASS_RANK[classification.phoneClass] === PHONE_CLASS_RANK[best.phoneClass] &&
          p.confidence > best.confidence);

      if (better) {
        best = {
          phone: p.phone,
          phoneClass: classification.phoneClass,
          lineType: p.lineType,
          confidence: p.confidence,
          provider: result.provider,
          sourceRef: p.sourceRef,
          reason: classification.reason,
        };
      }
    }

    // Good enough. Every further provider is money for an answer already held.
    if (best && best.confidence >= STOP_AT_CONFIDENCE) break;
  }

  const totalCostCents = attempts.reduce((n, a) => n + a.costCents, 0);

  if (!best) {
    return {
      phone: null,
      phoneClass: "unknown",
      lineType: "unknown",
      confidence: 0,
      provider: null,
      sourceRef: null,
      validatedAt: null,
      reason: stoppedByBudget
        ? "Stopped before finding a direct number: the enrichment budget was reached."
        : attempts.some((a) => a.tried)
          ? "No provider returned a usable direct number for this person."
          : "No contact provider was available to ask.",
      email,
      profileUrl,
      attempts,
      totalCostCents,
      stoppedByBudget,
    };
  }

  return {
    phone: best.phone,
    phoneClass: best.phoneClass,
    lineType: best.lineType,
    confidence: best.confidence,
    provider: best.provider,
    sourceRef: best.sourceRef,
    validatedAt: new Date().toISOString(),
    reason: best.reason,
    email,
    profileUrl,
    attempts,
    totalCostCents,
    stoppedByBudget,
  };
}
