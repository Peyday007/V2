"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// The operator's Workshop section.
//
// It answers the questions nobody could answer without opening database
// tables: who got one, what was in theirs, did they read it, what did they
// press, what did they tell us, and what should somebody do about it today.
//
// Behind the admin passphrase via the middleware, like every other admin page.
// The one rule this screen must not break: opening a prospect's workshop to
// check it must not look like the prospect opening it. The preview link below
// carries ?preview=1 and the API records those events separately, so an
// operator reading a page can never inflate an engagement number.

type Row = Record<string, unknown> & {
  id: string;
  token: string;
  status: string;
  statusLabel: string;
  leads?: { business_name?: string; city?: string; state?: string } | null;
};

type VariantReport = {
  variant: string;
  delivered: number;
  opened: number;
  interested: number;
  auditCompleted: number;
  privateBuildRequested: number;
  walkthroughRequested: number;
  converted: number;
  openRate: number | null;
  interestRate: number | null;
  conversionRate: number | null;
  lowSample: boolean;
  caveat: string | null;
};

type ListResponse = {
  legacy: boolean;
  totals: Record<string, number>;
  variants: VariantReport[];
  rows: Row[];
  error: string | null;
};

type Detail = {
  packet: Record<string, unknown>;
  lead: Record<string, unknown>;
  statusLabel: string;
  nextAction: string;
  opportunities: Record<string, unknown>[];
  bottleneck: Record<string, unknown>[];
  auditComplete: boolean;
  map: Record<string, unknown>[];
  timeline: Record<string, unknown>[];
  previewTimeline: Record<string, unknown>[];
  versions: Record<string, unknown>[];
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "attention", label: "Needs you" },
  { id: "interested", label: "Interested" },
  { id: "engaged", label: "Engaged" },
  { id: "sent", label: "Sent, not opened" },
] as const;

export default function WorkshopAdminPage() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("attention");
  const [query, setQuery] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/workshops");
    const j = await res.json();
    if (!res.ok) {
      setErr(j.error || "Could not load workshops.");
      return;
    }
    setData(j);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = useCallback(async (token: string) => {
    const res = await fetch(`/api/workshops?token=${encodeURIComponent(token)}`);
    if (res.ok) setDetail(await res.json());
  }, []);

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const q = query.trim().toLowerCase();
    return all.filter((r) => {
      if (q) {
        const name = String(r.leads?.business_name ?? "").toLowerCase();
        const owner = String(r.owner_name ?? "").toLowerCase();
        if (!name.includes(q) && !owner.includes(q)) return false;
      }
      switch (filter) {
        case "attention":
          return (
            (r.interested_at || r.demo_requested_at || r.walkthrough_requested_at ||
              r.trial_requested_at) && !r.follow_up_done_at
          );
        case "interested":
          return !!(r.interested_at || r.trial_requested_at);
        case "engaged":
          return r.status === "engaged";
        case "sent":
          return !!r.sent_at && !r.first_opened_at && !r.opened_at;
        default:
          return true;
      }
    });
  }, [data, filter, query]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    await fetch("/api/workshops", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    await load();
    if (detail) await openDetail(String(detail.packet.token));
  }

  if (err) {
    return (
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <h1>Workshops</h1>
        <div className="card" style={{ borderColor: "var(--red)", lineHeight: 1.7 }}>
          {err}
        </div>
      </div>
    );
  }

  const t = data?.totals ?? {};

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 4 }}>Workshops</h1>
      <p className="faint" style={{ marginTop: 0, lineHeight: 1.6 }}>
        Every assessment sent, what the prospect did with it, and what needs doing now.
      </p>

      {data?.legacy && (
        <div className="card" style={{ borderColor: "var(--amber)", lineHeight: 1.7, marginBottom: 16 }}>
          Running against the old schema. Run{" "}
          <code>supabase/migrations/0045_workshop_assessment.sql</code> to enable findings,
          the bottleneck audit, event tracking and variants. Existing links keep working
          either way.
        </div>
      )}

      {/* ------------------------------- totals ------------------------------ */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <Stat label="Created" value={t.created ?? 0} />
        <Stat label="Sent" value={t.sent ?? 0} />
        <Stat label="Opened" value={t.opened ?? 0} />
        <Stat label="Interested" value={t.interested ?? 0} warn={false} />
        <Stat label="Audits done" value={t.auditsCompleted ?? 0} />
        <Stat label="Private builds" value={t.demoRequested ?? 0} />
        <Stat label="Walkthroughs" value={t.walkthroughRequested ?? 0} />
        <Stat label="Converted" value={t.converted ?? 0} />
        <Stat label="Needs you" value={t.needsAttention ?? 0} warn={(t.needsAttention ?? 0) > 0} />
      </div>

      {/* ------------------------------ variants ----------------------------- */}
      {(data?.variants?.length ?? 0) > 0 && (
        <details style={{ marginBottom: 20 }} className="card">
          <summary style={{ cursor: "pointer" }}>Performance by variant</summary>
          <table style={{ width: "100%", marginTop: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr className="faint" style={{ textAlign: "left", fontSize: "0.85rem" }}>
                <th>Variant</th>
                <th>Delivered</th>
                <th>Opened</th>
                <th>Interested</th>
                <th>Converted</th>
                <th>Open %</th>
                <th>Interest %</th>
              </tr>
            </thead>
            <tbody>
              {data!.variants.map((v) => (
                <tr key={v.variant} style={{ borderTop: "1px solid var(--border)" }}>
                  <td>{v.variant}</td>
                  <td>{v.delivered}</td>
                  <td>{v.opened}</td>
                  <td>{v.interested}</td>
                  <td>{v.converted}</td>
                  <td>{v.openRate === null ? "—" : `${v.openRate}%`}</td>
                  <td>{v.interestRate === null ? "—" : `${v.interestRate}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/*
            Raw counts first, percentages second, and a warning when the sample
            cannot carry them. No winner is ever declared — two conversions out
            of five is forty per cent and means nothing.
          */}
          {data!.variants.some((v) => v.lowSample) && (
            <p className="faint" style={{ lineHeight: 1.6, marginTop: 10 }}>
              {data!.variants.find((v) => v.lowSample)!.caveat} Do not pick a winner from
              this yet.
            </p>
          )}
        </details>
      )}

      {/* ------------------------------- filters ----------------------------- */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className="btn-ghost"
            onClick={() => setFilter(f.id)}
            style={{ color: filter === f.id ? "var(--amber)" : undefined }}
          >
            {f.label}
          </button>
        ))}
        <input
          placeholder="Search business or contact"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ marginLeft: "auto", minWidth: 220 }}
        />
      </div>

      {/* -------------------------------- list ------------------------------- */}
      <div style={{ display: "grid", gap: 8 }}>
        {rows.length === 0 && <p className="faint">Nothing matches that filter.</p>}
        {rows.map((r) => {
          const needs = Boolean(
            (r.interested_at || r.demo_requested_at || r.walkthrough_requested_at ||
              r.trial_requested_at) && !r.follow_up_done_at
          );
          return (
            <div
              key={r.id}
              className="card"
              style={{ borderColor: needs ? "var(--amber)" : "var(--border)" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <strong>{r.leads?.business_name ?? "Unknown business"}</strong>{" "}
                  <span className="faint">
                    {[r.leads?.city, r.leads?.state].filter(Boolean).join(", ")}
                  </span>
                  <div className="faint" style={{ fontSize: "0.85rem" }}>
                    {r.statusLabel}
                    {r.variant ? ` · ${r.variant}` : ""}
                    {r.owner_name ? ` · ${r.owner_name}` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <button className="btn-ghost" onClick={() => openDetail(String(r.token))}>
                    Open
                  </button>
                  {needs && (
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => act({ id: r.id, follow_up_done: true })}
                    >
                      Mark followed up
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ------------------------------- detail ------------------------------ */}
      {detail && (
        <WorkshopDetail
          detail={detail}
          busy={busy}
          onClose={() => setDetail(null)}
          onAct={act}
          onRegenerate={async () => {
            setBusy(true);
            await fetch("/api/workshops", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: detail.packet.id, action: "regenerate" }),
            });
            setBusy(false);
            await openDetail(String(detail.packet.token));
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div>
      <div className="faint" style={{ fontSize: "0.8rem" }}>
        {label}
      </div>
      <div
        style={{
          fontSize: "1.5rem",
          fontWeight: 600,
          color: warn ? "var(--red)" : "var(--amber)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function WorkshopDetail({
  detail,
  busy,
  onClose,
  onAct,
  onRegenerate,
}: {
  detail: Detail;
  busy: boolean;
  onClose: () => void;
  onAct: (body: Record<string, unknown>) => void;
  onRegenerate: () => void;
}) {
  const p = detail.packet;
  const [note, setNote] = useState(String(p.operator_note ?? ""));
  const url =
    typeof window !== "undefined" ? `${window.location.origin}/workshop/${p.token}` : "";

  return (
    <div className="card" style={{ marginTop: 24, borderColor: "var(--amber)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <h2 style={{ marginTop: 0 }}>{String(detail.lead.business_name ?? "")}</h2>
        <button className="btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>

      <p className="faint" style={{ lineHeight: 1.7 }}>
        {detail.statusLabel} · version {String(p.packet_version ?? 1)}
      </p>
      <p style={{ lineHeight: 1.7 }}>
        <strong>Next:</strong> {detail.nextAction}
      </p>

      {/*
        The preview link carries ?preview=1 so the API records the visit
        separately. An operator checking a page must never look like the
        prospect reading it.
      */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <a className="btn-ghost" href={`${url}?preview=1`} target="_blank" rel="noreferrer">
          Preview safely
        </a>
        <button className="btn-ghost" onClick={() => navigator.clipboard?.writeText(url)}>
          Copy link
        </button>
        <button className="btn-ghost" disabled={busy} onClick={onRegenerate}>
          Regenerate findings
        </button>
      </div>

      <Section title={`Findings they were shown (${detail.opportunities.length})`}>
        {detail.opportunities.map((o, i) => (
          <div key={i} style={{ marginBottom: 12 }}>
            <strong>{String(o.title ?? "")}</strong>{" "}
            <span className="faint">
              · {String(o.stage ?? "")} · {String(o.confidence ?? "")} confidence
            </span>
            <div className="faint" style={{ lineHeight: 1.6 }}>
              {String(o.evidence ?? "")}
            </div>
            {/* Internal only. This endpoint is behind the passphrase; the
                public one strips it entirely. */}
            {o.internal_note ? (
              <div style={{ color: "var(--amber)", lineHeight: 1.6 }}>
                Talk track: {String(o.internal_note)}
              </div>
            ) : null}
          </div>
        ))}
      </Section>

      {detail.bottleneck.length > 0 && (
        <Section title="What they told us">
          {detail.bottleneck.map((b, i) => (
            <div key={i} className="faint" style={{ lineHeight: 1.7 }}>
              {String(b.area)} — {String(b.detail ?? "no detail")} ·{" "}
              {String(b.frequency ?? "?")} · affects {String(b.affects ?? "?")}
            </div>
          ))}
        </Section>
      )}

      {detail.map.length > 0 && (
        <Section title="Opportunity map they saw">
          {detail.map.map((m, i) => (
            <div key={i} className="faint" style={{ lineHeight: 1.7 }}>
              [{String(m.band)}] {String(m.heading)}
            </div>
          ))}
        </Section>
      )}

      <Section title={`What they did (${detail.timeline.length})`}>
        {detail.timeline.length === 0 && <p className="faint">Nothing yet.</p>}
        {detail.timeline.slice(0, 40).map((e, i) => (
          <div key={i} className="faint" style={{ lineHeight: 1.7, fontSize: "0.9rem" }}>
            {new Date(String(e.occurred_at)).toLocaleString()} — {String(e.event_type)}
            {e.target ? ` (${String(e.target)})` : ""}
          </div>
        ))}
        {detail.previewTimeline.length > 0 && (
          <p className="faint" style={{ marginTop: 8, fontSize: "0.85rem" }}>
            Plus {detail.previewTimeline.length} admin preview visits, excluded from every
            count above.
          </p>
        )}
      </Section>

      <Section title="Your notes">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          style={{ width: "100%" }}
          placeholder="What you know that the record does not"
        />
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <button className="btn" disabled={busy} onClick={() => onAct({ id: p.id, operator_note: note })}>
            Save note
          </button>
          <button
            className="btn-ghost"
            disabled={busy}
            onClick={() => onAct({ id: p.id, follow_up_done: true })}
          >
            Mark followed up
          </button>
          <button className="btn-ghost" disabled={busy} onClick={() => onAct({ id: p.id, revoke: true })}>
            Revoke link
          </button>
        </div>
      </Section>

      {detail.versions.length > 0 && (
        <Section title="Earlier versions">
          {detail.versions.map((v, i) => (
            <div key={i} className="faint" style={{ lineHeight: 1.7 }}>
              v{String(v.version)} — {String(v.reason ?? "")} ·{" "}
              {new Date(String(v.created_at)).toLocaleString()}
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
      <h3 style={{ marginTop: 0, fontSize: "1rem" }}>{title}</h3>
      {children}
    </div>
  );
}
