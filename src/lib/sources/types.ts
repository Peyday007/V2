// A pluggable decision-maker source. The waterfall runs these in order and
// stops as soon as one returns a high-confidence finding.

import type { EmailCandidate } from "../extractEmails";
import type { SiteSignals } from "../siteSignals";

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
  /**
   * Email addresses seen on the pages this source read.
   *
   * Optional, and only the website source fills it in. It rides along on the
   * crawl that was already happening to find the owner's name rather than
   * costing a second fetch — the contact page that names the owner is almost
   * always the page that shows their address.
   */
  emails?: EmailCandidate[];
  /**
   * What the crawled pages say about how this business gets work: mobile,
   * booking, schema, security, freshness. Only the website source fills it in.
   */
  signals?: SiteSignals;
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
