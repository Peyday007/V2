import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";
import { recordEvent } from "./events";
import { isMissingColumnError } from "./enrichmentGrade";
import {
  listAccounts,
  setAccountDailyLimit,
  instantlyCapability,
  campaignDailyLimit,
} from "./instantly/client";
import { loadSettings, migrationHint } from "./instantlyStore";
import {
  computeCapacity,
  planAllLimits,
  smartDailyCap,
  DEFAULT_RAMP,
  type RampPolicy,
  type SendingAccount,
} from "./sendingCapacity";

// Reading the inboxes, and moving their limits.
//
// The decisions all live in sendingCapacity.ts, which is pure and tested. This
// file does the parts that touch the world: fetch, count bounces, write the
// log, make the call, record what happened.
//
// The ordering below is the important bit and it is deliberate:
//
//   1. read the accounts from Instantly
//   2. attach OUR OWN bounce history, per inbox
//   3. decide
//   4. WRITE THE CHANGE DOWN, then make it
//   5. re-read what stuck, and recompute the cap from that
//
// Step 4 in that order — log first, act second — is what makes this auditable.
// A change that was attempted and refused leaves a row saying so. The
// alternative, logging after a successful call, means the only changes with a
// record are the ones that worked, which is exactly backwards from what you
// want when something has gone wrong.

export type SyncOutcome = {
  ok: boolean;
  accounts: number;
  changed: number;
  failed: number;
  dailySends: number;
  leadsPerDay: number;
  /** Every decision, including the holds, so the page can show its reasoning. */
  decisions: { email: string; from?: number; to?: number; reason: string; applied?: boolean }[];
  error: string | null;
};

const failure = (error: string): SyncOutcome => ({
  ok: false,
  accounts: 0,
  changed: 0,
  failed: 0,
  dailySends: 0,
  leadsPerDay: 0,
  decisions: [],
  error,
});

/**
 * Bounces and sends per inbox, from our own event log.
 *
 * Instantly reports a health score, but it is theirs and it lags. This is the
 * signal we have first-hand: `from_email` on an email event IS the sending
 * account, so a bounce can be attributed to the inbox that caused it.
 *
 * A fourteen-day window. Shorter and one bad afternoon halves an account;
 * longer and a problem from a fortnight ago is still holding back an inbox
 * that recovered.
 */
async function recentDeliverability(): Promise<Map<string, { sends: number; bounces: number }>> {
  const out = new Map<string, { sends: number; bounces: number }>();
  try {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const { data } = await supabaseAdmin()
      .from("email_events")
      .select("event_type, from_email")
      .gte("occurred_at", since)
      .not("from_email", "is", null)
      .limit(50000);

    for (const row of data || []) {
      const inbox = String(row.from_email || "").toLowerCase();
      if (!inbox) continue;
      const entry = out.get(inbox) || { sends: 0, bounces: 0 };
      if (row.event_type === "bounced") entry.bounces += 1;
      else if (row.event_type === "sent") entry.sends += 1;
      out.set(inbox, entry);
    }
  } catch {
    // No history is not a reason to refuse to sync. It only ever makes the
    // planner MORE cautious, because an account with no recorded sends never
    // clears the minimum-volume bar for a reduction.
  }
  return out;
}

/**
 * Sync the accounts, optionally adjust their limits, and recompute the cap.
 *
 * `adjust` is passed in rather than read here so the "check what would happen"
 * button on the page can run exactly this code with adjust off, and see the
 * same decisions the worker would make. A preview that runs different code
 * from the thing it previews is worth nothing.
 */
export async function syncSendingAccounts(opts: {
  adjust: boolean;
  actor: "admin" | "worker";
}): Promise<SyncOutcome> {
  const capability = instantlyCapability();
  if (!capability.available) return failure(capability.reason);

  const { settings, error: settingsError } = await loadSettings();
  if (settingsError) return failure(settingsError);

  const fetched = await listAccounts();
  if (!fetched.ok) return failure(fetched.error);

  const db = supabaseAdmin();

  // What we already know about each inbox: when we last moved it, and whether
  // somebody has told us to leave it alone.
  const known = new Map<string, { last_changed_at: string | null; excluded: boolean }>();
  try {
    const { data, error } = await db
      .from("sending_accounts")
      .select("email, last_changed_at, excluded");
    if (error && !isMissingColumnError(error)) {
      return failure(migrationHint(error.message) || error.message);
    }
    for (const row of data || []) {
      known.set(String(row.email).toLowerCase(), {
        last_changed_at: row.last_changed_at ?? null,
        excluded: !!row.excluded,
      });
    }
  } catch (e) {
    return failure(e instanceof Error ? e.message : String(e));
  }

  const health = await recentDeliverability();

  const accounts: SendingAccount[] = fetched.accounts.map((a) => {
    const seen = health.get(a.email) || { sends: 0, bounces: 0 };
    return {
      email: a.email,
      dailyLimit: a.dailyLimit,
      warmupScore: a.warmupScore,
      warmupStatus: a.warmupStatus,
      active: a.active,
      createdAt: a.createdAt,
      recentSends: seen.sends,
      recentBounces: seen.bounces,
      lastRaisedAt: known.get(a.email)?.last_changed_at ?? null,
    };
  });

  // Cache what Instantly says, before anything is changed.
  for (const a of accounts) {
    await db
      .from("sending_accounts")
      .upsert(
        {
          email: a.email,
          daily_limit: a.dailyLimit,
          warmup_score: a.warmupScore,
          warmup_status: a.warmupStatus,
          active: a.active,
          provider_created_at: a.createdAt,
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: "email" }
      )
      .then(undefined, () => {});
  }

  const policy: RampPolicy = {
    ...DEFAULT_RAMP,
    ceiling: settings.account_limit_ceiling || DEFAULT_RAMP.ceiling,
  };

  /*
   * An excluded inbox is skipped entirely — not planned and then discarded.
   *
   * The escape hatch has to be real: somebody will have one account that is
   * special for a reason the software cannot know, and the answer to that must
   * not be "switch the whole feature off".
   */
  const adjustable = accounts.filter((a) => !known.get(a.email)?.excluded);
  const { changes, holds } = planAllLimits(adjustable, policy);

  const decisions: SyncOutcome["decisions"] = [];
  let changed = 0;
  let failed = 0;

  if (opts.adjust) {
    for (const change of changes) {
      // Written down BEFORE the call. A change that gets refused still leaves
      // a record that it was attempted, and why.
      const { data: logged } = await db
        .from("account_limit_changes")
        .insert({
          email: change.email,
          limit_before: change.from,
          limit_after: change.to,
          direction: change.direction,
          reason: change.reason,
          actor: opts.actor,
          applied: false,
        })
        .select("id")
        .single();

      const result = await setAccountDailyLimit(change.email, change.to);

      if (result.ok) {
        changed += 1;
        if (logged?.id) {
          await db.from("account_limit_changes").update({ applied: true }).eq("id", logged.id);
        }
        await db
          .from("sending_accounts")
          .update({
            daily_limit: change.to,
            last_changed_at: new Date().toISOString(),
            last_change_reason: change.reason,
          })
          .eq("email", change.email);

        // Reflected locally so the capacity recomputed below uses the new
        // number rather than the one we just replaced.
        const local = accounts.find((a) => a.email === change.email);
        if (local) local.dailyLimit = change.to;

        await recordEvent({
          type: "prompt.changed",
          entityType: "prompt",
          entityId: `instantly:account:${change.email}`,
          actorType: opts.actor === "worker" ? "worker" : "admin",
          source: opts.actor === "worker" ? "worker" : "ui",
          previousValue: { daily_limit: change.from },
          newValue: { daily_limit: change.to },
          metadata: { area: "instantly_sending_limits", reason: change.reason, direction: change.direction },
          verificationStatus: "verified",
        });
      } else {
        failed += 1;
        if (logged?.id) {
          await db
            .from("account_limit_changes")
            .update({ applied: false, error: result.error })
            .eq("id", logged.id);
        }
      }

      decisions.push({ ...change, applied: result.ok });
    }
  } else {
    // Preview: the same decisions, none of them made.
    for (const change of changes) decisions.push({ ...change, applied: false });
  }

  for (const hold of holds) decisions.push({ email: hold.email, reason: hold.reason });

  /* ------------------------- recompute the cap --------------------------- */
  const steps = await activeSequenceSteps();
  const headroom = Number(settings.capacity_headroom) || 0.85;
  /*
   * The campaign's own limit, read fresh rather than remembered.
   *
   * It is a field somebody edits in Instantly, so a cached copy would be wrong
   * within minutes of the edit that mattered. Null when it cannot be read, and
   * computeCapacity is explicit in the reason about which of those it is.
   */
  const campaignLimit = settings.campaign_id
    ? await campaignDailyLimit(settings.campaign_id)
    : null;
  const cap = smartDailyCap(accounts, steps, headroom, campaignLimit);
  const capacity = computeCapacity(accounts, headroom, campaignLimit);

  await db
    .from("instantly_settings")
    .update({
      last_capacity_sync_at: new Date().toISOString(),
      computed_daily_sends: capacity.dailySends,
      computed_leads_per_day: cap.leadsPerDay,
      // Only when smart mode is on. Otherwise the numbers are computed and
      // shown, and the cap the operator typed is left exactly as they left it
      // — this must never silently overwrite a number somebody chose.
      ...(settings.smart_capacity_enabled && cap.leadsPerDay > 0
        ? { daily_push_cap: Math.max(1, Math.min(1000, cap.leadsPerDay)) }
        : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", true)
    .then(undefined, () => {});

  return {
    ok: true,
    accounts: accounts.length,
    changed,
    failed,
    dailySends: capacity.dailySends,
    leadsPerDay: cap.leadsPerDay,
    decisions,
    error: null,
  };
}

/**
 * How many emails a lead will receive.
 *
 * From the active sequence, because that is what decides the multiplier in
 * capacity ÷ steps. Defaults to 3 when there is no published sequence: a guess
 * is needed, and guessing HIGH is the safe direction — it produces a smaller
 * daily cap, which under-uses the inboxes rather than overrunning them.
 */
export async function activeSequenceSteps(): Promise<number> {
  try {
    const { data } = await supabaseAdmin()
      .from("email_sequences")
      .select("steps")
      .eq("status", "active")
      .maybeSingle();
    const steps = (data?.steps as unknown[]) || [];
    if (Array.isArray(steps) && steps.length > 0) return steps.length;
  } catch {
    // Falls through to the cautious default.
  }
  return 3;
}
