import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { syncSendingAccounts, activeSequenceSteps } from "@/lib/capacitySync";
import { loadSettings, migrationHint } from "@/lib/instantlyStore";
import { campaignDailyLimit } from "@/lib/instantly/client";
import {
  computeCapacity,
  smartDailyCap,
  planAllLimits,
  daysToCeiling,
  DEFAULT_RAMP,
  type SendingAccount,
} from "@/lib/sendingCapacity";

export const dynamic = "force-dynamic";

/*
 * The inboxes: what they can carry, and what would happen to them.
 *
 * GET is entirely local — it reads the cached account rows and runs the same
 * pure planner the worker runs, so the page can show exactly what WOULD happen
 * without anything happening. A preview that runs different code from the
 * thing it previews is worth nothing.
 *
 * POST is the one that acts, and it takes an explicit `adjust` flag rather
 * than inferring it, so "refresh the numbers" and "go and change my accounts"
 * are visibly different requests.
 */

const ACCOUNT_COLUMNS =
  "email, daily_limit, warmup_score, warmup_status, active, provider_created_at, last_changed_at, last_change_reason, excluded, last_synced_at";

export async function GET() {
  const { settings, error, capacityAvailable } = await loadSettings();
  if (!capacityAvailable) {
    return NextResponse.json({
      available: false,
      error:
        "Run supabase/migrations/0031_sending_capacity.sql to switch this on. Until then the daily cap stays the number you typed.",
      accounts: [],
      changes: [],
      holds: [],
    });
  }

  const db = supabaseAdmin();
  const { data, error: readErr } = await db
    .from("sending_accounts")
    .select(ACCOUNT_COLUMNS)
    .order("daily_limit", { ascending: false });
  if (readErr) {
    return NextResponse.json(
      { available: false, error: migrationHint(readErr.message) || readErr.message, accounts: [] },
      { status: 200 }
    );
  }

  const rows = data || [];
  const accounts: SendingAccount[] = rows.map((a) => ({
    email: String(a.email),
    dailyLimit: Number(a.daily_limit || 0),
    warmupScore: a.warmup_score === null || a.warmup_score === undefined ? null : Number(a.warmup_score),
    warmupStatus: a.warmup_status ?? null,
    active: !!a.active,
    createdAt: a.provider_created_at ?? null,
    lastRaisedAt: a.last_changed_at ?? null,
  }));

  const policy = { ...DEFAULT_RAMP, ceiling: settings.account_limit_ceiling || DEFAULT_RAMP.ceiling };
  const headroom = Number(settings.capacity_headroom) || 0.85;
  const steps = await activeSequenceSteps();

  /*
   * The one non-local read on this route, and it earns its place.
   *
   * The campaign's daily limit is the cap that actually decides how much goes
   * out, and it lives only in Instantly — there is no copy here to read. It is
   * also the field somebody edits when they want more volume, so caching it
   * would show a stale number at exactly the moment it changed. Null on any
   * failure, which falls back to the inbox total and says so.
   */
  const campaignLimit = settings.campaign_id
    ? await campaignDailyLimit(settings.campaign_id).catch(() => null)
    : null;

  // The plan is computed over the accounts that are NOT excluded, matching
  // exactly what the worker would do.
  const adjustable = accounts.filter((a, i) => !rows[i].excluded);
  const { changes, holds } = planAllLimits(adjustable, policy);

  const recent = await db
    .from("account_limit_changes")
    .select("email, limit_before, limit_after, direction, reason, actor, applied, error, created_at")
    .order("created_at", { ascending: false })
    .limit(25);

  return NextResponse.json({
    available: true,
    error,
    accounts: rows.map((a, i) => ({ ...a, ...accounts[i] })),
    capacity: computeCapacity(accounts, headroom, campaignLimit),
    smart: smartDailyCap(accounts, steps, headroom, campaignLimit),
    campaignDailyLimit: campaignLimit,
    sequenceSteps: steps,
    ceiling: policy.ceiling,
    daysToCeiling: daysToCeiling(adjustable, policy),
    changes,
    holds,
    history: recent.data || [],
  });
}

/**
 * Refresh from Instantly, and — only if asked — apply the limit changes.
 *
 * Deliberately usable in both modes from the page: "Check the inboxes" runs it
 * with adjust false and shows what would happen, "Apply" runs it with adjust
 * true. Same code path either way.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const adjust = body.adjust === true;

  if (adjust && body.acknowledge_external !== true) {
    /*
     * Changing a daily limit writes a setting into somebody else's account.
     * That is the only thing in this whole system that does, so it is not done
     * on an unqualified POST — the caller has to say they mean it.
     */
    return NextResponse.json(
      {
        error:
          "Applying changes edits the sending limits on your Instantly accounts. Confirm you intend that.",
      },
      { status: 400 }
    );
  }

  const outcome = await syncSendingAccounts({ adjust, actor: "admin" });
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: 502 });
  }
  return NextResponse.json(outcome);
}

/** Leave one inbox alone, or stop leaving it alone. */
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) return NextResponse.json({ error: "Which account?" }, { status: 400 });
  if (typeof body.excluded !== "boolean") {
    return NextResponse.json({ error: "Excluded or not?" }, { status: 400 });
  }

  const { error } = await supabaseAdmin()
    .from("sending_accounts")
    .update({ excluded: body.excluded })
    .eq("email", email);
  if (error) {
    return NextResponse.json({ error: migrationHint(error.message) || error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
