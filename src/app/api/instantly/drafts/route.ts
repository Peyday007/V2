import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordEvent } from "@/lib/events";
import { sendReply } from "@/lib/instantly/client";
import { loadSettings, migrationHint } from "@/lib/instantlyStore";
import { INTENT_LABEL, isReplyIntent } from "@/lib/replyIntent";

export const dynamic = "force-dynamic";

/*
 * The queue of replies waiting on a person, and what happens when they decide.
 *
 * The rule the whole route turns on: A DRAFT IS ONLY EVER MARKED 'sent' AFTER
 * A SEND ACTUALLY HAPPENED. There are two ways it can happen —
 *
 *   1. Through Instantly's API. Convenient, and UNVERIFIED against a live
 *      account, so a failure here is reported in full and the draft stays
 *      approved-but-unsent rather than being quietly marked done.
 *
 *   2. By a person copying the text into the Instantly inbox and pressing
 *      send there. This is the path that definitely works, and it is why
 *      "Approve" and "Sent" are two separate actions rather than one.
 *
 * The same reasoning as the SMS path: a message marked sent that never arrived
 * is worse than a visible failure, because everybody stops chasing it.
 */

const DRAFT_COLUMNS =
  "id, thread_id, lead_id, event_id, intent, intent_confidence, intent_reason, subject, body, status, decided_by, decided_at, decision_note, send_error, created_at";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") || "pending";
  const db = supabaseAdmin();

  let q = db.from("email_drafts").select(DRAFT_COLUMNS).order("created_at", { ascending: false }).limit(200);
  if (status !== "all") q = q.eq("status", status);

  const { data: drafts, error } = await q;
  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message, drafts: [] },
      { status: 500 }
    );
  }

  const rows = drafts || [];
  // The reply itself and the business it came from, so the page can show what
  // is being answered rather than just the answer. Approving a draft without
  // seeing the message it responds to is rubber-stamping.
  const leadIds = [...new Set(rows.map((d) => String(d.lead_id)))];
  const eventIds = rows.map((d) => d.event_id).filter((id): id is number => typeof id === "number");

  const [leadsRes, eventsRes] = await Promise.all([
    leadIds.length
      ? db.from("leads").select("id, business_name, city, state, phone").in("id", leadIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    eventIds.length
      ? db.from("email_events").select("id, body, subject, from_email, occurred_at").in("id", eventIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);

  const leads = new Map((leadsRes.data || []).map((l) => [String(l.id), l]));
  const events = new Map((eventsRes.data || []).map((e) => [Number(e.id), e]));

  return NextResponse.json({
    drafts: rows.map((d) => ({
      ...d,
      intent_label: isReplyIntent(d.intent) ? INTENT_LABEL[d.intent] : d.intent,
      lead: leads.get(String(d.lead_id)) ?? null,
      reply: typeof d.event_id === "number" ? (events.get(d.event_id) ?? null) : null,
    })),
    error: null,
  });
}

type Action = "approve" | "reject" | "mark_sent" | "send";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  const action = body.action as Action;
  const decidedBy = (typeof body.decided_by === "string" && body.decided_by.trim()) || "admin";
  const note = typeof body.note === "string" ? body.note.trim() : "";

  if (!id) return NextResponse.json({ error: "Which draft?" }, { status: 400 });
  if (!["approve", "reject", "mark_sent", "send"].includes(action)) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: draft, error } = await db
    .from("email_drafts")
    .select(DRAFT_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: migrationHint(error.message) || error.message }, { status: 500 });
  }
  if (!draft) return NextResponse.json({ error: "No such draft." }, { status: 404 });
  if (draft.status === "sent") {
    return NextResponse.json({ error: "That reply has already gone out." }, { status: 400 });
  }

  const now = new Date().toISOString();

  /* -------------------------------- reject -------------------------------- */
  if (action === "reject") {
    // The edited body is kept even on a rejection. What somebody chose NOT to
    // send is worth as much as what they did, and it is the only record of why
    // the drafting was wrong.
    await db
      .from("email_drafts")
      .update({ status: "rejected", decided_by: decidedBy, decided_at: now, decision_note: note || null })
      .eq("id", id);
    await recordEvent({
      type: "email.draft_rejected",
      entityType: "email_thread",
      entityId: String(draft.thread_id),
      leadId: String(draft.lead_id),
      actorType: "admin",
      source: "ui",
      previousValue: { intent: draft.intent, body: draft.body },
      newValue: { note: note || null },
      verificationStatus: "verified",
    });
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  /*
   * An approver may rewrite the draft, and usually should. The edited text is
   * what gets stored and what gets sent — never the original — because
   * approving an edit and sending the machine's version is the worst possible
   * combination of the two.
   */
  const finalSubject =
    typeof body.subject === "string" && body.subject.trim() ? body.subject.trim() : draft.subject;
  const finalBody =
    typeof body.body === "string" && body.body.trim() ? body.body.trim() : draft.body;

  /* -------------------------------- approve ------------------------------- */
  if (action === "approve") {
    await db
      .from("email_drafts")
      .update({
        status: "approved",
        subject: finalSubject,
        body: finalBody,
        decided_by: decidedBy,
        decided_at: now,
        decision_note: note || null,
      })
      .eq("id", id);
    await recordEvent({
      type: "email.draft_approved",
      entityType: "email_thread",
      entityId: String(draft.thread_id),
      leadId: String(draft.lead_id),
      actorType: "admin",
      source: "ui",
      previousValue: { body: draft.body },
      newValue: { body: finalBody, edited: finalBody !== draft.body },
      verificationStatus: "verified",
    });
    return NextResponse.json({
      ok: true,
      status: "approved",
      subject: finalSubject,
      body: finalBody,
      // Said plainly, because "approved" on its own reads like "sent".
      note: "Approved. Nothing has been sent yet — copy it into the Instantly inbox and send it there, then press \"Mark as sent\".",
    });
  }

  /* ------------------------------- mark sent ------------------------------ */
  if (action === "mark_sent") {
    // A person is telling us they sent it by hand. Recorded as their claim,
    // which is what it is — hence verificationStatus 'unverified'.
    await db
      .from("email_drafts")
      .update({
        status: "sent",
        subject: finalSubject,
        body: finalBody,
        decided_by: decidedBy,
        decided_at: now,
        decision_note: note || "Sent by hand from the Instantly inbox.",
      })
      .eq("id", id);
    await recordEvent({
      type: "email.reply_sent",
      entityType: "email_thread",
      entityId: String(draft.thread_id),
      leadId: String(draft.lead_id),
      actorType: "admin",
      source: "ui",
      newValue: { body: finalBody },
      metadata: { channel: "instantly inbox, by hand" },
      verificationStatus: "unverified",
    });
    return NextResponse.json({ ok: true, status: "sent" });
  }

  /* ---------------------------- send via the API --------------------------- */
  const { settings } = await loadSettings();
  const { data: thread } = await db
    .from("email_threads")
    .select("id, email, campaign_id")
    .eq("id", draft.thread_id)
    .maybeSingle();
  if (!thread) {
    return NextResponse.json({ error: "The thread this draft belongs to is gone." }, { status: 400 });
  }

  // The id of the message being answered, from the webhook payload we kept.
  let replyToUuid: string | null = null;
  if (typeof draft.event_id === "number") {
    const { data: ev } = await db
      .from("email_events")
      .select("payload")
      .eq("id", draft.event_id)
      .maybeSingle();
    const payload = (ev?.payload || {}) as Record<string, unknown>;
    for (const key of ["reply_to_uuid", "replyToUuid", "email_id", "emailId", "message_uuid"]) {
      const v = payload[key];
      if (typeof v === "string" && v.trim()) {
        replyToUuid = v.trim();
        break;
      }
    }
  }

  const result = await sendReply({
    replyToUuid,
    campaignId: thread.campaign_id || settings.campaign_id,
    toEmail: String(thread.email),
    subject: finalSubject,
    body: finalBody,
  });

  if (!result.ok) {
    // Approved, not sent. The row keeps the error so the page can offer the
    // copy-and-paste route with the reason showing, and nothing anywhere
    // claims this reply reached anybody.
    await db
      .from("email_drafts")
      .update({
        status: "approved",
        subject: finalSubject,
        body: finalBody,
        decided_by: decidedBy,
        decided_at: now,
        send_error: result.error,
      })
      .eq("id", id);
    await recordEvent({
      type: "email.reply_send_failed",
      entityType: "email_thread",
      entityId: String(draft.thread_id),
      leadId: String(draft.lead_id),
      actorType: "admin",
      source: "ui",
      newValue: { error: result.error },
    });
    return NextResponse.json(
      {
        error: result.error,
        status: "approved",
        remedy:
          "Nothing was sent. Copy the text into the Instantly inbox, send it there, then press \"Mark as sent\".",
      },
      { status: 502 }
    );
  }

  await db
    .from("email_drafts")
    .update({
      status: "sent",
      subject: finalSubject,
      body: finalBody,
      decided_by: decidedBy,
      decided_at: now,
      decision_note: note || null,
      send_error: null,
    })
    .eq("id", id);
  await recordEvent({
    type: "email.reply_sent",
    entityType: "email_thread",
    entityId: String(draft.thread_id),
    leadId: String(draft.lead_id),
    actorType: "admin",
    source: "ui",
    newValue: { body: finalBody },
    metadata: { channel: "instantly api", provider_message_id: result.id },
    verificationStatus: "verified",
  });

  return NextResponse.json({ ok: true, status: "sent", providerMessageId: result.id });
}
