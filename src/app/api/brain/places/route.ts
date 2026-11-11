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
    return NextResponse.json({ ok: true, placesKeyConfigured: placesKeyConfigured() });
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
        { error: "places_error", status: e.status, hint: e.hint },
        { status: 502 }
      );
    }
    console.error("[brain/places] unexpected error", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
