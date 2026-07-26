"use client";

import { useEffect, useState } from "react";
import { CALL_OUTCOMES } from "@/lib/constants";

type Summary = {
  dials: number;
  connects: number;
  dmConvos: number;
  appointments: number;
  dmPer100: number;
  connectRate: number;
  apptPer100: number;
};

type Metrics = {
  overall: Summary;
  outcomes: Record<string, number>;
  callers: (Summary & { name: string })[];
};

export default function MetricsPage() {
  const [m, setM] = useState<Metrics | null>(null);

  useEffect(() => {
    fetch("/api/metrics")
      .then((r) => r.json())
      .then(setM);
  }, []);

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
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 20 }}>Metrics</h1>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
          marginBottom: 28,
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
      <table style={{ marginBottom: 28 }}>
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

      <h2 style={{ marginBottom: 10 }}>Outcome breakdown</h2>
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
        </tbody>
      </table>
    </div>
  );
}
