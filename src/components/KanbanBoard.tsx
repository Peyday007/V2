"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  SALES_STAGES,
  STAGE_LABELS,
  SalesStage,
  DEFAULT_STAGE,
} from "@/lib/stages";
import { DELIVERY_STAGES } from "@/lib/constants";
import { MACHINE_STATUS_LABELS, MachineStatus, IN_FLIGHT } from "@/lib/machineStatus";
import { useLeads, Lead, ContactLite } from "@/hooks/useLeads";

type Pipeline = "sales" | "delivery";

type Deal = {
  id: string;
  name: string;
  stage: string;
  value: number | null;
  notes: string | null;
  created_at: string;
};

export default function KanbanBoard() {
  const [pipeline, setPipeline] = useState<Pipeline>("sales");
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 105px)",
      }}
    >
      {pipeline === "sales" ? (
        <SalesBoard pipeline={pipeline} setPipeline={setPipeline} />
      ) : (
        <DeliveryBoard pipeline={pipeline} setPipeline={setPipeline} />
      )}
    </div>
  );
}

function PipelineSwitch({
  pipeline,
  setPipeline,
}: {
  pipeline: Pipeline;
  setPipeline: (p: Pipeline) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {(["sales", "delivery"] as Pipeline[]).map((p) => (
        <button
          key={p}
          className={p === pipeline ? "btn" : "btn-ghost"}
          onClick={() => setPipeline(p)}
          style={{ padding: "5px 14px" }}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------- SALES ---------------------------------- */

function SalesBoard({
  pipeline,
  setPipeline,
}: {
  pipeline: Pipeline;
  setPipeline: (p: Pipeline) => void;
}) {
  const { leads, contacts, state, reload, applyStageLocally, lastFetchedAt, realtime } =
    useLeads();
  const [dragId, setDragId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<Lead | null>(null);
  const [attack, setAttack] = useState("");
  const [attackLoading, setAttackLoading] = useState(false);
  const [showDnc, setShowDnc] = useState(true);
  const [q, setQ] = useState("");
  const [showDiag, setShowDiag] = useState(false);

  const visible = useMemo(
    () =>
      leads.filter((l) => {
        if (!showDnc && l.do_not_call) return false;
        if (q.trim()) {
          const needle = q.trim().toLowerCase();
          const hay = [l.business_name, l.city, l.state, l.phone, l.industry]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        return true;
      }),
    [leads, showDnc, q]
  );

  const activeFilters = (showDnc ? 0 : 1) + (q.trim() ? 1 : 0);
  const hiddenByFilters = leads.length - visible.length;

  async function moveLead(id: string, stage: SalesStage) {
    applyStageLocally(id, stage);
    const res = await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipeline_stage: stage }),
    });
    if (!res.ok) {
      alert("Could not save that move — reloading the board.");
    }
    reload();
  }

  async function whatToAttack() {
    setAttackLoading(true);
    const res = await fetch("/api/prioritize");
    const j = await res.json();
    setAttack(res.ok ? j.recommendation : j.error || "Failed");
    setAttackLoading(false);
  }

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 14,
          flexShrink: 0,
          flexWrap: "wrap",
        }}
      >
        <h1>Sales Board</h1>
        <PipelineSwitch pipeline={pipeline} setPipeline={setPipeline} />
        <input
          placeholder="Search leads…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ maxWidth: 220 }}
        />
        <label
          className="faint"
          style={{ display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}
        >
          <input
            type="checkbox"
            checked={showDnc}
            onChange={(e) => setShowDnc(e.target.checked)}
            style={{ width: "auto" }}
          />
          show DNC
        </label>
        {activeFilters > 0 && (
          <button
            className="btn-ghost"
            style={{ padding: "4px 10px" }}
            onClick={() => {
              setQ("");
              setShowDnc(true);
            }}
          >
            Clear filters ({activeFilters})
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button
          className="btn-ghost"
          style={{ padding: "5px 10px" }}
          onClick={() => setShowDiag(!showDiag)}
          title="Database diagnostics"
        >
          ⓘ
        </button>
        <button className="btn-ghost" onClick={whatToAttack} disabled={attackLoading}>
          ⚡ {attackLoading ? "Thinking…" : "What to Attack Today"}
        </button>
        <button className="btn" onClick={() => setShowNew(true)}>
          + New Lead
        </button>
      </div>

      {showDiag && (
        <DiagnosticsPanel
          onClose={() => setShowDiag(false)}
          boardCount={leads.length}
          lastFetchedAt={lastFetchedAt}
          realtime={realtime}
        />
      )}

      {attack && (
        <div
          className="card"
          style={{ marginBottom: 14, borderColor: "var(--amber-dim)", flexShrink: 0 }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <h3 style={{ color: "var(--amber)" }}>What to Attack Today</h3>
            <button
              className="btn-ghost"
              style={{ padding: "2px 10px" }}
              onClick={() => setAttack("")}
            >
              ✕
            </button>
          </div>
          <p style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem" }}>{attack}</p>
        </div>
      )}

      {state.status === "error" && (
        <div
          className="card"
          style={{ borderColor: "var(--red)", marginBottom: 14, flexShrink: 0 }}
        >
          <h3 style={{ color: "var(--red)", marginBottom: 6 }}>
            Could not load leads
          </h3>
          <p style={{ fontSize: "0.85rem" }}>{state.message}</p>
          <button className="btn-ghost" style={{ marginTop: 10 }} onClick={reload}>
            Retry
          </button>
        </div>
      )}

      {state.status === "loading" && (
        <p className="muted" style={{ padding: 20 }}>
          Loading leads…
        </p>
      )}

      {state.status === "success_empty" && <EmptyExplainer />}

      {(state.status === "success_with_data" || state.status === "success_empty") && (
        <>
          {hiddenByFilters > 0 && (
            <p className="faint" style={{ marginBottom: 8, flexShrink: 0 }}>
              {hiddenByFilters} lead{hiddenByFilters === 1 ? "" : "s"} hidden by
              filters · {leads.length} total loaded
            </p>
          )}
          <div
            style={{
              display: "flex",
              gap: 14,
              overflowX: "auto",
              flex: 1,
              minHeight: 0,
              paddingBottom: 8,
            }}
          >
            {SALES_STAGES.map((stage) => {
              const inStage = visible.filter((l) => l.pipeline_stage === stage);
              return (
                <Column
                  key={stage}
                  title={STAGE_LABELS[stage]}
                  count={inStage.length}
                  onDrop={() => {
                    if (dragId) moveLead(dragId, stage);
                    setDragId(null);
                  }}
                >
                  {inStage.map((l) => (
                    <LeadCard
                      key={l.id}
                      lead={l}
                      contacts={contacts[l.id] || []}
                      onDragStart={() => setDragId(l.id)}
                      onEdit={() => setEditing(l)}
                      onAdvance={(next) => moveLead(l.id, next)}
                    />
                  ))}
                </Column>
              );
            })}
          </div>
        </>
      )}

      {(showNew || editing) && (
        <LeadModal
          lead={editing}
          onClose={() => {
            setShowNew(false);
            setEditing(null);
          }}
          onSaved={() => {
            setShowNew(false);
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

/**
 * An empty board must never be ambiguous. This asks the engine why there is
 * nothing to show: no campaign yet, sourcing running, everything still
 * enriching, or everything already assigned.
 */
function EmptyExplainer() {
  const [info, setInfo] = useState<{
    campaigns: number;
    running: number;
    inFlight: number;
    assigned: number;
    failed: number;
    checked: boolean;
  }>({ campaigns: 0, running: 0, inFlight: 0, assigned: 0, failed: 0, checked: false });

  useEffect(() => {
    (async () => {
      try {
        const [campRes, diagRes] = await Promise.all([
          fetch("/api/sourcing").then((r) => r.json()),
          fetch("/api/diagnostics").then((r) => r.json()),
        ]);
        const camps = campRes.campaigns || [];
        const byStatus: Record<string, number> = diagRes.leads?.by_machine_status || {};
        const inFlight = IN_FLIGHT.reduce((n, s) => n + (byStatus[s] || 0), 0);
        setInfo({
          campaigns: camps.length,
          running: camps.filter((c: { status: string }) => c.status === "running").length,
          inFlight,
          assigned: (byStatus.assigned_to_packet || 0) + (byStatus.contacted || 0),
          failed: byStatus.enrichment_failed || 0,
          checked: true,
        });
      } catch {
        setInfo((i) => ({ ...i, checked: true }));
      }
    })();
  }, []);

  let headline = "No leads in the database yet";
  let detail =
    "This is a real empty database, not a loading error. Start a sourcing campaign to generate leads automatically.";

  if (info.checked) {
    if (info.running > 0) {
      headline = "Sourcing is running";
      detail =
        "The engine is searching Google Places right now. Businesses appear here as soon as they're saved — watch progress on the Sourcing tab.";
    } else if (info.inFlight > 0) {
      headline = "Leads are still being processed";
      detail = `${info.inFlight} lead(s) are moving through normalization and enrichment. They'll appear once processing completes.`;
    } else if (info.assigned > 0) {
      headline = "All leads are already assigned or called";
      detail = `${info.assigned} lead(s) exist but are in caller packets or already contacted.`;
    } else if (info.failed > 0) {
      headline = "All generated leads failed qualification";
      detail = `${info.failed} business(es) were found but didn't meet your campaign's rating, review, website, or franchise rules. Loosen the filters and run again.`;
    } else if (info.campaigns === 0) {
      headline = "No sourcing campaign has been run yet";
      detail =
        "Go to the Sourcing tab, create a campaign (industry, city, search terms, target count), and press Start. The engine generates and saves businesses automatically.";
    }
  }

  return (
    <div className="card" style={{ marginBottom: 14, flexShrink: 0 }}>
      <h3 style={{ marginBottom: 6 }}>{headline}</h3>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        {detail}
      </p>
      <a href="/admin/sourcing" className="btn" style={{ marginTop: 12 }}>
        Go to Sourcing →
      </a>
    </div>
  );
}

function Column({
  title,
  count,
  onDrop,
  children,
}: {
  title: string;
  count: number;
  onDrop: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      style={{
        background: "var(--bg-raised)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
        minWidth: 300,
        width: 300,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
          padding: "0 2px",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontWeight: 700,
            fontSize: "0.78rem",
            textTransform: "uppercase",
            letterSpacing: "0.09em",
            color: "var(--text-dim)",
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: "0.72rem",
            background: "var(--bg-hover)",
            color: "var(--text-dim)",
            borderRadius: 3,
            padding: "1px 8px",
          }}
        >
          {count}
        </span>
      </div>
      <div style={{ overflowY: "auto", flex: 1 }}>
        {count === 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              minHeight: 120,
              color: "var(--text-faint)",
              fontSize: "0.8rem",
            }}
          >
            empty
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function LeadCard({
  lead,
  contacts,
  onDragStart,
  onEdit,
  onAdvance,
}: {
  lead: Lead;
  contacts: ContactLite[];
  onDragStart: () => void;
  onEdit: () => void;
  onAdvance: (next: SalesStage) => void;
}) {
  const idx = SALES_STAGES.indexOf(lead.pipeline_stage);
  const next =
    idx >= 0 && idx < SALES_STAGES.length - 2 ? SALES_STAGES[idx + 1] : null;
  const dm = contacts.find((c) => c.full_name);
  const location = [lead.city, lead.state].filter(Boolean).join(", ");
  const assignTag =
    lead.status === "new"
      ? "unassigned"
      : lead.status === "in_packet"
        ? "in packet"
        : lead.status;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border-card)",
        borderRadius: 6,
        padding: 12,
        marginBottom: 10,
        cursor: "grab",
        opacity: lead.do_not_call ? 0.5 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 6,
          alignItems: "flex-start",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: "0.9rem", lineHeight: 1.35 }}>
          {lead.business_name}
        </span>
        <span className="tag-dim" style={{ whiteSpace: "nowrap" }}>
          {lead.do_not_call ? "DNC" : assignTag}
        </span>
      </div>

      <div style={{ marginBottom: 6 }}>
        <span
          className="tag-dim"
          style={{
            color:
              lead.machine_status === "ready_for_calling"
                ? "var(--green)"
                : lead.machine_status === "enrichment_failed"
                  ? "var(--red)"
                  : "var(--text-dim)",
          }}
        >
          {MACHINE_STATUS_LABELS[lead.machine_status as MachineStatus] ||
            lead.machine_status}
        </span>
        {lead.qualification_failure_reason && (
          <span className="faint" style={{ marginLeft: 6 }}>
            {lead.qualification_failure_reason}
          </span>
        )}
      </div>

      {lead.stage_was_unrecognized && (
        <div
          style={{
            fontSize: "0.72rem",
            color: "var(--red)",
            marginBottom: 6,
          }}
        >
          ⚠ had an unrecognized stage — shown here as New Lead
        </div>
      )}

      {dm && (
        <div style={{ fontSize: "0.78rem", color: "var(--amber)", marginBottom: 6 }}>
          DM: {dm.full_name}
          {dm.title ? ` (${dm.title})` : ""}
        </div>
      )}

      {lead.notes && (
        <div
          style={{
            background: "var(--bg-inset)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "8px 10px",
            fontSize: "0.78rem",
            color: "var(--text-dim)",
            marginBottom: 8,
          }}
        >
          {lead.notes.slice(0, 120)}
        </div>
      )}

      {lead.phone && (
        <a
          href={`tel:${lead.phone}`}
          style={{
            display: "block",
            color: "var(--amber)",
            fontWeight: 600,
            fontSize: "0.85rem",
            marginBottom: 4,
          }}
        >
          {lead.phone}
        </a>
      )}
      <div className="faint" style={{ marginBottom: 8 }}>
        {[location, lead.industry].filter(Boolean).join(" · ")}
        {lead.rating != null ? ` · ★ ${lead.rating}` : ""}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {next && (
          <button
            className="btn-ghost"
            style={{ justifyContent: "center", padding: "6px 10px", fontSize: "0.72rem" }}
            onClick={() => onAdvance(next)}
          >
            → {STAGE_LABELS[next]}
          </button>
        )}
        <button
          className="btn-ghost"
          style={{
            justifyContent: "center",
            padding: "6px 10px",
            fontSize: "0.72rem",
            borderColor: "var(--border)",
            color: "var(--text-dim)",
          }}
          onClick={onEdit}
        >
          ✎ Edit
        </button>
      </div>
    </div>
  );
}

function LeadModal({
  lead,
  onClose,
  onSaved,
}: {
  lead: Lead | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    business_name: lead?.business_name || "",
    phone: lead?.phone || "",
    website: lead?.website || "",
    city: lead?.city || "",
    state: lead?.state || "",
    industry: lead?.industry || "",
    pipeline_stage: lead?.pipeline_stage || DEFAULT_STAGE,
    notes: lead?.notes || "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function set(k: string, v: string) {
    setForm({ ...form, [k]: v });
  }

  async function save() {
    if (!form.business_name.trim()) return;
    setSaving(true);
    setError("");
    const res = await fetch(lead ? `/api/leads/${lead.id}` : "/api/leads", {
      method: lead ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || "Save failed");
      setSaving(false);
      return;
    }
    onSaved();
  }

  async function archive() {
    if (!lead) return;
    if (!confirm("Archive this lead? It will be hidden from the board.")) return;
    setSaving(true);
    await fetch(`/api/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    onSaved();
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 480, maxWidth: "92vw" }}
      >
        <h2 style={{ marginBottom: 16 }}>{lead ? "Edit Lead" : "New Lead"}</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            placeholder="Business name"
            value={form.business_name}
            onChange={(e) => set("business_name", e.target.value)}
            autoFocus
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <input
              placeholder="Phone"
              value={form.phone}
              onChange={(e) => set("phone", e.target.value)}
            />
            <input
              placeholder="Website"
              value={form.website}
              onChange={(e) => set("website", e.target.value)}
            />
            <input
              placeholder="City"
              value={form.city}
              onChange={(e) => set("city", e.target.value)}
            />
            <input
              placeholder="State"
              value={form.state}
              onChange={(e) => set("state", e.target.value)}
            />
            <input
              placeholder="Industry"
              value={form.industry}
              onChange={(e) => set("industry", e.target.value)}
            />
            <select
              value={form.pipeline_stage}
              onChange={(e) => set("pipeline_stage", e.target.value)}
            >
              {SALES_STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <textarea
            placeholder="Notes"
            rows={3}
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
          {error && <p style={{ color: "var(--red)" }}>{error}</p>}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button
            className="btn"
            onClick={save}
            disabled={saving || !form.business_name.trim()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <div style={{ flex: 1 }} />
          {lead && (
            <button className="btn-danger" onClick={archive} disabled={saving}>
              Archive
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function DiagnosticsPanel({
  onClose,
  boardCount,
  lastFetchedAt,
  realtime,
}: {
  onClose: () => void;
  boardCount: number;
  lastFetchedAt: string | null;
  realtime: boolean;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [diag, setDiag] = useState<any>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/diagnostics")
      .then((r) => r.json())
      .then(setDiag)
      .catch((e) => setErr(String(e)));
  }, []);

  return (
    <div
      className="card"
      style={{ marginBottom: 14, flexShrink: 0, borderColor: "var(--border-strong)" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <h3>Diagnostics</h3>
        <button className="btn-ghost" style={{ padding: "2px 10px" }} onClick={onClose}>
          ✕
        </button>
      </div>
      {err && <p style={{ color: "var(--red)" }}>{err}</p>}
      {!diag && !err && <p className="muted">Checking database…</p>}
      {diag && (
        <div style={{ fontSize: "0.8rem", display: "grid", gap: 3 }}>
          <div>
            Supabase project: <strong>{diag.supabase_project_ref || "not set"}</strong>{" "}
            <span className="faint">({diag.vercel_env})</span>
          </div>
          <div>
            Keys — anon: {diag.anon_key_present ? "✓" : "✗"} · Anthropic:{" "}
            {diag.anthropic_key_present ? "✓" : "✗"} · caller secret:{" "}
            {diag.caller_secret_present ? "✓" : "✗"}
          </div>
          <div>
            Leads in database: <strong>{diag.leads?.total ?? "?"}</strong> · archived:{" "}
            {diag.leads?.archived ?? "?"} · DNC: {diag.leads?.do_not_call ?? "?"} · in
            packet: {diag.leads?.assigned_to_packet ?? "?"}
          </div>
          <div>Rendered on this board: {boardCount}</div>
          <div className="faint">
            By stage:{" "}
            {diag.leads?.by_stage
              ? Object.entries(diag.leads.by_stage)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" · ")
              : "—"}
          </div>
          {diag.leads?.unrecognized_stage_count > 0 && (
            <div style={{ color: "var(--red)" }}>
              ⚠ {diag.leads.unrecognized_stage_count} lead(s) have an unrecognized
              stage — run migration 0005.
            </div>
          )}
          <div className="faint">
            Realtime: {realtime ? "connected" : "not connected"} · last fetch:{" "}
            {lastFetchedAt ? new Date(lastFetchedAt).toLocaleTimeString() : "—"}
          </div>
          {diag.errors?.length > 0 && (
            <div style={{ color: "var(--red)" }}>
              Errors: {diag.errors.join(" | ")}
            </div>
          )}
          {diag.migration_hint && (
            <div style={{ color: "var(--amber)" }}>{diag.migration_hint}</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ DELIVERY -------------------------------- */

function DeliveryBoard({
  pipeline,
  setPipeline,
}: {
  pipeline: Pipeline;
  setPipeline: (p: Pipeline) => void;
}) {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<Deal | null>(null);

  async function load() {
    setStatus("loading");
    try {
      const { data, error } = await supabase()
        .from("deals")
        .select("id, name, stage, value, notes, created_at")
        .eq("pipeline", "delivery")
        .order("created_at", { ascending: false });
      if (error) {
        console.error("[DeliveryBoard]", error);
        setMessage(`Could not load deals. Database error: ${error.message}`);
        setStatus("error");
        return;
      }
      setDeals((data as Deal[]) || []);
      setStatus("ready");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Unexpected error");
      setStatus("error");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function moveDeal(id: string, stage: string) {
    setDeals((d) => d.map((x) => (x.id === id ? { ...x, stage } : x)));
    await fetch(`/api/deals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage }),
    });
    load();
  }

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 14,
          flexShrink: 0,
        }}
      >
        <h1>Delivery Board</h1>
        <PipelineSwitch pipeline={pipeline} setPipeline={setPipeline} />
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => setShowNew(true)}>
          + New Deal
        </button>
      </div>

      {status === "error" && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 14 }}>
          <h3 style={{ color: "var(--red)", marginBottom: 6 }}>Could not load deals</h3>
          <p style={{ fontSize: "0.85rem" }}>{message}</p>
          <button className="btn-ghost" style={{ marginTop: 10 }} onClick={load}>
            Retry
          </button>
        </div>
      )}
      {status === "loading" && <p className="muted" style={{ padding: 20 }}>Loading…</p>}

      {status === "ready" && (
        <div
          style={{
            display: "flex",
            gap: 14,
            overflowX: "auto",
            flex: 1,
            minHeight: 0,
            paddingBottom: 8,
          }}
        >
          {DELIVERY_STAGES.map((stage) => {
            const inStage = deals.filter((d) => d.stage === stage);
            return (
              <Column
                key={stage}
                title={stage}
                count={inStage.length}
                onDrop={() => {
                  if (dragId) moveDeal(dragId, stage);
                  setDragId(null);
                }}
              >
                {inStage.map((d) => (
                  <DealCard
                    key={d.id}
                    deal={d}
                    onDragStart={() => setDragId(d.id)}
                    onEdit={() => setEditing(d)}
                    onAdvance={(next) => moveDeal(d.id, next)}
                  />
                ))}
              </Column>
            );
          })}
        </div>
      )}

      {(showNew || editing) && (
        <DealModal
          deal={editing}
          onClose={() => {
            setShowNew(false);
            setEditing(null);
          }}
          onSaved={() => {
            setShowNew(false);
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}

function DealCard({
  deal,
  onDragStart,
  onEdit,
  onAdvance,
}: {
  deal: Deal;
  onDragStart: () => void;
  onEdit: () => void;
  onAdvance: (next: string) => void;
}) {
  const stages = DELIVERY_STAGES as readonly string[];
  const idx = stages.indexOf(deal.stage);
  const next = idx >= 0 && idx < stages.length - 1 ? stages[idx + 1] : null;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border-card)",
        borderRadius: 6,
        padding: 12,
        marginBottom: 10,
        cursor: "grab",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: "0.9rem" }}>{deal.name}</span>
        {deal.value != null && (
          <span style={{ color: "var(--amber)", fontWeight: 700, whiteSpace: "nowrap" }}>
            ${Number(deal.value).toLocaleString()}
          </span>
        )}
      </div>
      {deal.notes && (
        <div
          style={{
            background: "var(--bg-inset)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "8px 10px",
            fontSize: "0.78rem",
            color: "var(--text-dim)",
            marginBottom: 8,
          }}
        >
          {deal.notes.slice(0, 140)}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {next && (
          <button
            className="btn-ghost"
            style={{ justifyContent: "center", padding: "6px 10px", fontSize: "0.72rem" }}
            onClick={() => onAdvance(next)}
          >
            → {next}
          </button>
        )}
        <button
          className="btn-ghost"
          style={{
            justifyContent: "center",
            padding: "6px 10px",
            fontSize: "0.72rem",
            borderColor: "var(--border)",
            color: "var(--text-dim)",
          }}
          onClick={onEdit}
        >
          ✎ Edit
        </button>
      </div>
    </div>
  );
}

function DealModal({
  deal,
  onClose,
  onSaved,
}: {
  deal: Deal | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(deal?.name || "");
  const [stage, setStage] = useState(deal?.stage || DELIVERY_STAGES[0]);
  const [value, setValue] = useState(deal?.value?.toString() || "");
  const [notes, setNotes] = useState(deal?.notes || "");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    const payload = {
      name: name.trim(),
      pipeline: "delivery",
      stage,
      value: value ? Number(value) : null,
      notes: notes || null,
    };
    await fetch(deal ? `/api/deals/${deal.id}` : "/api/deals", {
      method: deal ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    onSaved();
  }

  async function remove() {
    if (!deal) return;
    if (!confirm("Delete this deal?")) return;
    setSaving(true);
    await fetch(`/api/deals/${deal.id}`, { method: "DELETE" });
    onSaved();
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 460, maxWidth: "90vw" }}
      >
        <h2 style={{ marginBottom: 16 }}>{deal ? "Edit Deal" : "New Deal"}</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            placeholder="Deal name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <select value={stage} onChange={(e) => setStage(e.target.value)}>
            {DELIVERY_STAGES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <input
            placeholder="Value ($)"
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <textarea
            placeholder="Notes"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button className="btn" onClick={save} disabled={saving || !name.trim()}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <div style={{ flex: 1 }} />
          {deal && (
            <button className="btn-danger" onClick={remove} disabled={saving}>
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
