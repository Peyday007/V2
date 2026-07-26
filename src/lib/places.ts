import "server-only";

// Google Places API (New) — Text Search with pagination.
// The key is server-only: GOOGLE_PLACES_API_KEY has no NEXT_PUBLIC_ prefix,
// so Next.js never ships it to the browser.

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

// Keep this mask tight — Places New bills by field tier.
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "places.primaryType",
  "places.types",
  "places.location",
  "nextPageToken",
].join(",");

export type PlaceResult = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: {
    longText?: string;
    shortText?: string;
    types?: string[];
  }[];
  nationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  primaryType?: string;
  types?: string[];
  location?: { latitude?: number; longitude?: number };
};

export type PlacesPage = {
  places: PlaceResult[];
  nextPageToken: string | null;
};

/** Turn Google's raw error into something the admin can act on. */
function explain(status: number, body: string): string {
  if (status === 403) {
    if (/blocked|has not been used|is disabled|SERVICE_DISABLED/i.test(body)) {
      return (
        "Google is blocking this request. Enable **Places API (New)** in Google Cloud Console " +
        "→ APIs & Services → Library (note: 'Places API' and 'Places API (New)' are different " +
        "products — you need the New one). If your API key has API restrictions, add Places API " +
        "(New) to its allowed list. Changes take a minute to propagate."
      );
    }
    return (
      "Google rejected the key (403). Check that billing is enabled on the Google Cloud project " +
      "and that the key has no HTTP-referrer restriction — this is a server-side call, so a " +
      "referrer-restricted key will always fail."
    );
  }
  if (status === 400) return "Google rejected the request as malformed (400).";
  if (status === 429) return "Google rate limit hit (429). It will retry automatically.";
  return "";
}

export class PlacesError extends Error {
  status: number;
  retryable: boolean;
  hint: string;
  constructor(status: number, message: string) {
    const hint = explain(status, message);
    super(`Places API ${status}: ${hint || message}`);
    this.status = status;
    this.hint = hint;
    // 429/5xx are transient; 4xx (bad key, bad request) are not.
    this.retryable = status === 429 || status >= 500;
  }
}

export function placesKeyConfigured(): boolean {
  return !!process.env.GOOGLE_PLACES_API_KEY;
}

export async function searchPlaces(opts: {
  textQuery: string;
  pageToken?: string | null;
  pageSize?: number;
  latitude?: number | null;
  longitude?: number | null;
  radiusM?: number | null;
}): Promise<PlacesPage> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new PlacesError(0, "GOOGLE_PLACES_API_KEY is not set on the server");
  }

  const body: Record<string, unknown> = {
    textQuery: opts.textQuery,
    pageSize: Math.min(opts.pageSize ?? 20, 20),
  };
  if (opts.pageToken) body.pageToken = opts.pageToken;
  if (opts.latitude != null && opts.longitude != null && opts.radiusM) {
    body.locationBias = {
      circle: {
        center: { latitude: opts.latitude, longitude: opts.longitude },
        radius: Math.min(opts.radiusM, 50000),
      },
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    throw new PlacesError(
      0,
      e instanceof Error && e.name === "AbortError"
        ? "request timed out"
        : String(e)
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[places] ${res.status}:`, text.slice(0, 1000));
    throw new PlacesError(res.status, text);
  }

  const json = (await res.json()) as {
    places?: PlaceResult[];
    nextPageToken?: string;
  };
  return {
    places: json.places || [],
    nextPageToken: json.nextPageToken || null,
  };
}

/** Pull city / state / zip out of Places addressComponents. */
export function addressParts(place: PlaceResult): {
  city: string | null;
  state: string | null;
  zip: string | null;
} {
  let city: string | null = null;
  let state: string | null = null;
  let zip: string | null = null;
  for (const c of place.addressComponents || []) {
    const types = c.types || [];
    if (types.includes("locality") && !city) city = c.longText || null;
    if (!city && types.includes("postal_town")) city = c.longText || null;
    if (types.includes("administrative_area_level_1")) {
      state = c.shortText || null;
    }
    if (types.includes("postal_code")) zip = c.longText || null;
  }
  return { city, state, zip };
}
