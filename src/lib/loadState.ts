import { coerceStage, normalizeStage, SalesStage } from "./stages";

export type LoadState =
  | { status: "loading" }
  | { status: "success_with_data" }
  | { status: "success_empty" }
  | { status: "error"; message: string };

export type RawLeadRow = { pipeline_stage?: string | null } & Record<string, unknown>;

/**
 * The rule that this whole bug came down to: an unresolved or failed query
 * must NEVER be presented as an empty board.
 */
export function deriveLoadState(
  rows: unknown[] | null,
  error: { message: string } | null
): LoadState {
  if (error) {
    const missing = /does not exist|schema cache|column/i.test(error.message);
    return {
      status: "error",
      message: missing
        ? `Database schema is out of date: ${error.message}. Run supabase/migrations/0005_canonical_stages.sql in the Supabase SQL Editor.`
        : `Could not load leads. Database error: ${error.message}`,
    };
  }
  if (rows === null) return { status: "loading" };
  return rows.length > 0
    ? { status: "success_with_data" }
    : { status: "success_empty" };
}

/** Attach a canonical stage to every row and flag any that were unrecognized. */
export function withCanonicalStages<T extends RawLeadRow>(
  rows: T[]
): (T & { pipeline_stage: SalesStage; stage_was_unrecognized: boolean })[] {
  return rows.map((r) => {
    const canonical = normalizeStage(r.pipeline_stage);
    return {
      ...r,
      pipeline_stage: canonical ?? coerceStage(r.pipeline_stage),
      stage_was_unrecognized: canonical === null,
    };
  });
}
