import { NextRequest, NextResponse } from "next/server";
import { pushEligibleLeads } from "@/lib/emailPush";

export const dynamic = "force-dynamic";

/*
 * The manual push button.
 *
 * All the work is in src/lib/emailPush.ts, shared with the automatic top-up,
 * so the button and the worker cannot drift into different ideas about who is
 * eligible. This route is the thin part: read a limit, run it, report what
 * happened.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const requested = Number(body.limit);
  const limit = Number.isInteger(requested) && requested > 0 ? requested : 0;

  const outcome = await pushEligibleLeads(limit, "admin");

  // A blocked push is a 400 with the reason in words — never a bare "none
  // available" while the page above it is showing a number.
  if (outcome.blocked) {
    return NextResponse.json({ error: outcome.blocked }, { status: 400 });
  }
  return NextResponse.json(outcome);
}
