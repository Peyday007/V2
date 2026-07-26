"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CONFIDENCE_LABEL,
  MIN_DIRECTIONAL,
  type AnalyticsReport,
  type Confidence,
  type DimensionReport,
  type ObjectionReport,
  type Segment,
} from "@/lib/analytics";

type ShowRate = {
  booked: number;
  held: number;
  noShow: number;
  awaiting: number;
  rate: number;
  low: number;
  high: number;
  confidence: Confidence;
};

type Payload = AnalyticsReport & {
  objections: ObjectionReport[];
  objectionsError: string | null;
  showRate: ShowRate | null;
  appointmentsError: string | null;
  windowDays: number | null;
};

const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 && v > 0 ? 1 : 0)}%`;

const CONFIDENCE_COLOR: Record<Confidence, string> = {
  insufficient: "var(--text-dim)",
  directional: "var(--amber)",
  reliable: "var(--green, #7bb661)",
};

function ConfidenceTag({ c }: { c: Confidence }) {
  return (
    <span className="tag-dim" style={{ color: CONFIDENCE_COLOR[c] }}>
      {CONFIDENCE_LABEL[c]}
    </span>
  );
}

const RANGES = [
  { label: "All time", days: 0 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 7 days", days: 7 },
];

export default function AnalyticsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(0);

  const load = useCallback(async () => {
    setData(null);
    const res = await fetch(`/api/analytics${days ? `?days=${days}` : ""}`);
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "Could not load analytics.");
      return;
    }
    setError(null);
    setData(json);
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <h1 style={{ marginBottom: 16 }}>Analytics</h1>
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>
          {error}
        </div>
      </div>
    );
  }
  if (!data) return <p className="muted">Loading…</p>;

  const t = data.totals;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6, flexWrap: "wrap" }}>
        <h1>Analytics</h1>
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
      <p className="faint" style={{ marginBottom: 24 }}>
        Every rate below carries the range it could really be, and every
        comparison carries a significance test. A number without enough calls
        behind it is labelled <em>Not enough data</em> rather than shown as a
        finding — a 100% success rate from one call is not a discovery.
      </p>

      {/* ------------------------------ totals ------------------------------ */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
          gap: 12,
          marginBottom: 28,
        }}
      >
        <Stat label="Calls logged" value={String(t.calls)} />
        <Stat
          label="Connected"
          value={pct(t.connectRate.rate)}
          range={t.calls ? `${pct(t.connectRate.low)}–${pct(t.connectRate.high)}` : undefined}
          sub={`${t.connects}/${t.calls}`}
        />
        <Stat
          label="Owner conversations"
          value={pct(t.ownerRate.rate)}
          range={t.calls ? `${pct(t.ownerRate.low)}–${pct(t.ownerRate.high)}` : undefined}
          sub={`${t.ownerConversations}/${t.calls}`}
          accent
        />
        <Stat
          label="Appointments"
          value={pct(t.appointmentRate.rate)}
          range={t.calls ? `${pct(t.appointmentRate.low)}–${pct(t.appointmentRate.high)}` : undefined}
          sub={`${t.appointments}/${t.calls}`}
        />
        <Stat
          label="Median call length"
          value={
            t.medianDurationSeconds === null
              ? "—"
              : `${Math.floor(t.medianDurationSeconds / 60)}m ${t.medianDurationSeconds % 60}s`
          }
          sub={
            t.medianDurationSeconds === null
              ? "not measured yet"
              : `from ${t.callsWithDuration} timed call${t.callsWithDuration === 1 ? "" : "s"}`
          }
        />
      </div>

      {/* --------------------------- what we know --------------------------- */}
      <h2 style={{ marginBottom: 10 }}>What the data currently supports</h2>
      {data.actionable.length === 0 ? (
        <div className="card" style={{ marginBottom: 28 }}>
          <p style={{ marginBottom: 8 }}>
            <strong>Nothing yet — and that is the correct answer.</strong>
          </p>
          <p className="faint" style={{ lineHeight: 1.6 }}>
            {t.calls === 0
              ? "No calls have been logged. Every measurement below starts filling in from the first call a caller saves."
              : `${t.calls} call${t.calls === 1 ? "" : "s"} logged. A comparison needs roughly ${MIN_DIRECTIONAL} calls on each side before a difference can be told apart from luck. The tables below show what is accumulating, and each one states how many more calls it needs.`}
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10, marginBottom: 28 }}>
          {data.actionable.map((f, i) => (
            <div key={i} className="card" style={{ borderColor: "var(--amber-dim)" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                <span className="tag-dim">{f.dimension}</span>
                <ConfidenceTag c={f.confidence} />
              </div>
              <div style={{ fontWeight: 700, color: "var(--amber)" }}>{f.headline}</div>
              <div className="faint" style={{ marginTop: 4, lineHeight: 1.5 }}>
                {f.detail}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---------------------------- dimensions ---------------------------- */}
      {data.dimensions.map((d) => (
        <Dimension key={d.key} d={d} />
      ))}

      {/* ---------------------------- objections ---------------------------- */}
      <h2 style={{ marginBottom: 4 }}>Objections</h2>
      <p className="faint" style={{ marginBottom: 10 }}>
        Which objections end the call. Logged automatically whenever a caller
        opens one in the dialer, plus anything typed into an outcome form.
      </p>
      {data.objectionsError ? (
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 28 }}>
          {data.objectionsError}
        </div>
      ) : data.objections.length === 0 ? (
        <p className="muted" style={{ marginBottom: 28 }}>
          No objections recorded yet.
        </p>
      ) : (
        <table style={{ marginBottom: 28 }}>
          <thead>
            <tr>
              <th>Objection</th>
              <th>Times raised</th>
              <th>Still reached the owner</th>
              <th>Survival rate</th>
              <th>Could really be</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {data.objections.map((o) => (
              <tr key={o.key}>
                <td style={{ fontWeight: 600 }}>{o.label}</td>
                <td>{o.timesRaised}</td>
                <td>{o.survivedToOwnerConversation}</td>
                <td style={{ color: "var(--amber)", fontWeight: 600 }}>{pct(o.survivalRate)}</td>
                <td className="faint">
                  {pct(o.low)}–{pct(o.high)}
                </td>
                <td>
                  <ConfidenceTag c={o.confidence} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* ----------------------------- show rate ---------------------------- */}
      <h2 style={{ marginBottom: 4 }}>Appointment show rate</h2>
      <p className="faint" style={{ marginBottom: 10 }}>
        Only counts appointments whose outcome has been recorded on the
        Appointments page. Booked-but-unmarked appointments are excluded rather
        than assumed to have happened.
      </p>
      {data.appointmentsError ? (
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 28 }}>
          {data.appointmentsError}
        </div>
      ) : !data.showRate || data.showRate.booked === 0 ? (
        <p className="muted" style={{ marginBottom: 28 }}>
          No appointments booked yet.
        </p>
      ) : (
        <div className="card" style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: "1.8rem", fontWeight: 700, color: "var(--amber)" }}>
                {data.showRate.held + data.showRate.noShow > 0
                  ? pct(data.showRate.rate)
                  : "—"}
              </div>
              <div className="faint">show rate</div>
            </div>
            <div className="faint" style={{ lineHeight: 1.7 }}>
              {data.showRate.held} held · {data.showRate.noShow} no-show ·{" "}
              {data.showRate.awaiting} still awaiting an outcome
              {data.showRate.held + data.showRate.noShow > 0 && (
                <>
                  <br />
                  True rate likely between {pct(data.showRate.low)} and {pct(data.showRate.high)}
                </>
              )}
            </div>
            <ConfidenceTag c={data.showRate.confidence} />
          </div>
        </div>
      )}

      {/* ----------------------------- coverage ----------------------------- */}
      <h2 style={{ marginBottom: 4 }}>Data coverage</h2>
      <p className="faint" style={{ marginBottom: 10 }}>
        What share of logged calls actually carries each field. A low number
        here means the analysis above is thinner than the call count suggests.
      </p>
      <table style={{ marginBottom: 40 }}>
        <thead>
          <tr>
            <th>Field</th>
            <th>Recorded on</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {data.coverage.map((c) => (
            <tr key={c.field}>
              <td style={{ fontWeight: 600 }}>{c.field}</td>
              <td
                style={{
                  color:
                    c.total === 0
                      ? "var(--text-dim)"
                      : c.recorded === c.total
                        ? "var(--amber)"
                        : "var(--text)",
                }}
              >
                {c.recorded}/{c.total}
              </td>
              <td className="faint">{c.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  range,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  range?: string;
  accent?: boolean;
}) {
  return (
    <div className="card" style={{ textAlign: "center" }}>
      <div
        style={{
          fontSize: "1.7rem",
          fontWeight: 700,
          color: accent ? "var(--amber)" : "var(--text)",
        }}
      >
        {value}
      </div>
      <div className="faint">{label}</div>
      {sub && <div className="faint">{sub}</div>}
      {range && <div className="faint">could be {range}</div>}
    </div>
  );
}

function Dimension({ d }: { d: DimensionReport }) {
  const [open, setOpen] = useState(false);
  const total = d.segments.reduce((n, s) => n + s.trials, 0);

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h2>{d.label}</h2>
        <span className="faint">{d.question}</span>
        <div style={{ flex: 1 }} />
        {d.segments.length > 0 && (
          <button
            className="btn-ghost"
            style={{ padding: "3px 10px", fontSize: "0.7rem" }}
            onClick={() => setOpen(!open)}
          >
            {open ? "Hide breakdown" : "Show breakdown"}
          </button>
        )}
      </div>

      <div
        className="card"
        style={{
          marginTop: 8,
          borderColor: d.finding.actionable ? "var(--amber-dim)" : "var(--border)",
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
          <ConfidenceTag c={d.finding.confidence} />
          <span className="faint">
            {total} call{total === 1 ? "" : "s"} measured on {d.metricLabel}
            {d.missing > 0 && ` · ${d.missing} skipped (field not recorded)`}
          </span>
        </div>
        <div
          style={{
            fontWeight: 700,
            color: d.finding.actionable ? "var(--amber)" : "var(--text)",
          }}
        >
          {d.finding.headline}
        </div>
        <div className="faint" style={{ marginTop: 4, lineHeight: 1.5 }}>
          {d.finding.detail}
        </div>

        {open && d.segments.length > 0 && (
          <table style={{ marginTop: 14 }}>
            <thead>
              <tr>
                <th>{d.label}</th>
                <th>Calls</th>
                <th>{d.metricLabel}</th>
                <th>Rate</th>
                <th>Could really be</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {d.segments.map((s: Segment) => (
                <tr key={s.key}>
                  <td style={{ fontWeight: 600 }}>{s.label}</td>
                  <td>{s.trials}</td>
                  <td>{s.successes}</td>
                  <td style={{ color: "var(--amber)", fontWeight: 600 }}>{pct(s.rate)}</td>
                  <td className="faint">
                    {pct(s.low)}–{pct(s.high)}
                  </td>
                  <td>
                    <ConfidenceTag c={s.confidence} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
