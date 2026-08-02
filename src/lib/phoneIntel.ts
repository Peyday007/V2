// Telephone numbers: normalising them, and deciding what one actually is.
//
// The whole point of this pipeline is a number that reaches the owner, so the
// classification below is the thing that decides whether a lead is worth
// calling. Two rules run through all of it:
//
//   A main business line is never a direct owner number. Discovering the
//   number already on the record and calling it "the owner's mobile" would be
//   the most expensive kind of wrong — it looks like progress and changes
//   nothing.
//
//   "Verified" means a provider or source asserted it. A number sitting near a
//   person's name on a page is "probable" at best. The grade drives caller
//   assignment, so inflating it puts callers on numbers that do not work.
//
// Pure: no I/O, so every rule here is testable.

import { normalizePhone } from "./normalize";

/* -------------------------------------------------------------------------- */
/* normalising                                                                */
/* -------------------------------------------------------------------------- */

/** E.164 for the US/Canada numbering plan, or null if it cannot be one. */
export function toE164(raw: string | null | undefined): string | null {
  const digits = normalizePhone(raw);
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Readable form, for a caller reading it off the screen. */
export function formatUs(raw: string | null | undefined): string | null {
  const e164 = toE164(raw);
  if (!e164) return null;
  const d = e164.slice(2);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/**
 * Structural validity under the North American plan. Catches the junk that
 * scraping produces — repeated digits, 555 test numbers, invalid area or
 * exchange codes — before any of it costs a provider call.
 */
export function structurallyValid(raw: string | null | undefined): {
  valid: boolean;
  reason?: string;
} {
  const e164 = toE164(raw);
  if (!e164) return { valid: false, reason: "Not a 10-digit North American number." };
  const d = e164.slice(2);
  const area = d.slice(0, 3);
  const exchange = d.slice(3, 6);

  if (area[0] === "0" || area[0] === "1") {
    return { valid: false, reason: "Area code cannot start with 0 or 1." };
  }
  if (exchange[0] === "0" || exchange[0] === "1") {
    return { valid: false, reason: "Exchange code cannot start with 0 or 1." };
  }
  if (exchange === "555") {
    return { valid: false, reason: "555 exchange — a placeholder, not a real line." };
  }
  if (/^(\d)\1{9}$/.test(d)) {
    return { valid: false, reason: "The same digit ten times is scraped junk." };
  }
  if (d === "1234567890" || d.endsWith("0000000")) {
    return { valid: false, reason: "Obvious filler." };
  }
  return { valid: true };
}

/* -------------------------------------------------------------------------- */
/* what kind of number is it                                                  */
/* -------------------------------------------------------------------------- */

export type LineType = "mobile" | "landline" | "voip" | "toll_free" | "unknown";

const TOLL_FREE = new Set(["800", "833", "844", "855", "866", "877", "888"]);

/**
 * Toll-free is decided from the area code, which is certain. Mobile vs landline
 * is NOT decidable from the number in North America — the two share area codes
 * and have done since number portability. Anything claiming otherwise from
 * digits alone is guessing, so this returns "unknown" and leaves the answer to
 * a provider that actually looked it up.
 */
export function lineTypeFromNumber(raw: string | null | undefined): LineType {
  const e164 = toE164(raw);
  if (!e164) return "unknown";
  return TOLL_FREE.has(e164.slice(2, 5)) ? "toll_free" : "unknown";
}

/* -------------------------------------------------------------------------- */
/* the classification that decides everything downstream                      */
/* -------------------------------------------------------------------------- */

export const PHONE_CLASSES = [
  "verified_owner_mobile",
  "probable_owner_mobile",
  "verified_owner_direct",
  "probable_owner_direct",
  "main_business_line",
  "unknown",
] as const;

export type PhoneClass = (typeof PHONE_CLASSES)[number];

export const PHONE_CLASS_LABEL: Record<PhoneClass, string> = {
  verified_owner_mobile: "Verified owner mobile",
  probable_owner_mobile: "Probable owner mobile",
  verified_owner_direct: "Verified owner direct line",
  probable_owner_direct: "Probable owner direct line",
  main_business_line: "Main business line",
  unknown: "Unknown",
};

/** Best first. Drives caller assignment order. */
export const PHONE_CLASS_RANK: Record<PhoneClass, number> = {
  verified_owner_mobile: 1,
  verified_owner_direct: 2,
  probable_owner_mobile: 3,
  probable_owner_direct: 4,
  main_business_line: 5,
  unknown: 6,
};

/** A number that actually reaches a person directly, rather than a switchboard. */
export function isDirectOwnerLine(c: PhoneClass): boolean {
  return c !== "main_business_line" && c !== "unknown";
}

/**
 * Confidence at which a provider's claim counts as verified rather than
 * probable. Deliberately high: "verified" sends a caller to that number first.
 */
export const VERIFIED_CONFIDENCE = 0.85;

export type ClassifyInput = {
  candidate: string | null | undefined;
  /** The number already on the Google record. */
  mainBusinessPhone: string | null | undefined;
  lineType: LineType;
  confidence: number;
  /** The provider asserted this number belongs to this person. */
  providerVerified: boolean;
  /** Did the identity evidence actually name the person we are after? */
  identityMatched: boolean;
  /** Another source gave a different number for the same person. */
  conflicting?: boolean;
};

export type Classification = {
  phoneClass: PhoneClass;
  /** Why, in words. Shown to the caller and kept on the record. */
  reason: string;
  /** False when the number must not be dialled as a direct owner line. */
  usable: boolean;
};

export function classifyNumber(input: ClassifyInput): Classification {
  const e164 = toE164(input.candidate);
  if (!e164) {
    return {
      phoneClass: "unknown",
      reason: "Not a usable telephone number.",
      usable: false,
    };
  }

  const structural = structurallyValid(e164);
  if (!structural.valid) {
    return { phoneClass: "unknown", reason: structural.reason!, usable: false };
  }

  // The single most important check. Rediscovering the switchboard is the
  // failure mode this entire pipeline exists to prevent.
  const main = toE164(input.mainBusinessPhone);
  if (main && main === e164) {
    return {
      phoneClass: "main_business_line",
      reason: "This is the main business number already on the record.",
      usable: false,
    };
  }

  const effectiveType = input.lineType === "unknown" ? lineTypeFromNumber(e164) : input.lineType;

  if (effectiveType === "toll_free") {
    return {
      phoneClass: "main_business_line",
      reason: "Toll-free numbers reach a switchboard, never a person directly.",
      usable: false,
    };
  }

  // No identity evidence means no claim about whose number this is, whatever
  // the provider's confidence.
  if (!input.identityMatched) {
    return {
      phoneClass: "unknown",
      reason: "Nothing ties this number to the named decision-maker.",
      usable: false,
    };
  }

  if (input.conflicting) {
    return {
      phoneClass: "unknown",
      reason: "Another source gives a different number for this person.",
      usable: false,
    };
  }

  const verified = input.providerVerified && input.confidence >= VERIFIED_CONFIDENCE;
  const mobile = effectiveType === "mobile";

  if (verified && mobile) {
    return {
      phoneClass: "verified_owner_mobile",
      reason: "Provider verified this mobile against the decision-maker.",
      usable: true,
    };
  }
  if (verified) {
    return {
      phoneClass: "verified_owner_direct",
      reason: "Provider verified this direct line against the decision-maker.",
      usable: true,
    };
  }
  if (mobile) {
    return {
      phoneClass: "probable_owner_mobile",
      reason: "Reported as the decision-maker's mobile, not independently verified.",
      usable: true,
    };
  }
  return {
    phoneClass: "probable_owner_direct",
    reason: "Reported as a direct line for the decision-maker, not independently verified.",
    usable: true,
  };
}

/* -------------------------------------------------------------------------- */
/* deduplication                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The key a lead is deduplicated on. Several signals, because any one of them
 * alone produces false merges: two franchisees share a domain, a shared
 * answering service gives two businesses one number.
 */
export function dedupeKeys(lead: {
  placeId?: string | null;
  domain?: string | null;
  phone?: string | null;
  address?: string | null;
  businessName?: string | null;
}): string[] {
  const keys: string[] = [];
  if (lead.placeId) keys.push(`place:${lead.placeId}`);
  const phone = toE164(lead.phone);
  if (phone) keys.push(`phone:${phone}`);
  if (lead.domain) keys.push(`domain:${lead.domain.toLowerCase()}`);
  if (lead.address && lead.businessName) {
    const addr = lead.address.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const name = lead.businessName.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (addr && name) keys.push(`site:${name}@${addr}`);
  }
  return keys;
}
