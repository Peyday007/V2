import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recordEvent } from "@/lib/events";
import {
  METRICS,
  METRIC_MAP,
  missingTargets,
  SUGGESTED_TARGETS,
  SUGGESTED_SOURCE,
  type Target,
} from "@/lib/benchmarks";

export const dynamic = "force-dynamic";

function migrationHint(message: string): string | null {
  if (/relation .* does not exist|schema cache/i.test(message)) {
    return (
      "Targets are not set up yet. Run supabase/migrations/0020_performance_targets.sql " +
      `in the Supabase SQL Editor, then reload. (${message})`
    );
  }
  return null;
}

export async function GET() {
  const db = supabase();
  const { data, error } = await db.from("performance_targets").select("*").eq("active", true);

  if (error) {
    const hint = migrationHint(error.message);
    // No table means no targets, which the app reports honestly rather than
    // substituting invented ones.
    return NextResponse.json(
      {
        metrics: METRICS,
        targets: [],
        missing: METRICS,
        suggested: SUGGESTED_TARGETS,
        suggestedSource: SUGGESTED_SOURCE,
        error: hint || error.message,
      },
      { status: hint ? 200 : 500 }
    );
  }

  const targets: Target[] = (data || []).map((r) => ({
    metric: r.metric,
    target: Number(r.target),
    source: r.source,
    note: r.note,
    minimumSample: r.minimum_sample,
  }));

  return NextResponse.json({
    metrics: METRICS,
    targets,
    missing: missingTargets(targets),
    suggested: SUGGESTED_TARGETS,
    suggestedSource: SUGGESTED_SOURCE,
    error: null,
  });
}

/**
 * Fill in the borrowed starting figures. Only for metrics that have no target
 * yet — a number you set deliberately is never overwritten by a borrowed one.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.action !== "use_suggested") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const db = supabase();
  const { data: existing, error: readErr } = await db
    .from("performance_targets")
    .select("metric");
  if (readErr) {
    return NextResponse.json(
      { error: migrationHint(readErr.message) || readErr.message },
      { status: 500 }
    );
  }

  const already = new Set((existing || []).map((r) => r.metric));
  const rows = SUGGESTED_TARGETS.filter((s) => !already.has(s.metric)).map((s) => ({
    metric: s.metric,
    target: s.value,
    source: SUGGESTED_SOURCE,
    note: s.basis,
    minimum_sample: 30,
    active: true,
    updated_at: new Date().toISOString(),
  }));

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, added: 0 });
  }

  const { error } = await db
    .from("performance_targets")
    .upsert(rows, { onConflict: "metric" });
  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message },
      { status: 500 }
    );
  }

  await recordEvent({
    type: "prompt.changed",
    entityType: "prompt",
    entityId: "target:suggested_defaults",
    actorType: "admin",
    source: "ui",
    previousValue: null,
    newValue: { metrics: rows.map((r) => r.metric), source: SUGGESTED_SOURCE },
    metadata: { added: rows.length, borrowed: true },
    verificationStatus: "unverified",
  });

  return NextResponse.json({ ok: true, added: rows.length });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const metric = String(body.metric || "");
  const def = METRIC_MAP[metric];
  if (!def) return NextResponse.json({ error: "Unknown metric" }, { status: 400 });

  const value = Number(body.target);
  if (!Number.isFinite(value) || value < 0) {
    return NextResponse.json({ error: "Target must be a positive number" }, { status: 400 });
  }
  if (def.kind === "rate" && value > 1) {
    return NextResponse.json(
      { error: "A rate target is between 0 and 1 — 0.3 means 30%." },
      { status: 400 }
    );
  }

  const source = String(body.source || "").trim();
  if (!source) {
    return NextResponse.json(
      {
        error:
          "Say where the number came from. A target with no provenance gets mistaken for a researched figure later.",
      },
      { status: 400 }
    );
  }

  const db = supabase();
  const { data: before } = await db
    .from("performance_targets")
    .select("target, source")
    .eq("metric", metric)
    .maybeSingle();

  const { error } = await db.from("performance_targets").upsert(
    {
      metric,
      target: value,
      source,
      note: typeof body.note === "string" ? body.note.trim() || null : null,
      minimum_sample: Number(body.minimum_sample) || 30,
      active: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "metric" }
  );
  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message },
      { status: 500 }
    );
  }

  await recordEvent({
    type: "prompt.changed",
    entityType: "prompt",
    entityId: `target:${metric}`,
    actorType: "admin",
    source: "ui",
    previousValue: before ? { target: before.target, source: before.source } : null,
    newValue: { target: value, source },
    metadata: { metric, label: def.label },
    verificationStatus: "verified",
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const metric = req.nextUrl.searchParams.get("metric") || "";
  if (!METRIC_MAP[metric]) {
    return NextResponse.json({ error: "Unknown metric" }, { status: 400 });
  }
  const db = supabase();
  const { error } = await db.from("performance_targets").delete().eq("metric", metric);
  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
