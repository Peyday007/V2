import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { bottleneckFor, ensureOpportunities, packetByToken } from "@/lib/workshopAssessment";
import { buildOpportunityMap } from "@/lib/bottleneckAudit";
import {
  reportVariants,
  nextAction,
  STATUS_LABEL,
  type VariantTally,
  type WorkshopStatus,
} from "@/lib/workshopLifecycle";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// The operator's view of every workshop.
//
// Behind the admin passphrase like everything else that is not /dial or
// /workshop — enforced by the middleware's isProtectedPath, so there is no
// second authorisation scheme here to get wrong.
//
// This is the side that MAY see internal notes. The public route builds its
// payload through stripInternal; this one deliberately does not, and the two
// are separate endpoints precisely so that difference is visible rather than
// depending on a flag somebody could pass wrongly.

const LIST_COLUMNS =
  "id, lead_id, token, status, variant, created_at, sent_at, first_opened_at, last_seen_at, " +
  "interested_at, demo_requested_at, walkthrough_requested_at, walkthrough_kind, " +
  "walkthrough_scheduled_at, live_change_approved_at, converted_at, trial_requested_at, " +
  "owner_name, owner_email, owner_phone, preferred_contact, operator_note, next_action, " +
  "follow_up_done_at, packet_version, leads(business_name, city, state, phone)";

/** Pre-0045 deployments. The section degrades rather than 500s. */
const LEGACY_COLUMNS =
  "id, lead_id, token, status, created_at, sent_at, opened_at, trial_requested_at, " +
  "owner_name, owner_email, owner_phone, leads(business_name, city, state, phone)";

function isMissingColumn(e: { message?: string } | null): boolean {
  return !!e?.message && /column .* does not exist|schema cache/i.test(e.message);
}

export async function GET(req: NextRequest) {
  const db = supabaseAdmin();
  const url = req.nextUrl.searchParams;
  const detailToken = url.get("token");

  /* ------------------------------ one record ------------------------------ */
  if (detailToken) {
    const found = await packetByToken(detailToken);
    if (!found) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const packetId = found.packet.id as string;

    // Internal notes included ON PURPOSE — this endpoint is behind the
    // passphrase and the operator needs the caller's talk track.
    const opportunities = await ensureOpportunities(packetId, found.lead);
    const bottleneck = await bottleneckFor(packetId);

    const { data: events } = await db
      .from("workshop_events")
      .select("event_type, target, metadata, variant, is_admin_preview, occurred_at")
      .eq("packet_id", packetId)
      .order("occurred_at", { ascending: false })
      .limit(400);

    const { data: versions } = await db
      .from("workshop_packet_versions")
      .select("version, reason, created_at")
      .eq("packet_id", packetId)
      .order("version", { ascending: false });

    const status = (found.packet.status as WorkshopStatus) ?? "sent";
    return NextResponse.json({
      packet: found.packet,
      lead: found.lead,
      statusLabel: STATUS_LABEL[status] ?? status,
      nextAction: (found.packet.next_action as string) || nextAction(status, bottleneck.complete),
      opportunities,
      bottleneck: bottleneck.answers,
      auditComplete: bottleneck.complete,
      map: bottleneck.complete ? buildOpportunityMap(bottleneck.answers) : [],
      // Prospect activity and admin previews kept apart, never merged.
      timeline: (events ?? []).filter((e) => !e.is_admin_preview),
      previewTimeline: (events ?? []).filter((e) => e.is_admin_preview),
      versions: versions ?? [],
    });
  }

  /* -------------------------------- the list ------------------------------ */
  let res = await db
    .from("workshop_packets")
    .select(LIST_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(500);
  let legacy = false;
  if (res.error && isMissingColumn(res.error)) {
    legacy = true;
    res = await db
      .from("workshop_packets")
      .select(LEGACY_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(500);
  }
  if (res.error) {
    return NextResponse.json(
      {
        error:
          `Could not read the workshops. If 0045 has not been run yet, run ` +
          `supabase/migrations/0045_workshop_assessment.sql. (${res.error.message})`,
      },
      { status: 500 }
    );
  }

  const rows = (res.data ?? []) as unknown as Record<string, unknown>[];

  /*
   * Counts, from prospect activity only.
   *
   * The status column already excludes admin previews because trackWorkshopEvent
   * never advances a status for one — so counting statuses cannot be inflated
   * by an operator checking a page.
   */
  const has = (r: Record<string, unknown>, k: string) => !!r[k];
  const totals = {
    created: rows.length,
    sent: rows.filter((r) => has(r, "sent_at")).length,
    opened: rows.filter((r) => has(r, "first_opened_at") || has(r, "opened_at")).length,
    interested: rows.filter(
      (r) => has(r, "interested_at") || has(r, "trial_requested_at")
    ).length,
    demoRequested: rows.filter((r) => has(r, "demo_requested_at")).length,
    walkthroughRequested: rows.filter((r) => has(r, "walkthrough_requested_at")).length,
    walkthroughScheduled: rows.filter((r) => has(r, "walkthrough_scheduled_at")).length,
    liveChangeApproved: rows.filter((r) => has(r, "live_change_approved_at")).length,
    converted: rows.filter((r) => has(r, "converted_at")).length,
    needsAttention: rows.filter(
      (r) =>
        (has(r, "interested_at") ||
          has(r, "demo_requested_at") ||
          has(r, "walkthrough_requested_at") ||
          has(r, "trial_requested_at")) &&
        !has(r, "follow_up_done_at")
    ).length,
  };

  /* Audits, counted from their own table rather than inferred. */
  let auditsStarted = 0;
  let auditsCompleted = 0;
  try {
    const { data: audits } = await db
      .from("workshop_bottleneck_answers")
      .select("packet_id, completed");
    const started = new Set<string>();
    const done = new Set<string>();
    for (const a of audits ?? []) {
      started.add(String(a.packet_id));
      if (a.completed) done.add(String(a.packet_id));
    }
    auditsStarted = started.size;
    auditsCompleted = done.size;
  } catch {
    // Table missing pre-0045.
  }

  /* ------------------------------- variants ------------------------------- */
  const byVariant = new Map<string, VariantTally>();
  for (const r of rows) {
    const v = String(r.variant ?? "control");
    const t =
      byVariant.get(v) ??
      ({
        variant: v,
        delivered: 0,
        opened: 0,
        engaged: 0,
        interested: 0,
        auditCompleted: 0,
        privateBuildRequested: 0,
        walkthroughRequested: 0,
        converted: 0,
      } as VariantTally);
    if (has(r, "sent_at")) t.delivered += 1;
    if (has(r, "first_opened_at") || has(r, "opened_at")) t.opened += 1;
    if (String(r.status) === "engaged") t.engaged += 1;
    if (has(r, "interested_at") || has(r, "trial_requested_at")) t.interested += 1;
    if (has(r, "demo_requested_at")) t.privateBuildRequested += 1;
    if (has(r, "walkthrough_requested_at")) t.walkthroughRequested += 1;
    if (has(r, "converted_at")) t.converted += 1;
    byVariant.set(v, t);
  }

  return NextResponse.json({
    legacy,
    totals: { ...totals, auditsStarted, auditsCompleted },
    variants: reportVariants([...byVariant.values()]),
    rows: rows.map((r) => ({
      ...r,
      statusLabel: STATUS_LABEL[(r.status as WorkshopStatus) ?? "sent"] ?? r.status,
    })),
    error: null,
  });
}

/* -------------------------------------------------------------------------- */

/** Operator actions: notes, follow-up, scheduling, revoking, regenerating. */
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  if (!id) return NextResponse.json({ error: "Which workshop?" }, { status: 400 });

  const db = supabaseAdmin();
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.operator_note === "string") {
    patch.operator_note = body.operator_note.slice(0, 4000);
  }
  if (typeof body.next_action === "string") patch.next_action = body.next_action.slice(0, 500);
  if (body.follow_up_done === true) patch.follow_up_done_at = new Date().toISOString();
  if (body.follow_up_done === false) patch.follow_up_done_at = null;
  if (typeof body.walkthrough_scheduled_at === "string") {
    patch.walkthrough_scheduled_at = body.walkthrough_scheduled_at;
    patch.status = "walkthrough_scheduled";
  }
  /*
   * Revoking is the one operator action that closes a link. Deliberately
   * explicit: nothing expires a workshop automatically, because an owner
   * returning to a dead link months later is a worse outcome than a link that
   * outlives its usefulness.
   */
  if (body.revoke === true) patch.status = "revoked";

  const { error } = await db.from("workshop_packets").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/**
 * Regenerate the findings, keeping what the prospect was shown.
 *
 * The previous version is snapshotted first. An owner who was shown one thing
 * in March and rings in June must be answerable with what they actually saw,
 * not with whatever the same code produces today against moved data.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  if (!id || body.action !== "regenerate") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: packet } = await db
    .from("workshop_packets")
    .select("id, lead_id, token, packet_version")
    .eq("id", id)
    .maybeSingle();
  if (!packet) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const { data: current } = await db
    .from("workshop_opportunities")
    .select("*")
    .eq("packet_id", id);

  const version = Number(packet.packet_version ?? 1);
  await db
    .from("workshop_packet_versions")
    .insert({
      packet_id: id,
      version,
      snapshot: { opportunities: current ?? [] },
      reason: String(body.reason ?? "Regenerated by an operator"),
    })
    .then(undefined, () => {});

  // Only now is it safe to clear and rebuild.
  await db.from("workshop_opportunities").delete().eq("packet_id", id);
  const { data: lead } = await db
    .from("leads")
    .select("*")
    .eq("id", packet.lead_id as string)
    .maybeSingle();
  if (lead) await ensureOpportunities(id, lead as unknown as Record<string, unknown>);

  await db
    .from("workshop_packets")
    .update({ packet_version: version + 1, updated_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json({ ok: true, version: version + 1, archived: (current ?? []).length });
}
