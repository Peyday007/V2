import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordEvent } from "@/lib/events";
import { instantlyCapability, listCampaigns, webhookSecretConfigured } from "@/lib/instantly/client";
import {
  loadSettings,
  migrationHint,
  selectEmailLeads,
  SETTINGS_COLUMNS,
  type InstantlySettings,
} from "@/lib/instantlyStore";
import { summarizeEmailAvailability } from "@/lib/emailEligibility";
import { dailyCounterFor, todayString } from "@/lib/refillPlan";

export const dynamic = "force-dynamic";

/**
 * The state of the whole integration, in one call.
 *
 * Includes the counts, because the settings for a cold-email programme were
 * otherwise chosen blind: "push 50 per run" means nothing until you know
 * whether 50 or 5000 leads have an email address at all. The same reasoning as
 * the lead-state counts on the recording settings page.
 */
export async function GET() {
  const { settings, error, autoPushAvailable, capacityAvailable } = await loadSettings();
  const capability = instantlyCapability();

  // How many leads could actually be emailed. Never allowed to fail the page.
  let availability = { available: 0, total: 0, reasons: [] as { reason: string; count: number }[] };
  let pushed = 0;
  let awaitingHuman = 0;
  let countsError: string | null = null;
  let addressTier = 0;
  try {
    const db = supabaseAdmin();
    // The shared reader, so this count and the push itself can never disagree
    // about which leads exist. It steps down through the optional address
    // columns rather than failing when a migration has not been run.
    const leads = await selectEmailLeads();
    if (leads.error) countsError = leads.error;
    availability = summarizeEmailAvailability(leads.rows);
    addressTier = leads.tier;

    const { count: threads } = await db
      .from("email_threads")
      .select("*", { count: "exact", head: true });
    pushed = threads || 0;

    const { count: drafts } = await db
      .from("email_drafts")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending");
    awaitingHuman = drafts || 0;
  } catch (e) {
    countsError = countsError || (e instanceof Error ? e.message : String(e));
  }

  // Only fetched when there is a key to fetch with, so the page does not sit
  // waiting on a request that cannot succeed.
  let campaigns: { id: string; name: string; status: string | null }[] = [];
  let campaignsError: string | null = null;
  if (capability.available) {
    const res = await listCampaigns();
    if (res.ok) campaigns = res.campaigns;
    else campaignsError = res.error;
  }

  return NextResponse.json({
    settings,
    error,
    countsError,
    capability,
    webhookSecretSet: webhookSecretConfigured(),
    campaigns,
    campaignsError,
    availability,
    pushed,
    awaitingHuman,
    autoPushAvailable,
    capacityAvailable,
    /*
     * Which sources of an address this database actually has.
     *
     * Worth surfacing rather than leaving as a mystery: with neither of these,
     * every lead reads "no email address on record" and the programme has
     * nobody to write to — which is exactly the state this page was in before
     * the crawler started reading contact pages.
     */
    addressSources: {
      websiteEmail: addressTier === 0 || addressTier === 2,
      directEmail: addressTier === 0 || addressTier === 1,
    },
    pushedToday: dailyCounterFor(
      { pushedToday: settings.pushed_today, pushedTodayDate: settings.pushed_today_date },
      todayString()
    ),
  });
}

/**
 * Save the settings.
 *
 * Two of these are decisions somebody should be able to date afterwards —
 * turning the programme on, and turning off the requirement that a person
 * reads a reply before it is answered — so both are written to the event log
 * with their previous value.
 */
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

  if (typeof body.campaign_id === "string") {
    patch.campaign_id = body.campaign_id.trim() || null;
  }
  if (typeof body.campaign_name === "string") {
    patch.campaign_name = body.campaign_name.trim() || null;
  }

  if (body.max_push_per_run !== undefined) {
    const n = Number(body.max_push_per_run);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      return NextResponse.json(
        {
          error:
            "Push between 1 and 500 leads per run. The cap is the thing that makes a mistake cost a batch instead of a list.",
        },
        { status: 400 }
      );
    }
    patch.max_push_per_run = n;
  }

  if (body.reply_confidence_floor !== undefined) {
    const f = Number(body.reply_confidence_floor);
    if (!Number.isFinite(f) || f < 0 || f > 1) {
      return NextResponse.json({ error: "The confidence floor is between 0 and 1." }, { status: 400 });
    }
    patch.reply_confidence_floor = f;
  }

  if (typeof body.auto_reply_enabled === "boolean") {
    /*
     * Switching this on means a message can reach a prospect in our name with
     * nobody having read it. That is a real decision and it is not made by
     * ticking a box on the way past — the caller has to say so explicitly.
     */
    if (body.auto_reply_enabled === true && body.acknowledge_autonomous !== true) {
      return NextResponse.json(
        {
          error:
            "Turning on automatic replies means an email goes to a prospect without anyone reading it. Confirm you intend that.",
        },
        { status: 400 }
      );
    }
    patch.auto_reply_enabled = body.auto_reply_enabled;
  }

  /* --------------------------- sending capacity --------------------------- */

  if (typeof body.smart_capacity_enabled === "boolean") {
    /*
     * Safe to turn on without ceremony: it only ever READS the accounts and
     * recomputes the cap from them. A number derived from what the inboxes can
     * actually carry is strictly better informed than one typed months ago.
     */
    patch.smart_capacity_enabled = body.smart_capacity_enabled;
  }

  if (body.account_limit_ceiling !== undefined) {
    const n = Number(body.account_limit_ceiling);
    if (!Number.isInteger(n) || n < 10 || n > 200) {
      return NextResponse.json(
        {
          error:
            "A ceiling between 10 and 200 a day per inbox. Above roughly 100 the mailbox providers start treating an address as a bulk sender however well it is warmed.",
        },
        { status: 400 }
      );
    }
    patch.account_limit_ceiling = n;
  }

  if (body.capacity_headroom !== undefined) {
    const f = Number(body.capacity_headroom);
    if (!Number.isFinite(f) || f < 0.1 || f > 1) {
      return NextResponse.json(
        { error: "Headroom is a share between 0.1 and 1 — 0.85 means plan against 85% of capacity." },
        { status: 400 }
      );
    }
    patch.capacity_headroom = f;
  }

  if (typeof body.auto_adjust_limits_enabled === "boolean") {
    /*
     * This one DOES need ceremony. It is the only setting in the system that
     * writes into an external account, and somebody switching it on should
     * know that is what they are doing.
     */
    if (body.auto_adjust_limits_enabled === true && body.acknowledge_external !== true) {
      return NextResponse.json(
        {
          error:
            "This changes the daily sending limits on your Instantly accounts for you. Confirm you intend that.",
        },
        { status: 400 }
      );
    }
    patch.auto_adjust_limits_enabled = body.auto_adjust_limits_enabled;
  }

  /* ------------------------- the automatic top-up ------------------------- */

  if (body.target_active_leads !== undefined) {
    const n = Number(body.target_active_leads);
    if (!Number.isInteger(n) || n < 1 || n > 5000) {
      return NextResponse.json(
        { error: "Keep between 1 and 5000 leads alive in the campaign." },
        { status: 400 }
      );
    }
    patch.target_active_leads = n;
  }

  if (body.daily_push_cap !== undefined) {
    // Refused rather than silently ignored while smart capacity owns this
    // number: a field that accepts a value and then overwrites it on the next
    // sync is worse than one that says no.
    const current = await loadSettings();
    if (current.settings.smart_capacity_enabled && body.smart_capacity_enabled !== false) {
      return NextResponse.json(
        {
          error:
            "The daily cap is being worked out from what your inboxes can carry. Switch smart capacity off first if you want to set it by hand.",
        },
        { status: 400 }
      );
    }
    const n = Number(body.daily_push_cap);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      return NextResponse.json(
        {
          error:
            "A daily cap between 1 and 1000. This is a deliverability limit, not a preference — a domain that goes from nothing to a thousand emails in an afternoon gets filtered, and it does not recover.",
        },
        { status: 400 }
      );
    }
    patch.daily_push_cap = n;
  }

  if (typeof body.auto_push_enabled === "boolean") {
    /*
     * Switching this on hands over the decision to send. Same treatment as
     * automatic replies: the caller has to say explicitly that they mean it,
     * because a box ticked on the way past is not an administrator enabling
     * autonomous sending, it is an accident.
     */
    if (body.auto_push_enabled === true) {
      if (body.acknowledge_autonomous !== true) {
        return NextResponse.json(
          {
            error:
              "Turning this on means leads get emailed without you pressing anything. Confirm you intend that.",
          },
          { status: 400 }
        );
      }
      const current = await loadSettings();
      // A top-up with no sequence would send whatever happens to be in the
      // Instantly campaign — possibly a half-written draft.
      if (!current.settings.campaign_id) {
        return NextResponse.json(
          { error: "Pick a campaign before switching on automatic top-ups." },
          { status: 400 }
        );
      }
    }
    patch.auto_push_enabled = body.auto_push_enabled;
  }

  // Switching the programme on with no campaign selected would push every
  // lead nowhere and mark them all failed.
  if (patch.enabled === true) {
    const current = await loadSettings();
    const campaign = (patch.campaign_id as string | null) ?? current.settings.campaign_id;
    if (!campaign) {
      return NextResponse.json(
        { error: "Pick an Instantly campaign before switching this on — there is nowhere to push to." },
        { status: 400 }
      );
    }
  }

  try {
    const db = supabaseAdmin();
    const { data: before } = await db
      .from("instantly_settings")
      .select(SETTINGS_COLUMNS)
      .eq("id", true)
      .maybeSingle();

    const { error } = await db.from("instantly_settings").update(patch).eq("id", true);
    if (error) {
      return NextResponse.json({ error: migrationHint(error.message) || error.message }, { status: 500 });
    }

    await recordEvent({
      type: "prompt.changed",
      entityType: "prompt",
      entityId: "instantly:settings",
      actorType: "admin",
      source: "ui",
      previousValue: (before as InstantlySettings | null) ?? null,
      newValue: patch,
      metadata: { area: "instantly_email" },
      verificationStatus: "verified",
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: migrationHint(msg) || msg }, { status: 500 });
  }
}
