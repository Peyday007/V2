import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { computeGaps, buildRecommendations } from "@/lib/workshopPacket";
import { isMissingColumnError } from "@/lib/enrichmentGrade";

export const dynamic = "force-dynamic";

/*
 * The owner's page, for our own eyes, without sending anybody anything.
 *
 * WHY THIS IS A SEPARATE ROUTE and not a flag on the token one: that route
 * marks the packet opened, advances its status and writes a workshop.opened
 * event. Looking at our own copy must never do any of that — an admin
 * checking the wording would otherwise show up in the funnel as a prospect
 * reading their page, and "opened" is a number people make decisions on.
 *
 * It runs the SAME computeGaps and buildRecommendations as the real page, off
 * the same lead row, so what it shows is what a prospect would see. A preview
 * built from a different code path is worth nothing.
 */

const LEAD_COLUMNS =
  "id, business_name, city, state, website, rating, review_count, answering_setup, diagnostic_findings";
// Without 0032 there is no diagnosis to read, and asking for it fails the
// whole query rather than degrading. Same ladder as everywhere else.
const FALLBACK_COLUMNS =
  "id, business_name, city, state, website, rating, review_count, answering_setup";

export async function GET(req: NextRequest) {
  const leadId = req.nextUrl.searchParams.get("lead_id");
  const db = supabaseAdmin();

  /*
   * With no lead named, show the page for whichever lead has a diagnosis.
   * "Show me the workshop" almost always means "show me what one looks like",
   * and picking an arbitrary lead that happens to have nothing on record
   * answers the question with a blank page.
   *
   * Each tier builds its own query rather than reusing a builder: the two
   * column sets produce different row types, and sharing one variable between
   * them is what the compiler objects to.
   */
  const read = async (columns: string, withDiagnosis: boolean) => {
    const q = db.from("leads").select(columns).is("archived_at", null);
    if (leadId) return q.eq("id", leadId).maybeSingle();
    if (withDiagnosis) return q.not("diagnostic_findings", "is", null).limit(1).maybeSingle();
    return q.limit(1).maybeSingle();
  };

  let res = await read(LEAD_COLUMNS, true);
  if (res.error && isMissingColumnError(res.error)) {
    res = await read(FALLBACK_COLUMNS, false);
  }

  if (res.error) {
    return NextResponse.json({ error: res.error.message, packet: null }, { status: 200 });
  }
  if (!res.data) {
    return NextResponse.json(
      {
        error: leadId
          ? "No such lead."
          : "No lead has a diagnosis yet, so there is nothing to preview. Run enrichment first.",
        packet: null,
      },
      { status: 200 }
    );
  }

  const lead = res.data as unknown as {
    id: string;
    business_name: string;
    city: string | null;
    state: string | null;
    website: string | null;
    rating: number | null;
    review_count: number | null;
    answering_setup: string | null;
    diagnostic_findings?: { key: string; headline: string; detail: string; basis: string[] }[] | null;
  };

  const gapInput = {
    businessName: lead.business_name,
    city: lead.city,
    website: lead.website,
    rating: lead.rating,
    reviewCount: lead.review_count,
    answeringSetup: lead.answering_setup,
    findings: lead.diagnostic_findings ?? undefined,
  };

  /*
   * The picker, from here rather than a separate endpoint.
   *
   * /api/leads has no GET — it only creates — and adding one to serve a
   * dropdown would be a wider change than this needs. Leads with a diagnosis
   * come first because those are the pages worth looking at; the rest are
   * still listed so a thin page can be inspected deliberately.
   */
  const choices = await db
    .from("leads")
    .select("id, business_name, city")
    .is("archived_at", null)
    .order("business_name")
    .limit(200);

  return NextResponse.json({
    error: null,
    leads: choices.data || [],
    packet: {
      leadId: lead.id,
      businessName: lead.business_name,
      city: lead.city,
      state: lead.state,
      gaps: computeGaps(gapInput),
      recommendations: buildRecommendations(gapInput),
      // The real page prefills these from the packet. There is no packet here,
      // and inventing a name would misrepresent what a prospect actually sees.
      contact: { name: "", phone: "", email: "" },
      alreadyRequested: false,
      requestedAt: null,
    },
  });
}
