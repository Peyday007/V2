// One definition of "may this business be emailed".
//
// Written the same way as leadEligibility.ts and for the same reason: the rule
// was about to be spelled out in three places — the push route, the admin
// count, and the "why was nothing pushed" explainer — and three copies of a
// suppression rule is two chances to get it wrong.
//
// The rule that matters most, stated once here so nothing downstream has to
// re-derive it:
//
//   THE DO-NOT-CALL LIST SUPPRESSES EMAIL TOO.
//
// Somebody who asked not to be called did not ask to be emailed instead. The
// suppression runs one way only — an email unsubscribe does NOT stop the
// phone, because unsubscribing from a sequence is a statement about the inbox,
// not about the business. That asymmetry is deliberate and is tested.
//
// Pure. No database, no network.

export type EmailLeadRow = {
  id?: string;
  /** Discovered by enrichment; the better address when it exists. */
  direct_email?: string | null;
  /** Whatever the earlier owner-intel pass found. */
  owner_email?: string | null;
  do_not_call?: boolean | null;
  archived_at?: string | null;
  email_unsubscribed_at?: string | null;
  email_bounced_at?: string | null;
  business_name?: string | null;
};

/** Which field an address came from, kept so a claim can be traced. */
export type EmailSource = "direct_email" | "owner_email";

export type ChosenEmail = { email: string; source: EmailSource } | null;

/**
 * A shape check, not a validity claim.
 *
 * Deliberately loose. This cannot tell whether an address receives mail — only
 * a send can — and a regex that rejects real addresses is worse than one that
 * lets a bad one through, because Instantly will report the bounce and the
 * bounce suppresses the lead automatically. So the bar is: one @, something on
 * each side, a dot in the domain, no whitespace.
 */
export function looksLikeEmail(value: string | null | undefined): boolean {
  const v = (value || "").trim();
  if (!v || /\s/.test(v)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(v);
}

/**
 * The best address on the record, and where it came from.
 *
 * direct_email first: it is the one a contact provider attached to a named
 * decision-maker, whereas owner_email may be the generic info@ off the
 * website. Both are used — a generic address still reaches the business — but
 * the better one goes first and the source is carried through so the admin
 * page can show which is which.
 */
export function chooseEmail(lead: EmailLeadRow): ChosenEmail {
  const direct = (lead.direct_email || "").trim().toLowerCase();
  if (looksLikeEmail(direct)) return { email: direct, source: "direct_email" };
  const owner = (lead.owner_email || "").trim().toLowerCase();
  if (looksLikeEmail(owner)) return { email: owner, source: "owner_email" };
  return null;
}

/**
 * Why this lead cannot be emailed, in words an operator can act on, or null
 * when it can be.
 *
 * Ordered most-decisive-first, so a suppressed lead reads as suppressed rather
 * than as "no email address" — the second is a data problem somebody might try
 * to fix, and nobody should be out looking for the address of a business that
 * asked to be left alone.
 */
export function emailUnavailableReason(lead: EmailLeadRow): string | null {
  if (lead.archived_at) return "Binned";
  if (lead.do_not_call) return "On the do-not-call list";
  if (lead.email_unsubscribed_at) return "Unsubscribed from email";
  if (lead.email_bounced_at) return "Email bounced";
  if (!chooseEmail(lead)) return "No email address on record";
  return null;
}

export function canEmail(lead: EmailLeadRow): boolean {
  return emailUnavailableReason(lead) === null;
}

/**
 * Whether an already-pushed lead may be pushed again.
 *
 * Never, by default. One thread per lead is enforced by a unique index in the
 * database as well, because a second sequence landing in the same inbox is the
 * behaviour that gets a sending domain burned.
 */
export function canRepush(existingStatus: string | null | undefined): boolean {
  // A push that errored never reached Instantly, so retrying it is not a
  // second sequence — it is the first one, again.
  return existingStatus === "failed";
}

export type EmailAvailability = {
  available: number;
  total: number;
  reasons: { reason: string; count: number }[];
};

export function summarizeEmailAvailability(rows: EmailLeadRow[]): EmailAvailability {
  let available = 0;
  const reasons = new Map<string, number>();
  for (const row of rows) {
    const reason = emailUnavailableReason(row);
    if (reason === null) available += 1;
    else reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }
  return {
    available,
    total: rows.length,
    reasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/** What to tell someone who pressed Push and got nothing back. */
export function explainNonePushable(a: EmailAvailability): string {
  if (a.total === 0) {
    return "There are no leads in the system at all. Generate a batch on the Leads tab.";
  }
  const top = a.reasons.slice(0, 3);
  if (top.length === 0) return "Every lead has already been pushed.";
  const parts = top.map((r) => `${r.count} ${r.reason.toLowerCase()}`);
  return `None of your ${a.total} leads can be emailed — ${parts.join(", ")}.`;
}

/**
 * The columns any email-eligibility check needs. Keeps the selects honest, and
 * — the lesson from migration 0023 — keeps this list short enough that a
 * column added by an unrun migration cannot take the whole page down.
 */
export const EMAIL_ELIGIBILITY_COLUMNS =
  "id, business_name, direct_email, owner_email, do_not_call, archived_at, email_unsubscribed_at, email_bounced_at";
