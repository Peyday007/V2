// Default geography for "just generate me leads" runs.
//
// Large metros with dense home-service markets, spread across regions so the
// data is not biased to one economy or climate — and, because recording is how
// calls get reviewed, chosen so the calls can actually be recorded.
//
// Fourteen states need every party on a call to consent. Leads there are
// perfectly good leads, they just cannot be recorded under the "skip two-party
// states" policy — so a caller working them produces no recording, no
// transcript, no AI reading and nothing for the review queue.
//
// The previous list opened with Detroit and also carried Chicago and Tampa,
// putting three of twelve default metros — including the largest — permanently
// outside recording. That is why the first lead on the call screen was a
// Michigan one.
//
// Which states those are is derived from the app's own list in consent.ts
// rather than written out again here, so the two cannot drift apart.

import { isAllPartyState } from "./consent";

export type Metro = {
  city: string;
  /** Two-letter state code, used to decide whether calls there are recordable. */
  state: string;
};

/** Everything a quick-mix run knows about, before any filtering. */
export const CANDIDATE_METROS: Metro[] = [
  // --- one-party consent: callable AND recordable -------------------------
  { city: "Dallas", state: "TX" },
  { city: "Houston", state: "TX" },
  { city: "San Antonio", state: "TX" },
  { city: "Atlanta", state: "GA" },
  { city: "Phoenix", state: "AZ" },
  { city: "Charlotte", state: "NC" },
  { city: "Denver", state: "CO" },
  { city: "Columbus", state: "OH" },
  { city: "Nashville", state: "TN" },
  { city: "Kansas City", state: "MO" },
  { city: "Indianapolis", state: "IN" },
  { city: "Minneapolis", state: "MN" },
  { city: "Richmond", state: "VA" },
  { city: "Salt Lake City", state: "UT" },
  { city: "Oklahoma City", state: "OK" },
  { city: "Louisville", state: "KY" },

  // --- all-party consent: good leads, never recordable --------------------
  // Kept here so they can still be targeted deliberately by name. They are
  // simply never part of the default mix.
  { city: "Detroit", state: "MI" },
  { city: "Chicago", state: "IL" },
  { city: "Tampa", state: "FL" },
  { city: "Los Angeles", state: "CA" },
  { city: "Philadelphia", state: "PA" },
  { city: "Seattle", state: "WA" },
  { city: "Boston", state: "MA" },
];

export function formatMetro(m: Metro): string {
  return `${m.city}, ${m.state}`;
}

/** Metros where a call is recordable on the caller's own consent. */
export const RECORDABLE_METROS: Metro[] = CANDIDATE_METROS.filter(
  (m) => !isAllPartyState(m.state)
);

/** Metros in the fourteen states that need everyone on the call to agree. */
export const ALL_PARTY_METROS: Metro[] = CANDIDATE_METROS.filter((m) =>
  isAllPartyState(m.state)
);

/**
 * What a "just generate me leads" run actually searches.
 *
 * One-party states only. Naming a city in an all-party state still works and
 * those leads are still worth calling — the default just no longer fills the
 * queue with businesses whose calls can never be reviewed.
 */
export const DEFAULT_METROS: string[] = RECORDABLE_METROS.map(formatMetro);

/** The same list for the other fourteen, addressable on purpose. */
export const DEFAULT_ALL_PARTY_METROS: string[] = ALL_PARTY_METROS.map(formatMetro);

/**
 * Trades worth calling for an AI receptionist: phone-driven, appointment-based,
 * usually run by people who are on a job site rather than at a desk.
 */
export const QUICK_MIX_TRADES = [
  "hvac",
  "plumbing",
  "roofing",
  "electrical",
  "garage_door",
  "restoration",
  "pest_control",
  "locksmith",
  "appliance_repair",
  "tree_service",
  "cleaning",
  "septic",
];
