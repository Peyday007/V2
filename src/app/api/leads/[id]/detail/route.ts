import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * Everything known about one business, in one call.
 *
 * The board card carries a name and a number; this is the rest — every
 * conversation, what was learned, what was promised, and what is booked.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = supabase();

  const { data: lead, error } = await db.from("leads").select("*").eq("id", id).single();
  if (error || !lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const [calls, contacts, callbacks, appointments, objections, packetRow] =
    await Promise.all([
      db
        .from("calls")
        .select(
          "id, outcome, reached_dm, notes, details, next_step, spoke_with_role, duration_seconds, attempt_number, created_at, callers(name)"
        )
        .eq("lead_id", id)
        .order("created_at", { ascending: false })
        .limit(200),
      db
        .from("contacts")
        .select("*")
        .eq("lead_id", id)
        .eq("active", true)
        .order("confidence", { ascending: false }),
      db
        .from("callbacks")
        .select("scheduled_for, status, reason, requested_by_name, requested_by_role, callers(name)")
        .eq("lead_id", id)
        .order("scheduled_for", { ascending: false }),
      db
        .from("appointments")
        .select("*, callers(name)")
        .eq("lead_id", id)
        .order("scheduled_for", { ascending: false }),
      db
        .from("call_objections")
        .select("objection_key, objection_label, outcome, created_at")
        .eq("lead_id", id)
        .order("created_at", { ascending: false }),
      db
        .from("packet_leads")
        .select("status, packets(id, name, status, callers(name))")
        .eq("lead_id", id)
        .maybeSingle(),
    ]);

  return NextResponse.json({
    lead,
    calls: calls.data || [],
    contacts: contacts.data || [],
    callbacks: callbacks.data || [],
    appointments: appointments.data || [],
    objections: objections.data || [],
    packet: packetRow.data || null,
    // A missing table is a migration problem, not an empty relationship.
    warnings: [
      objections.error && "Objections unavailable — run migration 0013.",
      callbacks.error && "Callbacks unavailable — run migration 0011.",
    ].filter(Boolean),
  });
}
