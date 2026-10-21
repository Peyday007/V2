// The close: a payment link on the workshop page, and the webhook that turns a
// paid checkout into `converted`.
//
// WHY THIS EXISTS. `converted` was declared in the lifecycle and unreachable
// from the page — the only way forward from interest was a person booking a
// phone or video call. Nobody here takes calls, so the close has to happen on
// the page: the prospect pays through Stripe Checkout, and Stripe tells us.
//
// WHAT DECIDES A CONVERSION. Only a Stripe event whose signature verifies
// against STRIPE_WEBHOOK_SECRET and whose checkout session reports
// payment_status "paid". Nothing the public page sends can produce one: the
// page may only START a checkout, and starting one implies interest, nothing
// more.
//
// FAIL CLOSED. With no secret key or no price configured, no checkout is
// offered and the page shows the interest form alone. A half-configured close
// that took a click and then failed would be worse than none.
//
// No Stripe SDK: two REST calls and an HMAC, all with the platform's fetch and
// node:crypto, so nothing new is installed.

import { createHmac, timingSafeEqual } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* the offer                                                                  */
/* -------------------------------------------------------------------------- */

export type CheckoutOffer = {
  amountCents: number;
  currency: string;
  name: string;
  /** "$497" — what the button says. */
  priceLabel: string;
};

/**
 * What the page may sell, read from the environment on every call so a removed
 * secret stops the offer without a redeploy.
 *
 *   STRIPE_SECRET_KEY     sk_live_… / sk_test_…
 *   WORKSHOP_PRICE_CENTS  whole cents, e.g. 49700
 *   WORKSHOP_CURRENCY     ISO code, default "usd"
 *   WORKSHOP_OFFER_NAME   what the line item is called
 */
export function checkoutOffer(env: Record<string, string | undefined> = process.env): CheckoutOffer | null {
  const key = (env.STRIPE_SECRET_KEY || "").trim();
  const cents = Number((env.WORKSHOP_PRICE_CENTS || "").trim());
  if (!key || !Number.isInteger(cents) || cents < 50) return null;
  const currency = ((env.WORKSHOP_CURRENCY || "usd").trim() || "usd").toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) return null;
  const name = (env.WORKSHOP_OFFER_NAME || "").trim() || "Your private build";
  return { amountCents: cents, currency, name, priceLabel: priceLabel(cents, currency) };
}

export function priceLabel(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/* -------------------------------------------------------------------------- */
/* starting a checkout                                                        */
/* -------------------------------------------------------------------------- */

export type CheckoutStart =
  | { ok: true; url: string; sessionId: string }
  | { ok: false; reason: string };

/**
 * One Stripe Checkout Session for one workshop packet.
 *
 * The packet id travels as client_reference_id AND as metadata, and is the only
 * thing the webhook uses to find the packet — never anything the browser sent.
 * The token is only in the return URLs, which point back at the same page.
 */
export async function createCheckoutSession(input: {
  packetId: string;
  token: string;
  origin: string;
  email?: string | null;
  offer: CheckoutOffer;
  fetchImpl?: typeof fetch;
  secretKey?: string;
}): Promise<CheckoutStart> {
  const key = (input.secretKey ?? process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (!key) return { ok: false, reason: "Payments are not set up." };
  if (!input.origin) return { ok: false, reason: "This page could not work out its own address." };

  const page = `${input.origin}/workshop/${encodeURIComponent(input.token)}`;
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("client_reference_id", input.packetId);
  form.set("metadata[workshop_packet]", input.packetId);
  form.set("payment_intent_data[metadata][workshop_packet]", input.packetId);
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", input.offer.currency);
  form.set("line_items[0][price_data][unit_amount]", String(input.offer.amountCents));
  form.set("line_items[0][price_data][product_data][name]", input.offer.name);
  form.set("success_url", `${page}?paid=1`);
  form.set("cancel_url", page);
  const email = (input.email || "").trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) form.set("customer_email", email);

  const doFetch = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch {
    return { ok: false, reason: "The payment page could not be reached. Try again in a moment." };
  }
  const body = (await res.json().catch(() => null)) as { id?: string; url?: string } | null;
  if (!res.ok || !body?.url || !body.id) {
    // The provider's message is not echoed: it can quote the request.
    return { ok: false, reason: "The payment page could not be opened. Try again in a moment." };
  }
  return { ok: true, url: body.url, sessionId: body.id };
}

/* -------------------------------------------------------------------------- */
/* the webhook                                                                */
/* -------------------------------------------------------------------------- */

/** Stripe's default tolerance for a signed timestamp. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verify a `Stripe-Signature` header against the raw body.
 *
 * Stripe signs `${t}.${payload}` with HMAC-SHA256 and may send several v1
 * signatures during a secret rotation; any one matching is enough. A timestamp
 * outside the tolerance is refused, so a captured request cannot be replayed
 * later.
 */
export function verifyStripeSignature(input: {
  payload: string;
  header: string | null;
  secret: string;
  nowSeconds?: number;
}): boolean {
  if (!input.header || !input.secret) return false;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of input.header.split(",")) {
    const [k, v] = part.split("=", 2).map((s) => s.trim());
    if (k === "t" && v && /^\d+$/.test(v)) t = Number(v);
    if (k === "v1" && v) v1.push(v);
  }
  if (t === null || v1.length === 0) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", input.secret).update(`${t}.${input.payload}`).digest();
  return v1.some((sig) => {
    if (!/^[0-9a-f]+$/i.test(sig)) return false;
    const given = Buffer.from(sig, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export type Conversion = {
  packetId: string;
  sessionId: string;
  amountTotal: number | null;
  currency: string | null;
  eventId: string;
};

/**
 * The conversion a Stripe event establishes, or null.
 *
 * `checkout.session.completed` with payment_status "paid", or the later
 * `checkout.session.async_payment_succeeded` for a delayed method. A completed
 * session that is still "unpaid" establishes nothing yet.
 */
export function conversionFromEvent(event: unknown): Conversion | null {
  if (!event || typeof event !== "object") return null;
  const e = event as {
    id?: unknown;
    type?: unknown;
    data?: { object?: Record<string, unknown> };
  };
  const type = String(e.type ?? "");
  if (type !== "checkout.session.completed" && type !== "checkout.session.async_payment_succeeded") {
    return null;
  }
  const session = e.data?.object;
  if (!session || session.object !== "checkout.session") return null;
  if (session.payment_status !== "paid") return null;
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  const packetId = String(metadata.workshop_packet ?? session.client_reference_id ?? "").trim();
  if (!packetId) return null;
  return {
    packetId,
    sessionId: String(session.id ?? ""),
    amountTotal: typeof session.amount_total === "number" ? session.amount_total : null,
    currency: typeof session.currency === "string" ? session.currency : null,
    eventId: String(e.id ?? ""),
  };
}
