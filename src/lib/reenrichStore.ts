import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";
import { isMissingColumnError } from "./enrichmentGrade";
import { availableProviders } from "./contactProviders";
import { enqueue } from "./jobs";
import { DEFAULT_BATCH, reenrichKey, type ReenrichPlan, type ReenrichLead } from "./reenrichPlan";

// The database-touching half of the re-enrichment backfill. Split out from the
// route so the manual button and the automatic worker read leads through
// exactly one implementation — the drift that produced "47 ready to call" next
// to "none are available" was two places disagreeing about which leads count.

const CORE = "id, business_name, website, owner_name, do_not_call, archived_at";

/**
 * Newest migration first, stepping down.
 *
 * Selecting a column from an unrun migration fails the WHOLE query rather than
 * degrading — the failure mode that took the packet pipeline down. If 0032 has
 * not run there is no diagnostic to be missing, and the run still usefully
 * collects addresses and names.
 */
const COLUMN_TIERS = [
  // 0044's attempt counter is the newest and so drops off first. Without it
  // every lead reads as never tried, which is the old forever-retry behaviour
  // — the safe direction for an unrun migration.
  `${CORE}, website_email, direct_email, owner_email, decision_maker_name, diagnostic_findings, enrich_attempts`,
  `${CORE}, website_email, direct_email, owner_email, decision_maker_name, diagnostic_findings`,
  `${CORE}, website_email, direct_email, owner_email, decision_maker_name`,
  `${CORE}, website_email, owner_email, decision_maker_name`,
  `${CORE}, owner_email, decision_maker_name`,
  `${CORE}, owner_email`,
];

export async function readReenrichLeads(): Promise<{
  rows: ReenrichLead[] | null;
  error: string | null;
}> {
  const db = supabaseAdmin();
  for (const columns of COLUMN_TIERS) {
    const res = await db.from("leads").select(columns).is("archived_at", null).limit(20000);
    if (!res.error) return { rows: res.data as unknown as ReenrichLead[], error: null };
    if (!isMissingColumnError(res.error)) return { rows: null, error: res.error.message };
  }
  return { rows: null, error: "Could not read the leads table at any column set." };
}

/**
 * What a re-run can and cannot produce, stated plainly.
 *
 * A direct number comes only from a paid contact provider. With none
 * configured a run cannot produce one, and the page must say so rather than
 * let somebody press the button expecting the gatekeeper problem to go away.
 */
export function reenrichCapabilities() {
  const providers = availableProviders();
  return {
    email: true,
    diagnostic: true,
    decisionMaker: true,
    directNumber: providers.length > 0,
    directNumberNote:
      providers.length > 0
        ? `Direct numbers will be attempted through ${providers.map((p) => p.key).join(", ")}, within the budget.`
        : "No contact provider is configured, so this will NOT find direct numbers. Callers will still reach the main line.",
  };
}

/**
 * Turn a plan into queued jobs, however it was triggered.
 *
 * The manual button and the automatic worker call this SAME function, so a
 * fix to one never silently misses the other — the drift that produced the
 * capacity page and the worker disagreeing about the sending limit earlier.
 */
export async function queueReenrichBatch(
  plan: ReenrichPlan
): Promise<{ queued: number; alreadyQueued: number }> {
  let queued = 0;
  let alreadyQueued = 0;
  const today = new Date();

  for (const item of plan.queue) {
    try {
      const accepted = await enqueue({
        type: "enrich_owner_contact",
        payload: {
          lead_id: item.id,
          /*
           * THE FLAG THAT MAKES THIS WORK AT ALL.
           *
           * enrichLeadForOwner runs shouldReEnrich() first, and an already
           * enriched lead is refused — correctly, so nothing pays twice for a
           * record that has not changed. But the record has not changed; the
           * APPLICATION has. Without this flag the backfill queues jobs that
           * every one of them declines, and the caller reports success while
           * nothing happens.
           */
          admin_requested: true,
          reason: "backfill",
        },
        // One per lead per day, so running twice in an afternoon — by hand,
        // by the worker, or both — is a no-op, and tomorrow picks up where
        // this left off.
        idempotencyKey: reenrichKey(item.id, today),
        // Behind live lead generation. This is catch-up work on leads that
        // already exist; nothing is waiting on it in real time.
        priority: 200,
      });
      if (accepted) queued += 1;
      else alreadyQueued += 1;
    } catch {
      // One lead failing to queue must not abandon the batch.
      alreadyQueued += 1;
    }
  }

  return { queued, alreadyQueued };
}

export type AutoReenrichSettings = {
  enabled: boolean;
  batch: number;
};

/**
 * Tolerates 0040 not having been run yet, same shape as every other settings
 * reader in this codebase: a missing column reads as "off", never as a crash
 * that takes the rest of the page down with it.
 */
export async function loadAutoReenrichSettings(): Promise<AutoReenrichSettings> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("enrichment_settings")
      .select("auto_reenrich_enabled, auto_reenrich_batch")
      .eq("id", true)
      .maybeSingle();
    if (error || !data) return { enabled: false, batch: DEFAULT_BATCH };
    return {
      enabled: !!data.auto_reenrich_enabled,
      batch: Number(data.auto_reenrich_batch) || DEFAULT_BATCH,
    };
  } catch {
    return { enabled: false, batch: DEFAULT_BATCH };
  }
}

/**
 * Write down what the last run did, on every exit path — including "switched
 * off". A note that only gets written when something happens is silent on the
 * one state an owner is most likely to be wrong about ("I turned that on,
 * didn't I?"), which is the exact bug the email top-up's note had to be fixed
 * for twice already.
 */
export async function recordReenrichRun(note: string, queued: number | null): Promise<void> {
  await supabaseAdmin()
    .from("enrichment_settings")
    .update({
      last_reenrich_note: note,
      last_reenrich_at: new Date().toISOString(),
      last_reenrich_queued: queued,
    })
    .eq("id", true)
    .then(
      () => {},
      () => {}
      // A database without 0040 has nowhere to put this. Silent: the run
      // itself still happened, and the note is a convenience, not the work.
    );
}
