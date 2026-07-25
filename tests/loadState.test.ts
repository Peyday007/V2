import { describe, it, expect } from "vitest";
import { deriveLoadState, withCanonicalStages } from "../src/lib/loadState";

describe("deriveLoadState — the regression that caused the empty board", () => {
  it("an unresolved query is LOADING, never empty", () => {
    expect(deriveLoadState(null, null)).toEqual({ status: "loading" });
  });

  it("a failed query is an ERROR, never empty", () => {
    const state = deriveLoadState(null, { message: "permission denied for table leads" });
    expect(state.status).toBe("error");
    if (state.status === "error") {
      expect(state.message).toContain("permission denied");
    }
  });

  it("a failed query with rows present still reports the error", () => {
    const state = deriveLoadState([{ id: 1 }], { message: "boom" });
    expect(state.status).toBe("error");
  });

  it("a missing table/column error tells the user to run the migration", () => {
    const state = deriveLoadState(null, {
      message: 'relation "public.contacts" does not exist',
    });
    if (state.status !== "error") throw new Error("expected error state");
    expect(state.message).toContain("0005_canonical_stages.sql");
  });

  it("only a genuinely empty successful result is success_empty", () => {
    expect(deriveLoadState([], null)).toEqual({ status: "success_empty" });
  });

  it("rows present is success_with_data", () => {
    expect(deriveLoadState([{ id: 1 }], null)).toEqual({
      status: "success_with_data",
    });
  });
});

describe("withCanonicalStages", () => {
  it("keeps valid stages and does not flag them", () => {
    const [row] = withCanonicalStages([{ pipeline_stage: "qualified" }]);
    expect(row.pipeline_stage).toBe("qualified");
    expect(row.stage_was_unrecognized).toBe(false);
  });

  it("converts legacy display text so old leads still render", () => {
    const [row] = withCanonicalStages([{ pipeline_stage: "Contact Attempted" }]);
    expect(row.pipeline_stage).toBe("contact_attempted");
    expect(row.stage_was_unrecognized).toBe(false);
  });

  it("rescues unknown stages into new_lead and FLAGS them (never hides a lead)", () => {
    const [row] = withCanonicalStages([{ pipeline_stage: "wat" }]);
    expect(row.pipeline_stage).toBe("new_lead");
    expect(row.stage_was_unrecognized).toBe(true);
  });

  it("rescues null/missing stages", () => {
    const rows = withCanonicalStages([{ pipeline_stage: null }, {}]);
    expect(rows.every((r) => r.pipeline_stage === "new_lead")).toBe(true);
    expect(rows.every((r) => r.stage_was_unrecognized)).toBe(true);
  });

  it("every row survives — count in equals count out", () => {
    const input = [
      { pipeline_stage: "new_lead" },
      { pipeline_stage: "Closed Won" },
      { pipeline_stage: "garbage" },
      { pipeline_stage: null },
    ];
    expect(withCanonicalStages(input)).toHaveLength(input.length);
  });
});
