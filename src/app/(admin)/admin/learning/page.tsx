"use client";

import { useCallback, useEffect, useState } from "react";

type Prior = {
  key: string;
  label: string;
  lift: number;
  rate: number;
  samples: number;
  confidence: string;
  applied: boolean;
  reason: string;
};

type Knowledge = {
  settings: { applyLearning: boolean; minSamples: number; explorationFloor: number; lastComputedAt: string | null };
  knowledge: {
    totalFacts: number;
    computedAt: string;
    angleLift: Prior[];
    scriptLift: Prior[];
    scriptWeights: Record<string, number>;
    industryYield: Prior[];
    timing: Prior[];
    bandCalibration: { band: string; estimated: number; closed: number; medianDealValue: number | null; verdict: string }[];
    blindSpots: { area: string; detail: string; needs: number }[];
  };
  summary: string;
  applied: Prior[];
  applications: { surface: string; prior_key: string; samples: number; detail: string; created_at: string }[];
  history: { total_facts: number; applied_priors: number; blind_spots: number; computed_at: string }[];
  error: string | null;
};

type Proposal = {
  id: string;
  scope: string;
  exact_change: string;
  reason: string;
  sample_size: number;
  baseline_rate: number | null;
  candidate_rate: number | null;
  p_value: number | null;
  confidence: number | null;
  controlled_for: string[] | null;
  status: string;
  created_at: string;
  rejected_reason: string | null;
};

type Verdict = {
  decision: "promote" | "keep_running" | "abandon";
  reason: string;
  primaryImproved: boolean;
  primaryPValue: number | null;
  guardrails: { outcome: string; worse: boolean; detail: string }[];
};

type Experiment = {
  id: string;
  scope: string;
  primary_metric: string;
  traffic_percent: number;
  minimum_sample: number;
  status: string;
  started_at: string;
  conclusion: string | null;
  verdict: Verdict;
  assigned: number;
};

type Version = {
  id: string;
  scope?: string;
  version?: number;
  status?: string;
  created_at: string;
};

type Payload = {
  proposals: Proposal[];
  experiments: Experiment[];
  versions: Version[];
  observationCount?: number;
  error: string | null;
};

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;

export default function LearningPage() {
  const [knowledge, setKnowledge] = useState<Knowledge | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [res, kres] = await Promise.all([
        fetch("/api/learning"),
        fetch("/api/learning/knowledge"),
      ]);
      const j = await res.json();
      setKnowledge(await kres.json().catch(() => null));
      setData({
        proposals: j.proposals ?? [],
        experiments: j.experiments ?? [],
        versions: j.versions ?? [],
        observationCount: j.observationCount ?? 0,
        error: j.error ?? null,
      });
    } catch (e) {
      setData({
        proposals: [],
        experiments: [],
        versions: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function scan() {
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/learning", { method: "PUT" });
    const j = await res.json();
    setBusy(false);
    if (!res.ok) {
      setMsg(j.error || "Could not run that.");
      return;
    }
    setMsg(
      j.created > 0
        ? `${j.created} proposal${j.created === 1 ? "" : "s"} raised.`
        : `Nothing worth proposing. ${(j.refused || [])
            .map((r: { dimension: string; reason: string }) => `${r.dimension}: ${r.reason}`)
            .join(" ")}`
    );
    load();
  }

  async function act(id: string, action: string) {
    setBusy(true);
    await fetch("/api/learning", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action, note: note[id] || "" }),
    });
    setBusy(false);
    load();
  }

  if (!data) return <p className="muted">Loading…</p>;

  const k = knowledge?.knowledge;

  const pending = data.proposals.filter((p) => p.status === "pending");
  const decided = data.proposals.filter((p) => p.status !== "pending");
  const running = data.experiments.filter((e) => e.status === "running");

  return (
    <div style={{ maxWidth: 980, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>Learning</h1>
      <p className="faint" style={{ marginBottom: 12, lineHeight: 1.6 }}>
        What the calls suggest might work better. <strong>Nothing here applies
        itself.</strong> A platform that rewrites its own pitch after a good week
        is how a team ends up with a script nobody chose and nobody can explain
        to a new hire.
      </p>
      {/* ----------------------- what the house knows ------------------------ */}
      <div className="card" style={{ marginBottom: 24, borderLeft: "3px solid var(--amber)" }}>
        <h2 style={{ marginTop: 0, marginBottom: 8 }}>What the house knows</h2>
        <p style={{ lineHeight: 1.7, marginTop: 0 }}>{knowledge?.summary ?? "Loading…"}</p>
        <p className="faint" style={{ lineHeight: 1.7 }}>
          Every call, every reply and every packet feeds one shared set of priors, and the
          diagnostic, the packet order, the opener split and the email writer all read it. The
          more the business runs, the sharper each of them gets — and nothing is acted on until
          it clears {knowledge?.settings?.minSamples ?? 30} observations, so an early lucky week
          cannot become policy.
        </p>

        {knowledge?.error && (
          <p style={{ color: "var(--red)", lineHeight: 1.6 }}>{knowledge.error}</p>
        )}

        {(knowledge?.applied?.length ?? 0) > 0 && (
          <>
            <div className="faint" style={{ marginTop: 14, marginBottom: 6, fontWeight: 700 }}>
              Being acted on right now
            </div>
            {knowledge!.applied.map((p) => (
              <div key={p.key} style={{ fontSize: "0.84rem", lineHeight: 1.6 }}>
                <span style={{ color: "var(--amber)", fontWeight: 700 }}>
                  {p.lift > 0 ? "▲" : "▼"} {p.label}
                </span>{" "}
                — {p.reason}
              </div>
            ))}
          </>
        )}

        {(k?.blindSpots?.length ?? 0) > 0 && (
          <>
            <div className="faint" style={{ marginTop: 14, marginBottom: 6, fontWeight: 700 }}>
              What it still cannot answer
            </div>
            {k!.blindSpots.map((b) => (
              <div key={b.area} style={{ fontSize: "0.84rem", lineHeight: 1.6 }}>
                <strong>{b.area}:</strong> {b.detail}{" "}
                {b.needs > 0 && (
                  <span className="faint">About {b.needs} more would settle it.</span>
                )}
              </div>
            ))}
            <p className="faint" style={{ marginTop: 8, lineHeight: 1.6, fontSize: "0.82rem" }}>
              This half matters as much as the other one. A system that only reports its
              conclusions quietly stops improving, because nobody can see where the next
              improvement would come from.
            </p>
          </>
        )}

        {Object.keys(k?.scriptWeights ?? {}).length > 0 && (
          <>
            <div className="faint" style={{ marginTop: 14, marginBottom: 6, fontWeight: 700 }}>
              How the openers are being split
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: "0.84rem" }}>
              {Object.entries(k!.scriptWeights).map(([v, w]) => (
                <span key={v}>
                  <strong>{v}</strong> {(w * 100).toFixed(0)}%
                </span>
              ))}
            </div>
            <p className="faint" style={{ marginTop: 6, lineHeight: 1.6, fontSize: "0.82rem" }}>
              Every opener keeps a share forever — {((knowledge?.settings?.explorationFloor ?? 0.2) * 100).toFixed(0)}%
              of traffic stays exploratory. A router that sends everything to today&rsquo;s winner
              cannot notice when the market moves, because the data it would need is data it
              stopped collecting.
            </p>
          </>
        )}

        {(knowledge?.applications?.length ?? 0) > 0 && (
          <>
            <div className="faint" style={{ marginTop: 14, marginBottom: 6, fontWeight: 700 }}>
              Where it actually changed something
            </div>
            {knowledge!.applications.slice(0, 8).map((a, i) => (
              <div key={i} className="faint" style={{ fontSize: "0.8rem", lineHeight: 1.6 }}>
                {new Date(a.created_at).toLocaleDateString()} · {a.surface.replace(/_/g, " ")} ·{" "}
                {a.detail}
              </div>
            ))}
          </>
        )}

        {(k?.bandCalibration?.length ?? 0) > 0 && (
          <>
            <div className="faint" style={{ marginTop: 14, marginBottom: 6, fontWeight: 700 }}>
              Was the size estimate right?
            </div>
            {k!.bandCalibration.map((b) => (
              <div key={b.band} style={{ fontSize: "0.82rem", lineHeight: 1.6 }}>
                <strong>{b.band}</strong> — {b.closed} of {b.estimated} closed. {b.verdict}
              </div>
            ))}
            <p className="faint" style={{ marginTop: 6, lineHeight: 1.6, fontSize: "0.82rem" }}>
              Reported, never applied. Nothing here moves a price on its own.
            </p>
          </>
        )}

        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
          <button
            className="btn-ghost"
            disabled={recomputing}
            onClick={async () => {
              setRecomputing(true);
              await fetch("/api/learning/knowledge", { method: "POST" }).catch(() => {});
              setRecomputing(false);
              load();
            }}
          >
            {recomputing ? "Rebuilding…" : "Rebuild now"}
          </button>
          {knowledge?.settings?.lastComputedAt && (
            <span className="faint">
              Last rebuilt {new Date(knowledge.settings.lastComputedAt).toLocaleString()}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={knowledge?.settings?.applyLearning ?? true}
              onChange={async (e) => {
                await fetch("/api/learning/knowledge", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ apply_learning: e.target.checked }),
                }).catch(() => {});
                load();
              }}
            />
            <span className="faint">Let what it learns change what the tools do</span>
          </label>
        </div>
      </div>

      <p className="faint" style={{ marginBottom: 20, lineHeight: 1.6 }}>
        Approving a proposal starts a <strong>test</strong>, not a rollout. A
        change that looked good in past data still has to beat the current
        approach live, and it is only promoted if the primary metric improves{" "}
        <em>and</em> nothing on the guardrail list gets worse — more meetings
        booked with fewer attended is a regression wearing a win&rsquo;s clothes.
      </p>

      {data.error && (
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 16 }}>
          {data.error}
        </div>
      )}
      {msg && (
        <div className="card" style={{ borderColor: "var(--amber-dim)", marginBottom: 16, lineHeight: 1.55 }}>
          {msg}
        </div>
      )}

      <button className="btn" onClick={scan} disabled={busy} style={{ marginBottom: 24 }}>
        {busy ? "Looking…" : "Look for something worth changing"}
      </button>

      {/* --------------------------- running tests -------------------------- */}
      {running.length > 0 && (
        <div style={{ marginBottom: 26 }}>
          <h2 style={{ marginBottom: 10 }}>Under test ({running.length})</h2>
          <div style={{ display: "grid", gap: 12 }}>
            {running.map((e) => (
              <div key={e.id} className="card">
                <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  <strong>{e.scope.replace(/_/g, " ")}</strong>
                  <span className="tag-dim">{e.traffic_percent}% of calls</span>
                  <span className="tag-dim">{e.assigned} calls in</span>
                  <span
                    className="tag"
                    style={{
                      color:
                        e.verdict.decision === "promote"
                          ? "var(--amber)"
                          : e.verdict.decision === "abandon"
                            ? "var(--red)"
                            : "var(--text-dim)",
                    }}
                  >
                    {e.verdict.decision.replace(/_/g, " ")}
                  </span>
                </div>
                <p className="faint" style={{ marginTop: 5, lineHeight: 1.55 }}>
                  {e.verdict.reason}
                </p>
                {e.verdict.guardrails.some((g) => g.worse) && (
                  <p style={{ color: "var(--red)", marginTop: 6, lineHeight: 1.5 }}>
                    Guardrail moving the wrong way:{" "}
                    {e.verdict.guardrails.filter((g) => g.worse).map((g) => g.detail).join("; ")}
                  </p>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <input
                    placeholder="What did you conclude?"
                    value={note[e.id] || ""}
                    onChange={(ev) => setNote({ ...note, [e.id]: ev.target.value })}
                    style={{ flex: 1, minWidth: 200 }}
                  />
                  <button className="btn-ghost" disabled={busy} onClick={() => act(e.id, "stop")}>
                    Stop the test
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------------------------- proposals ----------------------------- */}
      <h2 style={{ marginBottom: 10 }}>Proposals ({pending.length})</h2>
      {pending.length === 0 ? (
        <p className="muted" style={{ marginBottom: 24 }}>
          Nothing proposed. That is the normal state — most differences between
          two approaches are noise, and this refuses far more often than it
          suggests.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 12, marginBottom: 26 }}>
          {pending.map((p) => (
            <div key={p.id} className="card" style={{ borderColor: "var(--amber-dim)" }}>
              <strong style={{ color: "var(--amber)" }}>{p.exact_change}</strong>
              <p className="faint" style={{ marginTop: 5, lineHeight: 1.55 }}>
                {p.reason}
              </p>
              <p className="faint" style={{ marginTop: 6 }}>
                {pct(p.baseline_rate)} → {pct(p.candidate_rate)} across {p.sample_size} calls
                {p.p_value !== null ? ` · p = ${p.p_value.toFixed(3)}` : ""}
              </p>
              {p.controlled_for && p.controlled_for.length > 0 && (
                <p className="faint" style={{ marginTop: 3 }}>
                  Controlled for: {p.controlled_for.join(", ")}
                </p>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button className="btn" disabled={busy} onClick={() => act(p.id, "test")}>
                  Test it
                </button>
                <input
                  placeholder="Why not? (optional)"
                  value={note[p.id] || ""}
                  onChange={(ev) => setNote({ ...note, [p.id]: ev.target.value })}
                  style={{ flex: 1, minWidth: 180 }}
                />
                <button className="btn-ghost" disabled={busy} onClick={() => act(p.id, "reject")}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ------------------------------ history ----------------------------- */}
      {decided.length > 0 && (
        <>
          <h2 style={{ marginBottom: 10 }}>Already decided</h2>
          <div style={{ display: "grid", gap: 8 }}>
            {decided.map((p) => (
              <div key={p.id} className="faint" style={{ lineHeight: 1.55 }}>
                <span className="tag-dim">{p.status}</span> {p.exact_change}
                {p.rejected_reason ? ` — ${p.rejected_reason}` : ""}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
