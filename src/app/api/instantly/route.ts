import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordEvent } from "@/lib/events";
import { instantlyCapability, listCampaigns, webhookSecretConfigured } from "@/lib/instantly/client";
import {
  loadSettings,
  migrationHint,
  SETTINGS_COLUMNS,
  type InstantlySettings,
} from "@/lib/instantlyStore";
import {
  EMAIL_ELIGIBILITY_COLUMNS,
  summarizeEmailAvailability,
  type EmailLeadRow,
} from "@/lib/emailEligibility";

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
  const { settings, error } = await loadSettings();
  const capability = instantlyCapability();

  // How many leads could actually be emailed. Never allowed to fail the page.
  let availability = { available: 0, total: 0, reasons: [] as { reason: string; count: number }[] };
  let pushed = 0;
  let awaitingHuman = 0;
  let countsError: string | null = null;
  try {
    const db = supabaseAdmin();
    const { data: rows, error: leadsErr } = await db
      .from("leads")
      .select(EMAIL_ELIGIBILITY_COLUMNS)
      .is("archived_at", null)
      .limit(50000);
    if (leadsErr) {
      // The two unsubscribe columns arrive with 0029. Before it is run this
      // select fails outright — say which migration, do not show a bare error.
      countsError = migrationHint(leadsErr.message) || leadsErr.message;
    } else {
      availability = summarizeEmailAvailability((rows || []) as EmailLeadRow[]);
    }

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
