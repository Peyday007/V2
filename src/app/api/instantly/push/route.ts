import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordEvent } from "@/lib/events";
import { isMissingColumnError } from "@/lib/enrichmentGrade";
import { pushLead, instantlyCapability } from "@/lib/instantly/client";
import type { PushSubject } from "@/lib/instantly/types";
import { loadSettings, migrationHint } from "@/lib/instantlyStore";
import {
  chooseEmail,
  emailUnavailableReason,
  explainNonePushable,
  summarizeEmailAvailability,
  type EmailLeadRow,
} from "@/lib/emailEligibility";
import {
  composePersonalization,
  composeVariables,
  splitName,
  type ComposeInput,
} from "@/lib/emailCompose";
import { appOrigin } from "@/lib/workshopSend";
import { packetUrl } from "@/lib/workshopPacket";

export const dynamic = "force-dynamic";

/*
 * Push a batch of leads into the Instantly campaign.
 *
 * Everything this route does is bounded:
 *
 *   - it runs only when an administrator has switched the programme on;
 *   - it pushes at most `max_push_per_run`, so a mistake costs a batch;
 *   - it never pushes a lead that already has a thread, because two sequences
 *     landing in one inbox is how a sending domain gets burned;
 *   - a lead that fails to push is recorded as failed rather than skipped, so
 *     nothing disappears silently.
 *
 * It is a manual action. There is no schedule and no worker job behind it —
 * somebody presses the button.
 */

/** Everything from the lead row that eligibility or composing needs. */
const CORE = [
  "id",
  "business_name",
  "city",
  "state",
  "website",
  "rating",
  "review_count",
  "answering_setup",
  "owner_name",
  "decision_maker_name",
  "industry",
  "owner_email",
  "do_not_call",
  "archived_at",
  "email_unsubscribed_at",
  "email_bounced_at",
].join(", ");

/** Arrives with migration 0023. Optional, exactly like enrichment_grade. */
const WITH_DIRECT = `${CORE}, direct_email`;

/**
 * The database row, in the database's own spelling.
 *
 * Deliberately NOT an intersection with ComposeInput: that type is camelCase
 * because it is the composer's vocabulary, and letting the two blur means
 * reading `lead.reviewCount` off a Postgres row and getting undefined —
 * silently, which is how a personalization line goes out missing its one
 * specific fact. The mapping between the two happens once, below, in the open.
 */
type LeadRow = EmailLeadRow & {
  id: string;
  business_name: string;
  city: string | null;
  state: string | null;
  website: string | null;
  rating: number | null;
  review_count: number | null;
  answering_setup: string | null;
  owner_name: string | null;
  decision_maker_name: string | null;
  industry: string | null;
};

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const requested = Number(body.limit);

  const { settings, error: settingsError } = await loadSettings();
  if (settingsError) return NextResponse.json({ error: settingsError }, { status: 500 });

  const capability = instantlyCapability();
  if (!capability.available) {
    return NextResponse.json({ error: capability.reason }, { status: 400 });
  }
  if (!settings.enabled) {
    return NextResponse.json(
      { error: "The email programme is switched off. Turn it on at the top of this page first." },
      { status: 400 }
    );
  }
  if (!settings.campaign_id) {
    return NextResponse.json(
      { error: "No Instantly campaign is selected — there is nowhere to push to." },
      { status: 400 }
    );
  }

  const cap = settings.max_push_per_run;
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, cap) : cap;

  const db = supabaseAdmin();

  /*
   * Read the leads. direct_email only exists after migration 0023, so the
   * select falls back rather than 500-ing — the same failure that took the
   * whole packet pipeline down once already. Owner enrichment improves WHICH
   * address is used; it is not allowed to be the reason nothing is pushed.
   */
  const buildQuery = (columns: string) =>
    db.from("leads").select(columns).is("archived_at", null).limit(20000);

  let leadsResult = await buildQuery(WITH_DIRECT);
  let usedDirectEmail = true;
  if (leadsResult.error && isMissingColumnError(leadsResult.error)) {
    leadsResult = await buildQuery(CORE);
    usedDirectEmail = false;
  }
  if (leadsResult.error) {
    return NextResponse.json(
      { error: migrationHint(leadsResult.error.message) || leadsResult.error.message },
      { status: 500 }
    );
  }
  const allLeads = (leadsResult.data || []) as unknown as LeadRow[];

  // Which leads already have a thread. One thread per lead, enforced here and
  // by a unique index, because the index alone would turn a duplicate into a
  // failed push rather than a skipped one.
  const { data: existing, error: threadsErr } = await db
    .from("email_threads")
    .select("lead_id, status")
    .limit(50000);
  if (threadsErr) {
    return NextResponse.json(
      { error: migrationHint(threadsErr.message) || threadsErr.message },
      { status: 500 }
    );
  }
  const alreadyPushed = new Set((existing || []).map((t) => String(t.lead_id)));

  const eligible = allLeads.filter(
    (l) => !alreadyPushed.has(l.id) && emailUnavailableReason(l) === null
  );

  if (eligible.length === 0) {
    const availability = summarizeEmailAvailability(allLeads);
    return NextResponse.json(
      {
        error:
          alreadyPushed.size > 0
            ? `Nothing new to push — ${alreadyPushed.size} lead${alreadyPushed.size === 1 ? " is" : "s are"} already in a campaign. ${explainNonePushable(availability)}`
            : explainNonePushable(availability),
        availability,
      },
      { status: 400 }
    );
  }

  const batch = eligible.slice(0, limit);

  /*
   * The workshop link, where one already exists.
   *
   * Read only. This route never creates a packet: a packet is something a
   * caller makes during a conversation, and minting one as a side effect of an
   * email push would put rows on the board that nobody spoke to. Where a
   * caller HAS already made one, the email points at the same page they would
   * have texted, so a prospect who gets both sees one consistent thing.
   */
  const links = new Map<string, string>();
  try {
    const origin = await appOrigin();
    if (origin) {
      const { data: packets } = await db
        .from("workshop_packets")
        .select("lead_id, token")
        .in("lead_id", batch.map((l) => l.id));
      for (const p of packets || []) {
        if (p.token) links.set(String(p.lead_id), packetUrl(origin, String(p.token)));
      }
    }
  } catch {
    // A missing link is a slightly less personal email, not a failure.
  }

  let pushed = 0;
  let failed = 0;
  const failures: { business: string; error: string }[] = [];
  let stoppedEarly: string | null = null;

  for (const lead of batch) {
    const chosen = chooseEmail(lead);
    // Re-checked rather than trusted from the filter above: this is the last
    // point before an address leaves the building.
    if (!chosen) continue;

    const ownerName = (lead.decision_maker_name || lead.owner_name || "").trim() || null;
    const { firstName, lastName } = splitName(ownerName);
    const composeInput: ComposeInput = {
      businessName: lead.business_name,
      city: lead.city,
      state: lead.state,
      website: lead.website,
      rating: lead.rating,
      reviewCount: lead.review_count,
      answeringSetup: lead.answering_setup,
      ownerName,
      industry: lead.industry,
      workshopLink: links.get(lead.id) || null,
    };

    const subject: PushSubject = {
      leadId: lead.id,
      email: chosen.email,
      firstName,
      lastName,
      companyName: lead.business_name,
      website: (lead.website || "").trim() || null,
      phone: null,
      personalization: composePersonalization(composeInput),
      customVariables: composeVariables(composeInput),
    };

    const result = await pushLead(settings.campaign_id, subject);

    const now = new Date().toISOString();
    if (result.ok) {
      pushed += 1;
      await db.from("email_threads").insert({
        lead_id: lead.id,
        instantly_lead_id: result.instantlyLeadId,
        campaign_id: settings.campaign_id,
        email: chosen.email,
        status: "pushed",
        last_event_at: now,
      });
      await recordEvent({
        type: "email.pushed",
        entityType: "email_thread",
        entityId: lead.id,
        leadId: lead.id,
        actorType: "admin",
        source: "ui",
        newValue: { email: chosen.email, campaign_id: settings.campaign_id },
        metadata: {
          email_source: chosen.source,
          personalized: subject.personalization !== "",
          workshop_link: !!composeInput.workshopLink,
        },
        verificationStatus: "verified",
      });
    } else {
      failed += 1;
      failures.push({ business: lead.business_name, error: result.error });
      // Recorded, not skipped. A failed push that leaves no row is a lead that
      // silently never gets emailed and that nobody can find again.
      await db.from("email_threads").insert({
        lead_id: lead.id,
        campaign_id: settings.campaign_id,
        email: chosen.email,
        status: "failed",
        push_error: result.error,
        last_event_at: now,
      });
      await recordEvent({
        type: "email.push_failed",
        entityType: "email_thread",
        entityId: lead.id,
        leadId: lead.id,
        actorType: "admin",
        source: "ui",
        newValue: { error: result.error, retryable: result.retryable },
      });

      // Rate limiting and a bad key are not per-lead problems. Carrying on
      // would mark the whole batch failed for one reason.
      if (result.retryable || /rejected the API key|could not find that campaign/i.test(result.error)) {
        stoppedEarly = result.error;
        break;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    pushed,
    failed,
    considered: eligible.length,
    limit,
    stoppedEarly,
    failures: failures.slice(0, 10),
    usedDirectEmail,
  });
}
