"use client";

import { useCallback, useEffect, useState } from "react";

type Session = { start: string; end: string; minutes: number; calls: number };

type Day = {
  date: string;
  sessions: Session[];
  activeMinutes: number;
  spanMinutes: number;
  idleMinutes: number;
  calls: number;
  callsPerActiveHour: number;
  measuredCallMinutes: number;
  firstAt: string | null;
  lastAt: string | null;
};

type Flag = {
  key: string;
  question: string;
  evidence: string;
  innocentExplanation: string;
  severity: "low" | "medium" | "high";
};

type Timesheet = {
  callerName: string;
  days: Day[];
  totalActiveHours: number;
  totalCalls: number;
  averageCallsPerActiveHour: number;
  daysWorked: number;
  flags: Flag[];
};

const RANGES = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 14 days", days: 14 },
  { label: "Last 30 days", days: 30 },
];

const SEVERITY_COLOR: Record<string, string> = {
  low: "var(--text-dim)",
  medium: "var(--amber)",
  high: "var(--red)",
};

const hrs = (m: number) => `${Math.round((m / 60) * 10) / 10}h`;
const clock = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "—";

export default function TimesheetPage() {
  const [data, setData] = useState<{ timesheets: Timesheet[]; basis: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(14);
  const [openCaller, setOpenCaller] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(null);
    const res = await fetch(`/api/timesheet?days=${days}`);
    const j = await res.json();
    if (!res.ok) {
      setError(j.error || "Could not build the timesheet.");
      return;
    }
    setError(null);
    setData(j);
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        <h1 style={{ marginBottom: 16 }}>Time</h1>
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>
          {error}
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6, flexWrap: "wrap" }}>
        <h1>Time</h1>
        <div style={{ flex: 1 }} />
        {RANGES.map((r) => (
          <button
            key={r.days}
            className={days === r.days ? "btn" : "btn-ghost"}
            onClick={() => setDays(r.days)}
            style={{ padding: "5px 12px", fontSize: "0.72rem" }}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 22 }}>
        <h3 style={{ marginBottom: 6 }}>What this is, and what it is not</h3>
        <p className="faint" style={{ lineHeight: 1.6 }}>
          Every call outcome is stamped with a <strong>server</strong> time the
          caller cannot edit, so a working day can be rebuilt from the work
          itself. Nobody clocks in, and nobody can round their hours up.
        </p>
        <p className="faint" style={{ lineHeight: 1.6, marginTop: 8 }}>
          What it cannot see: whether someone was at their desk between two
          calls, or whether a number was really dialed rather than the outcome
          just clicked. <strong>Treat the flags below as questions to ask, not
          as proof.</strong> Each one comes with the innocent explanation, because
          most of the time that is the right one.
        </p>
      </div>

      {!data && <p className="muted">Reading the calls…</p>}
      {data?.timesheets.length === 0 && (
        <p className="muted">No calls logged in this window.</p>
      )}

      <div style={{ display: "grid", gap: 14 }}>
        {(data?.timesheets || []).map((t) => (
          <div key={t.callerName} className="card">
            <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
              <h3 style={{ fontSize: "1.05rem" }}>{t.callerName}</h3>
              <span style={{ color: "var(--amber)", fontWeight: 700 }}>
                {t.totalActiveHours}h active
              </span>
              <span className="faint">
                {t.totalCalls} calls over {t.daysWorked} day{t.daysWorked === 1 ? "" : "s"} ·{" "}
                {t.averageCallsPerActiveHour} calls an hour
              </span>
              <div style={{ flex: 1 }} />
              <button
                className="btn-ghost"
                style={{ padding: "4px 12px", fontSize: "0.7rem" }}
                onClick={() => setOpenCaller(openCaller === t.callerName ? null : t.callerName)}
              >
                {openCaller === t.callerName ? "Hide days" : "Day by day"}
              </button>
            </div>

            {t.flags.length > 0 && (
              <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                {t.flags.map((f) => (
                  <div
                    key={f.key}
                    style={{
                      padding: "10px 12px",
                      background: "var(--bg-inset)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: "0.88rem", color: SEVERITY_COLOR[f.severity] }}>
                      {f.question}
                    </div>
                    <div className="faint" style={{ marginTop: 3, lineHeight: 1.5 }}>
                      {f.evidence}
                    </div>
                    <div className="faint" style={{ marginTop: 4, lineHeight: 1.5, fontStyle: "italic" }}>
                      Could just be: {f.innocentExplanation}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {t.flags.length === 0 && (
              <p className="faint" style={{ marginTop: 10 }}>
                Nothing here looks worth asking about.
              </p>
            )}

            {openCaller === t.callerName && (
              <table style={{ marginTop: 14 }}>
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Active</th>
                    <th>First → last</th>
                    <th>Gaps</th>
                    <th>Calls</th>
                    <th>Per hour</th>
                    <th>On the phone</th>
                  </tr>
                </thead>
                <tbody>
                  {t.days.map((d) => (
                    <tr key={d.date}>
                      <td style={{ fontWeight: 600 }}>
                        {new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        })}
                      </td>
                      <td style={{ color: "var(--amber)", fontWeight: 600 }}>
                        {hrs(d.activeMinutes)}
                      </td>
                      <td className="faint">
                        {clock(d.firstAt)} → {clock(d.lastAt)}
                      </td>
                      <td className="faint">
                        {d.idleMinutes > 0 ? hrs(d.idleMinutes) : "—"}
                        {d.sessions.length > 1 && (
                          <span> in {d.sessions.length} stints</span>
                        )}
                      </td>
                      <td>{d.calls}</td>
                      <td className="faint">{d.callsPerActiveHour}</td>
                      <td className="faint">
                        {d.measuredCallMinutes > 0 ? `${d.measuredCallMinutes}m` : "not timed"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>

      {data && (
        <p className="faint" style={{ marginTop: 22, lineHeight: 1.6 }}>
          {data.basis} A stretch of work ends when there is no logged outcome for
          20 minutes, so genuine breaks are excluded from active time rather than
          being billed as work.
        </p>
      )}
    </div>
  );
}
