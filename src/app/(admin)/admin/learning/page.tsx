"use client";

import { useCallback, useEffect, useState } from "react";

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
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await fetch("/api/learning");
    setData(await res.json());
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
