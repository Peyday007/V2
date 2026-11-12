import { NextRequest, NextResponse } from "next/server";
import { verifyBrainRequest } from "@/lib/brainBridge";
import { PlacesError, placesKeyConfigured, searchPlaces } from "@/lib/places";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/*
 * Brain's door to V2's Google Places connection.
 *
 * The path is outside the admin passphrase (see isProtectedPath); the Ed25519
 * signature checked here is the whole access control. Every auth failure gets
 * the same body, so a caller learns nothing about why; the reason is logged.
 * The Google key never leaves this deployment — only mapped results do.
 */

const PATH = "/api/brain/places";

type Body = {
  probe?: boolean;
  /** With probe: also ask Google whether it accepts the key (an IDs-only search, Google's no-charge SKU). */
  verify?: boolean;
  textQuery?: string;
  latitude?: number;
  longitude?: number;
  radiusM?: number;
  pageToken?: string;
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const verdict = verifyBrainRequest({
    method: "POST",
    path: PATH,
    timestamp: req.headers.get("x-brain-timestamp"),
    keyId: req.headers.get("x-brain-key-id"),
    signature: req.headers.get("x-brain-signature"),
    body: raw,
  });
  if (!verdict.ok) {
    console.warn(`[brain/places] refused: ${verdict.reason}`);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.probe === true) {
    if (body.verify !== true || !placesKeyConfigured()) {
      return NextResponse.json({ ok: true, placesKeyConfigured: placesKeyConfigured() });
    }
    return NextResponse.json({ ok: true, placesKeyConfigured: true, google: await verifyKey() });
  }

  const textQuery = typeof body.textQuery === "string" ? body.textQuery.trim() : "";
  if (textQuery.length < 3 || textQuery.length > 200) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!placesKeyConfigured()) {
    return NextResponse.json({ error: "places_not_configured" }, { status: 503 });
  }

  try {
    const page = await searchPlaces({
      textQuery,
      pageSize: 20,
      latitude: num(body.latitude),
      longitude: num(body.longitude),
      radiusM: num(body.radiusM),
      pageToken: typeof body.pageToken === "string" && body.pageToken ? body.pageToken : null,
    });
    return NextResponse.json({
      ok: true,
      places: page.places.map((p) => ({
        id: p.id,
        name: p.displayName?.text ?? null,
        address: p.formattedAddress ?? null,
        website: p.websiteUri ?? null,
        phone: p.nationalPhoneNumber ?? null,
        primaryType: p.primaryType ?? null,
        businessStatus: p.businessStatus ?? null,
      })),
      nextPageToken: page.nextPageToken,
    });
  } catch (e) {
    if (e instanceof PlacesError) {
      return NextResponse.json(
        { error: "places_error", status: e.status, hint: e.hint, google: googleMessage(errorMessageOf(e.body)) },
        { status: 502 }
      );
    }
    console.error("[brain/places] unexpected error", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/**
 * Does Google accept the key? One Text Search asking only for place ids
 * (Google's "IDs Only" SKU, which carries no charge), returning Google's own
 * status, reason codes and one-line message — never the key, and never
 * Google's raw body. A 403 with no reason codes (PERMISSION_DENIED alone) is
 * only diagnosable from the message, so it is passed on with anything that
 * looks like a key or a URL removed.
 */
function errorMessageOf(body: string): unknown {
  try {
    return (JSON.parse(body) as { error?: { message?: unknown } })?.error?.message;
  } catch {
    return null;
  }
}

function googleMessage(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const key = process.env.GOOGLE_PLACES_API_KEY ?? "";
  let text = raw.replace(/\s+/g, " ").trim();
  if (key) text = text.split(key).join("[key]");
  text = text.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[key]").replace(/https?:\/\/\S+/g, "[link]");
  return text.slice(0, 300);
}

async function verifyKey(): Promise<{ accepted: boolean; status: number; reasons: string[]; googleStatus: string | null; message: string | null }> {
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY ?? "",
        "X-Goog-FieldMask": "places.id",
      },
      body: JSON.stringify({ textQuery: "coffee in Camp Hill, PA", pageSize: 1 }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return { accepted: true, status: res.status, reasons: [], googleStatus: null, message: null };
    const parsed = (await res.json().catch(() => null)) as
      | { error?: { status?: string; message?: string; details?: { reason?: string }[] } }
      | null;
    const reasons = (parsed?.error?.details ?? [])
      .map((d) => d.reason)
      .filter((r): r is string => typeof r === "string" && /^[A-Z_]{3,64}$/.test(r));
    const googleStatus = parsed?.error?.status && /^[A-Z_]{3,64}$/.test(parsed.error.status) ? parsed.error.status : null;
    return { accepted: false, status: res.status, reasons, googleStatus, message: googleMessage(parsed?.error?.message) };
  } catch {
    return { accepted: false, status: 0, reasons: [], googleStatus: null, message: null };
  }
}
