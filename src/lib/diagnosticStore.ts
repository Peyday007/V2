import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";
import { recordEvent } from "./events";
import { isMissingColumnError } from "./enrichmentGrade";
import { diagnose, topFindings, sellableAngles, diagnosticIsThin, type Finding } from "./diagnostic";
import { estimateAffordability, type Affordability } from "./affordability";
import { UNKNOWN_SIGNALS, type SiteSignals } from "./siteSignals";

// Writing the diagnosis down, and reading it back.
//
// The pure parts are in diagnostic.ts and affordability.ts. This is the layer
// that maps between them and the database, which matters more than it sounds:
// the tri-state signals go into NULLABLE booleans and a null has to survive
// the round trip. A `?? false` anywhere in here would turn "we could not tell"
// into "they definitely do not have it", and the diagnostic would start making
// claims the crawl never supported.
//
// Everything here degrades rather than throws. A database without migration
// 0032 loses the diagnosis and keeps the lead.

const SIGNAL_COLUMNS: Record<keyof SiteSignals, string> = {
  https: "site_https",
  mobileViewport: "site_mobile_viewport",
  contactForm: "site_contact_form",
  onlineBooking: "site_online_booking",
  clickToCall: "site_click_to_call",
  localBusinessSchema: "site_local_schema",
  publishedHours: "site_published_hours",
  claimsEmergency: "site_claims_emergency",
  showsReviews: "site_shows_reviews",
  hasPageTitle: "site_has_title",
  hasMetaDescription: "site_has_meta_description",
  copyrightYear: "site_copyright_year",
  landingBytes: "site_landing_bytes",
  tools: "site_tools",
};

/** Every column the diagnosis reads or writes, so selects stay honest. */
export const DIAGNOSTIC_COLUMNS = [
  "id",
  "business_name",
  "city",
  "state",
  "industry",
  "website",
  "rating",
  "review_count",
  "answering_setup",
  "existing_provider",
  "office_staff_count",
  "map_rank",
  "map_result_count",
  ...Object.values(SIGNAL_COLUMNS),
].join(", ");

type LeadRow = Record<string, unknown>;

/** Database row → the tri-state signals, with nulls preserved. */
export function signalsFromRow(row: LeadRow): SiteSignals {
  const tri = (key: string): boolean | null => {
    const v = row[key];
    // Explicitly three-way. `!!v` would collapse null to false, which is the
    // one mistake this whole module exists to avoid.
    return v === true ? true : v === false ? false : null;
  };
  return {
    https: tri(SIGNAL_COLUMNS.https),
    mobileViewport: tri(SIGNAL_COLUMNS.mobileViewport),
    contactForm: tri(SIGNAL_COLUMNS.contactForm),
    onlineBooking: tri(SIGNAL_COLUMNS.onlineBooking),
    clickToCall: tri(SIGNAL_COLUMNS.clickToCall),
    localBusinessSchema: tri(SIGNAL_COLUMNS.localBusinessSchema),
    publishedHours: tri(SIGNAL_COLUMNS.publishedHours),
    claimsEmergency: tri(SIGNAL_COLUMNS.claimsEmergency),
    showsReviews: tri(SIGNAL_COLUMNS.showsReviews),
    hasPageTitle: tri(SIGNAL_COLUMNS.hasPageTitle),
    hasMetaDescription: tri(SIGNAL_COLUMNS.hasMetaDescription),
    copyrightYear:
      typeof row[SIGNAL_COLUMNS.copyrightYear] === "number"
        ? (row[SIGNAL_COLUMNS.copyrightYear] as number)
        : null,
    landingBytes:
      typeof row[SIGNAL_COLUMNS.landingBytes] === "number"
        ? (row[SIGNAL_COLUMNS.landingBytes] as number)
        : null,
    tools: Array.isArray(row[SIGNAL_COLUMNS.tools]) ? (row[SIGNAL_COLUMNS.tools] as string[]) : [],
  };
}

/** The signals as a column patch. Nulls are written as nulls. */
export function signalsToPatch(s: SiteSignals): Record<string, unknown> {
  return {
    [SIGNAL_COLUMNS.https]: s.https,
    [SIGNAL_COLUMNS.mobileViewport]: s.mobileViewport,
    [SIGNAL_COLUMNS.contactForm]: s.contactForm,
    [SIGNAL_COLUMNS.onlineBooking]: s.onlineBooking,
    [SIGNAL_COLUMNS.clickToCall]: s.clickToCall,
    [SIGNAL_COLUMNS.localBusinessSchema]: s.localBusinessSchema,
    [SIGNAL_COLUMNS.publishedHours]: s.publishedHours,
    [SIGNAL_COLUMNS.claimsEmergency]: s.claimsEmergency,
    [SIGNAL_COLUMNS.showsReviews]: s.showsReviews,
    [SIGNAL_COLUMNS.hasPageTitle]: s.hasPageTitle,
    [SIGNAL_COLUMNS.hasMetaDescription]: s.hasMetaDescription,
    [SIGNAL_COLUMNS.copyrightYear]: s.copyrightYear,
    [SIGNAL_COLUMNS.landingBytes]: s.landingBytes,
    [SIGNAL_COLUMNS.tools]: s.tools,
    site_scanned_at: new Date().toISOString(),
  };
}

export type DiagnosisResult = {
  findings: Finding[];
  shown: Finding[];
  angles: number;
  thin: boolean;
  affordability: Affordability;
};

/** Run both engines over one lead row. Pure, given the row. */
export function diagnoseRow(row: LeadRow): DiagnosisResult {
  const site = signalsFromRow(row);
  const findings = diagnose({
    businessName: String(row.business_name || "this business"),
    city: (row.city as string) ?? null,
    state: (row.state as string) ?? null,
    industry: (row.industry as string) ?? null,
    website: (row.website as string) ?? null,
    rating: typeof row.rating === "number" ? row.rating : null,
    reviewCount: typeof row.review_count === "number" ? row.review_count : null,
    mapRank: typeof row.map_rank === "number" ? row.map_rank : null,
    mapResultCount: typeof row.map_result_count === "number" ? row.map_result_count : null,
    site,
    answeringSetup: (row.answering_setup as string) ?? null,
    existingProvider: (row.existing_provider as string) ?? null,
  });

  const shown = topFindings(findings, 4);
  const affordability = estimateAffordability({
    industry: (row.industry as string) ?? null,
    reviewCount: typeof row.review_count === "number" ? row.review_count : null,
    rating: typeof row.rating === "number" ? row.rating : null,
    mapRank: typeof row.map_rank === "number" ? row.map_rank : null,
    hasWebsite: !!String(row.website || "").trim(),
    hasBookingTool: site.onlineBooking === true || site.tools.length > 0,
    hasSchema: site.localBusinessSchema === true,
    mobileReady: site.mobileViewport === true,
    officeStaffCount: (row.office_staff_count as string) ?? null,
  });

  return {
    findings,
    shown,
    angles: sellableAngles(shown).length,
    thin: diagnosticIsThin(shown),
    affordability,
  };
}

/**
 * Diagnose a lead and write it down.
 *
 * Never throws. A missing column means migration 0032 has not been run, and
 * the correct behaviour there is to leave the lead exactly as it was — not to
 * fail the enrichment run that produced the signals.
 */
export async function runDiagnostic(
  leadId: string,
  freshSignals?: SiteSignals
): Promise<DiagnosisResult | null> {
  const db = supabaseAdmin();
  try {
    const { data, error } = await db
      .from("leads")
      .select(DIAGNOSTIC_COLUMNS)
      .eq("id", leadId)
      .maybeSingle();
    if (error) {
      if (isMissingColumnError(error)) return null;
      throw new Error(error.message);
    }
    if (!data) return null;

    // Fresh signals from a crawl that just happened beat the stored ones.
    const row: LeadRow = freshSignals
      ? { ...(data as unknown as LeadRow), ...signalsToPatch(freshSignals) }
      : (data as unknown as LeadRow);

    const result = diagnoseRow(row);

    const patch: Record<string, unknown> = {
      diagnostic_findings: result.shown,
      diagnostic_hook: result.shown[0]?.headline ?? null,
      diagnostic_angles: result.angles,
      diagnostic_at: new Date().toISOString(),
      affordability_band: result.affordability.band,
      affordability_monthly_low: result.affordability.monthlyBudget.low,
      affordability_monthly_high: result.affordability.monthlyBudget.high,
      affordability_one_off_ceiling: result.affordability.oneOffCeiling,
      affordability_confidence: result.affordability.confidence,
      affordability_signals: result.affordability.signals,
    };
    if (freshSignals) Object.assign(patch, signalsToPatch(freshSignals));

    const { error: writeErr } = await db.from("leads").update(patch).eq("id", leadId);
    if (writeErr && !isMissingColumnError(writeErr)) throw new Error(writeErr.message);

    await recordEvent({
      type: "lead.enriched",
      entityType: "lead",
      entityId: leadId,
      leadId,
      actorType: "worker",
      source: "worker",
      newValue: {
        angles: result.angles,
        findings: result.shown.map((f) => f.key),
        hook: result.shown[0]?.headline ?? null,
      },
      metadata: {
        field: "diagnostic",
        thin: result.thin,
        // The band, not the numbers. Even the event log does not need to carry
        // a dollar figure about somebody's business around.
        size_band: result.affordability.band,
        size_confidence: result.affordability.confidence,
      },
      verificationStatus: "unverified",
    });

    return result;
  } catch (e) {
    console.error(`[diagnostic] ${leadId}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** The stored findings for a lead, for the packet page and the dialer. */
export function findingsFromRow(row: LeadRow): Finding[] {
  const raw = row.diagnostic_findings;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (f): f is Finding =>
      !!f && typeof f === "object" && typeof (f as Finding).headline === "string"
  );
}

export { UNKNOWN_SIGNALS };
