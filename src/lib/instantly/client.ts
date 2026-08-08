import "server-only";
import type { Campaign, InstantlyCapability, PushResult, PushSubject } from "./types";
import {
  explainStatus,
  hasVisibleText,
  normaliseAccounts,
  normaliseCampaigns,
  pushBody,
  readCampaignSteps,
  toInstantlySequence,
  countBlocks,
  formatBody,
  type SendingAccountRow,
} from "./mapping";

// The pure request/response mapping lives in ./mapping so it can be unit
// tested — this file imports server-only, which a test cannot load. Re-exported
// here so callers still have one import for the adapter.
export {
  countBlocks,
  explainStatus,
  formatBody,
  hasVisibleText,
  normaliseAccounts,
  normaliseCampaigns,
  pushBody,
  readCampaignSteps,
  toInstantlySequence,
} from "./mapping";

// Talking to Instantly.
//
// UNVERIFIED AGAINST A LIVE ACCOUNT. Written from the documented shape of the
// Instantly v2 API; there are no credentials here to exercise it with. Verify
// the request bodies against current docs before running a real campaign, and
// push a batch of one first — `max_push_per_run` exists so a wrong guess about
// the payload costs a handful of leads rather than a list.
//
// Same contract as every other provider in this codebase:
//
//   - the key comes from the environment and is never logged, never stored in
//     the database and never returned to the browser;
//   - the capability check explains itself, so an admin can act without
//     guessing which variable is missing;
//   - nothing throws. A failed push comes back as `ok: false` with something
//     readable, because the alternative is a 500 on a button an operator
//     pressed and a lead that is neither pushed nor marked as failed.
//
// What this file will never grow: the ability to send an email. Instantly
// sends. This application decides who, and reads what comes back.

const BASE = (process.env.INSTANTLY_API_BASE || "https://api.instantly.ai/api/v2").replace(
  /\/+$/,
  ""
);

const REQUIRED = ["INSTANTLY_API_KEY"] as const;

export function instantlyCapability(): InstantlyCapability {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length === 0) {
    return { available: true, reason: "Connected to Instantly.", missing: [] };
  }
  return {
    available: false,
    reason:
      `Instantly is not configured — ${missing.join(", ")} is not set. Add it in ` +
      `Vercel → Settings → Environment Variables and redeploy. Until then nothing ` +
      `is pushed and no replies come back.`,
    missing: [...missing],
  };
}

/** The shared secret the webhook route checks. Separate from the API key. */
export function webhookSecretConfigured(): boolean {
  return !!process.env.INSTANTLY_WEBHOOK_SECRET;
}

type Fetched = { ok: true; body: unknown } | { ok: false; error: string; retryable: boolean };

async function call(
  path: string,
  init: { method: string; body?: unknown }
): Promise<Fetched> {
  const key = process.env.INSTANTLY_API_KEY;
  if (!key) return { ok: false, error: instantlyCapability().reason, retryable: false };

  try {
    const res = await fetch(`${BASE}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // Never serve a cached campaign list or a cached push.
      cache: "no-store",
    });

    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      return {
        ok: false,
        error: explainStatus(res.status, text),
        // Their problem, or rate limiting: worth another go. A 4xx is ours.
        retryable: res.status >= 500 || res.status === 429,
      };
    }
    // Some endpoints answer 200 with an empty body.
    const text = await res.text();
    return { ok: true, body: text ? safeJson(text) : {} };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      retryable: true,
    };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

/* -------------------------------------------------------------------------- */
/* campaigns                                                                  */
/* -------------------------------------------------------------------------- */

export async function listCampaigns(): Promise<
  { ok: true; campaigns: Campaign[] } | { ok: false; error: string }
> {
  const res = await call("/campaigns?limit=100", { method: "GET" });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, campaigns: normaliseCampaigns(res.body) };
}

/**
 * The campaign's own daily sending limit.
 *
 * The second of Instantly's two caps, and usually the binding one: the inboxes
 * each have a limit, and the campaign has a limit, and the lower wins. Without
 * this the capacity plan sums the inboxes and believes a number that will never
 * go out — see computeCapacity for what that costs.
 *
 * Null on any failure, deliberately. A campaign whose limit could not be read
 * must not be treated as a campaign with no limit, and it must not be treated
 * as a campaign limited to zero either; the caller falls back to the inbox
 * total and says the limit was not read.
 */
export async function campaignDailyLimit(campaignId: string): Promise<number | null> {
  if (!campaignId || !instantlyCapability().available) return null;
  const res = await call(`/campaigns/${encodeURIComponent(campaignId)}`, { method: "GET" });
  if (!res.ok) return null;
  // Reuse the list parser rather than a second set of key guesses, so a rename
  // in Instantly's field names is fixed in one place.
  const [campaign] = normaliseCampaigns([res.body]);
  return campaign?.dailyLimit ?? null;
}

/* -------------------------------------------------------------------------- */
/* pushing a lead                                                             */
/* -------------------------------------------------------------------------- */

export async function pushLead(
  campaignId: string,
  subject: PushSubject
): Promise<PushResult> {
  const capability = instantlyCapability();
  if (!capability.available) {
    return { ok: false, error: capability.reason, retryable: false };
  }
  if (!campaignId) {
    return {
      ok: false,
      error: "No Instantly campaign is selected. Pick one on the Email page first.",
      retryable: false,
    };
  }

  const res = await call("/leads", { method: "POST", body: pushBody(campaignId, subject) });
  if (!res.ok) return { ok: false, error: res.error, retryable: res.retryable };

  const body = res.body as Record<string, unknown> | null;
  const id = body?.id ?? (body?.lead as Record<string, unknown> | undefined)?.id;
  return { ok: true, instantlyLeadId: id ? String(id) : null, email: subject.email };
}

/* -------------------------------------------------------------------------- */
/* replying                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Send an approved reply through Instantly's inbox.
 *
 * PARTICULARLY UNVERIFIED. The push endpoint above is at least a documented
 * shape that a wrong guess fails loudly on; this one puts words in front of a
 * prospect. So the flow around it is built to work WITHOUT it: the admin page
 * offers "copy into the Instantly inbox" first and treats this as the
 * convenience, and a failure here never marks a draft as sent.
 *
 * `replyToUuid` is Instantly's id for the message being answered. Without it
 * a reply would start a new thread instead of continuing the conversation,
 * which is why an absent id is refused rather than sent anyway.
 */
export async function sendReply(input: {
  replyToUuid: string | null;
  campaignId: string | null;
  toEmail: string;
  subject: string;
  body: string;
}): Promise<{ ok: true; id: string | null } | { ok: false; error: string }> {
  const capability = instantlyCapability();
  if (!capability.available) return { ok: false, error: capability.reason };
  if (!input.replyToUuid) {
    return {
      ok: false,
      error:
        "Instantly did not send us an id for the message being answered, so a reply here would start a new thread rather than continue theirs. Copy the draft into the Instantly inbox instead.",
    };
  }

  const res = await call("/emails/reply", {
    method: "POST",
    body: {
      reply_to_uuid: input.replyToUuid,
      eaccount: undefined,
      subject: input.subject,
      body: { text: input.body },
      to_address_email_list: input.toEmail,
      campaign_id: input.campaignId || undefined,
    },
  });
  if (!res.ok) return { ok: false, error: res.error };
  const body = res.body as Record<string, unknown> | null;
  return { ok: true, id: body?.id ? String(body.id) : null };
}

/* -------------------------------------------------------------------------- */
/* publishing a sequence                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Put a generated sequence into the campaign.
 *
 * UNVERIFIED, like the rest of this file, and the flow around it is built to
 * survive that: a failure here leaves the sequence marked active in our own
 * database with a "copy this into Instantly" view on the page, and says so.
 * Nothing pretends the campaign was updated when it was not.
 *
 * This OVERWRITES the campaign's existing steps. That is the intent — one
 * active sequence, so anybody can say what a lead pushed today will receive —
 * but it is worth a sentence, because it means publishing discards whatever
 * was typed into the Instantly editor by hand.
 */
export async function publishSequence(
  campaignId: string,
  steps: { step: number; delayDays: number; subject: string; body: string }[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  const capability = instantlyCapability();
  if (!capability.available) return { ok: false, error: capability.reason };
  if (!campaignId) {
    return { ok: false, error: "No Instantly campaign is selected, so there is nowhere to publish to." };
  }
  if (steps.length === 0) {
    return { ok: false, error: "The sequence has no emails in it." };
  }

  /*
   * TRY, THEN GO AND LOOK — for each format in turn.
   *
   * This shape exists because of a real campaign: four emails published with
   * their subject lines intact and every single body blank, for days, while
   * this app reported "Published". The PATCH had returned 200. An accepted
   * request and a correct one are different facts, and the only way to have
   * the second is to read the campaign back.
   *
   * Two formats are tried because which one this API wants is not something
   * we get to know from in here — the documented one first, the previous
   * assumption second. Verifying BETWEEN them is what makes trying two
   * honest rather than a shotgun: each attempt is checked against the real
   * campaign, and the one reported is the one that actually stored words.
   */
  let last: { blank: number; fused: number; stored: number } | null = null;

  for (const format of ["paragraphs", "html", "text"] as const) {
    const res = await call(`/campaigns/${encodeURIComponent(campaignId)}`, {
      method: "PATCH",
      body: { sequences: [toInstantlySequence(steps, format)] },
    });
    if (!res.ok) return { ok: false, error: res.error };

    const stored = await readPublishedSteps(campaignId);

    /*
     * Could not check. NOT reported as a failure to publish — the PATCH did
     * succeed, and calling that a failure sends somebody chasing copy that is
     * fine. It does mean there is no point trying the other format, because
     * there is no way to tell whether this one worked.
     */
    if (stored === null) return { ok: true };

    const blank = stored.filter((s) => !hasVisibleText(s.body)).length;

    /*
     * Structure, not just presence.
     *
     * "Is it empty" was too weak a check and shipped the second failure: the
     * bodies came back full of words with every paragraph fused into one
     * block, and passed. A step written as four paragraphs that stores as one
     * did not survive, so it is compared against what was sent.
     */
    const fused = stored.filter((s, i) => {
      const sent = steps[i];
      if (!sent) return false;
      const wanted = countBlocks(formatBody(sent.body, format));
      return wanted > 1 && countBlocks(s.body) < wanted;
    }).length;

    if (blank === 0 && fused === 0 && stored.length >= steps.length) return { ok: true };
    last = { blank, fused, stored: stored.length };
  }

  if (last && last.stored < steps.length) {
    return {
      ok: false,
      error:
        `Instantly stored ${last.stored} of the ${steps.length} emails in this sequence. ` +
        `The rest were dropped, so the campaign is not what was written here.`,
    };
  }
  if (last && last.blank > 0) {
    return {
      ok: false,
      error:
        `Instantly accepted the sequence but stored ${last.blank} of ${last.stored} emails with ` +
        `an empty body — the subjects arrived and the words did not. All three formats were ` +
        `tried and none stuck, so this is something about the campaign or the account rather ` +
        `than the formatting. Press "Read it" below and paste the emails in by hand for now.`,
    };
  }
  return {
    ok: false,
    error:
      `The copy is in Instantly, but ${last?.fused ?? 0} of ${last?.stored ?? 0} emails lost ` +
      `their paragraph breaks and will arrive as one block of text. Everything is there and it ` +
      `will send — it just reads badly. Open the campaign's sequence editor and put the line ` +
      `breaks back, or press "Read it" below and paste them in.`,
  };
}

/**
 * What Instantly currently has for a campaign, as opposed to what we sent.
 *
 * Null when it cannot be read — never an empty list, which would read as "the
 * campaign has no copy" and is the sort of thing that gets somebody to
 * republish over copy that was fine.
 */
export async function readPublishedSteps(
  campaignId: string
): Promise<{ subject: string; body: string }[] | null> {
  if (!campaignId || !instantlyCapability().available) return null;
  const res = await call(`/campaigns/${encodeURIComponent(campaignId)}`, { method: "GET" });
  if (!res.ok) return null;
  return readCampaignSteps(res.body);
}

/**
 * How many leads are still being worked in the campaign.
 *
 * The refill tops up to a target, and a target needs a current number. Returns
 * null rather than 0 when it cannot tell — a refill that reads "0 active" from
 * a failed request would push a full batch into a campaign that is already
 * full, which is the one mistake this whole number exists to prevent.
 */
export async function activeLeadCount(campaignId: string): Promise<number | null> {
  if (!campaignId || !instantlyCapability().available) return null;
  const res = await call("/leads/list", {
    method: "POST",
    body: { campaign: campaignId, limit: 1 },
  });
  if (!res.ok) return null;
  const body = res.body as Record<string, unknown> | null;
  for (const key of ["total", "total_count", "count"]) {
    const v = body?.[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* the sending accounts                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every inbox in the workspace, with what it is currently allowed to send.
 *
 * This is the number the whole capacity plan rests on, so a failure here has
 * to be a failure — never an empty list. An empty list reads as "no capacity",
 * which would stop the programme dead and look like a configuration problem
 * rather than a request that did not come back.
 */
export async function listAccounts(): Promise<
  { ok: true; accounts: SendingAccountRow[] } | { ok: false; error: string }
> {
  const res = await call("/accounts?limit=100", { method: "GET" });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, accounts: normaliseAccounts(res.body) };
}

/**
 * Change what one inbox may send in a day.
 *
 * The only call in this codebase that writes a setting into somebody else's
 * account, so it is worth being explicit about what protects it: the decision
 * of whether and how far to move is made in sendingCapacity.ts, which is pure
 * and tested, and every change is written to account_limit_changes with its
 * reason before this is called. This function does not decide anything.
 */
export async function setAccountDailyLimit(
  email: string,
  dailyLimit: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  const capability = instantlyCapability();
  if (!capability.available) return { ok: false, error: capability.reason };
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 500) {
    // A guard against a caller, not against the policy: the policy already
    // bounds this. Belt and braces on the one call that changes an account.
    return { ok: false, error: `Refusing to set a daily limit of ${dailyLimit}.` };
  }

  const res = await call(`/accounts/${encodeURIComponent(email)}`, {
    method: "PATCH",
    body: { daily_limit: dailyLimit },
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}
