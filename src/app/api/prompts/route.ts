import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recordEvent } from "@/lib/events";
import { PROMPTS, PROMPT_MAP, validateTemplate } from "@/lib/prompts";

export const dynamic = "force-dynamic";

function migrationHint(message: string): string | null {
  if (/relation .* does not exist|schema cache/i.test(message)) {
    return (
      "Prompt editing is not set up yet. Run supabase/migrations/0018_prompts.sql " +
      `in the Supabase SQL Editor, then reload. (${message})`
    );
  }
  return null;
}

/** Every prompt, with its default and any saved override. */
export async function GET() {
  const db = supabase();
  const { data, error } = await db.from("prompts").select("key, template, note, updated_at");

  if (error) {
    const hint = migrationHint(error.message);
    // Without the table every prompt simply runs its default, which is a
    // working state — say so rather than showing an empty page.
    return NextResponse.json(
      {
        prompts: PROMPTS.map((p) => ({ ...p, override: null, updatedAt: null })),
        error: hint || error.message,
      },
      { status: hint ? 200 : 500 }
    );
  }

  const overrides = new Map((data || []).map((r) => [r.key, r]));
  return NextResponse.json({
    prompts: PROMPTS.map((p) => {
      const saved = overrides.get(p.key);
      return {
        ...p,
        override: saved?.template ?? null,
        note: saved?.note ?? null,
        updatedAt: saved?.updated_at ?? null,
      };
    }),
    error: null,
  });
}

/** Save an override. */
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const key = typeof body.key === "string" ? body.key : "";
  const template = typeof body.template === "string" ? body.template : "";
  const def = PROMPT_MAP[key];

  if (!def) return NextResponse.json({ error: "Unknown prompt" }, { status: 400 });

  const problems = validateTemplate(def, template);
  const errors = problems.filter((p) => p.level === "error");
  if (errors.length > 0) {
    return NextResponse.json({ error: errors[0].message, problems }, { status: 400 });
  }

  const db = supabase();
  const { data: before } = await db
    .from("prompts")
    .select("template")
    .eq("key", key)
    .maybeSingle();

  const { error } = await db.from("prompts").upsert(
    {
      key,
      template,
      note: typeof body.note === "string" ? body.note.trim() || null : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );
  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message },
      { status: 500 }
    );
  }

  // The event log is the undo history: every previous wording is recoverable.
  await recordEvent({
    type: "prompt.changed",
    entityType: "prompt",
    entityId: key,
    actorType: "admin",
    source: "ui",
    previousValue: { template: before?.template ?? null },
    newValue: { template },
    metadata: { label: def.label, note: body.note ?? null },
    verificationStatus: "verified",
  });

  return NextResponse.json({ ok: true, problems });
}

/** Put a prompt back to the wording it shipped with. */
export async function DELETE(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key") || "";
  const def = PROMPT_MAP[key];
  if (!def) return NextResponse.json({ error: "Unknown prompt" }, { status: 400 });

  const db = supabase();
  const { data: before } = await db
    .from("prompts")
    .select("template")
    .eq("key", key)
    .maybeSingle();

  const { error } = await db.from("prompts").delete().eq("key", key);
  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message },
      { status: 500 }
    );
  }

  await recordEvent({
    type: "prompt.changed",
    entityType: "prompt",
    entityId: key,
    actorType: "admin",
    source: "ui",
    previousValue: { template: before?.template ?? null },
    newValue: { template: null, reset_to_default: true },
    metadata: { label: def.label },
    verificationStatus: "verified",
  });

  return NextResponse.json({ ok: true });
}
