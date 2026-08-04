import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { needsAPerson } from "@/lib/aiAuthority";

export const dynamic = "force-dynamic";

/*
 * How many things are waiting on a person, in three numbers.
 *
 * The whole reason the Needs-you page exists: the answer to "is there anything
 * for me" should cost one glance, not three page loads. This is the cheapest
 * possible version of that — three counting queries, no rows returned — so the
 * nav badge can be live without loading three pages' worth of data behind it.
 *
 * Every count degrades to zero independently. A missing table for one queue
 * must not blank the other two: a badge that reads 0 because a table is gone
 * is exactly as wrong as a badge that reads 0 because there is nothing to do,
 * and the difference is what `error` carries.
 */

/**
 * PromiseLike rather than Promise: a Supabase query builder is thenable but is
 * not a Promise, so typing this as one rejects every call site.
 */
type Countable = PromiseLike<{ count: number | null; error: { message: string } | null }>;

async function count(run: () => Countable): Promise<{ n: number; error: string | null }> {
  try {
    const { count: n, error } = await run();
    if (error) return { n: 0, error: error.message };
    return { n: n || 0, error: null };
  } catch (e) {
    return { n: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Count the readings that actually need somebody, by reading their reasons.
 *
 * A count query cannot express "has at least one reason that is not a
 * system-state one" without a negated array-containment operator, and this
 * area has been broken once already by trusting PostgREST behaviour I could
 * not test locally. The rows are few — they are the escalations — so they are
 * fetched and filtered in memory, which is provably right.
 */
async function reasonsNeedingAPerson(
  db: ReturnType<typeof supabaseAdmin>
): Promise<{ count: number | null; error: { message: string } | null }> {
  const { data, error } = await db
    .from("call_analysis")
    .select("review_reasons")
    .eq("needs_review", true)
    .is("reviewed_at", null)
    .limit(2000);
  if (error) return { count: null, error };
  const n = (data || []).filter((r) => needsAPerson(r.review_reasons || [])).length;
  return { count: n, error: null };
}

export async function GET() {
  const db = supabaseAdmin();

  const [callbacks, reviews, blocked, appointments] = await Promise.all([
    // Drafted or approved and not yet sent — the ones a person still owes.
    count(() =>
      db
        .from("followup_tasks")
        .select("*", { count: "exact", head: true })
        .in("status", ["drafted", "approved"])
    ),
    /*
     * The AI applies its own reading; these are the ones it could not settle.
     *
     * Reasons are read rather than counted, because a row whose only reason is
     * "there was no transcript" is not work — with recording off that is every
     * call, and the badge said 30 while every one of them offered a human the
     * choice of "read it right" or "got it wrong" about a reading that was
     * never made.
     *
     * The list route applies the SAME predicate. Two places deciding what
     * counts as work is how the badge and the page disagreed last week.
     */
    count(() => reasonsNeedingAPerson(db)),
    count(() =>
      db.from("blocked_actions").select("*", { count: "exact", head: true }).eq("status", "pending")
    ),
    // Booked, in the past, and nobody has said whether it happened. A future
    // appointment is not work — it is a diary entry.
    count(() =>
      db
        .from("appointments")
        .select("*", { count: "exact", head: true })
        .is("attendance_status", null)
        .lt("scheduled_for", new Date().toISOString())
    ),
  ]);

  const errors = [callbacks.error, reviews.error, blocked.error, appointments.error].filter(
    Boolean
  ) as string[];

  const counts = {
    callbacks: callbacks.n,
    reviews: reviews.n + blocked.n,
    appointments: appointments.n,
  };

  return NextResponse.json({
    ...counts,
    total: counts.callbacks + counts.reviews + counts.appointments,
    error: errors.length
      ? `Some counts could not be read, so the total is lower than the truth: ${errors[0]}`
      : null,
  });
}
