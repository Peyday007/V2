// The provider-neutral interface for finding a person's direct number.
//
// Deliberately an interface with a "none" default, the same shape as
// src/lib/telephony.ts. Nothing in this codebase hard-codes a vendor: the
// waterfall walks whatever adapters are configured, in price order, and stops
// at the first sufficiently confident result.
//
// What a provider must NOT do is invent. An adapter returns null when it has
// nothing; it never downgrades the main business number into "the owner's
// mobile", and it never reports verified unless the provider itself asserts
// the number belongs to that person.

import type { LineType } from "../phoneIntel";

/** Everything known about the person, sent to every provider. */
export type LookupSubject = {
  leadId: string;
  fullName: string;
  firstName: string;
  lastName: string;
  title: string | null;
  businessName: string;
  domain: string | null;
  city: string | null;
  state: string | null;
  address: string | null;
  /** A public email or profile URL, when one was already found. */
  email: string | null;
  profileUrl: string | null;
  /** So an adapter can refuse to return the switchboard. */
  mainBusinessPhone: string | null;
};

/** One consistent internal shape, whatever the vendor returns. */
export type ProviderPhone = {
  phone: string;
  lineType: LineType;
  /** 0-1, the provider's own confidence, normalised. */
  confidence: number;
  /** The provider asserts this number belongs to this person. */
  providerVerified: boolean;
  /** The vendor's own record id, so a claim can be traced back. */
  sourceRef: string | null;
};

export type LookupResult = {
  provider: string;
  phones: ProviderPhone[];
  /** Public email, if the provider returned one and we did not have it. */
  email?: string | null;
  profileUrl?: string | null;
  /** Retrieval time, kept for retention and audit. */
  retrievedAt: string;
  /**
   * What this call cost, in whole cents. Providers bill differently — some per
   * request, some only on a hit — so an adapter reports what it actually
   * incurred rather than the pipeline assuming.
   */
  costCents: number;
  /** Set when the adapter could not run at all. Not a failure of the person. */
  skipped?: string;
  error?: string;
};

export type ContactProvider = {
  key: string;
  label: string;
  /** Cheapest and most reliable first. Lower runs earlier. */
  order: number;
  /**
   * Providers that charge only for a successful match should say so — the
   * waterfall will try them before ones that bill per request.
   */
  billsOnlyOnHit: boolean;
  /** Cost per successful lookup, in cents. Configurable per deployment. */
  costPerHitCents: number;
  /** False when unconfigured. The waterfall skips it without erroring. */
  isAvailable(): boolean;
  /** Why it is unavailable, in words an admin can act on. */
  unavailableReason(): string | null;
  lookup(subject: LookupSubject): Promise<LookupResult>;
};

/** Confidence at which the waterfall stops and does not pay the next provider. */
export const STOP_AT_CONFIDENCE = 0.85;

/** Below this a provider's phone is not worth storing at all. */
export const MIN_USABLE_CONFIDENCE = 0.4;

export function emptyResult(provider: string, skipped: string): LookupResult {
  return {
    provider,
    phones: [],
    retrievedAt: new Date().toISOString(),
    costCents: 0,
    skipped,
  };
}
