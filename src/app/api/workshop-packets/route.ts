import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordEvent } from "@/lib/events";
import { smsCapability } from "@/lib/sms";
import { PACKET_STATUS_RANK, type PacketStatus } from "@/lib/workshopPacket";
import {
  COMPANY_NAME,
  createAndSendPacket,
  defaultsFor,
  loadPacket,
  LEAD_PACKET_COLUMNS,
  type LeadForPacket,
} from "@/lib/workshopSend";

export const dynamic = "force-dynamic";

// Admin side. Behind the passphrase, like everything else that is not /dial.

function payload(over: Record<string, unknown> = {}) {
  return {
    waiting: [],
    recent: [],
    counts: { not_sent: 0, sent: 0, opened: 0, trial_requested: 0 },
    sms: smsCapability(),
    companyName: COMPANY_NAME,
    error: null as string | null,
    ...over,
  };
}

function migrationHint(message: string): string | null {
  if (/relation .* does not exist|column .* does not exist|schema cache/i.test(message)) {
    return (
      "Run supabase/migrations/0024_workshop_packets.sql in the Supabase SQL Editor, then reload. " +
      `(${message})`
    );
  }
  return null;
}

/**
 * Everything the board needs: what is waiting on a human, and what has moved
 * recently.
 *
 * `waiting` is the one that matters — packets where an owner agreed to a trial
 * and nobody has picked it up yet. That is the whole point of the feature, so
 * it is a separate list rather than something to spot inside a table.
 */
export async function GET(req: NextRequest) {
  const db = supabaseAdmin();
  const leadId = req.nextUrl.searchParams.get("lead_id");

  try {
    // One lead's packet, for the panel on the lead record.
    if (leadId) {
      const { data: lead } = await db
        .from("leads")
        .select(LEAD_PACKET_COLUMNS)
        .eq("id", leadId)
        .maybeSingle();
      const packet = await loadPacket(leadId);
      return NextResponse.json(
        payload({
          packet,
          defaults: lead ? defaultsFor(lead as LeadForPacket) : { name: "", phone: "" },
        })
      );
    }

    const { data, error } = await db
      .from("workshop_packets")
      .select(
        "id, lead_id, token, status, delivery_method, owner_name, owner_phone, owner_email, agreed_name, agreed_phone, agreed_email, sent_by_name, last_send_error, created_at, sent_at, opened_at, trial_requested_at, acknowledged_at, leads(business_name, city, state, phone)"
      )
      .order("trial_requested_at", { ascending: false, nullsFirst: false })
      .limit(200);

    if (error) {
      return NextResponse.json(
        payload({ error: migrationHint(error.message) || error.message }),
        { status: 200 }
      );
    }

    const rows = data || [];
    const counts = { not_sent: 0, sent: 0, opened: 0, trial_requested: 0 };
    for (const r of rows) {
      const s = r.status as PacketStatus;
      if (s in counts) counts[s] += 1;
    }

    return NextResponse.json(
      payload({
        waiting: rows.filter((r) => r.status === "trial_requested" && !r.acknowledged_at),
        recent: [...rows]
          .sort(
            (a, b) =>
              PACKET_STATUS_RANK[b.status as PacketStatus] -
                PACKET_STATUS_RANK[a.status as PacketStatus] ||
              Date.parse(b.created_at) - Date.parse(a.created_at)
          )
          .slice(0, 50),
        counts,
      })
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(payload({ error: migrationHint(msg) || msg }), { status: 200 });
  }
}

/** Send from the admin side — same implementation the dialer uses. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const leadId = String(body.lead_id || "");
  if (!leadId) return NextResponse.json({ error: "No lead" }, { status: 400 });

  const { data: lead } = await supabaseAdmin()
    .from("leads")
    .select(LEAD_PACKET_COLUMNS)
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return NextResponse.json({ error: "No such lead" }, { status: 404 });
  const defaults = defaultsFor(lead as LeadForPacket);

  const result = await createAndSendPacket({
    leadId,
    ownerName: String(body.owner_name || defaults.name || ""),
    ownerPhone: String(body.owner_phone || defaults.phone || ""),
    ownerEmail: typeof body.owner_email === "string" ? body.owner_email : null,
    senderName: String(body.sender_name || "").trim() || "your rep",
    linkOnly: body.link_only === true,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, link: result.link, packet: result.packet },
      { status: 200 }
    );
  }
  return NextResponse.json({
    error: null,
    packet: result.packet,
    link: result.link,
    message: result.message,
    segments: result.segments,
  });
}

/**
 * "I have got this one."
 *
 * Clears it off the waiting list without changing the packet's status — the
 * owner still requested a trial, and rewriting that to make a banner go away
 * would falsify the record the stats are built on.
 */
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");
  if (!id) return NextResponse.json({ error: "No packet" }, { status: 400 });

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("workshop_packets")
    .update({
      acknowledged_at: new Date().toISOString(),
      acknowledged_note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id, lead_id")
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message },
      { status: 500 }
    );
  }

  if (data) {
    await recordEvent({
      type: "workshop.acknowledged",
      entityType: "lead",
      entityId: data.lead_id,
      leadId: data.lead_id,
      actorType: "admin",
      source: "ui",
      newValue: { note: body.note || null },
    });
  }

  return NextResponse.json({ ok: true, error: null });
}
