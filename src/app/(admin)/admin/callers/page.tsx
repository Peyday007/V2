"use client";

import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "@/components/Confirm";

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

      <Trials callers={callers} />
      <Profiles />
    </div>
  );
}

/* ------------------------------- trials ---------------------------------- */

type TrialPart = {
  key: string;
  label: string;
  meaning: string;
  successes: number;
  trials: number;
  rate: number | null;
  benchmarkRate: number | null;
  status: "settled" | "unsettled" | "unmeasured";
  verdict: "above" | "below" | "on_par" | "unknown";
  note?: string;
};

type Trial = {
  id: string;
  caller_id: string;
  status: string;
  decision: string | null;
  decision_note: string | null;
  target_calls: number;
  started_at: string;
  callers: { id: string; name: string; active: boolean } | null;
  packets: { id: string; name: string; status: string } | null;
  score: {
    callsMade: number;
    targetCalls: number;
    percentComplete: number;
    daysActive: number;
    callsPerActiveDay: number;
    headline: string;
    parts: TrialPart[];
    recommendation: {
      key: string;
      action: string;
      evidence: string;
      unresolved: string[];
    };
  };
};

const VERDICT_TEXT: Record<string, string> = {
  above: "ahead of the team",
  below: "behind the team",
  on_par: "matched the team",
  unknown: "can't tell yet",
};

const REC_COLOR: Record<string, string> = {
  add: "var(--amber)",
  cut: "var(--red)",
  extend: "var(--text)",
  in_progress: "var(--text-dim)",
};

function Trials({ callers }: { callers: Caller[] }) {
  const [trials, setTrials] = useState<Trial[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [who, setWho] = useState("");
  const [size, setSize] = useState("100");
  const [busy, setBusy] = useState<string | null>(null);
  const { ask, dialog } = useConfirm();

  const load = useCallback(async () => {
    const res = await fetch("/api/trials");
    const j = await res.json();
    if (!res.ok) {
      setError(j.error || "Could not load trials.");
      setTrials([]);
      return;
    }
    setError(null);
    setTrials(j.trials);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function start() {
    setBusy("start");
    setMsg("");
    setError(null);
    const res = await fetch("/api/trials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caller_id: who, target_calls: Number(size) }),
    });
    const j = await res.json();
    setBusy(null);
    if (!res.ok) {
      setError(j.error || "Could not start the trial.");
      return;
    }
    const name = callers.find((c) => c.id === who)?.name || "They";
    setMsg(`Trial started. ${j.leads} leads are in ${name}'s dialer now.`);
    load();
  }

  async function decide(t: Trial, decision: "added" | "cut" | "extended") {
    const name = t.callers?.name || "this caller";
    const body: Record<string, string[]> = {};
    const copy: Record<string, { title: string; lines: string[]; label: string; danger: boolean }> = {
      added: {
        title: `Add ${name} to the team?`,
        lines: ["They keep their PIN and carry on dialing. Future packets start playing to their strengths as those emerge."],
        label: "Add them",
        danger: false,
      },
      cut: {
        title: `Cut ${name}?`,
        lines: [
          "Their sign-in is revoked immediately, so they cannot start another call.",
          "Nothing is deleted — every call they made, and everything they learned about those businesses, stays in the system.",
        ],
        label: "Cut them",
        danger: true,
      },
      extended: {
        title: `Give ${name} another 100 calls?`,
        lines: ["The trial keeps running with a higher target. The bar stays frozen where it was, so they are still judged against the same team."],
        label: "Extend it",
        danger: false,
      },
    };
    const c = copy[decision];
    const ok = await ask({
      title: c.title,
      body: c.lines,
      confirmLabel: c.label,
      danger: c.danger,
    });
    if (!ok) return;

    setBusy(t.id);
    const res = await fetch(`/api/trials/${t.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, ...body }),
    });
    const j = await res.json();
    setBusy(null);
    if (!res.ok) setError(j.error || "Could not save that.");
    else setMsg(`Recorded: ${name} — ${decision}.`);
    load();
  }

  const live = (trials || []).filter((t) => t.status === "running" || t.status === "complete");
  const past = (trials || []).filter((t) => t.status === "decided" || t.status === "abandoned");
  const available = callers.filter((c) => !live.some((t) => t.caller_id === c.id));

  return (
    <div style={{ marginTop: 40 }}>
      <h2 style={{ marginBottom: 6 }}>Tryouts</h2>
      <p className="faint" style={{ marginBottom: 16, lineHeight: 1.6 }}>
        Give a candidate a standard packet and see how they do. The leads are
        deliberately <strong>not</strong> weighted toward their strengths, so two
        candidates get the same difficulty. The bar is frozen when the trial
        starts — if the team improves meanwhile, they are still judged against the
        team they actually joined.
      </p>

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 14 }}>
          {error}
        </div>
      )}
      {msg && (
        <div className="card" style={{ borderColor: "var(--amber-dim)", color: "var(--amber)", marginBottom: 14 }}>
          {msg}
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={who} onChange={(e) => setWho(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">Choose a candidate…</option>
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="faint">gets</span>
          <input
            type="number"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            style={{ maxWidth: 80 }}
            min={10}
          />
          <span className="faint">leads to work through</span>
          <button className="btn" onClick={start} disabled={busy === "start" || !who}>
            {busy === "start" ? "Starting…" : "Start tryout"}
          </button>
        </div>
        {available.length === 0 && callers.length > 0 && (
          <p className="faint" style={{ marginTop: 10 }}>
            Everyone active already has a trial running.
          </p>
        )}
      </div>

      {trials === null && <p className="muted">Loading…</p>}

      <div style={{ display: "grid", gap: 14 }}>
        {live.map((t) => (
          <TrialCard key={t.id} t={t} busy={busy === t.id} onDecide={decide} />
        ))}
      </div>

      {past.length > 0 && (
        <>
          <h3 style={{ margin: "22px 0 10px" }}>Past tryouts</h3>
          <table>
            <thead>
              <tr>
                <th>Caller</th>
                <th>Calls</th>
                <th>Outcome</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {past.map((t) => (
                <tr key={t.id}>
                  <td style={{ fontWeight: 600 }}>{t.callers?.name || "—"}</td>
                  <td>
                    {t.score.callsMade}/{t.target_calls}
                  </td>
                  <td
                    style={{
                      color: t.decision === "cut" ? "var(--red)" : "var(--amber)",
                      fontWeight: 600,
                    }}
                  >
                    {t.decision || t.status}
                  </td>
                  <td className="faint">
                    {new Date(t.started_at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {dialog}
    </div>
  );
}

function TrialCard({
  t,
  busy,
  onDecide,
}: {
  t: Trial;
  busy: boolean;
  onDecide: (t: Trial, d: "added" | "cut" | "extended") => void;
}) {
  const s = t.score;
  const done = s.callsMade >= s.targetCalls;

  return (
    <div className="card" style={{ borderColor: done ? "var(--amber-dim)" : "var(--border)" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <h3 style={{ fontSize: "1.05rem" }}>{t.callers?.name || "Candidate"}</h3>
        <span style={{ color: "var(--amber)", fontWeight: 600, fontSize: "0.85rem" }}>
          {s.headline}
        </span>
      </div>

      <div
        style={{
          height: 8,
          background: "var(--bg-inset)",
          borderRadius: 4,
          overflow: "hidden",
          margin: "10px 0 4px",
        }}
      >
        <div
          style={{ width: `${s.percentComplete}%`, height: "100%", background: "var(--amber)" }}
        />
      </div>
      <div className="faint">
        {s.callsMade} of {s.targetCalls} calls · {s.callsPerActiveDay} a day over{" "}
        {s.daysActive} day{s.daysActive === 1 ? "" : "s"}
      </div>

      <table style={{ marginTop: 14 }}>
        <thead>
          <tr>
            <th>Measure</th>
            <th>Them</th>
            <th>Team bar</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {s.parts.map((p) => (
            <tr key={p.key}>
              <td>
                <div style={{ fontWeight: 600 }}>{p.label}</div>
                <div className="faint">{p.meaning}</div>
              </td>
              <td>
                {p.rate === null
                  ? "—"
                  : p.key === "effort"
                    ? `${p.rate.toFixed(1)}/day`
                    : `${Math.round(p.rate * 100)}% (${p.successes}/${p.trials})`}
              </td>
              <td className="faint">
                {p.benchmarkRate === null
                  ? "—"
                  : p.key === "effort"
                    ? `${p.benchmarkRate.toFixed(1)}/day`
                    : `${Math.round(p.benchmarkRate * 100)}%`}
              </td>
              <td
                style={{
                  color:
                    p.status !== "settled"
                      ? "var(--text-dim)"
                      : p.verdict === "below"
                        ? "var(--red)"
                        : p.verdict === "above"
                          ? "var(--amber)"
                          : "var(--text)",
                  fontWeight: 600,
                }}
              >
                {p.status === "settled" ? VERDICT_TEXT[p.verdict] : "not settled"}
                {p.note && (
                  <div className="faint" style={{ fontWeight: 400, marginTop: 2 }}>
                    {p.note}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 700, color: REC_COLOR[s.recommendation.key] }}>
          {s.recommendation.action}
        </div>
        <div className="faint" style={{ lineHeight: 1.55, marginTop: 3 }}>
          {s.recommendation.evidence}
        </div>
        {s.recommendation.unresolved.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="faint" style={{ fontWeight: 700 }}>
              This tryout could not settle:
            </div>
            {s.recommendation.unresolved.map((u, i) => (
              <div key={i} className="faint" style={{ lineHeight: 1.5 }}>
                · {u}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <button className="btn" disabled={busy} onClick={() => onDecide(t, "added")}>
          Add to team
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => onDecide(t, "extended")}>
          Give them another 100
        </button>
        <button className="btn-danger" disabled={busy} onClick={() => onDecide(t, "cut")}>
          Cut
        </button>
      </div>
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
