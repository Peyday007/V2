// The parts of the Instantly client that are pure: what a request body looks
// like, how a response is read, and how an HTTP status is explained.
//
// Split out of client.ts for one reason — client.ts imports `server-only`, so
// anything living there cannot be unit-tested. Given the whole adapter is
// UNVERIFIED against a live account, the mapping is exactly the part that most
// needs a test, so it lives where a test can reach it.

import type { Campaign, PushSubject } from "./types";

/** HTTP status in the sender's own words, rather than a bare number. */
export function explainStatus(status: number, detail: string): string {
  const tail = detail ? ` (${detail})` : "";
  if (status === 401 || status === 403) {
    return `Instantly rejected the API key. Check INSTANTLY_API_KEY is a v2 key from Settings → Integrations, and that it has not been revoked.${tail}`;
  }
  if (status === 404) {
    return `Instantly could not find that campaign. Pick the campaign again on the Email page — it may have been deleted or belong to another workspace.${tail}`;
  }
  if (status === 422 || status === 400) {
    return `Instantly refused the lead as malformed. This usually means a missing or invalid email address.${tail}`;
  }
  if (status === 429) {
    return `Instantly is rate-limiting us. The rest of the batch was not pushed; run it again in a few minutes.${tail}`;
  }
  if (status >= 500) {
    return `Instantly returned a server error. Nothing was pushed; try again shortly.${tail}`;
  }
  return `Instantly returned HTTP ${status}.${tail}`;
}

/**
 * Read a campaign list.
 *
 * Accepts a bare array, `{ items: [] }` and `{ data: [] }`, because paginated
 * list endpoints change their envelope more often than they change their
 * contents, and a campaign list that silently comes back empty would present
 * as "you have no campaigns" rather than as a parsing bug.
 */
export function normaliseCampaigns(body: unknown): Campaign[] {
  const container = body as { items?: unknown; data?: unknown } | unknown[];
  const list = Array.isArray(container)
    ? container
    : Array.isArray((container as { items?: unknown })?.items)
      ? (container as { items: unknown[] }).items
      : Array.isArray((container as { data?: unknown })?.data)
        ? (container as { data: unknown[] }).data
        : [];

  const out: Campaign[] = [];
  for (const entry of list) {
    const o = entry as Record<string, unknown>;
    const id = o?.id ?? o?.campaign_id;
    if (!id) continue;
    out.push({
      id: String(id),
      name: String(o?.name ?? o?.campaign_name ?? "Untitled campaign"),
      status: o?.status === undefined || o?.status === null ? null : String(o.status),
      /*
       * The campaign's own daily cap, which is usually the real constraint on
       * how much goes out — see computeCapacity. Null when it is not in the
       * response, never a guessed default: a guess here would silently change
       * how many leads a day the top-up pushes.
       */
      dailyLimit: firstNumber(o, ["daily_limit", "dailyLimit", "campaign_daily_limit"]),
    });
  }
  return out;
}

/**
 * How the line breaks are carried across.
 *
 * Two formats because we do not get to know which one this account's API
 * wants, and guessing cost a campaign: four emails published with their
 * subjects intact and every body blank, for days, with the app reporting
 * success. So both are expressed here and the publisher tries them against
 * the real campaign, reading back which one actually stored.
 *
 *   "text"  — what Instantly's own API documentation shows: a plain string
 *             with \n between the lines. Tried FIRST, because it is the
 *             documented contract rather than an inference.
 *   "html"  — <br> between lines, markup escaped. What this code used to send
 *             on the assumption that the editor renders HTML.
 */
export type BodyFormat = "text" | "html";

export function formatBody(body: string, format: BodyFormat): string {
  if (format === "text") return body;
  return body
    .split("\n")
    .map((line) => (line.trim() === "" ? "<br>" : escapeHtml(line)))
    .join("<br>");
}

/**
 * Our sequence, in Instantly's shape.
 *
 * THE OFF-BY-ONE HERE IS THE WHOLE FUNCTION. The two systems count the gap
 * from opposite ends:
 *
 *   ours       — `delayDays` on a step is the wait BEFORE it. Step 1 is 0.
 *   Instantly  — `delay` on a step is the wait AFTER it, before the next one.
 *
 * So the wait that we hang on step N+1 has to be hung on step N going out.
 * Getting this backwards does not fail: it produces a sequence that sends on
 * the wrong days, silently, for as long as it runs. Hence a pure function with
 * a test rather than an inline map inside the route.
 */
export function toInstantlySequence(
  steps: { step: number; delayDays: number; subject: string; body: string }[],
  format: BodyFormat = "text"
): { steps: { type: string; delay: number; variants: { subject: string; body: string }[] }[] } {
  return {
    steps: steps.map((s, i) => ({
      type: "email",
      // The wait after this one is the wait the NEXT one asked for. The last
      // step has nothing following it, so it waits for nothing.
      delay: i + 1 < steps.length ? steps[i + 1].delayDays : 0,
      variants: [
        {
          subject: s.subject,
          body: formatBody(s.body, format),
        },
      ],
    })),
  };
}

/**
 * Read the steps back OUT of a campaign, as Instantly actually stored them.
 *
 * The other half of publishing, and the half that was missing. A PATCH that
 * returns 200 proves the request was accepted, not that the copy arrived —
 * and a campaign whose subjects are present while every body is blank returns
 * 200 exactly like a campaign that worked. Without reading back, the page says
 * "Published" either way, which is the one thing it must never do.
 *
 * Tolerant about shape for the same reason as every other reader here: this is
 * used to decide whether to REPORT A PROBLEM, so a field rename must not
 * manufacture an empty body and cry wolf about copy that is really there.
 */
export function readCampaignSteps(
  body: unknown
): { subject: string; body: string }[] | null {
  const campaign = body as Record<string, unknown> | null;
  if (!campaign || typeof campaign !== "object") return null;

  const sequences = campaign.sequences;
  if (!Array.isArray(sequences) || sequences.length === 0) return null;

  // Only the first sequence carries the copy — Instantly's own documentation
  // says the array exists but only element zero is used.
  const first = sequences[0] as Record<string, unknown> | null;
  const steps = first?.steps;
  if (!Array.isArray(steps)) return null;

  const out: { subject: string; body: string }[] = [];
  for (const entry of steps) {
    const step = entry as Record<string, unknown>;
    const variants = Array.isArray(step?.variants) ? step.variants : [];
    const variant = (variants[0] ?? {}) as Record<string, unknown>;
    out.push({
      subject: firstString(variant, ["subject"]) ?? "",
      body: firstString(variant, ["body"]) ?? "",
    });
  }
  return out;
}

/**
 * Is there anything a prospect would actually read?
 *
 * Tags alone are not content. A body of "<br><br>" or "<div></div>" renders as
 * a blank email, and it is the exact shape a mangled round-trip produces, so
 * emptiness is judged on what survives stripping the markup out.
 */
export function hasVisibleText(html: string): boolean {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .trim().length > 0;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Read the sending-account list.
 *
 * Tolerant about key names for the same reason as the webhook parser: this
 * feeds a number that decides how much gets sent, and a field that silently
 * reads as undefined would come back as a capacity of zero — which looks
 * exactly like "you have no inboxes" rather than like a parsing bug.
 *
 * An account whose daily limit cannot be read is returned with a limit of 0
 * rather than a guessed default. Zero drops it out of the capacity total,
 * which is the safe direction; a guessed 50 would have the planner sending
 * against inboxes it knows nothing about.
 */
export function normaliseAccounts(body: unknown): SendingAccountRow[] {
  const container = body as { items?: unknown; data?: unknown } | unknown[];
  const list = Array.isArray(container)
    ? container
    : Array.isArray((container as { items?: unknown })?.items)
      ? (container as { items: unknown[] }).items
      : Array.isArray((container as { data?: unknown })?.data)
        ? (container as { data: unknown[] }).data
        : [];

  const out: SendingAccountRow[] = [];
  for (const entry of list) {
    const o = entry as Record<string, unknown>;
    const email = firstString(o, ["email", "eaccount", "account", "from_email"]);
    if (!email) continue;

    out.push({
      email: email.toLowerCase(),
      dailyLimit: firstNumber(o, ["daily_limit", "dailyLimit", "campaign_daily_limit"]) ?? 0,
      warmupScore: firstNumber(o, ["stat_warmup_score", "warmup_score", "warmupScore"]),
      warmupStatus: firstString(o, ["warmup_status", "warmupStatus"]),
      // Instantly reports status as 1 for active. A missing status is treated
      // as active, because the alternative is silently ignoring every inbox
      // when they rename the field.
      active: isActive(o),
      createdAt: firstString(o, ["timestamp_created", "created_at", "createdAt"]),
    });
  }
  return out;
}

export type SendingAccountRow = {
  email: string;
  dailyLimit: number;
  warmupScore: number | null;
  warmupStatus: string | null;
  active: boolean;
  createdAt: string | null;
};

function isActive(o: Record<string, unknown>): boolean {
  const status = o.status ?? o.account_status;
  if (typeof status === "number") return status === 1;
  if (typeof status === "string") {
    return !/paused|disabled|inactive|error|disconnected/i.test(status);
  }
  if (typeof o.is_active === "boolean") return o.is_active;
  return true;
}

function firstString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function firstNumber(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** The body of a lead push. Pure, so a test can assert what would be sent. */
export function pushBody(campaignId: string, subject: PushSubject): Record<string, unknown> {
  return {
    campaign: campaignId,
    email: subject.email,
    // Omitted rather than sent as null: Instantly merges these into a template
    // and a null arriving in one renders as the word "null" in a prospect's
    // inbox.
    first_name: subject.firstName || undefined,
    last_name: subject.lastName || undefined,
    company_name: subject.companyName,
    website: subject.website || undefined,
    phone: subject.phone || undefined,
    personalization: subject.personalization,
    custom_variables: subject.customVariables,
    // A lead already in the campaign must not be duplicated into it. Two
    // sequences running at the same address is the fastest way to be marked
    // as spam by the only person we wanted to reach.
    skip_if_in_campaign: true,
    skip_if_in_workspace: false,
  };
}
