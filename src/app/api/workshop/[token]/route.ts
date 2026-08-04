import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordEvent } from "@/lib/events";
import {
  advanceStatus,
  buildRecommendations,
  computeGaps,
  looksLikeToken,
  type PacketStatus,
} from "@/lib/workshopPacket";

export const dynamic = "force-dynamic";

// The only endpoint a business owner can reach, and the only one with no
// authentication in front of it.
//
// Three rules, because this is the app's single public surface:
//
//   1. The token is the credential. A malformed one is rejected before it
//      reaches the database.
//   2. Nothing about any other lead is ever returned. The response is built
//      field by field from an allow-list, never by spreading a row — a
//      `select *` here would publish the owner's phone, the enrichment
//      provider, the do-not-call flag and every internal id.
//   3. Not found and expired look identical from outside. Distinguishing them
//      turns this into an oracle for guessing tokens.

function notFound() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

async function packetByToken(token: string) {
  const { data } = await supabaseAdmin()
    .from("workshop_packets")
    .select(
      "id, lead_id, token, status, owner_name, owner_phone, owner_email, trial_requested_at, leads(business_name, city, state, website, rating, review_count, answering_setup, diagnostic_findings)"
    )
    .eq("token", token)
    .maybeSingle();
  return data;
}

/** Supabase types a to-one relation as an object or an array depending on the join. */
function one<T>(rel: T | T[] | null | undefined): T | null {
  if (Array.isArray(rel)) return rel[0] ?? null;
  return rel ?? null;
}

type LeadBits = {
  business_name: string;
  city: string | null;
  state: string | null;
  website: string | null;
  rating: number | null;
  review_count: number | null;
  answering_setup: string | null;
  /**
   * The findings, cached by the diagnostic. Present for any lead enriched
   * since migration 0032; absent for older ones, which fall back to the three
   * original checks in computeGaps.
   */
  diagnostic_findings?: { key: string; headline: string; detail: string; basis: string[] }[] | null;
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!looksLikeToken(token)) return notFound();

  let row;
  try {
    row = await packetByToken(token);
  } catch {
    // Never leak a database error to a prospect's browser.
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
  if (!row) return notFound();

  const lead = one(row.leads as LeadBits | LeadBits[] | null);
  if (!lead) return notFound();

  // Mark it opened — but only forwards. This runs on every load, so without
  // advanceStatus a refresh after agreeing would knock trial_requested back
  // down to opened and lose the only state anybody cares about.
  const current = row.status as PacketStatus;
  const next = advanceStatus(current, "opened");
  if (next !== current) {
    await supabaseAdmin()
      .from("workshop_packets")
      .update({ status: next, opened_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", row.id);
    await recordEvent({
      type: "workshop.opened",
      entityType: "lead",
      entityId: row.lead_id,
      leadId: row.lead_id,
      actorType: "system",
      source: "api",
      newValue: { status: next },
    });
  }

  /*
   * One input for both, so the page cannot show findings that the
   * recommendations do not answer.
   *
   * `findings` is the diagnosis when one exists. Note what is NOT passed:
   * nothing from affordability.ts. The size estimate is internal, it never
   * reaches this response, and there is a test asserting no budget figure or
   * band word appears in any owner-facing string.
   */
  const gapInput = {
    businessName: lead.business_name,
    city: lead.city,
    website: lead.website,
    rating: lead.rating,
    reviewCount: lead.review_count,
    answeringSetup: lead.answering_setup,
    findings: lead.diagnostic_findings ?? undefined,
  };

  return NextResponse.json({
    businessName: lead.business_name,
    city: lead.city,
    state: lead.state,
    gaps: computeGaps(gapInput),
    recommendations: buildRecommendations(gapInput),
    // Prefilled into the form. These are values this owner supplied or that a
    // caller recorded about them — nothing about any other business.
    contact: {
      name: row.owner_name || "",
      phone: row.owner_phone || "",
      email: row.owner_email || "",
    },
    alreadyRequested: (row.status as PacketStatus) === "trial_requested",
    requestedAt: row.trial_requested_at,
  });
}

/**
 * The owner agrees to the trial.
 *
 * No OTP, no identity check — by design. This is a checkbox on a public page,
 * and its value is that a human is alerted and follows up, not that it is
 * binding. Nothing downstream treats it as a signed contract.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!looksLikeToken(token)) return notFound();

  const body = await req.json().catch(() => ({}));
  const name = String(body.name || "").trim().slice(0, 120);
  const phone = String(body.phone || "").trim().slice(0, 40);
  const email = String(body.email || "").trim().slice(0, 160);

  if (!body.agreed) {
    return NextResponse.json({ error: "Please tick the box to start the trial." }, { status: 400 });
  }
  if (!name || !phone) {
    return NextResponse.json({ error: "We need a name and a phone number." }, { status: 400 });
  }

  let row;
  try {
    row = await packetByToken(token);
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
  if (!row) return notFound();

  // Agreeing twice is not an error — the owner refreshed, or tapped twice on a
  // slow connection. Report success and leave the first timestamp alone.
  if ((row.status as PacketStatus) === "trial_requested") {
    return NextResponse.json({ ok: true, alreadyRequested: true });
  }

  const now = new Date().toISOString();
  const { error } = await supabaseAdmin()
    .from("workshop_packets")
    .update({
      status: "trial_requested",
      trial_requested_at: now,
      // Stored separately from owner_name/owner_phone: what the owner typed is
      // evidence, and it must not silently overwrite what the caller recorded.
      agreed_name: name,
      agreed_phone: phone,
      agreed_email: email || null,
      agreed_text: String(body.agreement_text || "").slice(0, 500) || null,
      updated_at: now,
    })
    .eq("id", row.id);

  if (error) {
    return NextResponse.json(
      { error: "We could not save that. Please try again in a moment." },
      { status: 500 }
    );
  }

  await recordEvent({
    type: "workshop.trial_requested",
    entityType: "lead",
    entityId: row.lead_id,
    leadId: row.lead_id,
    actorType: "system",
    source: "api",
    newValue: { name, phone, email: email || null },
    verificationStatus: "unverified",
  });

  return NextResponse.json({ ok: true, alreadyRequested: false });
}
