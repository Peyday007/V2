import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordEvent } from "@/lib/events";
import { ALL_PARTY_CONSENT_STATES } from "@/lib/consent";
import { transcriptionCapability } from "@/lib/transcription";
import { usingServiceRole } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

// Mirrors the check constraint on call_intelligence_settings.consent_policy.
// Adding one here without adding it in a migration means the save fails on a
// constraint violation instead of doing anything.
const POLICIES = [
  "all_party",
  "per_state",
  "one_party",
  "one_party_only",
  "disabled",
] as const;

function migrationHint(message: string): string | null {
  if (/relation .* does not exist|column .* does not exist|schema cache/i.test(message)) {
    return (
      "Recording is not set up yet. Run supabase/migrations/0019_call_intelligence.sql and " +
      `0021_browser_recordings.sql in the Supabase SQL Editor, then reload. (${message})`
    );
  }
  return null;
}

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin()
      .from("call_intelligence_settings")
      .select(
        "recording_enabled, consent_policy, consent_announcement, retention_days, transcription_enabled, ai_decides, ai_confidence_floor, ai_spot_check_rate"
      )
      .eq("id", true)
      .maybeSingle();
    if (error) {
      return NextResponse.json(
        { settings: null, error: migrationHint(error.message) || error.message },
        { status: 200 }
      );
    }
    const cap = transcriptionCapability();
    return NextResponse.json({
      settings: data,
      allPartyStates: ALL_PARTY_CONSENT_STATES,
      transcription: { available: cap.available, reason: cap.reason, remedy: cap.remedy ?? null },
      serviceRole: usingServiceRole(),
      error: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ settings: null, error: migrationHint(msg) || msg }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.recording_enabled === "boolean") {
    patch.recording_enabled = body.recording_enabled;
  }
  if (typeof body.transcription_enabled === "boolean") {
    patch.transcription_enabled = body.transcription_enabled;
  }
  if (typeof body.ai_decides === "boolean") {
    patch.ai_decides = body.ai_decides;
  }
  if (body.ai_spot_check_rate !== undefined) {
    const rate = Number(body.ai_spot_check_rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      return NextResponse.json(
        { error: "The spot-check rate is a share between 0 and 1 — 0.02 means 2%." },
        { status: 400 }
      );
    }
    if (rate === 0 && body.acknowledge_unmeasurable !== true) {
      return NextResponse.json(
        {
          error:
            "A zero spot-check rate means no reading is ever checked, so model accuracy becomes unmeasurable. Set at least 1%, or confirm you want it off.",
        },
        { status: 400 }
      );
    }
    patch.ai_spot_check_rate = rate;
  }
  if (body.ai_confidence_floor !== undefined) {
    const floor = Number(body.ai_confidence_floor);
    if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
      return NextResponse.json({ error: "The confidence floor is between 0 and 1." }, { status: 400 });
    }
    patch.ai_confidence_floor = floor;
  }
  if (typeof body.consent_policy === "string") {
    if (!(POLICIES as readonly string[]).includes(body.consent_policy)) {
      return NextResponse.json({ error: "Unknown consent policy" }, { status: 400 });
    }
    patch.consent_policy = body.consent_policy;
  }
  if (typeof body.consent_announcement === "string") {
    const text = body.consent_announcement.trim();
    if (text.length < 10) {
      return NextResponse.json(
        {
          error:
            "The announcement is what the prospect is actually told. It needs to say recording is happening.",
        },
        { status: 400 }
      );
    }
    patch.consent_announcement = text;
  }
  if (body.retention_days !== undefined) {
    const days = Number(body.retention_days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return NextResponse.json({ error: "Keep recordings for 1 to 3650 days" }, { status: 400 });
    }
    patch.retention_days = days;
  }

  try {
    const db = supabaseAdmin();
    const { data: before } = await db
      .from("call_intelligence_settings")
      .select("recording_enabled, consent_policy, transcription_enabled, retention_days")
      .eq("id", true)
      .maybeSingle();

    const { error } = await db.from("call_intelligence_settings").update(patch).eq("id", true);
    if (error) {
      return NextResponse.json(
        { error: migrationHint(error.message) || error.message },
        { status: 500 }
      );
    }

    // Switching recording on or off is a decision worth being able to date.
    await recordEvent({
      type: "prompt.changed",
      entityType: "prompt",
      entityId: "recording:settings",
      actorType: "admin",
      source: "ui",
      previousValue: before ?? null,
      newValue: patch,
      metadata: { area: "call_recording" },
      verificationStatus: "verified",
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: migrationHint(msg) || msg }, { status: 500 });
  }
}
