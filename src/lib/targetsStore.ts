// Loading the absolute targets, for every surface that reports a number.
//
// Kept apart from ./benchmarks so the maths stays pure and testable while the
// database access lives here.
//
// Fails open on purpose: if the table is missing (migration not run yet) or the
// query errors, this returns an empty list. That means "no bar is asserted",
// which the assessments already handle honestly — it never breaks the page and
// it never invents a target.

import { supabase } from "./supabase";
import type { MetricKey, Target } from "./benchmarks";

export async function loadTargets(): Promise<Target[]> {
  try {
    const db = supabase();
    const { data, error } = await db
      .from("performance_targets")
      .select("metric, target, source, note, minimum_sample")
      .eq("active", true);
    if (error || !data) return [];
    return data.map((r) => ({
      metric: r.metric as MetricKey,
      target: Number(r.target),
      source: String(r.source ?? "set_by_operator"),
      note: r.note ?? null,
      minimumSample: Number(r.minimum_sample) || 30,
    }));
  } catch {
    return [];
  }
}
