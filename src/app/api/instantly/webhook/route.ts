import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordEvent } from "@/lib/events";
import { safeEqual } from "@/lib/adminAuth";
import { normaliseEvent, suppressesEmail } from "@/lib/instantly/events";
import { sendReply } from "@/lib/instantly/client";
import type { EmailEventType } from "@/lib/instantly/types";
import { loadSettings, migrationHint, THREAD_COLUMNS, type ThreadRow } from "@/lib/instantlyStore";
import { readReply, shouldDraftReply, suppressesFurtherEmail } from "@/lib/replyIntent";
import { buildDraft, mayAutoSend } from "@/lib/emailDraft";
import { COMPANY_NAME, appOrigin } from "@/lib/workshopSend";
import { advanceStatus, packetUrl, type PacketStatus } from "@/lib/workshopPacket";
import { splitName } from "@/lib/emailCompose";

export const dynamic = "force-dynamic";

/*
 * Where a reply lands.
 *
 * This is the only public write endpoint in the integration, so it is the one
 * worth being careful about. Three things it does deliberately:
 *
 *   IT FAILS CLOSED. With no INSTANTLY_WEBHOOK_SECRET set it accepts nothing.
 *   An unauthenticated endpoint that writes rows keyed by an email address is
 *   an invitation to unsubscribe somebody else's leads.
 *
 *   IT NEVER PROCESSES A DELIVERY TWICE. Instantly retries. A retried reply
 *   counted twice produces two drafts, and the second one goes to a prospect
 *   who already had an answer. The unique index on idempotency_key is what
 *   enforces that; the duplicate is answered 200 so Instantly stops retrying.
 *
 *   IT ACTS ONLY IN ONE DIRECTION. The one thing it does without a human is
 *   SUPPRESS — an unsubscribe or a bounce stops further email immediately.
 *   Everything that would send something waits for a person.
 */

/** The path is public, so this is the whole access control. */
function authorised(req: NextRequest): { ok: boolean; error: string } {
  const expected = process.env.INSTANTLY_WEBHOOK_SECRET || "";
  if (!expected) {
    return {
      ok: false,
      error:
        "INSTANTLY_WEBHOOK_SECRET is not set, so this endpoint accepts nothing. Set it in Vercel, redeploy, and put the same value on the webhook in Instantly.",
    };
  }
  const supplied =
    req.headers.get("x-instantly-secret") ||
    req.headers.get("x-webhook-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    "";
  // Constant-time, same as the admin cookie: a secret compared with === can be
  // guessed a character at a time by anyone who can measure the response.
  if (!supplied || !safeEqual(supplied, expected)) {
    return { ok: false, error: "Bad or missing webhook secret." };
  }
  return { ok: true, error: "" };
}

/** How an event moves the thread's status. Forward-ish, and never backwards
 *  from a reply — an "opened" arriving after a reply must not undo it. */
const STATUS_RANK: Record<string, number> = {
  pushed: 0,
  sent: 1,
  opened: 2,
  replied: 4,
  bounced: 5,
  unsubscribed: 5,
  failed: 0,
};

/** Which webhook events earn a line on the lead's own history. */
const HISTORY_TYPE: Partial<Record<EmailEventType, string>> = {
  sent: "email.sent",
  opened: "email.opened",
  clicked: "email.opened",
  replied: "email.replied",
  bounced: "email.bounced",
  unsubscribed: "email.unsubscribed",
};

function nextStatus(current: string, event: EmailEventType): string {
  const proposed =
    event === "sent"
      ? "sent"
      : event === "opened" || event === "clicked"
        ? "opened"
        : event === "replied"
          ? "replied"
          : event === "bounced"
            ? "bounced"
            : event === "unsubscribed"
              ? "unsubscribed"
              : current;
  const from = STATUS_RANK[current] ?? 0;
  const to = STATUS_RANK[proposed] ?? 0;
  return to > from ? proposed : current;
}

export async function POST(req: NextRequest) {
  const auth = authorised(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  const payload = await req.json().catch(() => null);
  const event = normaliseEvent(payload);
  if (!event) {
    // 200, not 400. A malformed body is not something Instantly can fix by
    // retrying, and a 4xx here makes them retry it for hours.
    return NextResponse.json({ ok: true, ignored: "Unrecognisable payload." });
  }

  const db = supabaseAdmin();

  let thread: ThreadRow | null = null;
  if (event.email) {
    const { data, error } = await db
      .from("email_threads")
      .select(THREAD_COLUMNS)
      .eq("email", event.email)
      .maybeSingle();
    if (error) {
      return NextResponse.json(
        { error: migrationHint(error.message) || error.message },
        { status: 500 }
      );
    }
    thread = (data as ThreadRow) ?? null;
  }

  /*
   * Record it first, whatever it is.
   *
   * Including events for addresses this app has never pushed — somebody may
   * have added leads in Instantly directly, and an unexplained event is
   * evidence worth keeping rather than a reason to drop the request.
   */
  const { data: inserted, error: insertErr } = await db
    .from("email_events")
    .insert({
      thread_id: thread?.id ?? null,
      lead_id: thread?.lead_id ?? null,
      event_type: event.type,
      subject: event.subject,
      body: event.body,
      from_email: event.fromEmail,
      payload: payload && typeof payload === "object" ? payload : {},
      occurred_at: event.occurredAt,
      idempotency_key: event.idempotencyKey,
    })
    .select("id")
    .single();

  if (insertErr) {
    // 23505 is the idempotency index: Instantly is retrying a delivery we
    // already handled. That is a success, and answering 200 stops the retries.
    if (insertErr.code === "23505") {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    return NextResponse.json(
      { error: migrationHint(insertErr.message) || insertErr.message },
      { status: 500 }
    );
  }
  const eventId = inserted?.id ?? null;

  if (!thread) {
    return NextResponse.json({ ok: true, recorded: true, matchedThread: false });
  }

  /* ---------------------------- move the thread --------------------------- */
  const patch: Record<string, unknown> = {
    status: nextStatus(thread.status, event.type),
    last_event_at: event.occurredAt,
    updated_at: new Date().toISOString(),
  };
  if (event.type === "replied") patch.reply_count = (thread.reply_count || 0) + 1;
  if (event.campaignId && !thread.campaign_id) patch.campaign_id = event.campaignId;
  await db.from("email_threads").update(patch).eq("id", thread.id);

  /*
   * The lead's history line.
   *
   * Only the five events that mean something on a lead's timeline get one. An
   * auto-reply, or an event type Instantly adds after this was written, is
   * already safe in email_events with its raw payload — writing it to the
   * history as "email.sent" would put a claim there that is not true, and the
   * history is the one place in this system that has to stay literal.
   */
  const historyType = HISTORY_TYPE[event.type];
  if (historyType) {
    await recordEvent({
      type: historyType,
      entityType: "email_thread",
      entityId: thread.id,
      leadId: thread.lead_id,
      actorType: "system",
      source: "api",
      newValue: { event: event.type, raw_type: event.rawType },
      occurredAt: event.occurredAt,
      verificationStatus: "verified",
    });
  }

  /* ------------------------------ suppression ----------------------------- */
  // The one autonomous action in the whole integration, and it only ever means
  // "send less".
  if (suppressesEmail(event.type)) {
    await db
      .from("leads")
      .update(
        event.type === "unsubscribed"
          ? { email_unsubscribed_at: event.occurredAt }
          : { email_bounced_at: event.occurredAt }
      )
      .eq("id", thread.lead_id);
    return NextResponse.json({ ok: true, suppressed: event.type });
  }

  /* -------------------- the packet the email links to --------------------- */
  /*
   * The email carries a link to the prospect's own page, and that packet was
   * created at `not_sent` when the lead was pushed. It becomes `sent` here,
   * when Instantly confirms the email actually went out — not at push time,
   * because pushing a lead into a campaign is not the same as a sequence
   * having sent anything, and a packet marked sent that never left is the
   * failure this whole integration is written to avoid.
   *
   * `advanceStatus` is forward-only, so a lead that already opened the page
   * cannot be knocked back to `sent` by a later step of the sequence going
   * out. Opening is worth more than sending and must not be overwritten.
   */
  if (event.type === "sent") {
    try {
      const { data: pkt } = await db
        .from("workshop_packets")
        .select("id, status")
        .eq("lead_id", thread.lead_id)
        .maybeSingle();
      if (pkt) {
        const next = advanceStatus(pkt.status as PacketStatus, "sent");
        if (next !== pkt.status) {
          await db
            .from("workshop_packets")
            .update({ status: next, sent_at: event.occurredAt, updated_at: new Date().toISOString() })
            .eq("id", pkt.id);
        }
      }
    } catch {
      // The packet is a nicety on this path; the event is already recorded.
    }
  }

  if (event.type !== "replied") {
    return NextResponse.json({ ok: true, recorded: true, status: patch.status });
  }

  /* -------------------------------- the reply ----------------------------- */
  const reading = readReply(event.body);

  // A reply that says "take me off your list" suppresses immediately, without
  // waiting for anybody to read it. Slower than that is not good enough.
  if (suppressesFurtherEmail(reading.intent)) {
    await db
      .from("leads")
      .update({ email_unsubscribed_at: event.occurredAt })
      .eq("id", thread.lead_id);
    await recordEvent({
      type: "email.unsubscribed",
      entityType: "email_thread",
      entityId: thread.id,
      leadId: thread.lead_id,
      actorType: "system",
      source: "api",
      newValue: { intent: reading.intent, reason: reading.reason },
      metadata: { from: "reply text" },
      confidence: reading.confidence,
      verificationStatus: "verified",
    });
    return NextResponse.json({ ok: true, intent: reading.intent, suppressed: true });
  }

  if (!shouldDraftReply(reading.intent)) {
    // Out of office, or nothing readable. Recorded, nothing drafted, and the
    // reply still shows on the page so a person can look if they want to.
    return NextResponse.json({ ok: true, intent: reading.intent, drafted: false });
  }

  /* ------------------------------ draft a reply --------------------------- */
  const { data: lead } = await db
    .from("leads")
    .select("id, business_name, owner_name, decision_maker_name")
    .eq("id", thread.lead_id)
    .maybeSingle();

  let workshopLink: string | null = null;
  try {
    const { data: packet } = await db
      .from("workshop_packets")
      .select("token")
      .eq("lead_id", thread.lead_id)
      .maybeSingle();
    // Derived from the request Instantly made, the same way the caller's Copy
    // Link is — so it is right on a preview deploy and on production without
    // anybody having to remember to set APP_BASE_URL.
    const origin = await appOrigin();
    if (packet?.token && origin) workshopLink = packetUrl(origin, String(packet.token));
  } catch {
    // No link is a slightly plainer reply, not a failure.
  }

  const { firstName } = splitName(lead?.decision_maker_name || lead?.owner_name || null);
  const draft = buildDraft(reading.intent, {
    businessName: lead?.business_name || "your business",
    ownerFirstName: firstName,
    // Signed by the company, not by a caller: nobody on the team pressed a
    // button here, and putting a person's name on a machine-written draft
    // makes it harder for whoever approves it to see that it is one.
    senderName: COMPANY_NAME || "the team",
    companyName: COMPANY_NAME || null,
    workshopLink,
    replyBody: event.body,
  });
  if (!draft) return NextResponse.json({ ok: true, intent: reading.intent, drafted: false });

  const { settings } = await loadSettings();
  const auto = mayAutoSend(reading.intent, reading.confidence, event.body, {
    autoReplyEnabled: settings.auto_reply_enabled,
    confidenceFloor: settings.reply_confidence_floor,
  });

  const { data: draftRow } = await db
    .from("email_drafts")
    .insert({
      thread_id: thread.id,
      lead_id: thread.lead_id,
      event_id: eventId,
      intent: reading.intent,
      intent_confidence: reading.confidence,
      intent_reason: reading.reason,
      subject: draft.subject,
      body: draft.body,
      // Created pending, always. If the auto-send conditions are met it is
      // moved to 'sent' below — but only after a send that actually happened.
      // A row marked 'sent' before anything was sent is the failure mode this
      // whole file is written to avoid.
      status: "pending",
      decision_note: auto.allowed ? null : auto.reason,
    })
    .select("id")
    .single();

  await recordEvent({
    type: "email.draft_created",
    entityType: "email_thread",
    entityId: thread.id,
    leadId: thread.lead_id,
    actorType: "system",
    source: "api",
    newValue: { intent: reading.intent, rationale: draft.rationale },
    metadata: { auto_send_allowed: auto.allowed, auto_send_reason: auto.reason },
    confidence: reading.confidence,
    verificationStatus: "unverified",
  });

  /* ------------------------ answer it, if allowed to ---------------------- */
  /*
   * Every condition in mayAutoSend has already been met by this point, which
   * means an administrator deliberately switched this on. Two things still
   * hold:
   *
   *   - the send has to succeed before anything is marked sent. A failure
   *     leaves the draft pending, exactly where a person will find it;
   *   - the reply that goes out is the drafted one, unedited, which is why
   *     the drafting rules refuse to put a price in it.
   */
  if (auto.allowed && draftRow?.id) {
    const sent = await sendReply({
      replyToUuid: event.replyToUuid,
      campaignId: thread.campaign_id || settings.campaign_id,
      toEmail: thread.email,
      subject: draft.subject,
      body: draft.body,
    });

    if (sent.ok) {
      await db
        .from("email_drafts")
        .update({
          status: "sent",
          decided_by: "automatic",
          decided_at: new Date().toISOString(),
          decision_note: auto.reason,
        })
        .eq("id", draftRow.id);
      await recordEvent({
        type: "email.reply_sent",
        entityType: "email_thread",
        entityId: thread.id,
        leadId: thread.lead_id,
        actorType: "system",
        source: "api",
        newValue: { body: draft.body, intent: reading.intent },
        metadata: { channel: "instantly api", automatic: true, provider_message_id: sent.id },
        confidence: reading.confidence,
        verificationStatus: "verified",
      });
      return NextResponse.json({ ok: true, intent: reading.intent, autoSent: true });
    }

    // Left pending on purpose. An automatic reply that could not be sent is a
    // reply somebody still needs to send.
    await db
      .from("email_drafts")
      .update({ send_error: sent.error, decision_note: "Automatic send failed; waiting for a person." })
      .eq("id", draftRow.id);
    await recordEvent({
      type: "email.reply_send_failed",
      entityType: "email_thread",
      entityId: thread.id,
      leadId: thread.lead_id,
      actorType: "system",
      source: "api",
      newValue: { error: sent.error },
      metadata: { automatic: true },
    });
  }

  return NextResponse.json({
    ok: true,
    intent: reading.intent,
    drafted: true,
    draftId: draftRow?.id ?? null,
    awaitingHuman: true,
  });
}

/** A GET so somebody configuring the webhook can check the URL is live. */
export async function GET(req: NextRequest) {
  const auth = authorised(req);
  return NextResponse.json(
    auth.ok
      ? { ok: true, message: "Webhook endpoint is live and the secret matches." }
      : { ok: false, error: auth.error },
    { status: auth.ok ? 200 : 401 }
  );
}
