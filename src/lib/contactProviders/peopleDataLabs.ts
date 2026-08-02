// People Data Labs — Person Enrichment.
//
// UNVERIFIED AGAINST A LIVE ACCOUNT. This adapter was written from the
// documented shape of the v5 Person Enrichment endpoint; nobody here has
// credentials, so it has never been exercised against the real API. Check the
// response mapping in `normalise` against current docs before trusting a bill.
// Everything it cannot map comes back empty rather than guessed.
//
// Billing: PDL charges per matched record, so this is marked billsOnlyOnHit.
// Confirm that against your own contract — the figure is configurable.

import {
  emptyResult,
  type ContactProvider,
  type LookupResult,
  type LookupSubject,
  type ProviderPhone,
} from "./types";
import { toE164, type LineType } from "../phoneIntel";

const ENDPOINT = "https://api.peopledatalabs.com/v5/person/enrich";

function lineTypeOf(raw: unknown): LineType {
  const t = String(raw ?? "").toLowerCase();
  if (t.includes("mobile") || t.includes("cell")) return "mobile";
  if (t.includes("landline") || t.includes("fixed")) return "landline";
  if (t.includes("voip")) return "voip";
  if (t.includes("toll")) return "toll_free";
  return "unknown";
}

/** Pure, so the mapping can be tested without a network or a key. */
export function normalise(
  body: unknown,
  subject: Pick<LookupSubject, "mainBusinessPhone">
): { phones: ProviderPhone[]; email: string | null; profileUrl: string | null } {
  const root = body as {
    status?: number;
    likelihood?: number;
    data?: {
      mobile_phone?: unknown;
      phone_numbers?: unknown;
      phones?: unknown;
      work_email?: unknown;
      personal_emails?: unknown;
      linkedin_url?: unknown;
      id?: unknown;
    };
  };
  const data = root?.data;
  if (!data) return { phones: [], email: null, profileUrl: null };

  // PDL reports a 0-10 likelihood for the match itself.
  const likelihood = Number(root.likelihood);
  const matchConfidence = Number.isFinite(likelihood)
    ? Math.max(0, Math.min(1, likelihood / 10))
    : 0.5;

  const main = toE164(subject.mainBusinessPhone);
  const seen = new Set<string>();
  const phones: ProviderPhone[] = [];

  const push = (raw: unknown, type: LineType, verified: boolean) => {
    const e164 = toE164(typeof raw === "string" ? raw : String(raw ?? ""));
    if (!e164 || seen.has(e164)) return;
    // Never hand back the switchboard as a personal number.
    if (main && e164 === main) return;
    seen.add(e164);
    phones.push({
      phone: e164,
      lineType: type,
      confidence: matchConfidence,
      providerVerified: verified,
      sourceRef: data.id ? String(data.id) : null,
    });
  };

  // A field explicitly named mobile_phone is the strongest thing PDL returns.
  if (data.mobile_phone) push(data.mobile_phone, "mobile", true);

  const list = Array.isArray(data.phone_numbers)
    ? data.phone_numbers
    : Array.isArray(data.phones)
      ? data.phones
      : [];
  for (const entry of list) {
    if (typeof entry === "string") {
      push(entry, "unknown", false);
      continue;
    }
    const o = entry as { number?: unknown; type?: unknown; E164?: unknown };
    push(o.number ?? o.E164, lineTypeOf(o.type), false);
  }

  const email =
    (typeof data.work_email === "string" && data.work_email) ||
    (Array.isArray(data.personal_emails) && typeof data.personal_emails[0] === "string"
      ? (data.personal_emails[0] as string)
      : null) ||
    null;

  return {
    phones,
    email,
    profileUrl: typeof data.linkedin_url === "string" ? data.linkedin_url : null,
  };
}

export const peopleDataLabs: ContactProvider = {
  key: "people_data_labs",
  label: "People Data Labs",
  order: 10,
  billsOnlyOnHit: true,
  costPerHitCents: Number(process.env.PDL_COST_CENTS || 20),

  isAvailable: () => !!process.env.PDL_API_KEY,
  unavailableReason: () =>
    process.env.PDL_API_KEY ? null : "PDL_API_KEY is not set in the environment.",

  async lookup(subject: LookupSubject): Promise<LookupResult> {
    const key = process.env.PDL_API_KEY;
    if (!key) return emptyResult("people_data_labs", "PDL_API_KEY is not set.");

    // Send the strongest identifiers available. A name alone matches the wrong
    // person constantly; a name plus a company domain rarely does.
    const params = new URLSearchParams();
    params.set("first_name", subject.firstName);
    params.set("last_name", subject.lastName);
    if (subject.domain) params.set("company", subject.domain);
    else params.set("company", subject.businessName);
    if (subject.city && subject.state) {
      params.set("location", `${subject.city}, ${subject.state}`);
    }
    if (subject.email) params.set("email", subject.email);
    if (subject.profileUrl) params.set("profile", subject.profileUrl);
    // Do not pay for a weak match.
    params.set("min_likelihood", "6");

    try {
      const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
        headers: { "X-Api-Key": key, Accept: "application/json" },
      });

      // 404 is PDL's "no match" — a valid answer, and on a hit-only plan, free.
      if (res.status === 404) {
        return {
          provider: "people_data_labs",
          phones: [],
          retrievedAt: new Date().toISOString(),
          costCents: 0,
        };
      }
      if (!res.ok) {
        return {
          provider: "people_data_labs",
          phones: [],
          retrievedAt: new Date().toISOString(),
          costCents: 0,
          error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        };
      }

      const body = await res.json();
      const { phones, email, profileUrl } = normalise(body, subject);
      return {
        provider: "people_data_labs",
        phones,
        email,
        profileUrl,
        retrievedAt: new Date().toISOString(),
        costCents: phones.length > 0 ? peopleDataLabs.costPerHitCents : 0,
      };
    } catch (e) {
      return {
        provider: "people_data_labs",
        phones: [],
        retrievedAt: new Date().toISOString(),
        costCents: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
};
