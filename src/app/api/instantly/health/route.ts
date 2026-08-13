import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { instantlyCapability, listCampaigns, campaignSendLedger } from "@/lib/instantly/client";
import { loadSettings } from "@/lib/instantlyStore";
import { emailHealth, type HealthFacts } from "@/lib/emailHealth";
import { isMissingColumnError } from "@/lib/enrichmentGrade";
import { summarizeEmailAvailability, type EmailLeadRow } from "@/lib/emailEligibility";

export const dynamic = "force-dynamic";

/*
 * "Is email actually running?" — answered in one request.
 *
 * Every fact here was already on the page, in six different cards, and none of
 * them answered the question. The worst of them was silent: the campaign
 * selector read "AI Dispatch — 3", and 3 is Instantly's code for Completed, a
 * campaign that sends nothing. Leads could be pushed into it all day.
 *
 * Every lookup is individually guarded. A health check that goes down when one
 * of its inputs is missing is worse than no health check, because it turns a
 * clear "the campaign is paused" into a blank card.
 */

async function safe<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch {
    return fallback;
  }
}

export async function GET() {
  const db = supabaseAdmin();
  const capability = instantlyCapability();
  // Settings read on its own, so a failure here reports as "not connected"
  // rather than taking the whole card down.
  let settings: Awaited<ReturnType<typeof loadSettings>>["settings"] | null = null;
  try {
    settings = (await loadSettings()).settings;
  } catch {
    settings = null;
  }

  /* ------------------------- the campaign's real state ------------------- */
  let campaignStatus: string | null = null;
  let campaignName: string | null = null;
  let campaignReadable = false;
  if (capability.available && settings?.campaign_id) {
    const res = await safe(() => listCampaigns(), { ok: false as const, error: "unreachable" });
    if (res.ok) {
      const mine = res.campaigns.find((c) => c.id === settings.campaign_id);
      if (mine) {
        campaignReadable = true;
        campaignStatus = mine.status;
        campaignName = mine.name;
      }
    }
  }

  /* ------------------------------ who is sendable ------------------------ */
  let sendable = 0;
  let pushedTotal = 0;
  await safe(async () => {
    const { data: threads } = await db.from("email_threads").select("lead_id").limit(50000);
    const already = new Set((threads || []).map((t) => String(t.lead_id)));
    pushedTotal = already.size;

    /*
     * THE NAME COLUMNS ARE PART OF THIS QUERY, not an afterthought.
     *
     * `sendable` now means "meets the recipient rule" — a personal address
     * with somebody named behind it — and without decision_maker_name and
     * owner_name in the select, every lead reads as unnamed and the figure
     * would be a flat zero however healthy the list is. The same omission
     * silently zeroed the reach breakdown once already.
     *
     * Column tiers: website_email arrives with 0030, direct_email with 0023,
     * decision_maker_name with 0023 as well.
     */
    const BASE = "id, owner_email, owner_name, do_not_call, archived_at, email_unsubscribed_at, email_bounced_at";
    const tiers = [
      `${BASE}, decision_maker_name, direct_email, website_email, website_email_kind`,
      `${BASE}, decision_maker_name, direct_email, website_email`,
      `${BASE}, decision_maker_name, website_email`,
      `${BASE}, website_email`,
      BASE,
    ];
    for (const columns of tiers) {
      const res = await db.from("leads").select(columns).is("archived_at", null).limit(20000);
      if (!res.error) {
        const rows = res.data as unknown as (EmailLeadRow & { id: string })[];
        /*
         * The POLICY count, not the "has any address" count. The card's whole
         * job is to say whether email can run; reporting contacts the push
         * will refuse is how "323 sendable" sat next to a campaign that could
         * not be topped up.
         */
        sendable = summarizeEmailAvailability(rows.filter((r) => !already.has(r.id))).reach
          .personalAndNamed;
        return;
      }
      if (!isMissingColumnError(res.error)) return;
    }
  }, undefined);

  /* -------------------------------- the worker --------------------------- */
  let workerMinutesAgo: number | null = null;
  await safe(async () => {
    const { data } = await db
      .from("jobs")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1);
    const newest = data?.[0]?.created_at;
    if (newest) {
      workerMinutesAgo = Math.max(
        0,
        Math.round((Date.now() - new Date(newest).getTime()) / 60000)
      );
    }
  }, undefined);

  /* ---------------------- did Instantly actually send -------------------- */
  let sentLast24h = 0;
  let repliesLast7d = 0;
  await safe(async () => {
    const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const [{ count: sent }, { count: replies }] = await Promise.all([
      db
        .from("email_events")
        .select("*", { count: "exact", head: true })
        .eq("event_type", "sent")
        .gte("occurred_at", dayAgo),
      db
        .from("email_events")
        .select("*", { count: "exact", head: true })
        .eq("event_type", "replied")
        .gte("occurred_at", weekAgo),
    ]);
    sentLast24h = sent || 0;
    repliesLast7d = replies || 0;
  }, undefined);

  /*
   * RECONCILE AGAINST INSTANTLY'S OWN LEDGER.
   *
   * The counts above come from email_events, which is filled by webhooks.
   * Webhooks are event detail: they arrive when they arrive, and they are
   * silently absent if the endpoint was down or the shared secret was wrong.
   * Reading a total off them reported "nothing sent in 24 hours" on a campaign
   * that was sending a hundred a day, and put a red warning on a healthy
   * programme.
   *
   * The larger of the two wins. A webhook we hold that analytics has not yet
   * counted is still a real send, and an analytics figure larger than our
   * webhook count means deliveries we simply never received. Neither can be
   * subtracted from the other, so taking the maximum is the only reconciliation
   * that cannot under-report.
   *
   * A failed read leaves the webhook figure exactly as it was — null from the
   * ledger means "could not ask", never "nothing was sent".
   */
  let ledgerRead = false;
  if (settings?.campaign_id) {
    await safe(async () => {
      const now = new Date();
      const ledger = await campaignSendLedger(
        settings!.campaign_id!,
        new Date(now.getTime() - 24 * 3600_000),
        now
      );
      if (!ledger) return;
      ledgerRead = true;
      sentLast24h = Math.max(sentLast24h, ledger.sent);
      repliesLast7d = Math.max(repliesLast7d, ledger.replies);
    }, undefined);
  }

  /*
   * What the automatic top-up last decided. Reads the columns 0037 adds, and
   * degrades to null rather than failing when it has not been run.
   */
  let refillNote: string | null = null;
  let refillCheckedMinutesAgo: number | null = null;
  await safe(async () => {
    const { data, error } = await db
      .from("instantly_settings")
      .select("last_refill_note, last_refill_checked_at")
      .eq("id", true)
      .maybeSingle();
    if (error || !data) return;
    refillNote = (data.last_refill_note as string | null) ?? null;
    const at = data.last_refill_checked_at as string | null;
    if (at) {
      refillCheckedMinutesAgo = Math.max(
        0,
        Math.round((Date.now() - new Date(at).getTime()) / 60000)
      );
    }
  }, undefined);

  let hasActiveSequence = false;
  await safe(async () => {
    const { count } = await db
      .from("email_sequences")
      .select("*", { count: "exact", head: true })
      .eq("status", "active");
    hasActiveSequence = (count || 0) > 0;
  }, undefined);

  const facts: HealthFacts = {
    connected: capability.available,
    connectionReason: capability.reason,
    programmeOn: !!settings?.enabled,
    campaignId: settings?.campaign_id ?? null,
    campaignName,
    campaignStatus,
    campaignReadable,
    hasActiveSequence,
    sendable,
    pushedTotal,
    workerMinutesAgo,
    autoPushOn: !!settings?.auto_push_enabled,
    sentLast24h,
    repliesLast7d,
    refillNote,
    refillCheckedMinutesAgo,
  };

  return NextResponse.json({
    health: emailHealth(facts),
    facts,
    // Which source the send count came from, so "0 sent" can be read as
    // "Instantly says none" rather than "we could not ask".
    sendCountSource: ledgerRead ? "instantly_analytics" : "webhooks_only",
    error: null,
  });
}
