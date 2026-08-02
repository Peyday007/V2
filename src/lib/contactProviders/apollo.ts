// Apollo.io — People Match.
//
// UNVERIFIED AGAINST A LIVE ACCOUNT. Written from the documented shape of the
// people/match endpoint. Apollo gates phone reveal behind plan level and
// charges credits per reveal, so this is marked as billing per request rather
// than only on a hit — the pessimistic assumption, so a budget cap cannot be
// overshot by a wrong guess about billing.
//
// Verify `normalise` against current docs before relying on it.

import {
  emptyResult,
  type ContactProvider,
  type LookupResult,
  type LookupSubject,
  type ProviderPhone,
} from "./types";
import { toE164, type LineType } from "../phoneIntel";

const ENDPOINT = "https://api.apollo.io/v1/people/match";

function lineTypeOf(raw: unknown): LineType {
  const t = String(raw ?? "").toLowerCase();
  if (t.includes("mobile") || t.includes("cell")) return "mobile";
  if (t.includes("work_hq") || t.includes("hq")) return "landline";
  if (t.includes("home")) return "landline";
  if (t.includes("voip")) return "voip";
  return "unknown";
}

/** Pure, so the mapping can be tested without a network or a key. */
export function normalise(
  body: unknown,
  subject: Pick<LookupSubject, "mainBusinessPhone">
): { phones: ProviderPhone[]; email: string | null; profileUrl: string | null } {
  const person = (body as { person?: Record<string, unknown> })?.person;
  if (!person) return { phones: [], email: null, profileUrl: null };

  const main = toE164(subject.mainBusinessPhone);
  const seen = new Set<string>();
  const phones: ProviderPhone[] = [];
  const id = person.id ? String(person.id) : null;

  const push = (raw: unknown, type: LineType, verified: boolean, confidence: number) => {
    const e164 = toE164(typeof raw === "string" ? raw : String(raw ?? ""));
    if (!e164 || seen.has(e164)) return;
    if (main && e164 === main) return;
    seen.add(e164);
    phones.push({ phone: e164, lineType: type, confidence, providerVerified: verified, sourceRef: id });
  };

  // A dedicated mobile field is a stronger claim than the general list.
  push(person.mobile_phone, "mobile", true, 0.9);

  const numbers = Array.isArray(person.phone_numbers) ? person.phone_numbers : [];
  for (const entry of numbers) {
    const o = entry as { raw_number?: unknown; sanitized_number?: unknown; type?: unknown; status?: unknown };
    const verified = String(o.status ?? "").toLowerCase().includes("verified");
    push(o.sanitized_number ?? o.raw_number, lineTypeOf(o.type), verified, verified ? 0.88 : 0.6);
  }

  const email =
    typeof person.email === "string" && !person.email.includes("email_not_unlocked")
      ? person.email
      : null;

  return {
    phones,
    email,
    profileUrl: typeof person.linkedin_url === "string" ? person.linkedin_url : null,
  };
}

export const apollo: ContactProvider = {
  key: "apollo",
  label: "Apollo.io",
  order: 20,
  // Pessimistic on purpose: assuming hit-only billing when it is per-request
  // is how a budget cap gets overshot.
  billsOnlyOnHit: false,
  costPerHitCents: Number(process.env.APOLLO_COST_CENTS || 30),

  isAvailable: () => !!process.env.APOLLO_API_KEY,
  unavailableReason: () =>
    process.env.APOLLO_API_KEY ? null : "APOLLO_API_KEY is not set in the environment.",

  async lookup(subject: LookupSubject): Promise<LookupResult> {
    const key = process.env.APOLLO_API_KEY;
    if (!key) return emptyResult("apollo", "APOLLO_API_KEY is not set.");

    const payload: Record<string, unknown> = {
      first_name: subject.firstName,
      last_name: subject.lastName,
      organization_name: subject.businessName,
      reveal_personal_emails: false,
      // Revealing a number is what costs; asking for it explicitly keeps the
      // spend intentional rather than incidental.
      reveal_phone_number: true,
    };
    if (subject.domain) payload.domain = subject.domain;
    if (subject.email) payload.email = subject.email;
    if (subject.profileUrl) payload.linkedin_url = subject.profileUrl;

    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "X-Api-Key": key,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        return {
          provider: "apollo",
          phones: [],
          retrievedAt: new Date().toISOString(),
          // A rejected request still consumed nothing billable.
          costCents: 0,
          error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        };
      }
      const body = await res.json();
      const { phones, email, profileUrl } = normalise(body, subject);
      return {
        provider: "apollo",
        phones,
        email,
        profileUrl,
        retrievedAt: new Date().toISOString(),
        // Charged per request on this plan model, hit or not.
        costCents: apollo.costPerHitCents,
      };
    } catch (e) {
      return {
        provider: "apollo",
        phones: [],
        retrievedAt: new Date().toISOString(),
        costCents: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
};
