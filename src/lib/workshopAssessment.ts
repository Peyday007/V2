import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";
import { recordEvent } from "./events";
import { diagnose, type DiagnosticInput } from "./diagnostic";
import { opportunitiesFromFindings } from "./opportunityBuilder";
import {
  rankOpportunities,
  stripAllInternal,
  type Opportunity,
  type PublicOpportunity,
} from "./opportunityModel";
import {
  buildOpportunityMap,
  type BottleneckAnswer,
  type MappedOpportunity,
} from "./bottleneckAudit";
import {
  advanceStatus,
  variantForToken,
  VARIANT_CONFIG,
  idempotencyKeyFor,
  needsAttention,
  nextAction,
  EVENT_STATUS,
  type WorkshopEvent,
  type WorkshopStatus,
  type WorkshopVariant,
} from "./workshopLifecycle";

// The database-touching half of the assessment.
//
// Everything that decides anything lives in the pure modules — the opportunity
// model, the bottleneck map, the lifecycle. This file reads rows, writes rows,
// and is careful about exactly two things:
//
//   1. NOTHING INTERNAL REACHES A PUBLIC RESPONSE. Not hidden by a component,
//      absent from the payload. There is one function that builds the public
//      shape and it goes through stripAllInternal.
//
//   2. A TOKEN SEES ONE WORKSHOP. Every public read is keyed by token and
//      scoped to that packet's id. There is no code path where a token
//      parameter selects rows belonging to a different packet.

/* -------------------------------------------------------------------------- */

const PACKET_COLUMNS =
  "id, lead_id, token, status, variant, packet_version, owner_name, owner_phone, owner_email, " +
  "preferred_contact, created_at, sent_at, first_opened_at, last_seen_at, interested_at, " +
  "demo_requested_at, walkthrough_requested_at, walkthrough_kind, walkthrough_scheduled_at, " +
  "live_change_approved_at, converted_at, trial_requested_at, operator_note, next_action, " +
  "follow_up_done_at, acknowledged_at";

const LEAD_COLUMNS =
  "id, business_name, city, state, industry, website, rating, review_count, answering_setup, " +
  "owner_name, decision_maker_name, diagnostic_findings";

/**
 * Older deployments have not run 0045. Rather than 500 the public page — the
 * one screen a member of the public sees — the read steps down to the columns
 * that have always existed and the new experience degrades to the old shape.
 */
function isMissingColumn(e: { message?: string } | null): boolean {
  return !!e?.message && /column .* does not exist|schema cache/i.test(e.message);
}

export type PublicAssessment = {
  businessName: string;
  market: string;
  researchedLine: string;
  headline: string;
  variant: WorkshopVariant;
  config: (typeof VARIANT_CONFIG)[WorkshopVariant];
  primary: PublicOpportunity | null;
  supporting: PublicOpportunity[];
  contact: { name: string; email: string; phone: string };
  status: WorkshopStatus;
  /** Interest already registered. Drives the "we have this" state, not a lock. */
  alreadyInterested: boolean;
  bottleneck: BottleneckAnswer[];
  auditComplete: boolean;
  map: MappedOpportunity[];
};

/* -------------------------------------------------------------------------- */
/* generating the findings                                                    */
/* -------------------------------------------------------------------------- */

function diagnosticInputFor(lead: Record<string, unknown>): DiagnosticInput {
  return {
    businessName: String(lead.business_name ?? "this business"),
    city: (lead.city as string) ?? null,
    state: (lead.state as string) ?? null,
    industry: (lead.industry as string) ?? null,
    website: (lead.website as string) ?? null,
    rating: (lead.rating as number) ?? null,
    reviewCount: (lead.review_count as number) ?? null,
    answeringSetup: (lead.answering_setup as string) ?? null,
  };
}

/**
 * The findings for a packet, frozen the first time they are asked for.
 *
 * Frozen matters. A rating moves, a review count grows, a website gets
 * rebuilt. An owner shown a finding in March who rings in June must be
 * answerable with what they were actually shown, not with what the same code
 * would produce today against different inputs.
 */
export async function ensureOpportunities(
  packetId: string,
  lead: Record<string, unknown>,
  limit = 3
): Promise<Opportunity[]> {
  const db = supabaseAdmin();

  const existing = await db
    .from("workshop_opportunities")
    .select("*")
    .eq("packet_id", packetId)
    .order("position", { ascending: true });

  if (!existing.error && existing.data && existing.data.length > 0) {
    return existing.data.map(rowToOpportunity);
  }
  // A missing table means 0045 has not been run. Generate in memory so the
  // page still works; the next read regenerates until the migration lands.
  const tableMissing = !!existing.error;

  const input = diagnosticInputFor(lead);
  const findings = diagnose(input);
  const built = opportunitiesFromFindings(findings, input);
  const ranked = rankOpportunities(built, limit);

  if (!tableMissing && ranked.length > 0) {
    await db
      .from("workshop_opportunities")
      .insert(
        ranked.map((o, i) => ({
          packet_id: packetId,
          stage: o.stage,
          category: o.category,
          title: o.title,
          summary: o.summary,
          evidence: o.evidence,
          source_type: o.sourceType,
          source_detail: o.sourceDetail ?? null,
          observed_at: o.observedAt,
          known_facts: o.knownFacts,
          inferences: o.inferences,
          needs_confirmation: o.needsConfirmation,
          would_verify_next: o.wouldVerifyNext,
          confidence: o.confidence,
          potential_effect: o.potentialEffect ?? null,
          demonstrable: o.demonstrable,
          demo_label: o.demoLabel ?? null,
          solution_directions: o.solutionDirections,
          custom_build_potential: o.customBuildPotential ?? null,
          rank_score: o.score,
          priority: o.priority,
          position: i,
          internal_note: o.internalNote ?? null,
        }))
      )
      .then(undefined, () => {});
  }

  return ranked;
}

function rowToOpportunity(r: Record<string, unknown>): Opportunity {
  return {
    id: String(r.id),
    stage: r.stage as Opportunity["stage"],
    category: String(r.category ?? ""),
    title: String(r.title ?? ""),
    summary: String(r.summary ?? ""),
    evidence: String(r.evidence ?? ""),
    sourceType: r.source_type as Opportunity["sourceType"],
    sourceDetail: (r.source_detail as string) ?? null,
    observedAt: String(r.observed_at ?? new Date().toISOString()),
    knownFacts: (r.known_facts as string[]) ?? [],
    inferences: (r.inferences as string[]) ?? [],
    needsConfirmation: (r.needs_confirmation as string[]) ?? [],
    wouldVerifyNext: (r.would_verify_next as string[]) ?? [],
    confidence: (r.confidence as Opportunity["confidence"]) ?? "medium",
    potentialEffect: (r.potential_effect as string) ?? null,
    demonstrable: !!r.demonstrable,
    demoLabel: (r.demo_label as string) ?? null,
    solutionDirections: (r.solution_directions as string[]) ?? [],
    customBuildPotential: (r.custom_build_potential as string) ?? null,
    priority: (r.priority as Opportunity["priority"]) ?? "supporting",
    internalNote: (r.internal_note as string) ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* reading a workshop, by token                                               */
/* -------------------------------------------------------------------------- */

export type PacketRow = Record<string, unknown>;

/** One token, one packet. Never a join that could widen. */
export async function packetByToken(
  token: string
): Promise<{ packet: PacketRow; lead: Record<string, unknown> } | null> {
  if (!token || token.length < 16) return null;
  const db = supabaseAdmin();

  let res = await db.from("workshop_packets").select(PACKET_COLUMNS).eq("token", token).maybeSingle();
  if (res.error && isMissingColumn(res.error)) {
    // Pre-0045 shape. The page degrades rather than failing.
    res = await db
      .from("workshop_packets")
      .select("id, lead_id, token, status, owner_name, owner_phone, owner_email, created_at, sent_at, trial_requested_at")
      .eq("token", token)
      .maybeSingle();
  }
  if (res.error || !res.data) return null;

  const packet = res.data as unknown as PacketRow;
  const { data: lead } = await db
    .from("leads")
    .select(LEAD_COLUMNS)
    .eq("id", packet.lead_id as string)
    .maybeSingle();
  if (!lead) return null;

  return { packet, lead: lead as unknown as Record<string, unknown> };
}

/** The bottleneck answers for THIS packet only. */
export async function bottleneckFor(packetId: string): Promise<{
  answers: BottleneckAnswer[];
  complete: boolean;
}> {
  const { data, error } = await supabaseAdmin()
    .from("workshop_bottleneck_answers")
    .select("area, detail, frequency, affects, completed")
    .eq("packet_id", packetId);
  if (error || !data) return { answers: [], complete: false };
  return {
    answers: data.map((r) => ({
      area: r.area as BottleneckAnswer["area"],
      detail: (r.detail as string) ?? null,
      frequency: (r.frequency as BottleneckAnswer["frequency"]) ?? null,
      affects: (r.affects as BottleneckAnswer["affects"]) ?? null,
    })),
    complete: data.some((r) => r.completed === true),
  };
}

/**
 * Everything the public page is allowed to know.
 *
 * THE ONE PLACE the public shape is built, so there is one place to audit. The
 * opportunities go through stripAllInternal and the operator columns
 * (operator_note, next_action, internal notes) are never read into it.
 */
export async function publicAssessment(token: string): Promise<PublicAssessment | null> {
  const found = await packetByToken(token);
  if (!found) return null;
  const { packet, lead } = found;

  const variant = (packet.variant as WorkshopVariant) || variantForToken(token);
  const config = VARIANT_CONFIG[variant] ?? VARIANT_CONFIG.control;

  const opportunities = await ensureOpportunities(
    packet.id as string,
    lead,
    config.summaryFindings
  );
  const publicOpps = stripAllInternal(opportunities);

  const bottleneck = await bottleneckFor(packet.id as string);
  const market = [lead.city, lead.state].filter(Boolean).join(", ");
  const status = (packet.status as WorkshopStatus) ?? "sent";

  return {
    businessName: String(lead.business_name ?? "your business"),
    market,
    researchedLine: `We looked at ${lead.business_name}${market ? ` in ${market}` : ""} — your listing, your website and what your customers say publicly — before writing any of this.`,
    headline: config.headline,
    variant,
    config,
    primary: publicOpps[0] ?? null,
    supporting: publicOpps.slice(1),
    contact: {
      name: String(packet.owner_name ?? ""),
      email: String(packet.owner_email ?? ""),
      phone: String(packet.owner_phone ?? ""),
    },
    status,
    alreadyInterested: status === "interested" || status === "trial_requested" ||
      ["demo_requested", "walkthrough_requested", "walkthrough_scheduled", "live_change_approved", "converted"].includes(status),
    bottleneck: bottleneck.answers,
    auditComplete: bottleneck.complete,
    map: bottleneck.complete ? buildOpportunityMap(bottleneck.answers) : [],
  };
}

/* -------------------------------------------------------------------------- */
/* writing                                                                    */
/* -------------------------------------------------------------------------- */

export type TrackInput = {
  packetId: string;
  event: WorkshopEvent;
  target?: string | null;
  metadata?: Record<string, unknown>;
  variant?: string | null;
  /** Admin previews are recorded and then excluded from every count. */
  isAdminPreview?: boolean;
};

/**
 * Record an interaction, once.
 *
 * The unique index on (packet_id, idempotency_key) does the deduplication, so
 * a double-tapped button or a re-fired view cannot inflate a conversion or
 * spawn a second follow-up task. A rejected insert is the system working, not
 * an error, so it is swallowed.
 *
 * ADMIN PREVIEW NEVER ADVANCES THE STATUS. An operator opening a prospect's
 * page to check it must not mark it opened, engaged, or anything else.
 */
export async function trackWorkshopEvent(input: TrackInput): Promise<{ recorded: boolean }> {
  const db = supabaseAdmin();
  const key = idempotencyKeyFor(input.event, input.target ?? null);

  const { error } = await db.from("workshop_events").insert({
    packet_id: input.packetId,
    event_type: input.event,
    target: input.target ?? null,
    metadata: input.metadata ?? {},
    variant: input.variant ?? null,
    is_admin_preview: !!input.isAdminPreview,
    idempotency_key: input.isAdminPreview ? `preview:${key ?? input.event}:${Date.now()}` : key,
  });

  // A duplicate key means it already happened. That is the point.
  const recorded = !error;

  if (!input.isAdminPreview) {
    const implied = EVENT_STATUS[input.event];
    if (implied && recorded) await applyStatus(input.packetId, implied, input.event);
  }

  return { recorded };
}

/** Move the lifecycle forward, never backward, and stamp the matching column. */
async function applyStatus(
  packetId: string,
  proposed: WorkshopStatus,
  event: WorkshopEvent
): Promise<void> {
  const db = supabaseAdmin();
  const { data } = await db
    .from("workshop_packets")
    .select("status")
    .eq("id", packetId)
    .maybeSingle();
  const current = ((data?.status as WorkshopStatus) ?? "sent") as WorkshopStatus;
  const next = advanceStatus(current, proposed);

  const patch: Record<string, unknown> = { status: next, updated_at: new Date().toISOString() };
  const now = new Date().toISOString();
  patch.last_seen_at = now;
  if (event === "workshop.opened") patch.first_opened_at = now;
  if (event === "workshop.interest_clicked") patch.interested_at = now;
  if (event === "workshop.private_example_requested") patch.demo_requested_at = now;
  if (event.startsWith("workshop.walkthrough_")) {
    patch.walkthrough_requested_at = now;
    patch.walkthrough_kind = event.includes("phone")
      ? "phone"
      : event.includes("video")
        ? "video"
        : "recorded";
  }
  if (event === "workshop.live_change_approved") patch.live_change_approved_at = now;
  if (event === "workshop.converted") patch.converted_at = now;

  await db.from("workshop_packets").update(patch).eq("id", packetId).then(undefined, () => {});

  if (needsAttention(event)) {
    await recordEvent({
      type: "workshop.needs_attention",
      entityType: "workshop_packet",
      entityId: packetId,
      source: "api",
      newValue: { event, status: next, next_action: nextAction(next, false) },
    }).catch(() => {});
  }
}

/**
 * Save one bottleneck answer as it is given.
 *
 * Upserted per area so a refresh mid-questionnaire loses nothing — an owner
 * who has ticked six boxes and typed two sentences will not start again, they
 * will close the tab.
 */
export async function saveBottleneckAnswer(
  packetId: string,
  answer: BottleneckAnswer
): Promise<boolean> {
  const { error } = await supabaseAdmin()
    .from("workshop_bottleneck_answers")
    .upsert(
      {
        packet_id: packetId,
        area: answer.area,
        detail: answer.detail?.slice(0, 2000) ?? null,
        frequency: answer.frequency ?? null,
        affects: answer.affects ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "packet_id,area" }
    );
  return !error;
}

/** Mark the questionnaire finished, which is what unlocks the map. */
export async function completeAudit(packetId: string): Promise<MappedOpportunity[]> {
  const db = supabaseAdmin();
  await db
    .from("workshop_bottleneck_answers")
    .update({ completed: true, updated_at: new Date().toISOString() })
    .eq("packet_id", packetId)
    .then(undefined, () => {});
  const { answers } = await bottleneckFor(packetId);
  return buildOpportunityMap(answers);
}

/** Their contact preference, captured only when they tell us. */
export async function recordInterestDetails(
  packetId: string,
  input: { name?: string; email?: string; phone?: string; preferred?: "phone" | "email" | "text" }
): Promise<void> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name?.trim()) patch.owner_name = input.name.trim().slice(0, 200);
  if (input.email?.trim()) patch.owner_email = input.email.trim().slice(0, 200);
  if (input.phone?.trim()) patch.owner_phone = input.phone.trim().slice(0, 50);
  if (input.preferred) patch.preferred_contact = input.preferred;
  await supabaseAdmin()
    .from("workshop_packets")
    .update(patch)
    .eq("id", packetId)
    .then(undefined, () => {});
}
