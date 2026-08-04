"use client";

import { useEffect, useState } from "react";
import { CALL_OUTCOMES } from "@/lib/constants";

// The per-caller table and the outcome breakdown.
//
// These were the whole of a separate "Metrics" page, which sat first in the
// navigation and read one table — calls — to produce counts. Analytics next to
// it read the same table plus appointments, objections, callbacks, leads and
// packets, and gave the same numbers WITH confidence intervals.
//
// So Metrics was a strict subset presented as a peer, and the older of the two
// was the one people saw first. These two tables were the only thing on it
// that Analytics did not already have, so they moved here and the page went.
//
// Deliberately kept as plain counts with no confidence tagging: this is the
// "what happened" half of the page, and the "is that any good" half is the
// section above it. Putting intervals on a raw dial count would be a
// statistical claim about something that is simply a fact.

type Summary = {
  dials: number;
  connects: number;
  dmConvos: number;
  appointments: number;
  dmPer100: number;
  connectRate: number;
  apptPer100: number;
};

type Payload = {
  overall: Summary;
  outcomes: Record<string, number>;
  callers: (Summary & { name: string })[];
  error?: string;
};

export default function TeamNumbers() {
  const [m, setM] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/metrics")
      .then((r) => r.json())
      .then((j) => {
        // An error payload has no `overall`, and reading through it used to
        // white-screen the page instead of showing the reason.
        if (!j || j.error || !j.overall) {
          setError(j?.error || "Could not load the team numbers.");
          return;
        }
        setM(j);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) {
    return (
      <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>
        {error}
      </div>
    );
  }
  if (!m) return <p className="muted">Loading…</p>;

  const stats = [
    { label: "Total dials", value: m.overall.dials },
    { label: "DM conversations", value: m.overall.dmConvos },
    { label: "DM convos / 100 dials", value: m.overall.dmPer100, accent: true },
    { label: "Appointments", value: m.overall.appointments },
    { label: "Appts / 100 dials", value: m.overall.apptPer100 },
    { label: "Connect rate %", value: m.overall.connectRate },
  ];

  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
          marginBottom: 24,
        }}
      >
        {stats.map((s) => (
          <div key={s.label} className="card" style={{ textAlign: "center" }}>
            <div
              style={{
                fontSize: "1.8rem",
                fontWeight: 700,
                color: s.accent ? "var(--amber)" : "var(--text)",
              }}
            >
              {s.value}
            </div>
            <div className="faint">{s.label}</div>
          </div>
        ))}
      </div>

      <h2 style={{ marginBottom: 10 }}>By caller</h2>
      <div style={{ overflowX: "auto", marginBottom: 28 }}>
        <table>
          <thead>
            <tr>
              <th>Caller</th>
              <th>Dials</th>
              <th>DM convos</th>
              <th>DM / 100</th>
              <th>Appts</th>
            </tr>
          </thead>
          <tbody>
            {m.callers.map((c) => (
              <tr key={c.name}>
                <td style={{ fontWeight: 600 }}>{c.name}</td>
                <td>{c.dials}</td>
                <td>{c.dmConvos}</td>
                <td style={{ color: "var(--amber)", fontWeight: 600 }}>{c.dmPer100}</td>
                <td>{c.appointments}</td>
              </tr>
            ))}
            {m.callers.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No calls logged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginBottom: 10 }}>Outcome breakdown</h2>
      <div style={{ overflowX: "auto", marginBottom: 28 }}>
        <table>
          <thead>
            <tr>
              <th>Outcome</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            {CALL_OUTCOMES.filter((o) => m.outcomes[o.value]).map((o) => (
              <tr key={o.value}>
                <td>{o.label}</td>
                <td>{m.outcomes[o.value]}</td>
              </tr>
            ))}
            {Object.keys(m.outcomes).length === 0 && (
              <tr>
                <td colSpan={2} className="muted">
                  Nothing logged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
