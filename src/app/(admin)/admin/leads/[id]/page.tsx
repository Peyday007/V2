"use client";

import { useCallback, useEffect, useState } from "react";
import { use } from "react";
import Link from "next/link";
import EventHistory from "@/components/EventHistory";
import { STAGE_LABELS } from "@/lib/stages";

type Rel<T> = T | T[] | null;

type Call = {
  id: string;
  outcome: string;
  reached_dm: boolean;
  notes: string | null;
  details: Record<string, string> | null;
  next_step: string | null;
  spoke_with_role: string | null;
  duration_seconds: number | null;
  attempt_number: number | null;
  created_at: string;
  callers: Rel<{ name: string }>;
};

type Detail = {
  lead: Record<string, unknown>;
  calls: Call[];
  contacts: {
    id: string;
    full_name: string | null;
    title: string | null;
    direct_phone: string | null;
    email: string | null;
    contact_source: string;
  }[];
  callbacks: {
    scheduled_for: string;
    status: string | null;
    reason: string | null;
    requested_by_name: string | null;
    callers: Rel<{ name: string }>;
  }[];
  appointments: Record<string, unknown>[];
  objections: { objection_key: string; objection_label: string | null; created_at: string }[];
  packet: { status: string; packets: Rel<{ name: string; status: string; callers: Rel<{ name: string }> }> } | null;
  warnings: string[];
};

type Dossier = {
  status: string;
  people: string[];
  theirSituation: string[];
  statedProblems: string[];
  pitched: string[];
  resistance: string[];
  promises: string[];
  commitments: string[];
  gaps: string[];
  hasSubstance: boolean;
};

function one<T>(rel: Rel<T>): T | null {
  return Array.isArray(rel) ? (rel[0] ?? null) : rel;
}

const s = (v: unknown): string | null => {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return null;
};

export default function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/leads/${id}/detail`);
    const j = await res.json();
    if (!res.ok) {
      setError(j.error || "Could not load this lead.");
      return;
    }
    setD(j);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>
        {error}
      </div>
    );
  }
  if (!d) return <p className="muted">Loading…</p>;

  const lead = d.lead;
  const packet = one(d.packet?.packets ?? null);
  const holder = packet ? one(packet.callers) : null;

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      <Link href="/" className="faint">
        ← Back to the board
      </Link>

      <div style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap", marginTop: 10 }}>
        <h1>{s(lead.business_name) || "(no name)"}</h1>
        {s(lead.pipeline_stage) && (
          <span className="tag-dim">
            {STAGE_LABELS[s(lead.pipeline_stage) as keyof typeof STAGE_LABELS] ||
              s(lead.pipeline_stage)}
          </span>
        )}
        {lead.do_not_call === true && (
          <span className="tag-dim" style={{ color: "var(--red)" }}>
            Do not call
          </span>
        )}
      </div>

      <p className="faint" style={{ marginBottom: 4 }}>
        {[s(lead.address), s(lead.city), s(lead.state)].filter(Boolean).join(", ")}
        {s(lead.industry) && ` · ${s(lead.industry)}`}
        {lead.rating != null && ` · ★ ${lead.rating} (${s(lead.review_count) || 0} reviews)`}
      </p>
      <p style={{ marginBottom: 18 }}>
        {s(lead.phone) && (
          <a href={`tel:${s(lead.phone)}`} style={{ fontSize: "1.2rem", fontWeight: 700 }}>
            {s(lead.phone)}
          </a>
        )}
        {s(lead.website) && (
          <>
            {" · "}
            <a href={s(lead.website)!} target="_blank" rel="noreferrer">
              website ↗
            </a>
          </>
        )}
        {packet && (
          <span className="faint">
            {" · "}with {holder?.name || "a caller"} in {packet.name}
          </span>
        )}
      </p>

      {d.warnings.length > 0 && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          {d.warnings.map((w, i) => (
            <div key={i} style={{ color: "var(--red)", fontSize: "0.82rem" }}>
              {w}
            </div>
          ))}
        </div>
      )}

      <Relationship id={id} />

      {/* ------------------------------ what we know ----------------------------- */}
      <h2 style={{ margin: "28px 0 10px" }}>What we know about them</h2>
      <div className="card" style={{ marginBottom: 20 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 10,
          }}
        >
          {[
            ["Owner", [s(lead.owner_name), s(lead.owner_title)].filter(Boolean).join(", ")],
            ["Owner email", s(lead.owner_email)],
            ["Gatekeeper", s(lead.gatekeeper_name)],
            ["Other decision maker", s(lead.other_decision_maker)],
            ["Direct number", s(lead.direct_number)],
            ["Extension", s(lead.extension)],
            [
              "Best time to call",
              [s(lead.best_call_day), s(lead.best_call_time)].filter(Boolean).join(" "),
            ],
            ["How calls are answered", s(lead.answering_setup)],
            ["Existing provider", s(lead.existing_provider)],
            ["Office staff", s(lead.office_staff_count)],
            ["After hours", s(lead.after_hours_process)],
            ["Independent or franchise", s(lead.ownership_type)],
            ["Attempts so far", s(lead.attempt_count)],
            ["Last objection", s(lead.last_objection)],
          ]
            .filter(([, v]) => !!v)
            .map(([label, value]) => (
              <div key={label as string}>
                <div className="faint">{label}</div>
                <div style={{ fontSize: "0.9rem" }}>{value}</div>
              </div>
            ))}
        </div>
        {s(lead.company_notes) && (
          <p style={{ marginTop: 12, fontSize: "0.88rem", lineHeight: 1.6 }}>
            {s(lead.company_notes)}
          </p>
        )}
        {s(lead.notes) && (
          <p style={{ marginTop: 8, fontSize: "0.88rem", lineHeight: 1.6 }}>{s(lead.notes)}</p>
        )}
      </div>

      {/* -------------------------------- diary --------------------------------- */}
      {(d.appointments.length > 0 || d.callbacks.length > 0) && (
        <>
          <h2 style={{ marginBottom: 10 }}>In the diary</h2>
          <div className="card" style={{ marginBottom: 20, display: "grid", gap: 8 }}>
            {d.appointments.map((a, i) => (
              <div key={i} style={{ fontSize: "0.88rem" }}>
                <strong style={{ color: "var(--amber)" }}>Meeting</strong>{" "}
                {new Date(String(a.scheduled_for)).toLocaleString()}
                {s(a.decision_maker_name) && ` with ${s(a.decision_maker_name)}`}
                {s(a.attendance_status) && s(a.attendance_status) !== "scheduled" && (
                  <span className="faint"> · {s(a.attendance_status)?.replace(/_/g, " ")}</span>
                )}
                {s(a.pain_point) && <div className="faint">Pain point: {s(a.pain_point)}</div>}
                {s(a.product) && <div className="faint">Discussed: {s(a.product)}</div>}
              </div>
            ))}
            {d.callbacks.map((cb, i) => (
              <div key={i} style={{ fontSize: "0.88rem" }}>
                <strong>Callback</strong> {new Date(cb.scheduled_for).toLocaleString()}
                <span className="faint">
                  {" "}
                  · {cb.status || "pending"}
                  {cb.requested_by_name && ` · asked for by ${cb.requested_by_name}`}
                </span>
                {cb.reason && <div className="faint">{cb.reason}</div>}
              </div>
            ))}
          </div>
        </>
      )}

      {/* ------------------------------- contacts ------------------------------- */}
      {d.contacts.length > 0 && (
        <>
          <h2 style={{ marginBottom: 10 }}>Contacts on file</h2>
          <div className="card" style={{ marginBottom: 20 }}>
            {d.contacts.map((c) => (
              <div key={c.id} style={{ fontSize: "0.88rem", marginBottom: 4 }}>
                {c.full_name || "(unknown)"}
                {c.title ? ` — ${c.title}` : ""}
                {c.direct_phone ? ` · ${c.direct_phone}` : ""}
                {c.email ? ` · ${c.email}` : ""}
                <span className="faint"> [{c.contact_source.replace(/_/g, " ")}]</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ---------------------------- every conversation ------------------------ */}
      <h2 style={{ marginBottom: 10 }}>Every conversation ({d.calls.length})</h2>
      {d.calls.length === 0 ? (
        <p className="muted" style={{ marginBottom: 20 }}>
          Nobody has called them yet.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 10, marginBottom: 24 }}>
          {d.calls.map((c) => (
            <CallCard key={c.id} c={c} />
          ))}
        </div>
      )}

      <EventHistory filter={{ lead_id: id }} limit={60} title="Full history" />
    </div>
  );
}

function CallCard({ c }: { c: Call }) {
  const caller = one(c.callers);
  const details = c.details || {};
  const shown = Object.entries(details).filter(
    ([k, v]) => v && k !== "note" && String(v).trim().length > 0
  );

  return (
    <div className="card">
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ color: c.reached_dm ? "var(--amber)" : "var(--text)" }}>
          {c.outcome.replace(/_/g, " ")}
        </strong>
        <span className="faint">
          {new Date(c.created_at).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
          {caller?.name && ` · ${caller.name}`}
          {c.attempt_number && ` · attempt ${c.attempt_number}`}
          {c.spoke_with_role && c.spoke_with_role !== "unknown" && ` · spoke with ${c.spoke_with_role}`}
          {c.duration_seconds ? ` · ${c.duration_seconds}s` : ""}
        </span>
      </div>

      {c.next_step && (
        <div style={{ color: "var(--amber)", fontSize: "0.88rem", marginTop: 6 }}>
          Next step: {c.next_step}
        </div>
      )}
      {c.notes && (
        <p style={{ fontSize: "0.88rem", lineHeight: 1.6, marginTop: 6 }}>{c.notes}</p>
      )}

      {shown.length > 0 && (
        <div
          style={{
            marginTop: 8,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 6,
          }}
        >
          {shown.map(([k, v]) => (
            <div key={k} className="faint">
              {k.replace(/_/g, " ")}: <span style={{ color: "var(--text)" }}>{String(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* --------------------------- client relationship -------------------------- */

function Relationship({ id }: { id: string }) {
  const [data, setData] = useState<{
    dossier: Dossier;
    analysis: string | null;
    analysisError: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/leads/${id}/relationship`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Could not read the relationship.");
        return j;
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  if (error) {
    return (
      <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>
        {error}
      </div>
    );
  }
  if (!data) return <p className="muted">Reading the relationship…</p>;

  const d = data.dossier;
  const blocks: [string, string[]][] = [
    ["People we have spoken to", d.people],
    ["How they run calls today", d.theirSituation],
    ["Problems they have stated", d.statedProblems],
    ["What we have pitched", d.pitched],
    ["Pushback heard", d.resistance],
    ["What we said we would do", d.promises],
    ["Already in the diary", d.commitments],
  ].filter(([, v]) => v.length > 0) as [string, string[]][];

  return (
    <div>
      <h2 style={{ marginBottom: 4 }}>Client relationship</h2>
      <p className="faint" style={{ marginBottom: 12 }}>
        Assembled from the record — every call, outcome form, callback and
        meeting. Nothing here is inferred.
      </p>

      <div className="card" style={{ borderColor: "var(--amber-dim)", marginBottom: 14 }}>
        <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--amber)" }}>
          {d.status}
        </div>

        {blocks.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 14,
              marginTop: 14,
            }}
          >
            {blocks.map(([title, lines]) => (
              <div key={title}>
                <div className="faint" style={{ fontWeight: 700, marginBottom: 4 }}>
                  {title}
                </div>
                {lines.map((l, i) => (
                  <div key={i} style={{ fontSize: "0.86rem", lineHeight: 1.5 }}>
                    · {l}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {d.gaps.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 700, fontSize: "0.86rem", color: "var(--red)" }}>
              What we still do not know
            </div>
            {d.gaps.map((g, i) => (
              <div key={i} className="faint" style={{ lineHeight: 1.5 }}>
                · {g}
              </div>
            ))}
          </div>
        )}
      </div>

      {data.analysis ? (
        <div className="card">
          <h3 style={{ marginBottom: 8, color: "var(--amber)" }}>The read</h3>
          <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.65, fontSize: "0.9rem" }}>
            {data.analysis}
          </p>
          <p className="faint" style={{ marginTop: 10 }}>
            Written from the record above and nothing else.
          </p>
        </div>
      ) : (
        data.analysisError && (
          <div className="card">
            <p className="faint" style={{ lineHeight: 1.6 }}>
              {data.analysisError}
            </p>
          </div>
        )
      )}
    </div>
  );
}
