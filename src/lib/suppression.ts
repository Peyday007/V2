// Do-not-call enforcement.
//
// A DNC request is about a PHONE NUMBER and the people behind it, not about a
// row in our database. The same business routinely exists more than once —
// imported twice, sourced from two search terms, or listed under a second
// trade — so suppressing only the record the caller happened to be looking at
// leaves every duplicate dialable. This module is the single place that
// decides whether a number is off limits.
//
// Pure functions, no database, so the rule is testable and identical
// everywhere it is applied: when a DNC is recorded, when a packet is built,
// and again the moment before a lead is handed to a caller.

import { normalizePhone } from "./normalize";

export type SuppressionRow = {
  lead_id?: string | null;
  normalized_phone?: string | null;
};

export type SuppressibleLead = {
  id: string;
  phone?: string | null;
  normalized_phone?: string | null;
  do_not_call?: boolean | null;
};

/** Fast lookup built once per request from the suppression table. */
export type SuppressionIndex = {
  leadIds: Set<string>;
  phones: Set<string>;
  size: number;
};

export function buildSuppressionIndex(rows: SuppressionRow[]): SuppressionIndex {
  const leadIds = new Set<string>();
  const phones = new Set<string>();
  for (const r of rows) {
    if (r.lead_id) leadIds.add(r.lead_id);
    const phone = normalizePhone(r.normalized_phone);
    if (phone) phones.add(phone);
  }
  return { leadIds, phones, size: rows.length };
}

/**
 * The phone number a lead should be matched on. Falls back to normalizing the
 * raw phone, because normalized_phone is only populated by the paths that
 * knew to set it.
 */
export function phoneKeyFor(lead: SuppressibleLead): string | null {
  return normalizePhone(lead.normalized_phone) ?? normalizePhone(lead.phone);
}

export type SuppressionCheck = {
  suppressed: boolean;
  /** Plain-language reason, safe to show to an admin. */
  reason: string | null;
  /** Which rule fired — used for the event record. */
  matchedOn: "lead" | "phone" | "flag" | null;
};

export function checkSuppressed(
  lead: SuppressibleLead,
  index: SuppressionIndex
): SuppressionCheck {
  if (lead.do_not_call) {
    return {
      suppressed: true,
      reason: "This lead is marked do not call.",
      matchedOn: "flag",
    };
  }
  if (index.leadIds.has(lead.id)) {
    return {
      suppressed: true,
      reason: "A do-not-call request was recorded against this lead.",
      matchedOn: "lead",
    };
  }
  const phone = phoneKeyFor(lead);
  if (phone && index.phones.has(phone)) {
    return {
      suppressed: true,
      reason:
        "This phone number is on the do-not-call list, recorded against another record for the same business.",
      matchedOn: "phone",
    };
  }
  return { suppressed: false, reason: null, matchedOn: null };
}

/** Split a candidate list into what may be called and what may not. */
export function partitionEligible<T extends SuppressibleLead>(
  leads: T[],
  index: SuppressionIndex
): { eligible: T[]; blocked: { lead: T; check: SuppressionCheck }[] } {
  const eligible: T[] = [];
  const blocked: { lead: T; check: SuppressionCheck }[] = [];
  for (const lead of leads) {
    const check = checkSuppressed(lead, index);
    if (check.suppressed) blocked.push({ lead, check });
    else eligible.push(lead);
  }
  return { eligible, blocked };
}

/**
 * Every lead that a new DNC request must also cover — the sibling records
 * sharing the suppressed phone number. Excludes the lead the request came
 * from, which is handled directly by its own update.
 */
export function siblingsToSuppress<T extends SuppressibleLead>(
  originLeadId: string,
  suppressedPhone: string | null,
  allLeads: T[]
): T[] {
  if (!suppressedPhone) return [];
  return allLeads.filter(
    (l) => l.id !== originLeadId && phoneKeyFor(l) === suppressedPhone
  );
}
