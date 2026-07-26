import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Makes one minimal Places call and returns Google's COMPLETE response.
 * A 403 has several possible causes that look identical in a truncated
 * message, so this exists to show the raw text rather than a guess.
 */
export async function GET() {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    return NextResponse.json({
      ok: false,
      stage: "env",
      message:
        "GOOGLE_PLACES_API_KEY is not present on this deployment. Add it in Vercel and redeploy.",
    });
  }

  // Report the shape of the key without ever exposing it.
  const fingerprint = {
    length: key.length,
    starts_with: key.slice(0, 6),
    ends_with: key.slice(-4),
    looks_like_google_key: /^AIza[0-9A-Za-z_-]{35}$/.test(key),
    has_whitespace: /\s/.test(key),
    has_quotes: /["']/.test(key),
  };

  let res: Response;
  try {
    res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.displayName",
      },
      body: JSON.stringify({ textQuery: "coffee in Detroit, MI", pageSize: 1 }),
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      stage: "network",
      key_fingerprint: fingerprint,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  const raw = await res.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* not JSON */
  }

  // Pull Google's own reason/domain metadata out, which is what actually
  // distinguishes the causes of a 403.
  const err = (parsed as { error?: { status?: string; message?: string; details?: unknown[] } })
    ?.error;
  const details = (err?.details || []) as { reason?: string; domain?: string; metadata?: unknown }[];

  let likelyCause: string | null = null;
  if (res.status === 403) {
    const reason = details.map((d) => d.reason).filter(Boolean).join(",");
    if (/SERVICE_DISABLED/i.test(raw)) {
      likelyCause =
        "The API is not enabled ON THE PROJECT THIS KEY BELONGS TO. A key from project A cannot use an API enabled in project B — check the project selector at the top of Google Cloud Console matches the project the key was created in.";
    } else if (/API_KEY_HTTP_REFERRER_BLOCKED/i.test(raw)) {
      likelyCause =
        "The key has an HTTP referrer (website) restriction. This is a server-side call with no referrer, so it will always be blocked. Set Application restrictions to 'None' (or IP addresses).";
    } else if (/API_KEY_SERVICE_BLOCKED/i.test(raw)) {
      likelyCause =
        "The key's API restrictions do not include Places API (New). Credentials → your key → API restrictions → add 'Places API (New)', or set 'Don't restrict key'.";
    } else if (/BILLING/i.test(raw)) {
      likelyCause = "Billing is not enabled on the Google Cloud project.";
    } else if (reason) {
      likelyCause = `Google reason code: ${reason}`;
    } else if (details.length === 0) {
      // A bare PERMISSION_DENIED with no ErrorInfo detail is what Places API
      // (New) returns when the project has no active billing — including a
      // free trial that still requires prepayment.
      likelyCause =
        "Google returned a bare PERMISSION_DENIED with no reason code. For Places API (New) this almost always means BILLING IS NOT ACTIVE on the project — including a free trial that still requires prepayment. Go to Google Cloud Console → Billing, complete any outstanding prepayment, and confirm a billing account is linked to this project. If you only just changed the key's API restrictions, also give it 2-5 minutes to propagate and test again.";
    }
  }

  return NextResponse.json({
    ok: res.ok,
    http_status: res.status,
    key_fingerprint: fingerprint,
    google_status: err?.status ?? null,
    google_message: err?.message ?? null,
    google_details: details,
    likely_cause: likelyCause,
    raw_response: raw.slice(0, 4000),
  });
}
