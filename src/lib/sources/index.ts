import "server-only";
import { websiteSource } from "./website";
import { searchApiSource } from "./searchApi";
import type { EnrichmentSource } from "./types";

export * from "./types";

/**
 * The enrichment waterfall, cheapest and most reliable first.
 * The internal-database step runs before any of these, inside the job handler.
 *
 * Adding a source means adding one file and one entry here — nothing else
 * in the pipeline changes.
 */
export const SOURCES: EnrichmentSource[] = [websiteSource, searchApiSource].sort(
  (a, b) => a.order - b.order
);

export function availableSources(): EnrichmentSource[] {
  return SOURCES.filter((s) => s.isAvailable());
}

export function sourceStatus(): { key: string; label: string; available: boolean }[] {
  return SOURCES.map((s) => ({
    key: s.key,
    label: s.label,
    available: s.isAvailable(),
  }));
}
