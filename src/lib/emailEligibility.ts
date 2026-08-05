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
  /**
   * Read off the business's own website by the enrichment crawl. For most
   * leads this is the ONLY address there is — see chooseEmail.
   */
  website_email?: string | null;
  /** personal | role | generic, as classified by the crawl that found it. */
  website_email_kind?: string | null;
  do_not_call?: boolean | null;
  archived_at?: string | null;
  email_unsubscribed_at?: string | null;
  email_bounced_at?: string | null;
  business_name?: string | null;
};

/** Which field an address came from, kept so a claim can be traced. */
export type EmailSource = "direct_email" | "owner_email" | "website_email";

/**
 * WHO an address reaches, as opposed to where it came from.
 *
 * Source and audience are different questions and used to be conflated. A
 * contact provider can return `info@`; a website crawl can return the owner's
 * own gmail. Ordering on source alone therefore sent a generic inbox ahead of
 * a named person, which is backwards for a programme whose entire purpose is
 * reaching somebody who can say yes.
 */
export type EmailAudience =
  /** A named decision-maker, attributed by a contact provider. */
  | "decision_maker"
  /** A named person: the owner's own address, however we came by it. */
  | "personal"
  /** info@, office@, service@. Reaches the business, nobody in particular. */
  | "generic";

export type ChosenEmail = {
  email: string;
  source: EmailSource;
  audience: EmailAudience;
} | null;

/**
 * Local parts that reach the business but not a person.
 *
 * Kept in step with ROLE_LOCAL_PARTS in extractEmails.ts by a test, rather
 * than imported: this module is loaded by the admin count, the push and the
 * explainer, and it must stay free of the crawler's dependencies.
 */
const GENERIC_LOCAL_PARTS = new Set([
  "info", "contact", "hello", "hi", "office", "admin", "sales", "service",
  "support", "enquiries", "inquiries", "bookings", "booking", "schedule",
  "scheduling", "dispatch", "team", "help", "customerservice", "accounts",
  "accounting", "billing", "estimates", "quotes", "jobs", "careers", "hr",
  "mail", "general", "reception", "frontdesk", "main",
]);

/** Does this address reach a person, judged from the address alone. */
export function isGenericAddress(email: string): boolean {
  const at = (email || "").indexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at).toLowerCase();
  return GENERIC_LOCAL_PARTS.has(local.replace(/[._-]/g, "")) || GENERIC_LOCAL_PARTS.has(local);
}

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
 * The order is by how much is known about who is behind the address:
 *
 *   1. direct_email — a contact provider attached it to a named
 *      decision-maker. Only ever present when a provider is configured.
 *   2. owner_email — whatever the owner-intel pass or a caller recorded.
 *   3. website_email — read off the business's own site by the crawl.
 *
 * The third one carries the whole programme in practice. With no contact
 * provider configured, 993 of 1000 leads had no address at all, because the
 * first two are only ever filled by paths that were not running. A generic
 * info@ scraped from a contact page is not as good as a named decision-maker's
 * inbox — but it reaches the business, and it is the difference between a cold
 * email programme and an empty one.
 */
/** How much we want each audience, lowest first. Generic is always last. */
const AUDIENCE_ORDER: Record<EmailAudience, number> = {
  decision_maker: 0,
  personal: 1,
  generic: 2,
};

/** The tie-break within one audience: how well attributed the source is. */
const SOURCE_ORDER: Record<EmailSource, number> = {
  direct_email: 0,
  owner_email: 1,
  website_email: 2,
};

export function chooseEmail(lead: EmailLeadRow): ChosenEmail {
  const candidates: NonNullable<ChosenEmail>[] = [];

  const add = (raw: string | null | undefined, source: EmailSource) => {
    const email = (raw || "").trim().toLowerCase();
    if (!looksLikeEmail(email)) return;

    /*
     * The audience is read off the ADDRESS, not off the column it arrived in.
     *
     * A provider that hands back `info@` has not found a decision-maker, and
     * treating it as one because of where it came from is how a generic inbox
     * ends up outranking the owner's own published address.
     */
    if (isGenericAddress(email)) {
      candidates.push({ email, source, audience: "generic" });
      return;
    }
    if (source === "website_email") {
      /*
       * Trust the crawler's own classification when it recorded one — it saw
       * the page, the surrounding text and whether the address matched a name
       * we already held. Falling back to the local part alone is only for
       * leads enriched before website_email_kind existed.
       */
      const kind = (lead.website_email_kind || "").trim().toLowerCase();
      const personal = kind ? kind === "personal" : true;
      candidates.push({ email, source, audience: personal ? "personal" : "generic" });
      return;
    }
    candidates.push({
      email,
      source,
      // A provider attributes an address to a named person; that attribution
      // is the thing being paid for, and it is what "verified" means here.
      audience: source === "direct_email" ? "decision_maker" : "personal",
    });
  };

  add(lead.direct_email, "direct_email");
  add(lead.owner_email, "owner_email");
  add(lead.website_email, "website_email");

  if (candidates.length === 0) return null;
  return candidates.sort(
    (a, b) =>
      AUDIENCE_ORDER[a.audience] - AUDIENCE_ORDER[b.audience] ||
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]
  )[0];
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
  /**
   * Who the sendable addresses actually reach.
   *
   * Surfaced because it was invisible and it is the single most important
   * thing about a cold-email list. "120 leads have an address" reads as
   * healthy whether those are 120 owners or 120 reception desks, and those are
   * completely different programmes. Counted before anything sends.
   */
  audience: Record<EmailAudience, number>;
};

export function summarizeEmailAvailability(rows: EmailLeadRow[]): EmailAvailability {
  let available = 0;
  const reasons = new Map<string, number>();
  const audience: Record<EmailAudience, number> = {
    decision_maker: 0,
    personal: 0,
    generic: 0,
  };
  for (const row of rows) {
    const reason = emailUnavailableReason(row);
    if (reason === null) {
      available += 1;
      const chosen = chooseEmail(row);
      if (chosen) audience[chosen.audience] += 1;
    } else {
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
  }
  return {
    available,
    total: rows.length,
    reasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    audience,
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
  "id, business_name, direct_email, owner_email, website_email, do_not_call, archived_at, email_unsubscribed_at, email_bounced_at";

/**
 * The same list, minus the columns that arrive with a migration.
 *
 * `direct_email` comes with 0023 and `website_email` with 0030. Selecting a
 * column from an unrun migration does not degrade — it fails the whole query,
 * which is exactly how the lead pipeline went down once already: every packet
 * query asked for enrichment columns that were not there, so "Add leads"
 * 500'd, nothing was inserted, and the callers' dialer said "all done".
 *
 * So the reader walks down this ladder instead of assuming. A database missing
 * a migration loses a source of addresses; it does not lose the page.
 */
export const EMAIL_ELIGIBILITY_TIERS: string[] = [
  EMAIL_ELIGIBILITY_COLUMNS,
  // no website_email (0030 unrun)
  "id, business_name, direct_email, owner_email, do_not_call, archived_at, email_unsubscribed_at, email_bounced_at",
  // no direct_email either (0023 unrun)
  "id, business_name, owner_email, do_not_call, archived_at, email_unsubscribed_at, email_bounced_at",
];
