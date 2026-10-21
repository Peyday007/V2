import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { trackWorkshopEvent } from "@/lib/workshopAssessment";
import { conversionFromEvent, verifyStripeSignature } from "@/lib/workshopCheckout";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Stripe tells us a workshop checkout was paid, and the packet becomes
// `converted`.
//
// The signature is checked against the RAW body before anything is parsed, so
// nobody but Stripe can mark a packet paid. The packet comes from the session's
// own metadata, which this app wrote when it opened the checkout.
//
// IDEMPOTENT. `workshop.converted` is a once-ever event, so Stripe's retries,
// a completed event followed by async_payment_succeeded, or two deliveries of
// one event all record a single conversion. A duplicate still answers 200 —
// a non-2xx makes Stripe retry for days.

export async function POST(req: NextRequest) {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured." }, { status: 503 });
  }
  const payload = await req.text();
  if (!verifyStripeSignature({ payload, header: req.headers.get("stripe-signature"), secret })) {
    return NextResponse.json({ error: "Bad signature." }, { status: 400 });
  }

  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    return NextResponse.json({ error: "Bad payload." }, { status: 400 });
  }

  const conversion = conversionFromEvent(event);
  // Every other event type is acknowledged and ignored.
  if (!conversion) return NextResponse.json({ received: true, converted: false });

  const { data: packet } = await supabaseAdmin()
    .from("workshop_packets")
    .select("id, variant")
    .eq("id", conversion.packetId)
    .maybeSingle();
  if (!packet) {
    // Not ours (another product on the same Stripe account), or deleted.
    return NextResponse.json({ received: true, converted: false });
  }

  const { recorded } = await trackWorkshopEvent({
    packetId: conversion.packetId,
    event: "workshop.converted",
    variant: (packet.variant as string) ?? null,
    metadata: {
      source: "stripe",
      stripe_event: conversion.eventId,
      checkout_session: conversion.sessionId,
      amount_total: conversion.amountTotal,
      currency: conversion.currency,
    },
  });
  return NextResponse.json({ received: true, converted: true, firstTime: recorded });
}
