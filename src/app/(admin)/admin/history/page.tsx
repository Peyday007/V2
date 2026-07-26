"use client";

import { useEffect, useState } from "react";
import EventHistory from "@/components/EventHistory";

type Summary = {
  sampled: number;
  newest: string | null;
  oldest: string | null;
  by_type: Record<string, number>;
  by_actor: Record<string, number>;
  by_source: Record<string, number>;
  error?: string;
};

const SCOPES = [
  { key: "", label: "Everything" },
  { key: "lead_id", label: "One lead" },
  { key: "caller_id", label: "One caller" },
  { key: "packet_id", label: "One packet" },
  { key: "call_id", label: "One call" },
  { key: "campaign_id", label: "One campaign" },
  { key: "correlation_id", label: "One workflow" },
];

export default function HistoryPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [scope, setScope] = useState("");
  const [scopeValue, setScopeValue] = useState("");
  const [applied, setApplied] = useState<Record<string, string | undefined>>({});

  useEffect(() => {
    fetch("/api/events/summary")
      .then((r) => r.json())
      .then(setSummary)
      .catch(() => setSummary(null));
  }, []);

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 16 }}>Event History</h1>

      {summary?.error && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <p style={{ color: "var(--red)", fontSize: "0.85rem" }}>{summary.error}</p>
        </div>
      )}

      {summary && !summary.error && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <div className="card">
            <h3 style={{ marginBottom: 8 }}>Recorded</h3>
            <div style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--amber)" }}>
              {summary.sampled}
            </div>
            <div className="faint">
              {summary.oldest
                ? `since ${new Date(summary.oldest).toLocaleDateString()}`
                : "no events yet"}
            </div>
          </div>
          <div className="card">
            <h3 style={{ marginBottom: 8 }}>By actor</h3>
            {Object.entries(summary.by_actor).map(([k, v]) => (
              <div key={k} style={{ fontSize: "0.8rem" }} className="muted">
                {k}: <strong>{v}</strong>
              </div>
            ))}
          </div>
          <div className="card">
            <h3 style={{ marginBottom: 8 }}>By source</h3>
            {Object.entries(summary.by_source).map(([k, v]) => (
              <div key={k} style={{ fontSize: "0.8rem" }} className="muted">
                {k}: <strong>{v}</strong>
              </div>
            ))}
          </div>
          <div className="card">
            <h3 style={{ marginBottom: 8 }}>Top event types</h3>
            {Object.entries(summary.by_type)
              .slice(0, 6)
              .map(([k, v]) => (
                <div key={k} style={{ fontSize: "0.78rem" }} className="muted">
                  {k}: <strong>{v}</strong>
                </div>
              ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 10 }}>Scope</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setScopeValue("");
              setApplied({});
            }}
            style={{ maxWidth: 200 }}
          >
            {SCOPES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          {scope && (
            <>
              <input
                placeholder="Paste the id"
                value={scopeValue}
                onChange={(e) => setScopeValue(e.target.value)}
                style={{ maxWidth: 340 }}
              />
              <button
                className="btn"
                onClick={() => setApplied({ [scope]: scopeValue.trim() || undefined })}
                disabled={!scopeValue.trim()}
              >
                Show
              </button>
            </>
          )}
          {Object.keys(applied).length > 0 && (
            <button
              className="btn-ghost"
              onClick={() => {
                setApplied({});
                setScope("");
                setScopeValue("");
              }}
            >
              Clear
            </button>
          )}
        </div>
        <p className="faint" style={{ marginTop: 8 }}>
          Every lead, packet, caller and call carries its own history. Paste an id
          to see just that entity, or pick &quot;One workflow&quot; to see every
          event a single call produced.
        </p>
      </div>

      <EventHistory filter={applied} limit={200} title="Events" />
    </div>
  );
}
