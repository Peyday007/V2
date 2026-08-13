// The shapes this application exchanges with Instantly.
//
// Kept separate from the client so everything that maps a payload can be
// tested without a network or an API key — which matters more here than
// usual, because the webhook parsing is the part most likely to be wrong.

/** What gets pushed into a campaign. Everything here comes off a lead row. */
export type PushSubject = {
  leadId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string;
  website: string | null;
  phone: string | null;
  /**
   * The one lead-specific sentence the sequence merges in. Computed by
   * emailCompose from fields already on the record — never invented.
   */
  personalization: string;
  /** Merge fields the sequence can reference by name. */
  customVariables: Record<string, string>;
};

export type PushResult =
  | { ok: true; instantlyLeadId: string | null; email: string }
  | { ok: false; error: string; retryable: boolean };

export type Campaign = {
  id: string;
  name: string;
  status: string | null;
  /**
   * The campaign's own cap — "max number of emails to send per day for this
   * campaign". Null when Instantly did not return it, which must never be
   * confused with a campaign that has no cap; see computeCapacity.
   */
  dailyLimit: number | null;
};

/**
 * Every event this app does something with, normalised to one vocabulary.
 *
 * Instantly's own names are more numerous and change; the mapping lives in
 * `normaliseEvent` so a rename there is a one-line fix rather than a hunt
 * through the routes.
 */
export const EMAIL_EVENTS = [
  "sent",
  "opened",
  "clicked",
  "replied",
  "bounced",
  "unsubscribed",
  "auto_reply",
  "other",
] as const;
export type EmailEventType = (typeof EMAIL_EVENTS)[number];

export type NormalisedEvent = {
  type: EmailEventType;
  /** Instantly's own name for it, kept so "other" is still traceable. */
  rawType: string;
  email: string | null;
  campaignId: string | null;
  subject: string | null;
  body: string | null;
  fromEmail: string | null;
  /**
   * Instantly's id for the message itself, needed to answer it in the same
   * thread rather than starting a new one. Frequently absent — the reply flow
   * has to work without it.
   */
  replyToUuid: string | null;
  /** Deep link into Instantly's inbox, so a human can answer it there. */
  uniboxUrl: string | null;
  occurredAt: string;
  /**
   * Deduplication key. Instantly retries deliveries, and a retried reply that
   * is counted twice produces two drafts for one message.
   */
  idempotencyKey: string;
};

/**
 * What Instantly's own ledger says went out.
 *
 * THE AUTHORITATIVE SEND COUNT. Webhooks are event detail — they arrive when
 * they arrive, they can be missed entirely if the endpoint was down or the
 * secret was wrong, and they were never designed to be a total. Reading
 * "nothing sent in 24 hours" off our own webhook table produced a red warning
 * on a campaign that was sending perfectly well.
 *
 * Null on any failure, never zero: "we could not ask" and "nothing was sent"
 * are different answers, and reporting the second for the first is exactly the
 * false alarm this exists to end.
 */
export type CampaignSendLedger = {
  sent: number;
  replies: number;
  /** The window asked for, so a caller can say what the number covers. */
  from: string;
  to: string;
};

/** Whether the integration can talk to Instantly at all, said in words. */
export type InstantlyCapability = {
  available: boolean;
  reason: string;
  missing: string[];
};
