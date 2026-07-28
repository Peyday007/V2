"use client";

import { useEffect, useState } from "react";

type Caller = {
  id: string;
  name: string;
  pin: string;
  active: boolean;
  created_at: string;
};

export default function CallersAdmin() {
  const [callers, setCallers] = useState<Caller[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch("/api/callers");
    setCallers(await res.json());
  }
  useEffect(() => {
    load();
  }, []);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    await fetch("/api/callers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setName("");
    setBusy(false);
    load();
  }

  async function toggle(c: Caller) {
    await fetch(`/api/callers/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !c.active }),
    });
    load();
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 20 }}>Callers</h1>

      <div className="card" style={{ marginBottom: 20, display: "flex", gap: 8 }}>
        <input
          placeholder="New caller name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn" onClick={add} disabled={busy || !name.trim()}>
          Add
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>PIN</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {callers.map((c) => (
            <tr key={c.id} style={{ opacity: c.active ? 1 : 0.5 }}>
              <td style={{ fontWeight: 600 }}>{c.name}</td>
              <td>
                <code
                  style={{
                    background: "var(--bg-hover)",
                    padding: "2px 8px",
                    borderRadius: 4,
                    letterSpacing: "0.15em",
                  }}
                >
                  {c.pin}
                </code>
              </td>
              <td>
                {c.active ? (
                  <span className="tag">Active</span>
                ) : (
                  <span className="tag-dim">Revoked</span>
                )}
              </td>
              <td style={{ textAlign: "right" }}>
                <button
                  className={c.active ? "btn-danger" : "btn-ghost"}
                  onClick={() => toggle(c)}
                  style={{ padding: "4px 12px" }}
                >
                  {c.active ? "Revoke" : "Reactivate"}
                </button>
              </td>
            </tr>
          ))}
          {callers.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No callers yet. Add one above — they sign in at /dial with their PIN.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <Profiles />
    </div>
  );
}

const SEVERITY_COLOR: Record<string, string> = {
  info: "var(--text-dim)",
  positive: "var(--amber)",
  attention: "var(--amber)",
  serious: "var(--red)",
};

const VERDICT_LABEL: Record<string, string> = {
  strong: "ahead of the team",
  weak: "behind the team",
  on_par: "in line with the team",
  not_enough_data: "not enough calls yet",
};

const VERDICT_COLOR: Record<string, string> = {
  strong: "var(--amber)",
  weak: "var(--red)",
  on_par: "var(--text)",
  not_enough_data: "var(--text-dim)",
};

type Skill = {
  key: string;
  label: string;
  meaning: string;
  successes: number;
  trials: number;
  rate: number;
  teamRate: number | null;
  verdict: string;
};

type Profile = {
  callerName: string;
  headline: string;
  calls: number;
  daysActive: number;
  callsPerActiveDay: number;
  ownerConversations: number;
  appointments: number;
  medianDurationSeconds: number | null;
  intelCaptureRate: number | null;
  objectionsHandled: number;
  objectionsSurvived: number;
  skills: Skill[];
  industries: {
    industry: string;
    calls: number;
    ownerConversations: number;
    rate: number;
    teamRate: number | null;
    verdict: string;
  }[];
  recommendations: { key: string; action: string; evidence: string; severity: string }[];
  routeToIndustries: string[];
};

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * What each caller is actually good at. Split into the skills the job really
 * consists of, because a single conversion rate hides whether someone is
 * losing calls at the gatekeeper or losing them at the close.
 */
function Profiles() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/callers/profiles")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Could not build profiles.");
        return j.profiles as Profile[];
      })
      .then(setProfiles)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div style={{ marginTop: 40 }}>
      <h2 style={{ marginBottom: 6 }}>How each caller is doing</h2>
      <p className="faint" style={{ marginBottom: 18, lineHeight: 1.6 }}>
        Every comparison is against the rest of the team over the same calls, and
        every one is significance-tested. Praise needs p &lt; 0.05; criticism needs
        p &lt; 0.01 — a harder bar, because acting on it costs someone their job.
        Where the calls do not support a judgement, it says so instead of guessing.
      </p>

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>
          {error}
        </div>
      )}
      {!profiles && !error && <p className="muted">Reading the calls…</p>}
      {profiles?.length === 0 && (
        <p className="muted">No calls logged yet, so there is nothing to profile.</p>
      )}

      <div style={{ display: "grid", gap: 14 }}>
        {(profiles || []).map((p) => (
          <div key={p.callerName} className="card">
            <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <h3 style={{ fontSize: "1.05rem" }}>{p.callerName}</h3>
              <span style={{ color: "var(--amber)", fontWeight: 600, fontSize: "0.85rem" }}>
                {p.headline}
              </span>
            </div>

            <div className="faint" style={{ marginTop: 4 }}>
              {p.calls} calls over {p.daysActive} day{p.daysActive === 1 ? "" : "s"} ·{" "}
              {p.callsPerActiveDay} a day · {p.ownerConversations} owner conversations ·{" "}
              {p.appointments} appointments
              {p.medianDurationSeconds !== null &&
                ` · typically ${p.medianDurationSeconds}s on the phone`}
              {p.intelCaptureRate !== null &&
                ` · notes something new on ${pct(p.intelCaptureRate)} of calls`}
            </div>

            {/* skills */}
            <table style={{ marginTop: 14 }}>
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Them</th>
                  <th>Rest of team</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {p.skills.map((s) => (
                  <tr key={s.key}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{s.label}</div>
                      <div className="faint">{s.meaning}</div>
                    </td>
                    <td>
                      {s.trials > 0 ? (
                        <>
                          {pct(s.rate)}{" "}
                          <span className="faint">
                            ({s.successes}/{s.trials})
                          </span>
                        </>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="faint">
                      {s.teamRate === null ? "—" : pct(s.teamRate)}
                    </td>
                    <td style={{ color: VERDICT_COLOR[s.verdict], fontWeight: 600 }}>
                      {VERDICT_LABEL[s.verdict]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* industries */}
            {p.industries.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <h3 style={{ marginBottom: 6 }}>By trade</h3>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {p.industries.map((i) => (
                    <span
                      key={i.industry}
                      className="tag-dim"
                      style={{ color: VERDICT_COLOR[i.verdict] }}
                      title={`${i.ownerConversations}/${i.calls} reached an owner${
                        i.teamRate !== null ? `; rest of team ${pct(i.teamRate)}` : ""
                      }`}
                    >
                      {i.industry} {pct(i.rate)} ({i.calls})
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* recommendations */}
            <div style={{ marginTop: 14 }}>
              <h3 style={{ marginBottom: 8 }}>What to do</h3>
              <div style={{ display: "grid", gap: 10 }}>
                {p.recommendations.map((r, i) => (
                  <div key={i}>
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: "0.88rem",
                        color: SEVERITY_COLOR[r.severity],
                      }}
                    >
                      {r.severity === "serious" && "⚠ "}
                      {r.action}
                    </div>
                    <div className="faint" style={{ lineHeight: 1.5, marginTop: 2 }}>
                      {r.evidence}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {p.routeToIndustries.length > 0 && (
              <p className="faint" style={{ marginTop: 12 }}>
                New packets for {p.callerName} are already being weighted toward{" "}
                <strong>{p.routeToIndustries.join(", ")}</strong>.
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
