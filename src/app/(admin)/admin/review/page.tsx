"use client";

import { useCallback, useEffect, useState } from "react";
import { ESCALATION_LABEL, type EscalationReason } from "@/lib/aiAuthority";
import { FIELD_LABEL } from "@/lib/callAnalysis";

type Disagreement = {
  field: string;
  label: string;
  human: unknown;
  ai: unknown;
  material: boolean;
};

type Row = {
  id: string;
  call_id: string;
  lead_id: string | null;
  authority: string;
  transcript_confidence: number | null;
  applied_result: Record<string, unknown> | null;
  transcript_result: Record<string, unknown> | null;
  ai_result: Record<string, unknown> | null;
  held_fields: { field: string; reason: string }[];
  disagreements: Disagreement[];
  review_reasons: string[];
  created_at: string;
  leads?: { business_name: string } | { business_name: string }[] | null;
  callers?: { name: string } | { name: string }[] | null;
};

type Blocked = {
  id: string;
  call_id: string | null;
  action: string;
  rationale: string | null;
  created_at: string;
  leads?: { business_name: string } | { business_name: string }[] | null;
};

type Payload = {
  queue: Row[];
  blocked: Blocked[];
  load: string;
  weekTotal: number;
  weekEscalated: number;
  error: string | null;
};

const ACTION_LABEL: Record<string, string> = {
  release_do_not_call: "Lift a do-not-call",
  change_price_or_discount: "Change a price or discount",
  change_script_or_prompt: "Change the script",
  send_message_to_prospect: "Message the prospect",
  judge_or_dismiss_a_caller: "Judge a caller",
  change_consent_behaviour: "Change consent behaviour",
};

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

export default function ReviewPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/review");
    setData(await res.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(id: string, verdict: "agreed" | "corrected") {
    setBusy(id);
    await fetch(`/api/review/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict }),
    });
    setBusy(null);
    setMsg(verdict === "agreed" ? "Marked as read correctly." : "Marked as corrected.");
    load();
  }

  async function decideAction(id: string, decision: "approved" | "rejected") {
    setBusy(id);
    await fetch("/api/review/blocked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision }),
    });
    setBusy(null);
    load();
  }

  if (!data) return <p className="muted">Loading…</p>;

  return (
    <div style={{ maxWidth: 980, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>Review</h1>
      <p className="faint" style={{ marginBottom: 12, lineHeight: 1.6 }}>
        The AI reads every call and its reading is <strong>applied</strong> — nobody
        confirms it. This page is only what it could not settle on its own.
      </p>
      <p className="faint" style={{ marginBottom: 20, lineHeight: 1.6 }}>
        {data.load} Calls land here when the transcript was too thin to be sure,
        when the model contradicts the caller on something that matters, when
        somebody asked not to be called — and a small random slice whatever the
        confidence, because otherwise there is no way to tell whether the model
        is any good.
      </p>

      {data.error && (
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 16 }}>
          {data.error}
        </div>
      )}
      {msg && (
        <div className="card" style={{ borderColor: "var(--amber-dim)", color: "var(--amber)", marginBottom: 16 }}>
          {msg}
        </div>
      )}

      {/* ------------------------ things it refused to do ------------------- */}
      {data.blocked.length > 0 && (
        <div style={{ marginBottom: 26 }}>
          <h2 style={{ marginBottom: 6 }}>Waiting on you ({data.blocked.length})</h2>
          <p className="faint" style={{ marginBottom: 10, lineHeight: 1.55 }}>
            The model asked to do these and was refused. They are on the
            never-automatic list — no confidence score makes them safe — so they
            happen because you say so, or not at all.
          </p>
          <div style={{ display: "grid", gap: 10 }}>
            {data.blocked.map((b) => (
              <div key={b.id} className="card" style={{ borderColor: "var(--red)" }}>
                <strong style={{ color: "var(--red)" }}>
                  {ACTION_LABEL[b.action] || b.action.replace(/_/g, " ")}
                </strong>
                <span className="faint" style={{ marginLeft: 8 }}>
                  {one(b.leads)?.business_name ?? "unknown business"}
                </span>
                {b.rationale && (
                  <p className="faint" style={{ marginTop: 4, lineHeight: 1.5 }}>
                    {b.rationale}
                  </p>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button
                    className="btn"
                    disabled={busy === b.id}
                    onClick={() => decideAction(b.id, "approved")}
                  >
                    Approve
                  </button>
                  <button
                    className="btn-ghost"
                    disabled={busy === b.id}
                    onClick={() => decideAction(b.id, "rejected")}
                  >
                    No
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ------------------------------ the queue --------------------------- */}
      <h2 style={{ marginBottom: 10 }}>Calls to look at ({data.queue.length})</h2>
      {data.queue.length === 0 ? (
        <p className="muted">
          Nothing needs a look. Every call this week was read and applied on its own.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {data.queue.map((r) => {
            const lead = one(r.leads);
            const caller = one(r.callers);
            const applied = r.applied_result || {};
            return (
              <div key={r.id} className="card">
                <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  <strong>{lead?.business_name ?? "Unknown business"}</strong>
                  {caller?.name && <span className="tag-dim">{caller.name}</span>}
                  <span className="tag-dim">{new Date(r.created_at).toLocaleString()}</span>
                  {r.transcript_confidence !== null && (
                    <span className="tag-dim">
                      confidence {Math.round(r.transcript_confidence * 100)}%
                    </span>
                  )}
                  <span className="tag-dim">{r.authority === "ai" ? "AI decided" : r.authority}</span>
                </div>

                <p style={{ marginTop: 5, color: "var(--amber)", lineHeight: 1.5 }}>
                  {r.review_reasons
                    .map((x) => ESCALATION_LABEL[x as EscalationReason] ?? x)
                    .join(". ")}
                  .
                </p>

                {r.disagreements.length > 0 && (
                  <table style={{ marginTop: 10 }}>
                    <thead>
                      <tr>
                        <th>Field</th>
                        <th>Caller said</th>
                        <th>Model heard</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.disagreements.map((d) => (
                        <tr key={d.field}>
                          <td style={{ color: d.material ? "var(--amber)" : undefined }}>
                            {d.label}
                            {d.material && " *"}
                          </td>
                          <td className="faint">{show(d.human)}</td>
                          <td>
                            <strong>{show(d.ai)}</strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {r.held_fields?.length > 0 && (
                  <p className="faint" style={{ marginTop: 8, lineHeight: 1.5 }}>
                    Not taken from the model:{" "}
                    {r.held_fields
                      .map((h) => `${FIELD_LABEL[h.field] ?? h.field} (${h.reason})`)
                      .join("; ")}
                  </p>
                )}

                <p className="faint" style={{ marginTop: 8, lineHeight: 1.55 }}>
                  <strong>Applied:</strong> reached{" "}
                  {show(applied.personReached)} · owner {show(applied.ownerReached)} ·
                  meeting {show(applied.meetingStatus)} · interest{" "}
                  {show(applied.interestLevel)}
                  {applied.coachingPoint ? ` · coaching: ${applied.coachingPoint}` : ""}
                </p>

                <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                  <button
                    className="btn"
                    disabled={busy === r.id}
                    onClick={() => decide(r.id, "agreed")}
                  >
                    Read it right
                  </button>
                  <button
                    className="btn-ghost"
                    disabled={busy === r.id}
                    onClick={() => decide(r.id, "corrected")}
                  >
                    Got it wrong
                  </button>
                  {r.lead_id && (
                    <a className="btn-ghost" href={`/admin/leads/${r.lead_id}`}>
                      Open the lead
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
