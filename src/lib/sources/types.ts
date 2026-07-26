// A pluggable decision-maker source. The waterfall runs these in order and
// stops as soon as one returns a high-confidence finding.

export type SourceFinding = {
  name: string;
  title: string;
  sourceUrl: string | null;
  supportingText: string;
  method: string;
  confidence: number;
};

export type SourceContext = {
  leadId: string;
  businessName: string;
  website: string | null;
  domain: string | null;
  city: string | null;
  state: string | null;
  industry: string | null;
};

export type SourceResult = {
  /** Every claim found, including weak and conflicting ones. */
  findings: SourceFinding[];
  /** Set when the source could not run (no key, blocked, error). */
  skipped?: string;
};

export type EnrichmentSource = {
  key: string;
  label: string;
  /** Cheapest and most reliable first. */
  order: number;
  /** False when unconfigured — the waterfall skips it without erroring. */
  isAvailable: () => boolean;
  run: (ctx: SourceContext) => Promise<SourceResult>;
};

/** Confidence at which the waterfall stops looking. */
export const STOP_CONFIDENCE = 0.85;
