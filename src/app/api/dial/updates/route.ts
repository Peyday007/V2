import { NextRequest, NextResponse } from "next/server";
import { getCallerId } from "@/lib/callerSession";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { liveUpdates, orderUpdates, unseenCount } from "@/lib/updates";

export const dynamic = "force-dynamic";

// The caller's copy.
//
// Under /api/dial/ because that prefix is open to a PIN-authenticated caller
// and everything else is behind the admin passphrase. Read-only apart from
// marking the panel seen — a caller can never post, edit, pin or retire an
// update, so the admin endpoint stays where it is.

function payload(over: Record<string, unknown> = {}) {
  return {
    updates: [],
    unseen: 0,
    lastSeenAt: null as string | null,
    error: null as string | null,
    ...over,
  };
}

export async function GET() {
  const callerId = await getCallerId();
  if (!callerId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  try {
    const db = supabaseAdmin();
    const [updatesRes, readRes] = await Promise.all([
      db
        .from("updates")
        .select("id, title, body, pinned, archived_at, created_at")
        .order("created_at", { ascending: false })
        .limit(50),
      db
        .from("caller_update_reads")
        .select("last_seen_at")
        .eq("caller_id", callerId)
        .maybeSingle(),
    ]);

    if (updatesRes.error) {
      // Never let a missing table stop somebody dialling. The panel simply
      // does not appear; the shift carries on.
      return NextResponse.json(payload({ error: updatesRes.error.message }), { status: 200 });
    }

    const rows = liveUpdates(updatesRes.data || []);
    const lastSeenAt = readRes.data?.last_seen_at ?? null;

    return NextResponse.json(
      payload({
        updates: orderUpdates(rows),
        unseen: unseenCount(rows, lastSeenAt),
        lastSeenAt,
      })
    );
  } catch (e) {
    return NextResponse.json(
      payload({ error: e instanceof Error ? e.message : String(e) }),
      { status: 200 }
    );
  }
}

/**
 * "I have read them."
 *
 * Not proof of reading and not meant to be — it exists only so the badge stops
 * nagging somebody who has already opened the panel. Stored as one timestamp
 * per caller rather than a row per update read.
 */
export async function POST(_req: NextRequest) {
  const callerId = await getCallerId();
  if (!callerId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const now = new Date().toISOString();
  const { error } = await supabaseAdmin()
    .from("caller_update_reads")
    .upsert({ caller_id: callerId, last_seen_at: now, updated_at: now }, { onConflict: "caller_id" });

  if (error) return NextResponse.json({ error: error.message }, { status: 200 });
  return NextResponse.json({ ok: true, lastSeenAt: now, error: null });
}
