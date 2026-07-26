import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recordEvent } from "@/lib/events";

export const dynamic = "force-dynamic";

const ATTENDANCE = ["scheduled", "held", "no_show", "cancelled", "rescheduled"] as const;
type Attendance = (typeof ATTENDANCE)[number];

export async function GET() {
  const db = supabase();
  const { data, error } = await db
    .from("appointments")
    .select(
      "id, lead_id, decision_maker_name, decision_maker_role, scheduled_for, timezone, phone, email, product, pain_point, confirmation_method, notes, attendance_status, attendance_recorded_at, attendance_note, created_at, leads(business_name, industry, city, state), callers(name)"
    )
    .order("scheduled_for", { ascending: false })
    .limit(500);

  if (error) {
    // A missing column means 0013 has not been run. Say which file, rather
    // than rendering an empty page that looks like "no appointments".
    const needsMigration = /column .* does not exist|schema cache/i.test(error.message);
    return NextResponse.json(
      {
        error: needsMigration
          ? `The appointments table is missing the attendance columns. Run supabase/migrations/0013_call_analytics.sql in the Supabase SQL Editor. (${error.message})`
          : error.message,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ appointments: data || [] });
}

/** Record whether an appointment was actually held. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { id, attendance_status, note } = body as {
    id?: string;
    attendance_status?: Attendance;
    note?: string;
  };

  if (!id || !attendance_status || !ATTENDANCE.includes(attendance_status)) {
    return NextResponse.json(
      { error: `attendance_status must be one of: ${ATTENDANCE.join(", ")}` },
      { status: 400 }
    );
  }

  const db = supabase();
  const { data: before } = await db
    .from("appointments")
    .select("id, lead_id, caller_id, call_id, attendance_status, scheduled_for")
    .eq("id", id)
    .single();
  if (!before) return NextResponse.json({ error: "Appointment not found" }, { status: 404 });

  const { error } = await db
    .from("appointments")
    .update({
      attendance_status,
      attendance_recorded_at: new Date().toISOString(),
      attendance_note: note || null,
    })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await recordEvent({
    type: "appointment.attendance_recorded",
    entityType: "appointment",
    entityId: id,
    leadId: before.lead_id,
    callId: before.call_id,
    actorType: "admin",
    source: "ui",
    previousValue: { attendance_status: before.attendance_status ?? "scheduled" },
    newValue: { attendance_status },
    metadata: { note: note || null, scheduled_for: before.scheduled_for },
    verificationStatus: "verified",
  });

  return NextResponse.json({ ok: true });
}
