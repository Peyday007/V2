// The close: a Stripe payment step on the workshop page, a signed webhook that
// marks the packet converted, and no call anywhere on the way.

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  checkoutOffer,
  conversionFromEvent,
  createCheckoutSession,
  verifyStripeSignature,
} from "../src/lib/workshopCheckout";
import {
  EVENT_STATUS,
  WORKSHOP_STATUSES,
  advanceStatus,
  needsAttention,
  nextAction,
} from "../src/lib/workshopLifecycle";
import { isProtectedPath } from "../src/lib/adminAuth";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

function sign(payload: string, secret: string, t: number): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("the offer is configured or absent", () => {
  it("is absent without a key or a price", () => {
    expect(checkoutOffer({})).toBeNull();
    expect(checkoutOffer({ STRIPE_SECRET_KEY: "sk_test_x" })).toBeNull();
    expect(checkoutOffer({ WORKSHOP_PRICE_CENTS: "49700" })).toBeNull();
    expect(
      checkoutOffer({ STRIPE_SECRET_KEY: "sk_test_x", WORKSHOP_PRICE_CENTS: "12.5" })
    ).toBeNull();
  });

  it("labels the price it will charge", () => {
    const offer = checkoutOffer({
      STRIPE_SECRET_KEY: "sk_test_x",
      WORKSHOP_PRICE_CENTS: "49700",
      WORKSHOP_OFFER_NAME: "Private build",
    });
    expect(offer).toMatchObject({ amountCents: 49700, currency: "usd", name: "Private build", priceLabel: "$497" });
  });
});

describe("starting a checkout", () => {
  const offer = { amountCents: 49700, currency: "usd", name: "Private build", priceLabel: "$497" };

  it("sends the packet id as the only link back, and returns Stripe's page", async () => {
    let sent = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const started = await createCheckoutSession({
      packetId: "pkt_1",
      token: "tok",
      origin: "https://example.test",
      email: "owner@example.test",
      offer,
      fetchImpl,
      secretKey: "sk_test_x",
    });
    expect(started).toEqual({ ok: true, url: "https://checkout.stripe.com/c/cs_1", sessionId: "cs_1" });
    const form = new URLSearchParams(sent);
    expect(form.get("client_reference_id")).toBe("pkt_1");
    expect(form.get("metadata[workshop_packet]")).toBe("pkt_1");
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("49700");
    expect(form.get("success_url")).toBe("https://example.test/workshop/tok?paid=1");
    expect(form.get("customer_email")).toBe("owner@example.test");
  });

  it("does not echo a provider error", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "sk_test_x is invalid" } }), { status: 401 })) as unknown as typeof fetch;
    const started = await createCheckoutSession({
      packetId: "pkt_1",
      token: "tok",
      origin: "https://example.test",
      offer,
      fetchImpl,
      secretKey: "sk_test_x",
    });
    expect(started.ok).toBe(false);
    expect(JSON.stringify(started)).not.toMatch(/sk_test/);
  });
});

describe("the webhook believes Stripe and nobody else", () => {
  const secret = "whsec_test";
  const now = 1_800_000_000;
  const payload = JSON.stringify({ id: "evt_1" });

  it("accepts a valid signature, including during a rotation", () => {
    expect(verifyStripeSignature({ payload, header: sign(payload, secret, now), secret, nowSeconds: now })).toBe(true);
    const rotated = `${sign(payload, "whsec_old", now)},v1=${sign(payload, secret, now).split("v1=")[1]}`;
    expect(verifyStripeSignature({ payload, header: rotated, secret, nowSeconds: now })).toBe(true);
  });

  it("refuses a wrong secret, a changed body, a stale timestamp and no header", () => {
    expect(verifyStripeSignature({ payload, header: sign(payload, "nope", now), secret, nowSeconds: now })).toBe(false);
    expect(
      verifyStripeSignature({ payload: payload + " ", header: sign(payload, secret, now), secret, nowSeconds: now })
    ).toBe(false);
    expect(
      verifyStripeSignature({ payload, header: sign(payload, secret, now - 301), secret, nowSeconds: now })
    ).toBe(false);
    expect(verifyStripeSignature({ payload, header: null, secret, nowSeconds: now })).toBe(false);
  });

  it("a paid completed session converts its packet; an unpaid one does not", () => {
    const event = (type: string, paymentStatus: string) => ({
      id: "evt_1",
      type,
      data: {
        object: {
          object: "checkout.session",
          id: "cs_1",
          payment_status: paymentStatus,
          client_reference_id: "pkt_1",
          metadata: { workshop_packet: "pkt_1" },
          amount_total: 49700,
          currency: "usd",
        },
      },
    });
    expect(conversionFromEvent(event("checkout.session.completed", "paid"))).toMatchObject({
      packetId: "pkt_1",
      sessionId: "cs_1",
      amountTotal: 49700,
    });
    expect(conversionFromEvent(event("checkout.session.async_payment_succeeded", "paid"))?.packetId).toBe("pkt_1");
    expect(conversionFromEvent(event("checkout.session.completed", "unpaid"))).toBeNull();
    expect(conversionFromEvent(event("payment_intent.succeeded", "paid"))).toBeNull();
  });

  it("is reachable without the admin passphrase, and nothing next to it is", () => {
    expect(isProtectedPath("/api/stripe/webhook")).toBe(false);
    expect(isProtectedPath("/api/stripe")).toBe(true);
    expect(isProtectedPath("/api/stripe/webhook-test")).toBe(true);
  });
});

describe("the lifecycle closes on the page, never on a call", () => {
  it("starting checkout is interest; only payment converts", () => {
    expect(EVENT_STATUS["workshop.checkout_started"]).toBe("interested");
    expect(EVENT_STATUS["workshop.converted"]).toBe("converted");
    expect(advanceStatus("engaged", "interested")).toBe("interested");
    expect(needsAttention("workshop.converted")).toBe(true);
  });

  it("no next action tells anybody to ring, call or book a time", () => {
    for (const status of WORKSHOP_STATUSES) {
      for (const audit of [true, false]) {
        expect(nextAction(status, audit), status).not.toMatch(/\bring\b|\bcall\b|book a time/i);
      }
    }
  });

  it("the public route refuses a phone or video walkthrough and a forged conversion", () => {
    const route = read("../src/app/api/workshop/[token]/route.ts");
    expect(route).not.toMatch(/phone: "workshop\.walkthrough_phone_requested"/);
    expect(route).not.toMatch(/video: "workshop\.walkthrough_video_requested"/);
    // The page can start a checkout; the converted event is never accepted from it.
    expect(route).toMatch(/"start_checkout"/);
    expect(route).not.toMatch(/event: "workshop\.converted"/);
  });
});
