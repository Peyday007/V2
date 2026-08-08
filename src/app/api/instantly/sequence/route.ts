import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordEvent } from "@/lib/events";
import { writeSequence } from "@/lib/sequenceWriter";
import { publishSequence, readPublishedSteps, hasVisibleText } from "@/lib/instantly/client";
import { loadSettings, migrationHint } from "@/lib/instantlyStore";
import { describeCadence, validatePlan, type SequenceStep } from "@/lib/sequencePlan";

export const dynamic = "force-dynamic";

/*
 * Sequences: written from a plain-language brief, published on one press.
 *
 * The split between those two is the point. The writing is fully automatic —
 * how many emails, how far apart, and what each one says are all its decision,
 * because being asked those questions is the hand-holding this was meant to
 * remove. Publishing is not, because publishing is what puts words in front of
 * every prospect in the campaign for the next month.
 */

const SEQUENCE_COLUMNS =
  "id, name, brief, steps, status, model, context_summary, created_at, published_at, published_by";

export async function GET() {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("email_sequences")
    .select(SEQUENCE_COLUMNS)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    return NextResponse.json(
      { sequences: [], error: migrationHint(error.message) || error.message },
      { status: 200 }
    );
  }

  /*
   * What the CAMPAIGN has, not what this database has.
   *
   * These two can disagree — a sequence marked active here whose copy never
   * survived the trip to Instantly looks completely healthy from inside this
   * app. Fetching it means the page can show the difference instead of
   * everybody assuming publishing worked because it said it did.
   */
  const { settings } = await loadSettings();
  const live = settings.campaign_id ? await readPublishedSteps(settings.campaign_id) : null;

  return NextResponse.json({
    inInstantly:
      live === null
        ? null
        : {
            steps: live.length,
            blankBodies: live.filter((s) => !hasVisibleText(s.body)).length,
            // Trimmed hard: this is for confirming copy arrived, not for
            // reading the emails, and the whole sequence would be a wall.
            preview: live.slice(0, 6).map((s) => ({
              subject: s.subject,
              bodyStart: s.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120),
            })),
          },
    sequences: (data || []).map((s) => {
      const steps = (s.steps || []) as SequenceStep[];
      return {
        ...s,
        cadence: describeCadence(steps),
        // Whether the prospect is actually given anything to click. Surfaced
        // rather than assumed, because a sequence edited by hand in Instantly
        // after publishing can lose the link without anything noticing.
        linksToPlan: steps.some((st) =>
          `${st.subject}\n${st.body}`.includes("{{workshop_link}}")
        ),
      };
    }),
    error: null,
  });
}

/** Write one. Nothing is sent and nothing is published — this only drafts. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const brief = typeof body.brief === "string" ? body.brief.trim() : "";

  if (!brief) {
    return NextResponse.json(
      { error: "Say what you want these emails to do, in your own words." },
      { status: 400 }
    );
  }
  if (brief.length > 4000) {
    return NextResponse.json({ error: "That brief is too long — a few paragraphs is plenty." }, { status: 400 });
  }

  const result = await writeSequence(brief);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, problems: result.problems ?? [] }, { status: 502 });
  }

  const db = supabaseAdmin();
  const { data: row, error } = await db
    .from("email_sequences")
    .insert({
      name: result.plan.name,
      brief,
      steps: result.plan.steps,
      status: "draft",
      model: result.model,
      context_summary: result.contextSummary,
    })
    .select(SEQUENCE_COLUMNS)
    .single();

  if (error) {
    return NextResponse.json({ error: migrationHint(error.message) || error.message }, { status: 500 });
  }

  await recordEvent({
    type: "prompt.changed",
    entityType: "prompt",
    entityId: `instantly:sequence:${row.id}`,
    actorType: "admin",
    source: "ui",
    newValue: { name: result.plan.name, steps: result.plan.steps.length, brief },
    metadata: { area: "instantly_email", model: result.model, context: result.contextSummary },
    verificationStatus: "unverified",
  });

  return NextResponse.json({
    sequence: { ...row, cadence: describeCadence(result.plan.steps) },
    error: null,
  });
}

/**
 * Publish one, or retire one.
 *
 * Publishing overwrites the campaign's steps in Instantly. That is the intent
 * — one active sequence, so anybody can say what a lead pushed today will
 * receive — but it discards anything typed into the Instantly editor by hand,
 * which is worth knowing before pressing it.
 */
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  const action = body.action === "archive" ? "archive" : "publish";
  const by = (typeof body.by === "string" && body.by.trim()) || "admin";

  if (!id) return NextResponse.json({ error: "Which sequence?" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: seq, error } = await db
    .from("email_sequences")
    .select(SEQUENCE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: migrationHint(error.message) || error.message }, { status: 500 });
  }
  if (!seq) return NextResponse.json({ error: "No such sequence." }, { status: 404 });

  if (action === "archive") {
    await db
      .from("email_sequences")
      .update({ status: "archived", archived_at: new Date().toISOString() })
      .eq("id", id);
    return NextResponse.json({ ok: true, status: "archived" });
  }

  const steps = (seq.steps || []) as SequenceStep[];

  // Re-validated at publish time, not just at write time. A row could have
  // been edited in the database between the two, and this is the last gate
  // before the copy reaches every prospect in the campaign.
  const problems = validatePlan({ name: seq.name, brief: seq.brief, steps });
  if (problems.length > 0) {
    return NextResponse.json(
      { error: "This sequence is not safe to publish.", problems },
      { status: 400 }
    );
  }

  const { settings } = await loadSettings();
  if (!settings.campaign_id) {
    return NextResponse.json(
      { error: "Pick an Instantly campaign first — there is nowhere to publish to." },
      { status: 400 }
    );
  }

  const published = await publishSequence(settings.campaign_id, steps);
  const now = new Date().toISOString();

  /*
   * Marked active either way, and the difference is reported honestly.
   *
   * If Instantly refused the update, this is still the sequence in force as
   * far as this application is concerned — but the campaign out there has not
   * changed, so the response says so and the page offers the copy-out view.
   * Nothing claims the campaign was updated when it was not.
   */
  await db.from("email_sequences").update({ status: "archived" }).eq("status", "active");
  await db
    .from("email_sequences")
    .update({ status: "active", published_at: now, published_by: by, archived_at: null })
    .eq("id", id);
  await db
    .from("instantly_settings")
    .update({ active_sequence_id: id, updated_at: now })
    .eq("id", true);

  await recordEvent({
    type: "prompt.changed",
    entityType: "prompt",
    entityId: `instantly:sequence:${id}`,
    actorType: "admin",
    source: "ui",
    newValue: { status: "active", pushed_to_instantly: published.ok },
    metadata: { area: "instantly_email", campaign_id: settings.campaign_id },
    verificationStatus: published.ok ? "verified" : "unverified",
  });

  if (!published.ok) {
    return NextResponse.json({
      ok: true,
      status: "active",
      pushedToInstantly: false,
      warning:
        `This is now the active sequence here, but the campaign out there does not match it: ` +
        `${published.error} ` +
        `Copy the emails into the Instantly sequence editor by hand, or press Publish again.`,
    });
  }

  return NextResponse.json({ ok: true, status: "active", pushedToInstantly: true });
}
