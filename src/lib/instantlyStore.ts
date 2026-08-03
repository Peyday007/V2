import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";

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
};

export const SETTINGS_COLUMNS =
  "enabled, campaign_id, campaign_name, max_push_per_run, auto_reply_enabled, reply_confidence_floor";

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
};

/** Points at the migration rather than repeating a Postgres error verbatim. */
export function migrationHint(message: string): string | null {
  if (/relation .* does not exist|column .* does not exist|schema cache/i.test(message)) {
    return (
      "The email tables are not there yet. Run supabase/migrations/0029_instantly_email.sql " +
      `in the Supabase SQL Editor, then reload this page. (${message})`
    );
  }
  return null;
}

export type SettingsLoad = {
  settings: InstantlySettings;
  /** Non-null when the row could not be read; the defaults are in use. */
  error: string | null;
};

export async function loadSettings(): Promise<SettingsLoad> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("instantly_settings")
      .select(SETTINGS_COLUMNS)
      .eq("id", true)
      .maybeSingle();
    if (error) {
      return { settings: SETTINGS_DEFAULTS, error: migrationHint(error.message) || error.message };
    }
    if (!data) return { settings: SETTINGS_DEFAULTS, error: null };
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
      },
      error: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { settings: SETTINGS_DEFAULTS, error: migrationHint(msg) || msg };
  }
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
