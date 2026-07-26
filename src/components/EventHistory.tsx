"use client";

import { useCallback, useEffect, useState } from "react";
import { eventLabel } from "@/lib/eventTypes";

export type EventRow = {
  id: number;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  lead_id: string | null;
  packet_id: string | null;
  call_id: string | null;
  campaign_id: string | null;
  actor_type: string | null;
  actor_caller_id: string | null;
  previous_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
  correlation_id: string | null;
  causation_event_id: number | null;
  source: string | null;
  confidence: number | null;
  verification_status: string | null;
  occurred_at: string;
};

/** Compact "a → b" rendering of a change. */
function ChangeLine({ row }: { row: EventRow }) {
  const prev = row.previous_value || {};
  const next = row.new_value || {};
  const keys = Object.keys(next);
  if (keys.length === 0) return null;
  return (
    <div style={{ fontSize: "0.78rem", marginTop: 3 }}>
      {keys.slice(0, 4).map((k) => (
        <div key={k}>
          <span className="faint">{k}: </span>
          {k in prev && prev[k] !== null && prev[k] !== undefined && (
            <>
              <span style={{ color: "var(--text-faint)", textDecoration: "line-through" }}>
                {String(prev[k])}
              </span>
              <span className="faint"> → </span>
            </>
          )}
          <span style={{ color: "var(--amber)" }}>{String(next[k])}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Event history. Scoped by whatever filter is passed — used both as the
 * global admin feed and as per-lead / per-packet / per-caller / per-call
 * history inside other screens.
 */
export default function EventHistory({
  filter,
  limit = 100,
  title = "History",
  compact = false,
}: {
  filter?: Record<string, string | undefined>;
  limit?: number;
  title?: string;
  compact?: boolean;
}) {
  const [rows, setRows] = useState<EventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [typeFilter, setTypeFilter] = useState("");

  const key = JSON.stringify(filter || {});

  const load = useCallback(async () => {
    setState("loading");
    const params = new URLSearchParams({ limit: String(limit) });
    for (const [k, v] of Object.entries(JSON.parse(key) as Record<string, string>)) {
      if (v) params.set(k, v);
    }
    if (typeFilter) params.set("type", typeFilter);

    const res = await fetch(`/api/events?${params}`);
    const j = await res.json();
    if (!res.ok) {
      setMessage(j.error || "Could not load history");
      setState("error");
      return;
    }
    setRows(j.events || []);
    setTotal(j.total || 0);
    setState("ready");
  }, [key, limit, typeFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const types = [...new Set(rows.map((r) => r.event_type))].sort();

  if (state === "error") {
    return (
      <div className="card" style={{ borderColor: "var(--red)" }}>
        <h3 style={{ color: "var(--red)", marginBottom: 6 }}>{title}</h3>
        <p style={{ fontSize: "0.85rem" }}>{message}</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <h3>{title}</h3>
        <span className="tag-dim">{total} events</span>
        <div style={{ flex: 1 }} />
        {!compact && types.length > 1 && (
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            style={{ maxWidth: 240 }}
          >
            <option value="">All event types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {eventLabel(t)}
              </option>
            ))}
          </select>
        )}
        <button className="btn-ghost" style={{ padding: "3px 10px" }} onClick={load}>
          Refresh
        </button>
      </div>

      {state === "loading" && <p className="muted">Loading history…</p>}

      {state === "ready" && rows.length === 0 && (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          No events recorded yet for this view.
        </p>
      )}

      {state === "ready" &&
        rows.map((r) => (
          <div
            key={r.id}
            style={{
              padding: "8px 0",
              borderBottom: "1px solid var(--border)",
              fontSize: "0.82rem",
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <strong style={{ color: "var(--amber)" }}>{eventLabel(r.event_type)}</strong>
              <span className="faint">
                {new Date(r.occurred_at).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
              {r.actor_type && <span className="tag-dim">{r.actor_type}</span>}
              {r.source && r.source !== "api" && (
                <span className="faint">via {r.source}</span>
              )}
              {r.confidence != null && (
                <span className="faint">confidence {r.confidence}</span>
              )}
              {r.verification_status === "verified" && (
                <span style={{ color: "var(--green)", fontSize: "0.72rem" }}>verified</span>
              )}
            </div>

            <ChangeLine row={r} />

            {r.data && Object.keys(r.data).length > 0 && !compact && (
              <details style={{ marginTop: 3 }}>
                <summary className="faint" style={{ cursor: "pointer" }}>
                  context
                </summary>
                <pre
                  style={{
                    fontSize: "0.7rem",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    marginTop: 4,
                    color: "var(--text-dim)",
                  }}
                >
                  {JSON.stringify(r.data, null, 2)}
                </pre>
              </details>
            )}
          </div>
        ))}
    </div>
  );
}
