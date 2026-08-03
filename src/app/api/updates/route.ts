import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordEvent } from "@/lib/events";
import { liveUpdates, orderUpdates, validateDraft, MAX_BODY, MAX_TITLE } from "@/lib/updates";

export const dynamic = "force-dynamic";

// Admin side. Behind the passphrase like everything that is not /dial.

const COLUMNS = "id, title, body, pinned, archived_at, created_at, updated_at";

function payload(over: Record<string, unknown> = {}) {
  return { updates: [], archived: [], error: null as string | null, ...over };
}

function migrationHint(message: string): string | null {
  if (/relation .* does not exist|column .* does not exist|schema cache/i.test(message)) {
    return (
      "Run supabase/migrations/0025_team_updates.sql in the Supabase SQL Editor, then reload. " +
      `(${message})`
    );
  }
  return null;
}

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin()
      .from("updates")
      .select(COLUMNS)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      return NextResponse.json(
        payload({ error: migrationHint(error.message) || error.message }),
        { status: 200 }
      );
    }

    const rows = data || [];
    return NextResponse.json(
      payload({
        updates: orderUpdates(liveUpdates(rows)),
        archived: rows.filter((r) => r.archived_at),
      })
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(payload({ error: migrationHint(msg) || msg }), { status: 200 });
  }
}

/** Post one. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const draft = {
    title: String(body.title || "").slice(0, MAX_TITLE + 1),
    body: String(body.body || "").slice(0, MAX_BODY + 1),
  };

  const problem = validateDraft(draft);
  if (problem) return NextResponse.json({ error: problem.message }, { status: 400 });

  const { data, error } = await supabaseAdmin()
    .from("updates")
    .insert({
      title: draft.title.trim(),
      body: draft.body.trim(),
      pinned: body.pinned === true,
    })
    .select(COLUMNS)
    .single();

  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message },
      { status: 500 }
    );
  }

  await recordEvent({
    type: "update.posted",
    entityType: "update",
    entityId: data.id,
    actorType: "admin",
    source: "ui",
    newValue: { title: data.title, pinned: data.pinned },
  });

  return NextResponse.json({ update: data, error: null });
}

/**
 * Edit, pin, or retire.
 *
 * Editing deliberately does NOT bump created_at, so fixing a typo cannot
 * re-notify every caller who has already read and acted on the update. If it
 * genuinely needs reading again, it gets posted again.
 */
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");
  if (!id) return NextResponse.json({ error: "Which update?" }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
  if (body.archived === true) patch.archived_at = new Date().toISOString();
  if (body.archived === false) patch.archived_at = null;

  if (body.title !== undefined || body.body !== undefined) {
    const draft = {
      title: String(body.title ?? "").slice(0, MAX_TITLE + 1),
      body: String(body.body ?? "").slice(0, MAX_BODY + 1),
    };
    const problem = validateDraft(draft);
    if (problem) return NextResponse.json({ error: problem.message }, { status: 400 });
    patch.title = draft.title.trim();
    patch.body = draft.body.trim();
  }

  const { data, error } = await supabaseAdmin()
    .from("updates")
    .update(patch)
    .eq("id", id)
    .select(COLUMNS)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message },
      { status: 500 }
    );
  }

  await recordEvent({
    type: body.archived === true ? "update.archived" : "update.edited",
    entityType: "update",
    entityId: id,
    actorType: "admin",
    source: "ui",
    newValue: { pinned: patch.pinned ?? null, archived: body.archived ?? null },
  });

  return NextResponse.json({ update: data, error: null });
}
