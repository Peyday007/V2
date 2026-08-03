import { NextRequest, NextResponse } from "next/server";
import { getCallerId } from "@/lib/callerSession";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordEvent } from "@/lib/events";
import { smsCapability } from "@/lib/sms";
import { canGenerateLink, computeGaps } from "@/lib/workshopPacket";
import {
  COMPANY_NAME,
  createAndSendPacket,
  defaultsFor,
  loadPacket,
  LEAD_PACKET_COLUMNS,
  type LeadForPacket,
} from "@/lib/workshopSend";

export const dynamic = "force-dynamic";

// The caller's own packet endpoint.
//
// Deliberately under /api/dial/ rather than /api/packets/: everything under
// /api/dial/ is open to a PIN-authenticated caller, and everything else is
// behind the admin passphrase. Putting this anywhere else would have locked
// the VAs out of the one button this whole feature is for.

/** Every response has the same shape, success or failure. */
function payload(over: Record<string, unknown> = {}) {
  return {
    packet: null,
    link: null,
    defaults: { name: "", phone: "" },
    gaps: [],
    suppressedReason: null as string | null,
    sms: smsCapability(),
    companyName: COMPANY_NAME,
    error: null as string | null,
    ...over,
  };
}

async function leadFor(leadId: string): Promise<LeadForPacket | null> {
  const { data } = await supabaseAdmin()
    .from("leads")
    .select(LEAD_PACKET_COLUMNS)
    .eq("id", leadId)
    .maybeSingle();
  return (data as LeadForPacket) ?? null;
}

/** What the panel shows before anybody presses anything. */
export async function GET(req: NextRequest) {
  const callerId = await getCallerId();
  if (!callerId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const leadId = req.nextUrl.searchParams.get("lead_id") || "";
  if (!leadId) return NextResponse.json(payload({ error: "No lead" }), { status: 200 });

  try {
    const lead = await leadFor(leadId);
    if (!lead) return NextResponse.json(payload({ error: "No such lead" }), { status: 200 });

    const packet = await loadPacket(leadId);
    const defaults = defaultsFor(lead);
    // Only suppression is reported here. Whether a TEXT can go is decided in
    // the panel from the name and number, because those are editable there.
    const gate = canGenerateLink({
      doNotCall: lead.do_not_call,
      phoneInvalid: lead.phone_invalid,
    });

    return NextResponse.json(
      payload({
        packet,
        defaults,
        suppressedReason: gate.reason,
        gaps: computeGaps({
          businessName: lead.business_name,
          city: lead.city,
          website: lead.website,
          rating: lead.rating,
          reviewCount: lead.review_count,
          answeringSetup: lead.answering_setup,
        }),
      })
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      payload({
        error: /relation .* does not exist|schema cache/i.test(msg)
          ? `Run supabase/migrations/0024_workshop_packets.sql in the Supabase SQL Editor. (${msg})`
          : msg,
      }),
      { status: 200 }
    );
  }
}

/**
 * Send it, or just mint the link.
 *
 * `link_only` is the Copy Link fallback: it creates the packet and hands back
 * the URL without texting anything, for the cases Twilio cannot serve — an
 * international number, an outage, or an owner who would rather have it by
 * email. The status stays where it was, because nothing was delivered.
 */
export async function POST(req: NextRequest) {
  const callerId = await getCallerId();
  if (!callerId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const leadId = String(body.lead_id || "");
  if (!leadId) return NextResponse.json({ error: "No lead" }, { status: 400 });

  const { data: caller } = await supabaseAdmin()
    .from("callers")
    .select("name")
    .eq("id", callerId)
    .maybeSingle();

  const lead = await leadFor(leadId);
  if (!lead) return NextResponse.json({ error: "No such lead" }, { status: 404 });
  const defaults = defaultsFor(lead);

  const result = await createAndSendPacket({
    leadId,
    ownerName: String(body.owner_name || defaults.name || ""),
    ownerPhone: String(body.owner_phone || defaults.phone || ""),
    ownerEmail: typeof body.owner_email === "string" ? body.owner_email : null,
    senderName: caller?.name || "your rep",
    senderCallerId: callerId,
    linkOnly: body.link_only === true,
  });

  if (!result.ok) {
    // 200, not 4xx: this is a normal outcome the panel renders inline. A bad
    // number is something the VA fixes and retries mid-call, not an exception.
    return NextResponse.json(
      { error: result.error, link: result.link, packet: result.packet },
      { status: 200 }
    );
  }

  if (body.link_only === true) {
    await recordEvent({
      type: "workshop.link_copied",
      entityType: "lead",
      entityId: leadId,
      leadId,
      actorCallerId: callerId,
      actorType: "caller",
      source: "ui",
    });
  }

  return NextResponse.json({
    error: null,
    packet: result.packet,
    link: result.link,
    message: result.message,
    segments: result.segments,
  });
}
