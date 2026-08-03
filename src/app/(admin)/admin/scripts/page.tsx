"use client";

import { useCallback, useEffect, useState } from "react";
import { SCRIPT_VERSIONS, buildScript, type ScriptVersion } from "@/lib/gatekeeperScripts";

type Flag = { level: "green" | "yellow" | "red"; message: string };

type Row = {
  version: ScriptVersion;
  name: string;
  dials: number;
  connects: number;
  ownerReaches: number;
  dmConversations: number;
  trialsRequested: number;
  connectRate: number | null;
  gatekeeperPassRate: number | null;
  dmConversationRate: number | null;
  trialRate: number | null;
  flags: Flag[];
};

type Payload = {
  rows: Row[];
  leader: string;
  untagged: number;
  days: number;
  error: string | null;
};

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

const FLAG_COLOUR: Record<Flag["level"], string> = {
  green: "var(--amber-dim)",
  yellow: "var(--amber)",
  red: "var(--red)",
};

export default function ScriptsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [days, setDays] = useState(30);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/script-stats?days=${days}`);
      const j = await res.json();
      setData({
        rows: j.rows ?? [],
        leader: j.leader ?? "",
        untagged: j.untagged ?? 0,
        days: j.days ?? days,
        error: j.error ?? null,
      });
    } catch (e) {
      setData({
        rows: [],
        leader: "",
        untagged: 0,
        days,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) return <p className="muted">Loading…</p>;

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>Gatekeeper scripts</h1>
      <p className="faint" style={{ marginBottom: 16, lineHeight: 1.6 }}>
        Three openers, one job: get past whoever answers, to the owner. They
        differ in exactly one thing each, so a difference in the numbers can be
        attributed to the opener rather than to everything at once.
      </p>

      {data.error && (
        <div
          className="card"
          style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 16, lineHeight: 1.55 }}
        >
          {data.error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 16 }}>
        <span className="faint">Last {data.days} days</span>
        <div style={{ flex: 1 }} />
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            className={d === days ? "btn" : "btn-ghost"}
            style={{ padding: "4px 12px", fontSize: "0.7rem" }}
            onClick={() => setDays(d)}
          >
            {d}d
          </button>
        ))}
      </div>

      {data.untagged > 0 && (
        <p className="faint" style={{ marginBottom: 16, lineHeight: 1.55 }}>
          {data.untagged} call{data.untagged === 1 ? "" : "s"} in this window had no
          script version set, so {data.untagged === 1 ? "it is" : "they are"} not
          counted anywhere below. That is correct — untagged calls are not a
          fourth variant — but a large number here means the picker is being
          skipped on the dialer.
        </p>
      )}

      <p style={{ marginBottom: 20, lineHeight: 1.6 }}>{data.leader}</p>

      {/* ------------------------------ the numbers ------------------------- */}
      <div style={{ display: "grid", gap: 14, marginBottom: 26 }}>
        {data.rows.map((r) => {
          const script = buildScript(r.version, { businessName: "[business]", ownerName: null });
          const worst = r.flags.some((f) => f.level === "red")
            ? "red"
            : r.flags.some((f) => f.level === "yellow")
              ? "yellow"
              : "green";
          return (
            <div
              key={r.version}
              className="card"
              style={{ borderColor: FLAG_COLOUR[worst as Flag["level"]] }}
            >
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <strong style={{ fontSize: "1.05rem" }}>
                  Script {r.version} — {r.name}
                </strong>
                <span className="tag-dim">{r.dials} dials</span>
              </div>
              <p className="faint" style={{ marginTop: 3, lineHeight: 1.5 }}>
                {script.premise}
              </p>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                  gap: 14,
                  marginTop: 14,
                }}
              >
                <Stat label="Connect rate" value={pct(r.connectRate)} note={`${r.connects} answered`} />
                <Stat
                  label="Gatekeeper pass"
                  value={pct(r.gatekeeperPassRate)}
                  note={`${r.ownerReaches} reached the owner`}
                  strong
                />
                <Stat
                  label="DM conversation"
                  value={pct(r.dmConversationRate)}
                  note={`${r.dmConversations} conversations`}
                />
                <Stat
                  label="Trial requested"
                  value={pct(r.trialRate)}
                  note={`${r.trialsRequested} trial${r.trialsRequested === 1 ? "" : "s"}`}
                />
              </div>

              <div style={{ display: "grid", gap: 5, marginTop: 14 }}>
                {r.flags.map((f, i) => (
                  <p
                    key={i}
                    style={{
                      color: FLAG_COLOUR[f.level],
                      lineHeight: 1.5,
                      fontWeight: f.level === "red" ? 700 : 400,
                    }}
                  >
                    {f.level === "red" ? "▲ " : f.level === "yellow" ? "• " : "✓ "}
                    {f.message}
                  </p>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* ------------------------------ the scripts ------------------------- */}
      <h2 style={{ marginBottom: 10 }}>What the callers are reading</h2>
      <div style={{ display: "grid", gap: 12, marginBottom: 40 }}>
        {SCRIPT_VERSIONS.map((v) => {
          const s = buildScript(v, { businessName: "[Business Name]", ownerName: null, callerName: "[you]" });
          return (
            <div key={v} className="card">
              <strong>
                {v} — {s.name}
              </strong>
              <p style={{ marginTop: 8, lineHeight: 1.6 }}>{s.opener}</p>
              <p className="faint" style={{ marginTop: 6, lineHeight: 1.55 }}>
                If pushed: {s.ifPushed}
              </p>
            </div>
          );
        })}
      </div>

      <p className="faint" style={{ marginBottom: 40, lineHeight: 1.6 }}>
        These are raw counts against fixed thresholds — no significance test and
        no model. A flag means <strong>look at this</strong>, never
        &ldquo;change this&rdquo;. Nothing here alters a script on its own.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  note,
  strong,
}: {
  label: string;
  value: string;
  note?: string;
  strong?: boolean;
}) {
  return (
    <div>
      <div
        className="faint"
        style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.08em" }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: strong ? "1.6rem" : "1.25rem",
          fontWeight: 700,
          color: strong ? "var(--amber)" : "var(--text)",
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      {note && (
        <div className="faint" style={{ fontSize: "0.72rem", marginTop: 2 }}>
          {note}
        </div>
      )}
    </div>
  );
}
