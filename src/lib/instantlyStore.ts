import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";
import { isMissingColumnError } from "./enrichmentGrade";
import { EMAIL_ELIGIBILITY_TIERS, type EmailLeadRow } from "./emailEligibility";

// The bits of the Instantly integration that touch the database, in one place
// so the four routes cannot disagree about what a setting means or about which
// migration to name when a table is missing.

export type InstantlySettings = {
  enabled: boolean;
  campaign_id: string | null;
  campaign_name: string | null;
  max_push_per_run: number;
  auto_reply_enabled: boolean;
  reply_confidence_floor: number;

  /* --- the automatic top-up, all from migration 0030 --- */
  auto_push_enabled: boolean;
  /** Refuse info@/office@ entirely. Off by default — see 0038. */
  named_people_only: boolean;
  /** Also refuse a personal address with nobody named behind it. See 0042. */
  require_named_person: boolean;
  target_active_leads: number;
  daily_push_cap: number;
  last_auto_push_at: string | null;
  pushed_today: number;
  pushed_today_date: string | null;
  active_sequence_id: string | null;

  /* --- sending capacity, all from migration 0031 --- */
  smart_capacity_enabled: boolean;
  auto_adjust_limits_enabled: boolean;
  account_limit_ceiling: number;
  capacity_headroom: number;
  last_capacity_sync_at: string | null;
  computed_daily_sends: number | null;
  computed_leads_per_day: number | null;

  /* --- what the top-up last decided, from migration 0037 --- */
  /** planRefill's own words for why it did or did not push. */
  last_refill_note: string | null;
  /** When it last CONSIDERED the question — distinct from last_auto_push_at. */
  last_refill_checked_at: string | null;
  /** How full the campaign was at that moment; null when unreadable. */
  last_refill_active_count: number | null;
};

const BASE_COLUMNS =
  "enabled, campaign_id, campaign_name, max_push_per_run, auto_reply_enabled, reply_confidence_floor";

const AUTOPUSH_COLUMNS =
  "auto_push_enabled, named_people_only, require_named_person, target_active_leads, daily_push_cap, last_auto_push_at, pushed_today, pushed_today_date, active_sequence_id";

const CAPACITY_COLUMNS =
  "smart_capacity_enabled, auto_adjust_limits_enabled, account_limit_ceiling, capacity_headroom, last_capacity_sync_at, computed_daily_sends, computed_leads_per_day";

/*
 * From 0037. Written on EVERY exit of the top-up, including the quiet ones.
 *
 * The whole point of these is to answer "why is nothing being pushed" without
 * anybody reading a server log, so they are loaded here and shown on the page.
 * They were written for months and read by nothing, which made the migration
 * that added them pointless.
 */
const REFILL_NOTE_COLUMNS =
  "last_refill_note, last_refill_checked_at, last_refill_active_count";

export const SETTINGS_COLUMNS = `${BASE_COLUMNS}, ${AUTOPUSH_COLUMNS}, ${CAPACITY_COLUMNS}, ${REFILL_NOTE_COLUMNS}`;

/**
 * What the settings are before anybody has saved any.
 *
 * Everything that could send something is off. A route that fails to read the
 * table therefore behaves as though the integration is switched off, which is
 * the only safe way for a read failure to degrade.
 */
export const SETTINGS_DEFAULTS: InstantlySettings = {
  enabled: false,
  campaign_id: null,
  campaign_name: null,
  max_push_per_run: 50,
  auto_reply_enabled: false,
  reply_confidence_floor: 0.7,
  auto_push_enabled: false,
  named_people_only: false,
  require_named_person: false,
  target_active_leads: 200,
  daily_push_cap: 100,
  last_auto_push_at: null,
  pushed_today: 0,
  pushed_today_date: null,
  active_sequence_id: null,
  smart_capacity_enabled: false,
  auto_adjust_limits_enabled: false,
  account_limit_ceiling: 90,
  capacity_headroom: 0.85,
  last_capacity_sync_at: null,
  computed_daily_sends: null,
  computed_leads_per_day: null,
  last_refill_note: null,
  last_refill_checked_at: null,
  last_refill_active_count: null,
};

/** Points at the migration rather than repeating a Postgres error verbatim. */
export function migrationHint(message: string): string | null {
  if (/relation .* does not exist|column .* does not exist|schema cache/i.test(message)) {
    return (
      "The email tables are not there yet. Run supabase/migrations/0029_instantly_email.sql, " +
      `0030_email_autonomy.sql and 0031_sending_capacity.sql in the Supabase SQL Editor, ` +
      `then reload this page. (${message})`
    );
  }
  return null;
}

export type SettingsLoad = {
  settings: InstantlySettings;
  /** Non-null when the row could not be read; the defaults are in use. */
  error: string | null;
  /** False when 0030 has not been run, so the page can say which part is missing. */
  autoPushAvailable: boolean;
  /** False when 0031 has not been run. */
  capacityAvailable: boolean;
};

/**
 * Read the settings row, tolerating a database that has 0029 but not 0030.
 *
 * The fallback matters more than it looks: the columns for the automatic
 * top-up all arrive with 0030, and selecting them from a database without it
 * fails the whole query — which would take the Email page down entirely rather
 * than just hiding the top-up controls. Same failure as the packet outage,
 * same fix.
 *
 * Every default is the safe one, so a read that falls all the way through
 * behaves as though nothing is switched on.
 */
export async function loadSettings(): Promise<SettingsLoad> {
  const db = supabaseAdmin();

  const read = async (columns: string) =>
    db.from("instantly_settings").select(columns).eq("id", true).maybeSingle();

  try {
    /*
     * Down the ladder one migration at a time, rather than all-or-nothing.
     *
     * Each tier drops the columns from one migration. A database with 0029 but
     * not 0031 loses the capacity controls and keeps everything else, instead
     * of the Email page failing outright — the same failure that took the
     * packet pipeline down, and the same fix.
     */
    let autoPushAvailable = true;
    let capacityAvailable = true;
    let res = await read(SETTINGS_COLUMNS);
    // Newest migration drops off first: 0037's note columns.
    if (res.error && isMissingColumnError(res.error)) {
      res = await read(`${BASE_COLUMNS}, ${AUTOPUSH_COLUMNS}, ${CAPACITY_COLUMNS}`);
    }
    if (res.error && isMissingColumnError(res.error)) {
      capacityAvailable = false;
      res = await read(`${BASE_COLUMNS}, ${AUTOPUSH_COLUMNS}`);
    }
    if (res.error && isMissingColumnError(res.error)) {
      autoPushAvailable = false;
      res = await read(BASE_COLUMNS);
    }
    if (res.error) {
      return {
        settings: SETTINGS_DEFAULTS,
        error: migrationHint(res.error.message) || res.error.message,
        autoPushAvailable: false,
        capacityAvailable: false,
      };
    }
    if (!res.data) {
      return { settings: SETTINGS_DEFAULTS, error: null, autoPushAvailable, capacityAvailable };
    }

    const data = res.data as unknown as Partial<InstantlySettings>;
    return {
      settings: {
        enabled: !!data.enabled,
        campaign_id: data.campaign_id ?? null,
        campaign_name: data.campaign_name ?? null,
        max_push_per_run: Number(data.max_push_per_run ?? SETTINGS_DEFAULTS.max_push_per_run),
        auto_reply_enabled: !!data.auto_reply_enabled,
        reply_confidence_floor: Number(
          data.reply_confidence_floor ?? SETTINGS_DEFAULTS.reply_confidence_floor
        ),
        auto_push_enabled: !!data.auto_push_enabled,
        named_people_only: !!data.named_people_only,
        require_named_person: !!data.require_named_person,
        target_active_leads: Number(data.target_active_leads ?? SETTINGS_DEFAULTS.target_active_leads),
        daily_push_cap: Number(data.daily_push_cap ?? SETTINGS_DEFAULTS.daily_push_cap),
        last_auto_push_at: data.last_auto_push_at ?? null,
        pushed_today: Number(data.pushed_today ?? 0),
        pushed_today_date: data.pushed_today_date ?? null,
        active_sequence_id: data.active_sequence_id ?? null,
        smart_capacity_enabled: !!data.smart_capacity_enabled,
        auto_adjust_limits_enabled: !!data.auto_adjust_limits_enabled,
        account_limit_ceiling: Number(
          data.account_limit_ceiling ?? SETTINGS_DEFAULTS.account_limit_ceiling
        ),
        capacity_headroom: Number(data.capacity_headroom ?? SETTINGS_DEFAULTS.capacity_headroom),
        last_capacity_sync_at: data.last_capacity_sync_at ?? null,
        computed_daily_sends: data.computed_daily_sends ?? null,
        computed_leads_per_day: data.computed_leads_per_day ?? null,
        last_refill_note: data.last_refill_note ?? null,
        last_refill_checked_at: data.last_refill_checked_at ?? null,
        last_refill_active_count: data.last_refill_active_count ?? null,
      },
      error: null,
      autoPushAvailable,
      capacityAvailable,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      settings: SETTINGS_DEFAULTS,
      error: migrationHint(msg) || msg,
      autoPushAvailable: false,
      capacityAvailable: false,
    };
  }
}

/**
 * Read every lead an email decision could apply to, whatever migrations have
 * actually been run.
 *
 * One function, used by the counts on the page and by the push itself, so the
 * two can never disagree about which leads exist — the drift that produced
 * "47 ready to call" next to "none are available" on the packet side.
 */
export async function selectEmailLeads(): Promise<{
  rows: EmailLeadRow[];
  /** Which tier worked, so the page can say a source is missing. */
  tier: number;
  error: string | null;
}> {
  const db = supabaseAdmin();
  for (let tier = 0; tier < EMAIL_ELIGIBILITY_TIERS.length; tier++) {
    const { data, error } = await db
      .from("leads")
      .select(EMAIL_ELIGIBILITY_TIERS[tier])
      .is("archived_at", null)
      .limit(50000);
    if (!error) return { rows: (data || []) as unknown as EmailLeadRow[], tier, error: null };
    // Only a missing column is worth stepping down for. A real failure — no
    // connection, a bad key — must be reported, not disguised as an empty list.
    if (!isMissingColumnError(error)) {
      return { rows: [], tier, error: migrationHint(error.message) || error.message };
    }
  }
  return {
    rows: [],
    tier: EMAIL_ELIGIBILITY_TIERS.length,
    error:
      "Could not read the leads table at all. Run the migrations in supabase/migrations in order.",
  };
}

export const THREAD_COLUMNS =
  "id, lead_id, instantly_lead_id, campaign_id, email, status, push_error, reply_count, last_event_at, created_at";

export type ThreadRow = {
  id: string;
  lead_id: string;
  instantly_lead_id: string | null;
  campaign_id: string | null;
  email: string;
  status: string;
  push_error: string | null;
  reply_count: number;
  last_event_at: string | null;
  created_at: string;
};

/** The thread for an address, which is how a webhook finds its lead. */
export async function threadByEmail(email: string): Promise<ThreadRow | null> {
  const { data } = await supabaseAdmin()
    .from("email_threads")
    .select(THREAD_COLUMNS)
    .eq("email", email.toLowerCase())
    .maybeSingle();
  return (data as ThreadRow) ?? null;
}
