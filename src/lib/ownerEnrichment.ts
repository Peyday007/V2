// The enrichment pipeline, end to end, for one lead.
//
//   Google business record
//     -> owner identification   (public sources, already built: ./sources)
//     -> direct-number discovery (contact providers, waterfall, budgeted)
//     -> validation             (./phoneIntel)
//     -> grading                (./enrichmentGrade)
//     -> caller assignment      (only A and B)
//
// The rules live in the pure modules above; this is the I/O around them. Every
// stage records what it attempted and what it cost, including the attempts
// that found nothing — cost per successful number is a lie without the misses
// in the denominator.

import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";
import { recordEvent } from "./events";
import { SOURCES, STOP_CONFIDENCE } from "./sources";
import { bestEmail, matchesOwnerName, type EmailCandidate } from "./extractEmails";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  selectDecisionMaker,
  type Candidate,
  type MatchContext,
} from "./decisionMaker";
import { availableProviders } from "./contactProviders";
import { runWaterfall, DEFAULT_LIMITS, shouldReEnrich, type BudgetLimits, type Spend } from "./directNumber";
import { classifyNumber, toE164 } from "./phoneIntel";
import { gradeLead } from "./enrichmentGrade";
import { nextState, type EnrichmentState } from "./enrichmentState";

export type EnrichOutcome = {
  leadId: string;
  state: EnrichmentState;
  grade: string | null;
  costCents: number;
  skipped?: string;
};

function period(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function loadLimits(): Promise<{ limits: BudgetLimits; enabled: boolean }> {
  try {
    const { data } = await supabaseAdmin()
      .from("enrichment_settings")
      .select(
        "enabled, max_cost_per_lead_cents, max_provider_attempts, monthly_budget_cents, per_run_budget_cents, min_confidence, data_expiry_days, max_retries"
      )
      .eq("id", true)
      .maybeSingle();
    if (!data) return { limits: DEFAULT_LIMITS, enabled: false };
    return {
      enabled: !!data.enabled,
      limits: {
        maxCostPerLeadCents: Number(data.max_cost_per_lead_cents) || DEFAULT_LIMITS.maxCostPerLeadCents,
        maxProviderAttempts: Number(data.max_provider_attempts) || DEFAULT_LIMITS.maxProviderAttempts,
        monthlyBudgetCents: Number(data.monthly_budget_cents) || DEFAULT_LIMITS.monthlyBudgetCents,
        perRunBudgetCents: Number(data.per_run_budget_cents) || DEFAULT_LIMITS.perRunBudgetCents,
        minConfidence: Number(data.min_confidence) || DEFAULT_LIMITS.minConfidence,
        dataExpiryDays: Number(data.data_expiry_days) || DEFAULT_LIMITS.dataExpiryDays,
        maxRetries: Number(data.max_retries) || DEFAULT_LIMITS.maxRetries,
      },
    };
  } catch {
    // Unreadable settings mean no paid calls. Spending money off a default
    // nobody chose is the wrong way to fail.
    return { limits: DEFAULT_LIMITS, enabled: false };
  }
}

export async function monthToDateSpend(): Promise<number> {
  try {
    const { data } = await supabaseAdmin()
      .from("enrichment_spend")
      .select("cents")
      .eq("period", period())
      .maybeSingle();
    return Number(data?.cents) || 0;
  } catch {
    // Unknown spend is treated as the cap being reached, not as zero.
    return Number.MAX_SAFE_INTEGER;
  }
}

async function addSpend(cents: number, lookups: number, hits: number): Promise<void> {
  if (cents === 0 && lookups === 0) return;
  const db = supabaseAdmin();
  const p = period();
  const { data: existing } = await db
    .from("enrichment_spend")
    .select("cents, lookups, hits")
    .eq("period", p)
    .maybeSingle();
  await db.from("enrichment_spend").upsert(
    {
      period: p,
      cents: (existing?.cents ?? 0) + cents,
      lookups: (existing?.lookups ?? 0) + lookups,
      hits: (existing?.hits ?? 0) + hits,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "period" }
  );
}

/* -------------------------------------------------------------------------- */
/* stage 1 — who is the decision-maker                                        */
/* -------------------------------------------------------------------------- */

type LeadRow = {
  id: string;
  business_name: string;
  phone: string | null;
  main_business_phone: string | null;
  website: string | null;
  domain: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  industry: string | null;
  owner_name: string | null;
  owner_title: string | null;
  owner_email: string | null;
  decision_maker_name: string | null;
  decision_maker_confidence: number | null;
  direct_phone: string | null;
  enriched_at: string | null;
  enrichment_attempts: number;
  contact_reported_wrong_at: string | null;
  updated_at: string | null;
};

/** Collect candidates from the public-source waterfall already in the app. */
async function identifyOwner(
  lead: LeadRow
): Promise<{ candidates: Candidate[]; sourcesUsed: string[]; emails: EmailCandidate[] }> {
  const candidates: Candidate[] = [];
  const sourcesUsed: string[] = [];
  const emails: EmailCandidate[] = [];

  // Anything a caller already told us outranks anything scraped.
  if (lead.owner_name) {
    candidates.push({
      name: lead.owner_name,
      title: lead.owner_title,
      sourceUrl: null,
      supportingText: `Recorded on the lead by a caller or an earlier run at ${lead.business_name}`,
      method: "internal",
      confidence: 0.9,
    });
    sourcesUsed.push("internal");
  }

  const ctx = {
    leadId: lead.id,
    businessName: lead.business_name,
    website: lead.website,
    domain: lead.domain,
    city: lead.city,
    state: lead.state,
    industry: lead.industry,
  };

  for (const source of SOURCES) {
    if (!source.isAvailable()) continue;
    sourcesUsed.push(source.key);
    try {
      const result = await source.run(ctx);
      // Addresses are kept even from a source that skipped on the name: a
      // crawl that found an email and no owner is still a lead we can email.
      if (result.emails?.length) emails.push(...result.emails);
      if (result.skipped) continue;
      for (const f of result.findings) {
        candidates.push({
          name: f.name,
          title: f.title,
          sourceUrl: f.sourceUrl,
          supportingText: f.supportingText,
          method: f.method,
          confidence: f.confidence,
        });
      }
      // Stop paying attention once something is convincing enough.
      if (candidates.some((c) => c.confidence >= STOP_CONFIDENCE)) break;
    } catch (e) {
      console.error(`[enrich] owner source ${source.key} threw:`, e);
    }
  }

  return { candidates, sourcesUsed, emails };
}

/**
 * Write down the best email the crawl saw, with where it came from.
 *
 * Two rules, both of which are the standing ones written out for this case:
 *
 *   NOTHING IS OVERWRITTEN SILENTLY. The scraped address goes in its own
 *   columns. `owner_email` is only filled when it is empty, so an address a
 *   caller typed in after speaking to somebody always wins over one a regex
 *   found in a footer.
 *
 *   ATTRIBUTION IS KEPT. The source URL and the retrieval date are stored
 *   alongside the address, and the evidence row records the text it sat in.
 *
 * Never throws. This is a bonus on top of owner enrichment; a failure to
 * record an email must not fail the enrichment run that found the owner.
 */
async function persistWebsiteEmail(
  db: SupabaseClient,
  leadId: string,
  row: LeadRow,
  seen: EmailCandidate[],
  ownerName: string | null
): Promise<void> {
  if (seen.length === 0) return;
  try {
    // Re-score now that the owner's name is known: maria@ is worth much more
    // than info@ once we know the owner is Maria, and that was not knowable
    // while the pages were being read.
    const rescored = ownerName
      ? seen.map((c) =>
          matchesOwnerName(c.email.slice(0, c.email.indexOf("@")), ownerName)
            ? { ...c, kind: "personal" as const, confidence: Math.min(0.98, c.confidence + 0.2) }
            : c
        )
      : seen;

    const best = bestEmail(rescored);
    if (!best) return;

    const patch: Record<string, unknown> = {
      website_email: best.email,
      website_email_kind: best.kind,
      website_email_source_url: best.sourceUrl,
      website_email_confidence: best.confidence,
      website_email_found_at: new Date().toISOString(),
    };
    // Only when there is nothing there already.
    if (!row.owner_email) patch.owner_email = best.email;

    await db.from("leads").update(patch).eq("id", leadId);

    await db
      .from("enrichment_evidence")
      .insert({
        lead_id: leadId,
        source_type: "website",
        source_url: best.sourceUrl,
        field: "email",
        value: best.email,
        supporting_text: best.supportingText.slice(0, 900),
        extraction_method: best.onDomain ? "mailto_on_domain" : "mailto_off_domain",
        confidence: best.confidence,
        is_conflicting: !!row.owner_email && row.owner_email !== best.email,
      })
      .then(undefined, () => {});

    await recordEvent({
      type: "lead.enriched",
      entityType: "lead",
      entityId: leadId,
      leadId,
      actorType: "worker",
      source: "worker",
      newValue: { email: best.email, kind: best.kind },
      metadata: {
        field: "email",
        source_url: best.sourceUrl,
        on_domain: best.onDomain,
        kept_existing_owner_email: !!row.owner_email,
      },
      confidence: best.confidence,
      verificationStatus: "unverified",
    });
  } catch (e) {
    console.error("[enrich] could not record the website email:", e);
  }
}

/* -------------------------------------------------------------------------- */
/* the whole thing                                                            */
/* -------------------------------------------------------------------------- */

export async function enrichLeadForOwner(
  leadId: string,
  opts: { adminRequested?: boolean; runSpend?: Spend } = {}
): Promise<EnrichOutcome> {
  const db = supabaseAdmin();
  const { limits, enabled } = await loadLimits();

  const { data: lead } = await db
    .from("leads")
    .select(
      "id, business_name, phone, main_business_phone, website, domain, address, city, state, industry, owner_name, owner_title, owner_email, decision_maker_name, decision_maker_confidence, direct_phone, enriched_at, enrichment_attempts, contact_reported_wrong_at, updated_at"
    )
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { leadId, state: "manual_review", grade: null, costCents: 0, skipped: "no such lead" };

  const row = lead as LeadRow;
  const mainPhone = row.main_business_phone || row.phone;

  // Do not pay twice for a record that has not changed.
  const refresh = shouldReEnrich({
    enrichedAt: row.enriched_at,
    attempts: row.enrichment_attempts ?? 0,
    callerReportedWrong: !!row.contact_reported_wrong_at,
    businessChangedAt: row.updated_at,
    adminRequested: !!opts.adminRequested,
    newProviderSince: null,
    limits,
  });
  if (!refresh.yes) {
    return { leadId, state: "call_ready", grade: null, costCents: 0, skipped: refresh.detail };
  }

  await db
    .from("leads")
    .update({
      enrichment_state: "pending_owner_identification",
      main_business_phone: mainPhone,
      enrichment_attempts: (row.enrichment_attempts ?? 0) + 1,
      enrichment_error: null,
    })
    .eq("id", leadId);

  /* ------------------------- stage 1: the person ------------------------- */
  const { candidates, sourcesUsed, emails: seenEmails } = await identifyOwner(row);
  const matchCtx: MatchContext = {
    businessName: row.business_name,
    domain: row.domain,
    city: row.city,
    state: row.state,
  };
  const selection = selectDecisionMaker(candidates, matchCtx);

  /*
   * Store the email before anything else can return.
   *
   * Deliberately here, above every branch below. An earlier version of this
   * function had a path that returned without setting machine_status, and
   * leads sat stuck forever because of it — so anything that must happen on
   * EVERY path happens before the branching starts, not in each arm of it.
   */
  await persistWebsiteEmail(db, leadId, row, seenEmails, selection.chosen ? selection.name : null);

  for (const c of candidates) {
    await db.from("enrichment_evidence").insert({
      lead_id: leadId,
      source_type: c.method,
      source_url: c.sourceUrl,
      field: "decision_maker_name",
      value: c.name,
      supporting_text: `${c.title ?? "no title"} — ${c.supportingText}`.slice(0, 900),
      extraction_method: c.method,
      confidence: c.confidence,
      is_conflicting:
        selection.chosen && c.name.toLowerCase() !== selection.name.toLowerCase(),
    }).then(undefined, () => {});
  }

  if (!selection.chosen) {
    // Ambiguity and absence are different problems with different fixes.
    const ambiguous = candidates.length > 0;
    const state = nextState({
      ownerIdentified: false,
      ambiguous,
      conflicting: false,
      directNumberFound: false,
      numberValidated: false,
      providerAvailable: availableProviders().length > 0,
      budgetStopped: false,
    });
    const graded = gradeLead({
      decisionMakerName: null,
      decisionMakerConfidence: 0,
      phoneClass: "main_business_line",
      directPhone: null,
    });
    await db
      .from("leads")
      .update({
        enrichment_state: state,
        enrichment_grade: graded.grade,
        enrichment_grade_reason: graded.reason,
        enrichment_sources: sourcesUsed,
        enriched_at: new Date().toISOString(),
        enrichment_error: selection.reason,
        /*
         * Callable. Not knowing the owner's name is the situation this whole
         * business started in — you ring the main line and ask for them.
         *
         * This line was missing entirely, so a lead nobody could name a
         * decision-maker for sat on machine_status 'enriching' forever and was
         * never handed to anybody. Silently, and for most of the batch.
         */
        machine_status: "ready_for_calling",
      })
      .eq("id", leadId);
    await recordEvent({
      type: "lead.enrichment_failed",
      entityType: "lead",
      entityId: leadId,
      leadId,
      actorType: "worker",
      source: "worker",
      newValue: { enrichment_state: state, grade: graded.grade },
      metadata: { reason: selection.reason, considered: selection.considered },
    });
    return { leadId, state, grade: graded.grade, costCents: 0 };
  }

  await db
    .from("leads")
    .update({
      enrichment_state: "owner_identified",
      decision_maker_name: selection.name,
      decision_maker_first_name: selection.firstName,
      decision_maker_last_name: selection.lastName,
      decision_maker_title: selection.title,
      decision_maker_role: selection.role,
      decision_maker_confidence: selection.confidence,
      decision_maker_source_url: selection.sourceUrl,
      decision_maker_evidence: `${selection.evidence} [${selection.signals.join("; ")}]`.slice(0, 900),
    })
    .eq("id", leadId);

  await recordEvent({
    type: "lead.decision_maker_found",
    entityType: "lead",
    entityId: leadId,
    leadId,
    actorType: "worker",
    source: "worker",
    newValue: { name: selection.name, title: selection.title, role: selection.role },
    metadata: { source_url: selection.sourceUrl, signals: selection.signals },
    confidence: selection.confidence,
    verificationStatus: "verified",
  });

  /* --------------------- stage 2: the direct number ---------------------- */
  const providers = availableProviders();
  const spend: Spend = opts.runSpend ?? { monthToDateCents: await monthToDateSpend(), thisRunCents: 0 };

  let waterfall = null as Awaited<ReturnType<typeof runWaterfall>> | null;

  if (enabled && providers.length > 0) {
    await db.from("leads").update({ enrichment_state: "pending_direct_number" }).eq("id", leadId);
    waterfall = await runWaterfall({
      subject: {
        leadId,
        fullName: selection.name,
        firstName: selection.firstName,
        lastName: selection.lastName,
        title: selection.title,
        businessName: row.business_name,
        domain: row.domain,
        city: row.city,
        state: row.state,
        address: row.address,
        email: row.owner_email,
        profileUrl: null,
        mainBusinessPhone: mainPhone,
      },
      providers,
      spend,
      limits,
    });

    for (const a of waterfall.attempts) {
      await db.from("enrichment_attempts").insert({
        lead_id: leadId,
        stage: "direct_number",
        provider: a.provider,
        attempted: a.tried,
        skipped_reason: a.skippedReason ?? null,
        error: a.error ?? null,
        phones_returned: a.phonesReturned,
        accepted: !!waterfall && waterfall.provider === a.provider && !!waterfall.phone,
        cost_cents: a.costCents,
      }).then(undefined, () => {});
    }

    await addSpend(
      waterfall.totalCostCents,
      waterfall.attempts.filter((a) => a.tried).length,
      waterfall.phone ? 1 : 0
    );
  }

  /* ------------------------ stage 3: validation -------------------------- */
  let validated = false;
  let phoneClass = "main_business_line" as ReturnType<typeof classifyNumber>["phoneClass"];

  if (waterfall?.phone) {
    // Re-run the classification here rather than trusting the waterfall's:
    // validation is the gate that keeps the switchboard out, and a gate that
    // trusts its input is not a gate.
    const check = classifyNumber({
      candidate: waterfall.phone,
      mainBusinessPhone: mainPhone,
      lineType: waterfall.lineType as never,
      confidence: waterfall.confidence,
      providerVerified: waterfall.phoneClass.startsWith("verified"),
      identityMatched: true,
    });
    phoneClass = check.phoneClass;
    validated = check.usable;

    await db
      .from("leads")
      .update({
        enrichment_state: validated ? "direct_number_validated" : "validation_failed",
        direct_phone: validated ? toE164(waterfall.phone) : null,
        direct_phone_type: waterfall.lineType,
        direct_phone_class: check.phoneClass,
        direct_phone_confidence: waterfall.confidence,
        direct_phone_provider: waterfall.provider,
        direct_phone_source: waterfall.sourceRef,
        direct_phone_validated_at: validated ? new Date().toISOString() : null,
        direct_email: waterfall.email,
        professional_profile_url: waterfall.profileUrl,
      })
      .eq("id", leadId);
  }

  /* -------------------------- stage 4: grading --------------------------- */
  const graded = gradeLead({
    decisionMakerName: selection.name,
    decisionMakerConfidence: selection.confidence,
    phoneClass,
    directPhone: validated ? waterfall?.phone : null,
  });

  const state = nextState({
    ownerIdentified: true,
    ambiguous: false,
    conflicting: false,
    directNumberFound: !!waterfall?.phone,
    numberValidated: validated,
    providerAvailable: providers.length > 0 && enabled,
    budgetStopped: !!waterfall?.stoppedByBudget,
  });

  const costCents = waterfall?.totalCostCents ?? 0;

  await db
    .from("leads")
    .update({
      enrichment_state: state,
      enrichment_grade: graded.grade,
      enrichment_grade_reason: graded.reason,
      enrichment_sources: [...sourcesUsed, ...(waterfall?.attempts.map((a) => a.provider) ?? [])],
      enrichment_cost_cents: costCents,
      enriched_at: new Date().toISOString(),
      enrichment_error: waterfall && !waterfall.phone ? waterfall.reason : null,
      contact_reported_wrong_at: null,
      /*
       * Always callable once enrichment has finished with it.
       *
       * This used to be `graded.callReady ? ready_for_calling :
       * enrichment_failed`, which marked every lead without a provider-supplied
       * direct number as "discarded — not worth calling". Without a contact
       * provider configured that is every lead, so the entire queue emptied
       * itself. A C grade means "we know who to ask for but not their mobile",
       * which is a perfectly good main-line lead and always was.
       *
       * The grade still decides ORDER — see orderLeadsForAssignment — so a
       * direct number gets called first when one exists.
       */
      machine_status: "ready_for_calling",
      enrichment_confidence: selection.confidence,
      recommended_ask: graded.callReady
        ? `Ask for ${selection.name}${selection.title ? `, the ${selection.title.toLowerCase()}` : ""} — dialling their direct number.`
        : `No direct number. Call the main line and ask for ${selection.name}.`,
    })
    .eq("id", leadId);

  await recordEvent({
    type: "lead.enriched",
    entityType: "lead",
    entityId: leadId,
    leadId,
    actorType: "worker",
    source: "worker",
    newValue: { enrichment_state: state, grade: graded.grade, call_ready: graded.callReady },
    metadata: {
      decision_maker: selection.name,
      phone_class: phoneClass,
      provider: waterfall?.provider ?? null,
      cost_cents: costCents,
    },
    confidence: selection.confidence,
  });

  return { leadId, state, grade: graded.grade, costCents };
}
