// One definition of "can this lead be put in front of a caller".
//
// This rule was written out by hand in three places — building a packet,
// topping a packet up, and counting what is ready on the dashboards — and they
// drifted. The dashboards counted any lead whose machine_status was
// ready_for_calling, while the packet queries also required status='new', not
// suppressed and not a bad number. So the page would say "47 ready to call" and
// the Add button would answer "none are available", which is exactly as
// confusing as it sounds.
//
// Everything now derives from here. Pure predicates so they can be tested, and
// a query helper so a Postgres query cannot express a different rule from the
// TypeScript.

export type LeadRow = {
  status?: string | null;
  machine_status?: string | null;
  do_not_call?: boolean | null;
  phone_invalid?: boolean | null;
  archived_at?: string | null;
  /** A | B | C | D — see src/lib/enrichmentGrade.ts. */
  enrichment_grade?: string | null;
  direct_phone?: string | null;
};

/** The engine has finished with it. */
export const READY_MACHINE_STATUS = "ready_for_calling";
/** Nobody is holding it. */
export const UNASSIGNED_STATUS = "new";

/** Can this lead go into a packet right now? */
export function isAvailableToCall(l: LeadRow): boolean {
  return unavailableReason(l) === null;
}

/**
 * Why a lead cannot be called, in words an operator can act on. Returns null
 * when it is available. The order matters: the most decisive reason wins, so a
 * suppressed lead reads as suppressed rather than as "already with a caller".
 */
export function unavailableReason(l: LeadRow): string | null {
  if (l.archived_at) return "Binned";
  if (l.do_not_call) return "On the do-not-call list";
  if (l.phone_invalid) return "Phone number is not callable";

  const machine = l.machine_status ?? "";
  if (machine === "contacted") return "Already called";
  if (machine === "assigned_to_packet") return "Already with a caller";
  if (machine === "enrichment_failed") return "Discarded — not worth calling";
  if (machine !== READY_MACHINE_STATUS) return "Still being researched";

  /*
   * THE ENRICHMENT GRADE DOES NOT DECIDE THIS. It used to, and that was wrong.
   *
   * The reasoning was sound — 111 live answers produced 6 owner conversations,
   * because most answers were receptionists at businesses nobody had a name
   * for. The implementation was not: it required an A or a B, and a lead only
   * reaches A or B if a paid contact provider returned a direct number. With
   * no provider configured, every lead grades C at best, so the rule excluded
   * EVERY LEAD IN THE SYSTEM and the callers had nothing to dial.
   *
   * A quality bar that cannot be met is not a quality bar, it is an outage.
   *
   * So the grade now decides ORDER, not eligibility — see
   * orderLeadsForAssignment in enrichmentGrade.ts. A packet is filled best-
   * first, so when direct numbers do exist the callers reach them first, and
   * when they do not, the packet is simply the main-line leads that were
   * always there.
   */

  // Machine-ready, but something else is holding it.
  if ((l.status ?? "") !== UNASSIGNED_STATUS) {
    return l.status === "called" ? "Already called" : "Already with a caller";
  }
  return null;
}

export type Availability = {
  available: number;
  total: number;
  /** Every reason the rest are unavailable, commonest first. */
  reasons: { reason: string; count: number }[];
};

export function summarizeAvailability(rows: LeadRow[]): Availability {
  let available = 0;
  const reasons = new Map<string, number>();
  for (const row of rows) {
    const reason = unavailableReason(row);
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

/** The columns any availability check needs. Keeps the selects honest. */
export const AVAILABILITY_COLUMNS =
  "id, status, machine_status, do_not_call, phone_invalid, archived_at, enrichment_grade, direct_phone";

/** The filters, as data, so they can be asserted in a test. */
export const AVAILABLE_EQ_FILTERS: [string, unknown][] = [
  ["status", UNASSIGNED_STATUS],
  ["machine_status", READY_MACHINE_STATUS],
  ["do_not_call", false],
  ["phone_invalid", false],
];
export const AVAILABLE_IS_FILTERS: [string, unknown][] = [["archived_at", null]];

/**
 * Deliberately empty.
 *
 * This used to carry ["enrichment_grade", ["A","B"]], which put the grade gate
 * into the SQL as well as the predicate. Kept as an empty list rather than
 * deleted so the shape stays symmetrical with the eq/is filters above, and so
 * the test that asserts the predicate and the query check the same things has
 * something to compare.
 */
export const AVAILABLE_IN_FILTERS: [string, unknown[]][] = [];

/** The minimum a query builder must support. */
type Filterable = {
  eq(column: string, value: unknown): Filterable;
  is(column: string, value: unknown): Filterable;
  in(column: string, values: unknown[]): Filterable;
};

/**
 * Apply the same rule to a Supabase query, returning the caller's own type
 * untouched. Deliberately not generic over the builder: inferring Supabase's
 * full query type through five chained calls makes TypeScript give up with
 * "type instantiation is excessively deep".
 */
export function applyAvailableFilter<T>(q: T): T {
  let f = q as unknown as Filterable;
  for (const [col, val] of AVAILABLE_EQ_FILTERS) f = f.eq(col, val);
  for (const [col, val] of AVAILABLE_IS_FILTERS) f = f.is(col, val);
  for (const [col, vals] of AVAILABLE_IN_FILTERS) f = f.in(col, vals);
  return f as unknown as T;
}

/**
 * What to tell someone who pressed a button and got nothing. Never just
 * "none available" — say where the leads went.
 */
export function explainNoneAvailable(a: Availability): string {
  if (a.total === 0) {
    return "There are no leads in the system at all. Generate a batch on the Leads tab.";
  }
  const top = a.reasons.slice(0, 3);
  if (top.length === 0) return "No leads are ready to call.";
  const parts = top.map((r) => `${r.count} ${r.reason.toLowerCase()}`);
  return `None of your ${a.total} leads are free to hand out — ${parts.join(", ")}. Generate more on the Leads tab.`;
}
