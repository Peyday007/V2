import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recordEvent, newCorrelationId } from "@/lib/events";
import { normalizePhone } from "@/lib/normalize";

export const dynamic = "force-dynamic";

function migrationHint(message: string): string | null {
  if (/column .* does not exist|schema cache|relation .* does not exist/i.test(message)) {
    return (
      "The do-not-call list is not set up. Run supabase/migrations/0011_owner_intel.sql " +
      `and supabase/migrations/0014_dnc_enforcement.sql in the Supabase SQL Editor. (${message})`
    );
  }
  return null;
}

export async function GET() {
  const db = supabase();
  const { data, error } = await db
    .from("suppressions")
    .select("id, lead_id, normalized_phone, requested_by, reason, note, source, created_at, leads(business_name, city, state)")
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message },
      { status: 500 }
    );
  }

  // How many lead records each suppressed number is actually protecting —
  // the whole point of matching on the number rather than the record.
  const phones = (data || [])
    .map((s) => s.normalized_phone)
    .filter((p): p is string => !!p);
  const covers: Record<string, number> = {};
  if (phones.length > 0) {
    const { data: leads } = await db
      .from("leads")
      .select("normalized_phone")
      .in("normalized_phone", phones);
    for (const l of leads || []) {
      if (l.normalized_phone) covers[l.normalized_phone] = (covers[l.normalized_phone] || 0) + 1;
    }
  }

  return NextResponse.json({ suppressions: data || [], covers });
}

/** Add a number to the list by hand — an emailed or mailed request. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const phone = normalizePhone(body.phone);
  if (!phone) {
    return NextResponse.json(
      { error: "Enter a valid 10-digit US phone number." },
      { status: 400 }
    );
  }

  const db = supabase();
  const { error } = await db.from("suppressions").upsert(
    {
      normalized_phone: phone,
      requested_by: body.requested_by || "unknown",
      reason: body.reason || "Added manually",
      note: body.note || null,
      source: "manual",
    },
    { onConflict: "normalized_phone", ignoreDuplicates: false }
  );
  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message },
      { status: 500 }
    );
  }

  // Apply it immediately to every record carrying that number, and pull them
  // out of any packet they are sitting in.
  const { data: matched } = await db
    .from("leads")
    .select("id, business_name")
    .eq("normalized_phone", phone);
  const ids = (matched || []).map((l) => l.id);

  if (ids.length > 0) {
    await db.from("leads").update({ do_not_call: true }).in("id", ids);
    await db.from("packet_leads").update({ status: "done" }).in("lead_id", ids);
  }

  const correlationId = newCorrelationId();
  for (const id of ids) {
    await recordEvent({
      type: "lead.suppressed",
      entityType: "lead",
      entityId: id,
      leadId: id,
      actorType: "admin",
      source: "ui",
      correlationId,
      previousValue: { do_not_call: false },
      newValue: { do_not_call: true },
      metadata: {
        reason: body.reason || "Added manually to the do-not-call list",
        normalized_phone: phone,
      },
      verificationStatus: "verified",
    });
  }

  return NextResponse.json({ ok: true, phone, leads_suppressed: ids.length });
}
