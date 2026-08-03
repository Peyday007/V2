import "server-only";
import { randomBytes } from "crypto";
import { headers } from "next/headers";
import { supabaseAdmin } from "./supabaseAdmin";
import { recordEvent } from "./events";
import { sendSms, smsCapability } from "./sms";
import {
  canSend,
  packetUrl,
  renderMessage,
  segmentCount,
  TOKEN_BYTES,
  type PacketStatus,
} from "./workshopPacket";

// Creating and sending a packet. One implementation, called from the caller's
// dialer and from the admin lead page, so the two cannot drift into sending
// different messages or applying different rules.

export const COMPANY_NAME = process.env.COMPANY_NAME || "";

/**
 * Where the owner's link points.
 *
 * Derived from the request the VA made, so it is right on preview deploys,
 * production and localhost without configuration. APP_BASE_URL overrides it
 * for the case where the app sits behind a proxy on a different hostname.
 */
export async function appOrigin(): Promise<string> {
  const configured = (process.env.APP_BASE_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");

  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host");
  if (!host) return "";
  const proto = h.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export type PacketRow = {
  id: string;
  lead_id: string;
  token: string;
  status: PacketStatus;
  delivery_method: string | null;
  owner_name: string | null;
  owner_phone: string | null;
  owner_email: string | null;
  sent_by_name: string | null;
  last_send_error: string | null;
  created_at: string;
  sent_at: string | null;
  opened_at: string | null;
  trial_requested_at: string | null;
  acknowledged_at: string | null;
};

export type LeadForPacket = {
  id: string;
  business_name: string;
  phone: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  rating: number | null;
  review_count: number | null;
  answering_setup: string | null;
  owner_name: string | null;
  decision_maker_name: string | null;
  direct_phone: string | null;
  do_not_call: boolean | null;
  phone_invalid: boolean | null;
};

export const LEAD_PACKET_COLUMNS =
  "id, business_name, phone, website, city, state, rating, review_count, answering_setup, owner_name, decision_maker_name, direct_phone, do_not_call, phone_invalid";

/** The best name and mobile we already hold, before the sender types anything. */
export function defaultsFor(lead: LeadForPacket): { name: string; phone: string } {
  return {
    name: (lead.decision_maker_name || lead.owner_name || "").trim(),
    // The direct number is the one likely to be a mobile. The main line is
    // offered as a fallback but is frequently a landline that cannot receive
    // a text at all, which Twilio reports as error 21614.
    phone: (lead.direct_phone || "").trim(),
  };
}

/** The packet for a lead, if one has ever been made. */
export async function loadPacket(leadId: string): Promise<PacketRow | null> {
  const { data } = await supabaseAdmin()
    .from("workshop_packets")
    .select(
      "id, lead_id, token, status, delivery_method, owner_name, owner_phone, owner_email, sent_by_name, last_send_error, created_at, sent_at, opened_at, trial_requested_at, acknowledged_at"
    )
    .eq("lead_id", leadId)
    .maybeSingle();
  return (data as PacketRow) ?? null;
}

export type SendOutcome =
  | { ok: true; packet: PacketRow; link: string; message: string; segments: number }
  | { ok: false; error: string; link: string | null; packet: PacketRow | null };

export type SendInput = {
  leadId: string;
  ownerName: string;
  ownerPhone: string;
  ownerEmail?: string | null;
  senderName: string;
  senderCallerId?: string | null;
  /** Create the packet and return the link, without texting anything. */
  linkOnly?: boolean;
};

/**
 * Create-or-reuse the packet, then text it.
 *
 * Order matters and is deliberate:
 *
 *   1. Check the suppression rules. A text is a contact, and somebody who
 *      asked not to be called did not ask to be texted instead.
 *   2. Create the row and the token. The link must exist before it is sent,
 *      and it stays reusable if the send fails.
 *   3. Send.
 *   4. Only on a confirmed success, mark it sent.
 *
 * A failure leaves the status exactly where it was — never `sent`. A packet
 * marked sent that never arrived is worse than a visible error, because the
 * caller stops chasing it.
 */
export async function createAndSendPacket(input: SendInput): Promise<SendOutcome> {
  const db = supabaseAdmin();

  const { data: lead } = await db
    .from("leads")
    .select(LEAD_PACKET_COLUMNS)
    .eq("id", input.leadId)
    .maybeSingle();
  if (!lead) return { ok: false, error: "No such lead.", link: null, packet: null };

  const l = lead as LeadForPacket;
  const gate = canSend({
    ownerName: input.ownerName,
    ownerPhone: input.ownerPhone,
    doNotCall: l.do_not_call,
    phoneInvalid: l.phone_invalid,
  });
  if (!gate.allowed) {
    return { ok: false, error: gate.reason || "Cannot send to this lead.", link: null, packet: null };
  }

  // Reuse the row and the token. Sending twice must not give the owner two
  // different links pointing at two different statuses.
  let packet = await loadPacket(input.leadId);
  if (!packet) {
    const { data, error } = await db
      .from("workshop_packets")
      .insert({
        lead_id: input.leadId,
        token: randomBytes(TOKEN_BYTES).toString("hex"),
        status: "not_sent",
        owner_name: input.ownerName.trim(),
        owner_phone: input.ownerPhone.trim(),
        owner_email: (input.ownerEmail || "").trim() || null,
        sent_by_caller_id: input.senderCallerId || null,
        sent_by_name: input.senderName,
      })
      .select(
        "id, lead_id, token, status, delivery_method, owner_name, owner_phone, owner_email, sent_by_name, last_send_error, created_at, sent_at, opened_at, trial_requested_at, acknowledged_at"
      )
      .single();
    if (error || !data) {
      const msg = error?.message || "Could not create the packet.";
      return {
        ok: false,
        error: /relation .* does not exist|column .* does not exist|schema cache/i.test(msg)
          ? `Run supabase/migrations/0024_workshop_packets.sql in the Supabase SQL Editor. (${msg})`
          : msg,
        link: null,
        packet: null,
      };
    }
    packet = data as PacketRow;
  }

  const origin = await appOrigin();
  const link = packetUrl(origin, packet.token);
  const message = renderMessage({
    ownerName: input.ownerName,
    vaName: input.senderName,
    companyName: COMPANY_NAME,
    businessName: l.business_name,
    link,
  });

  if (input.linkOnly) {
    // The manual fallback. The row exists and the link works; nothing was
    // texted, so the status stays where it is.
    return { ok: true, packet, link, message, segments: segmentCount(message) };
  }

  const capability = smsCapability();
  if (!capability.available) {
    return { ok: false, error: capability.reason, link, packet };
  }

  const result = await sendSms(input.ownerPhone.trim(), message);

  if (!result.ok) {
    await db
      .from("workshop_packets")
      .update({
        last_send_error: result.error,
        owner_name: input.ownerName.trim(),
        owner_phone: input.ownerPhone.trim(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", packet.id);

    await recordEvent({
      type: "workshop.send_failed",
      entityType: "lead",
      entityId: input.leadId,
      leadId: input.leadId,
      actorCallerId: input.senderCallerId || null,
      actorType: input.senderCallerId ? "caller" : "admin",
      source: "ui",
      newValue: { error: result.error, retryable: result.retryable },
    });

    return {
      ok: false,
      error: result.error,
      link,
      packet: { ...packet, last_send_error: result.error },
    };
  }

  const now = new Date().toISOString();
  const { data: updated } = await db
    .from("workshop_packets")
    .update({
      // Only ever set here, after Twilio confirmed it accepted the message.
      status: "sent",
      sent_at: now,
      delivery_method: "text",
      owner_name: input.ownerName.trim(),
      owner_phone: input.ownerPhone.trim(),
      owner_email: (input.ownerEmail || "").trim() || packet.owner_email,
      sent_by_caller_id: input.senderCallerId || null,
      sent_by_name: input.senderName,
      provider_message_id: result.messageId,
      last_send_error: null,
      updated_at: now,
    })
    .eq("id", packet.id)
    .select(
      "id, lead_id, token, status, delivery_method, owner_name, owner_phone, owner_email, sent_by_name, last_send_error, created_at, sent_at, opened_at, trial_requested_at, acknowledged_at"
    )
    .single();

  await recordEvent({
    type: "workshop.sent",
    entityType: "lead",
    entityId: input.leadId,
    leadId: input.leadId,
    actorCallerId: input.senderCallerId || null,
    actorType: input.senderCallerId ? "caller" : "admin",
    source: "ui",
    newValue: { to: input.ownerPhone, segments: result.segments },
    metadata: { provider_message_id: result.messageId },
    verificationStatus: "verified",
  });

  return {
    ok: true,
    packet: (updated as PacketRow) ?? { ...packet, status: "sent", sent_at: now },
    link,
    message,
    segments: result.segments,
  };
}
