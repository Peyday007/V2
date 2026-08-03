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
    });
  }
  return out;
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
