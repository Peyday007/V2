// Turning an Instantly webhook into something this application understands.
//
// Pure, and deliberately in its own file with no `server-only` import, so
// every payload shape can be tested directly. This is the part most likely to
// be wrong — a vendor renaming `reply_received` to `email_replied` breaks the
// most valuable event in the system — so it is written to be tolerant and to
// fail loudly rather than quietly.
//
// The two rules it is built around:
//
//   NEVER SILENTLY DROP. An event whose type is not recognised still lands in
//   email_events as "other" with its raw payload. A shape change then shows up
//   as a run of unknown events on the admin page instead of as replies that
//   never arrived.
//
//   NEVER DOUBLE-COUNT. Instantly retries deliveries. Two identical rows for
//   one reply means two drafts, and the second one gets sent to a prospect
//   who already had an answer.

import type { EmailEventType, NormalisedEvent } from "./types";

/**
 * Instantly's event names, as documented, mapped to ours.
 *
 * Several spellings are listed for the same thing on purpose: the webhook
 * payload has used both `reply_received` and `email_replied` in different
 * versions of the documentation, and accepting both costs nothing while
 * accepting neither loses a reply.
 */
const TYPE_MAP: Record<string, EmailEventType> = {
  email_sent: "sent",
  sent: "sent",
  email_opened: "opened",
  opened: "opened",
  email_link_clicked: "clicked",
  link_clicked: "clicked",
  clicked: "clicked",
  reply_received: "replied",
  email_replied: "replied",
  replied: "replied",
  email_bounced: "bounced",
  bounced: "bounced",
  lead_unsubscribed: "unsubscribed",
  unsubscribed: "unsubscribed",
  lead_interested: "replied",
  auto_reply_received: "auto_reply",
  auto_reply: "auto_reply",
};

export function mapEventType(raw: string): EmailEventType {
  return TYPE_MAP[String(raw || "").trim().toLowerCase()] ?? "other";
}

/** First non-empty string among several possible key spellings. */
function pick(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/**
 * A stable key for one delivery.
 *
 * Uses Instantly's own event id when it sends one. When it does not, the key
 * is built from the parts that identify the event — type, address, timestamp
 * and a slice of the body — because a retry repeats all of those exactly,
 * while a genuinely new reply from the same person differs in at least the
 * timestamp.
 *
 * Deliberately NOT a hash of the whole payload: Instantly includes fields that
 * vary between retries, and any of those would make every retry look new.
 */
export function idempotencyKeyFor(
  raw: Record<string, unknown>,
  type: EmailEventType,
  email: string | null,
  occurredAt: string,
  body: string | null
): string {
  const given = pick(raw, ["event_id", "eventId", "id", "message_id", "messageId"]);
  if (given) return `instantly:${given}`;
  const bodyPart = (body || "").replace(/\s+/g, " ").trim().slice(0, 120);
  return `instantly:${type}:${email || "?"}:${occurredAt}:${bodyPart}`;
}

function toIso(value: string | null): string {
  if (!value) return new Date().toISOString();
  // Instantly sends both ISO strings and unix seconds depending on the event.
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && value.trim() !== "" && !/[-:TZ]/.test(value)) {
    const ms = asNumber > 1e12 ? asNumber : asNumber * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

/**
 * Normalise one webhook body.
 *
 * Returns null only when there is nothing usable at all — no event type and no
 * email address. Everything else produces a row, because an event we cannot
 * classify is still evidence that something happened.
 */
export function normaliseEvent(payload: unknown): NormalisedEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;

  const rawType = pick(raw, ["event_type", "eventType", "type", "event"]) || "";
  const email = pick(raw, ["lead_email", "leadEmail", "email", "lead"]);
  if (!rawType && !email) return null;

  const type = mapEventType(rawType);
  const occurredAt = toIso(pick(raw, ["timestamp", "occurred_at", "created_at", "date"]));

  // The full reply first; the snippet only as a fallback. Drafting a response
  // to a truncated message is how a reply gets answered on half its content.
  const body = pick(raw, [
    "reply_text",
    "reply_text_plain",
    "replyText",
    "body",
    "text",
    "reply_html",
    "reply_text_snippet",
  ]);

  return {
    type,
    rawType: rawType || "unknown",
    email: email ? email.toLowerCase() : null,
    campaignId: pick(raw, ["campaign_id", "campaignId", "campaign"]),
    subject: pick(raw, ["reply_subject", "subject", "email_subject"]),
    body,
    fromEmail: pick(raw, ["from_email", "fromEmail", "email_account", "reply_from"]),
    // Only the keys that plausibly identify the MESSAGE. A campaign id or a
    // lead id here would be worse than nothing: the reply endpoint would
    // accept it and answer the wrong thread.
    replyToUuid: pick(raw, ["reply_to_uuid", "replyToUuid", "email_id", "emailId", "message_uuid"]),
    uniboxUrl: pick(raw, ["unibox_url", "uniboxUrl"]),
    occurredAt,
    idempotencyKey: idempotencyKeyFor(raw, type, email ? email.toLowerCase() : null, occurredAt, body),
  };
}

/**
 * Events that must suppress the lead from any further email, immediately,
 * without anyone approving anything.
 *
 * This is the one place in the integration that acts on its own, and it only
 * ever acts in the direction of sending less.
 */
export function suppressesEmail(type: EmailEventType): boolean {
  return type === "unsubscribed" || type === "bounced";
}

/** Events worth waking a human for. */
export function needsHuman(type: EmailEventType): boolean {
  return type === "replied";
}
