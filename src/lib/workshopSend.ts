import "server-only";
import { randomBytes } from "crypto";
import { headers } from "next/headers";
import { supabaseAdmin } from "./supabaseAdmin";
import { recordEvent } from "./events";
import { sendSms, smsCapability } from "./sms";
import {
  canGenerateLink,
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

  // Two different bars. Producing a link needs only that the business is not
  // suppressed; TEXTING one also needs somebody to address it to and a number
  // to send it to. Applying the send bar to both is what made Copy Link dead
  // on every lead without a discovered mobile — which, with no contact
  // provider configured, is all of them.
  const gate = input.linkOnly
    ? canGenerateLink({ doNotCall: l.do_not_call, phoneInvalid: l.phone_invalid })
    : canSend({
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
      // 23505 = the one-packet-per-lead unique index. Two people pressed Send
      // on the same business at once; the other one won. That is not a failure
      // worth showing anybody — load the row they created and carry on with
      // the same token, which is exactly what the constraint is there to
      // guarantee.
      if (error?.code === "23505") {
        const existing = await loadPacket(input.leadId);
        if (existing) packet = existing;
      }

      if (!packet) {
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
    } else {
      packet = data as PacketRow;
    }
  }

  const origin = await appOrigin();
  const link = packetUrl(origin, packet.token);
  const message = renderMessage({
    ownerName: input.ownerName.trim() || "there",
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

/* -------------------------------------------------------------------------- */
/* packets for a whole email batch                                            */
/* -------------------------------------------------------------------------- */

/**
 * Make sure every lead in this batch has a packet, and hand back the links.
 *
 * THIS REVERSES AN EARLIER DECISION, so the reasoning is worth writing down.
 *
 * The email push used to READ existing packets and never create one, on the
 * grounds that a packet is something a caller makes during a conversation and
 * minting one as a side effect would fill the board with businesses nobody had
 * spoken to.
 *
 * That was wrong about the consequence. A freshly-created packet sits at
 * `not_sent`, and nothing on the board surfaces those — the trial alert reads
 * `trial_requested` and the admin list is a list. What it actually did was
 * make {{workshop_link}} empty for every cold-emailed lead, because a lead
 * being emailed by definition has not been spoken to yet. The variable was
 * shipped, plumbed and permanently blank.
 *
 * So the email now mints its own. The prospect clicks a link and sees the same
 * page a caller would have sent them: their own gaps, their own
 * recommendations, the same offer.
 *
 * Two queries for the whole batch rather than three per lead — a two-hundred
 * lead push through createAndSendPacket would be six hundred round trips.
 *
 * Suppression is already applied upstream: emailEligibility excludes anyone on
 * the do-not-call list before a lead reaches a batch. That is the same bar
 * canGenerateLink applies, and this function is never the first gate.
 */
export async function ensurePacketsFor(
  leads: { id: string; ownerName?: string | null; ownerEmail?: string | null }[],
  origin: string
): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  if (leads.length === 0 || !origin) return links;

  const db = supabaseAdmin();
  const ids = leads.map((l) => l.id);

  try {
    const { data: existing, error } = await db
      .from("workshop_packets")
      .select("lead_id, token")
      .in("lead_id", ids);
    // A missing table means migration 0024 has not been run. The email still
    // goes; it just has no link in it.
    if (error) return links;

    const have = new Set<string>();
    for (const p of existing || []) {
      if (p.token) {
        have.add(String(p.lead_id));
        links.set(String(p.lead_id), packetUrl(origin, String(p.token)));
      }
    }

    const missing = leads.filter((l) => !have.has(l.id));
    if (missing.length === 0) return links;

    const rows = missing.map((l) => ({
      lead_id: l.id,
      token: randomBytes(TOKEN_BYTES).toString("hex"),
      status: "not_sent" as const,
      // So the board and the dialer can tell a packet the sequence made from
      // one a caller made on a call. A VA opening this lead later sees that
      // the owner already has the link, which changes what they say.
      delivery_method: "email" as const,
      sent_by_name: "Email sequence",
      owner_name: (l.ownerName || "").trim() || null,
      owner_email: (l.ownerEmail || "").trim() || null,
    }));

    const { data: created } = await db
      .from("workshop_packets")
      .insert(rows)
      .select("lead_id, token");

    for (const p of created || []) {
      if (p.token) links.set(String(p.lead_id), packetUrl(origin, String(p.token)));
    }

    /*
     * A partial insert is possible: the one-packet-per-lead index rejects the
     * whole statement if a caller created one for any of these leads between
     * the read above and this write. Re-read rather than losing the batch —
     * the constraint exists to guarantee one token per lead, and the right
     * response to hitting it is to use the token that won.
     */
    if ((created?.length ?? 0) < missing.length) {
      const { data: after } = await db
        .from("workshop_packets")
        .select("lead_id, token")
        .in("lead_id", missing.map((l) => l.id));
      for (const p of after || []) {
        if (p.token) links.set(String(p.lead_id), packetUrl(origin, String(p.token)));
      }
    }
  } catch {
    // No link is a slightly plainer email, never a failed push.
  }

  return links;
}
