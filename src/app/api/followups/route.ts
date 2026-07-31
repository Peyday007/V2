import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recordEvent } from "@/lib/events";
import { buildQueue, needsAlert, type FollowupStatus } from "@/lib/followup";
import { loadSettings } from "@/lib/callIntelligence";

export const dynamic = "force-dynamic";

function migrationHint(message: string): string | null {
  if (/relation .* does not exist|column .* does not exist|schema cache/i.test(message)) {
    return (
      "The follow-up queue is not set up yet. Run supabase/migrations/0019_call_intelligence.sql " +
      `in the Supabase SQL Editor, then reload. (${message})`
    );
  }
  return null;
}

export async function GET() {
  const db = supabase();
  const settings = await loadSettings();

  const { data, error } = await db
    .from("followup_tasks")
    .select(
      "id, call_id, lead_id, assigned_to, kind, reason, channel_target, draft_subject, draft_body, due_at, status, drafted_at, approved_at, sent_at, opened_at, answered_at, converted_at, alerted_at, created_at, leads(business_name, phone, city, state), callers(name)"
    )
    .order("due_at")
    .limit(500);

  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message },
      { status: 500 }
    );
  }

  function one<T>(rel: unknown): T | null {
    if (Array.isArray(rel)) return (rel[0] as T) ?? null;
    return (rel as T) ?? null;
  }

  const rows = data || [];
  const queue = buildQueue(
    rows.map((r) => ({
      id: r.id,
      dueAt: r.due_at,
      status: r.status as FollowupStatus,
      businessName:
        one<{ business_name: string }>(r.leads)?.business_name ?? null,
    }))
  );
  const byId = new Map(rows.map((r) => [r.id, r]));

  const items = queue.map((q) => {
    const row = byId.get(q.id)!;
    return {
      ...q,
      callId: row.call_id,
      leadId: row.lead_id,
      kind: row.kind,
      reason: row.reason,
      target: row.channel_target,
      draftSubject: row.draft_subject,
      draftBody: row.draft_body,
      assignedTo: one<{ name: string }>(row.callers)?.name ?? null,
      lead: one<{ business_name: string; phone: string; city: string; state: string }>(row.leads),
      alertedAt: row.alerted_at,
      timeline: {
        drafted: row.drafted_at,
        approved: row.approved_at,
        sent: row.sent_at,
        opened: row.opened_at,
        answered: row.answered_at,
        converted: row.converted_at,
      },
      needsAlert: needsAlert({ urgency: q.urgency, alertedAt: row.alerted_at }),
    };
  });

  const open = items.filter((i) => i.urgency !== "done");
  const overdue = open.filter((i) => i.urgency === "overdue");

  // Response time is the number the spec asks to report: how long a warm
  // follow-up actually took, measured only on ones that were sent.
  const sent = rows.filter((r) => r.sent_at);
  const responseMinutes = sent
    .map((r) => (new Date(r.sent_at!).getTime() - new Date(r.created_at).getTime()) / 60000)
    .sort((a, b) => a - b);
  const median =
    responseMinutes.length > 0
      ? Math.round(responseMinutes[Math.floor(responseMinutes.length / 2)])
      : null;

  return NextResponse.json({
    items,
    open: open.length,
    overdue: overdue.length,
    deadlineMinutes: settings.followup_deadline_minutes,
    automaticSending: settings.automatic_sending,
    medianResponseMinutes: median,
    sentCount: sent.length,
    withinTarget: sent.filter(
      (r) =>
        (new Date(r.sent_at!).getTime() - new Date(r.created_at).getTime()) / 60000 <=
        settings.followup_deadline_minutes
    ).length,
  });
}

const TRANSITIONS: Record<string, { column: string; status: FollowupStatus }> = {
  approve: { column: "approved_at", status: "approved" },
  sent: { column: "sent_at", status: "sent" },
  opened: { column: "opened_at", status: "sent" },
  answered: { column: "answered_at", status: "answered" },
  converted: { column: "converted_at", status: "converted" },
  cancel: { column: "cancelled_at", status: "cancelled" },
};

/** Move a follow-up along, or save an edited draft. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const db = supabase();
  const { data: before } = await db
    .from("followup_tasks")
    .select("id, lead_id, call_id, status, created_at")
    .eq("id", id)
    .maybeSingle();
  if (!before) return NextResponse.json({ error: "Follow-up not found" }, { status: 404 });

  /* ------------------------------ save a draft ----------------------------- */
  if (body.action === "save_draft") {
    const { error } = await db
      .from("followup_tasks")
      .update({
        draft_subject: String(body.subject ?? ""),
        draft_body: String(body.body ?? ""),
        status: before.status === "pending" ? "drafted" : before.status,
        drafted_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  const move = TRANSITIONS[String(body.action)];
  if (!move) {
    return NextResponse.json(
      { error: `Unknown action. Use: save_draft, ${Object.keys(TRANSITIONS).join(", ")}` },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { [move.column]: now, status: move.status };

  const { error } = await db.from("followup_tasks").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await recordEvent({
    type: "followup.updated",
    entityType: "followup",
    entityId: id,
    leadId: before.lead_id,
    callId: before.call_id,
    actorType: "admin",
    source: "ui",
    previousValue: { status: before.status },
    newValue: { status: move.status, at: now },
    metadata: {
      // Time-to-send is the metric the spec cares about, so record it here
      // rather than recomputing it from timestamps later.
      minutes_from_call:
        body.action === "sent"
          ? Math.round(
              (Date.now() - new Date(before.created_at).getTime()) / 60000
            )
          : null,
    },
    verificationStatus: "verified",
  });

  return NextResponse.json({ ok: true, status: move.status });
}

/** Mark overdue items as alerted, so the queue nags once rather than forever. */
export async function PATCH() {
  const db = supabase();
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("followup_tasks")
    .update({ alerted_at: nowIso })
    .lt("due_at", nowIso)
    .is("alerted_at", null)
    .in("status", ["pending", "drafted", "approved", "overdue"])
    .select("id, lead_id");
  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message },
      { status: 500 }
    );
  }
  for (const row of data || []) {
    await recordEvent({
      type: "followup.overdue",
      entityType: "followup",
      entityId: row.id,
      leadId: row.lead_id,
      actorType: "system",
      source: "system",
      newValue: { overdue_at: nowIso },
    });
  }
  return NextResponse.json({ ok: true, alerted: (data || []).length });
}
