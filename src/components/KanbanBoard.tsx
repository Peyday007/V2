"use client";

import { useEffect, useState } from "react";
import { PIPELINES, SALES_STAGES, Pipeline } from "@/lib/constants";
import { supabase } from "@/lib/supabase";

type Lead = {
  id: string;
  business_name: string;
  phone: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  industry: string | null;
  rating: number | null;
  review_count: number | null;
  status: string;
  stage: string;
  do_not_call: boolean;
  notes: string | null;
  created_at: string;
  contacts: { full_name: string | null; title: string | null }[];
};

type Deal = {
  id: string;
  name: string;
  pipeline: Pipeline;
  stage: string;
  value: number | null;
  notes: string | null;
  created_at: string;
};

export default function KanbanBoard() {
  const [pipeline, setPipeline] = useState<Pipeline>("sales");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [editingLead, setEditingLead] = useState<Lead | null>(null);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [attack, setAttack] = useState("");
  const [attackLoading, setAttackLoading] = useState(false);

  const stages = PIPELINES[pipeline];
  const isSales = pipeline === "sales";

  async function load() {
    setLoading(true);
    if (isSales) {
      const { data } = await supabase()
        .from("leads")
        .select("*, contacts(full_name, title)")
        .order("created_at", { ascending: false })
        .limit(500);
      setLeads((data as Lead[]) || []);
    } else {
      const { data } = await supabase()
        .from("deals")
        .select("*")
        .eq("pipeline", "delivery")
        .order("created_at", { ascending: false });
      setDeals((data as Deal[]) || []);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline]);

  async function moveLead(id: string, stage: string) {
    setLeads((l) => l.map((x) => (x.id === id ? { ...x, stage } : x)));
    await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage }),
    });
  }

  async function moveDeal(id: string, stage: string) {
    setDeals((d) => d.map((x) => (x.id === id ? { ...x, stage } : x)));
    await fetch(`/api/deals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage }),
    });
  }

  function onDrop(stage: string) {
    if (!dragId) return;
    if (isSales) moveLead(dragId, stage);
    else moveDeal(dragId, stage);
    setDragId(null);
  }

  async function whatToAttack() {
    setAttackLoading(true);
    const res = await fetch("/api/prioritize");
    const j = await res.json();
    setAttack(res.ok ? j.recommendation : j.error || "Failed");
    setAttackLoading(false);
  }

  const counts = isSales
    ? (s: string) => leads.filter((l) => l.stage === s).length
    : (s: string) => deals.filter((d) => d.stage === s).length;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 105px)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 18,
          flexShrink: 0,
        }}
      >
        <h1>{isSales ? "Sales Board" : "Delivery Board"}</h1>
        <div style={{ display: "flex", gap: 6 }}>
          {(Object.keys(PIPELINES) as Pipeline[]).map((p) => (
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
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={whatToAttack} disabled={attackLoading}>
          ⚡ {attackLoading ? "Thinking…" : "What to Attack Today"}
        </button>
        <button className="btn" onClick={() => setShowNew(true)}>
          {isSales ? "+ New Lead" : "+ New Deal"}
        </button>
      </div>

      {attack && (
        <div
          className="card"
          style={{ marginBottom: 16, borderColor: "var(--amber-dim)", flexShrink: 0 }}
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

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
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
          {stages.map((stage) => (
            <div
              key={stage}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(stage)}
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
                  {stage}
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
                  {counts(stage)}
                </span>
              </div>

              <div style={{ overflowY: "auto", flex: 1 }}>
                {counts(stage) === 0 && (
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
                )}
                {isSales
                  ? leads
                      .filter((l) => l.stage === stage)
                      .map((l) => (
                        <LeadCard
                          key={l.id}
                          lead={l}
                          onDragStart={() => setDragId(l.id)}
                          onEdit={() => setEditingLead(l)}
                          onAdvance={(next) => moveLead(l.id, next)}
                        />
                      ))
                  : deals
                      .filter((d) => d.stage === stage)
                      .map((d) => (
                        <DealCard
                          key={d.id}
                          deal={d}
                          stages={stages}
                          onDragStart={() => setDragId(d.id)}
                          onEdit={() => setEditingDeal(d)}
                          onAdvance={(next) => moveDeal(d.id, next)}
                        />
                      ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {isSales && (showNew || editingLead) && (
        <LeadModal
          lead={editingLead}
          onClose={() => {
            setShowNew(false);
            setEditingLead(null);
          }}
          onSaved={() => {
            setShowNew(false);
            setEditingLead(null);
            load();
          }}
        />
      )}
      {!isSales && (showNew || editingDeal) && (
        <DealModal
          deal={editingDeal}
          onClose={() => {
            setShowNew(false);
            setEditingDeal(null);
          }}
          onSaved={() => {
            setShowNew(false);
            setEditingDeal(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function LeadCard({
  lead,
  onDragStart,
  onEdit,
  onAdvance,
}: {
  lead: Lead;
  onDragStart: () => void;
  onEdit: () => void;
  onAdvance: (next: string) => void;
}) {
  const stages = SALES_STAGES as readonly string[];
  const idx = stages.indexOf(lead.stage);
  const next = idx >= 0 && idx < stages.length - 2 ? stages[idx + 1] : null;
  const dm = lead.contacts?.find((c) => c.full_name);
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

      {dm && (
        <div
          style={{
            fontSize: "0.78rem",
            color: "var(--amber)",
            marginBottom: 6,
          }}
        >
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
    stage: lead?.stage || "New Lead",
    notes: lead?.notes || "",
  });
  const [saving, setSaving] = useState(false);

  function set(k: string, v: string) {
    setForm({ ...form, [k]: v });
  }

  async function save() {
    if (!form.business_name.trim()) return;
    setSaving(true);
    if (lead) {
      await fetch(`/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
    } else {
      await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
    }
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
            <select value={form.stage} onChange={(e) => set("stage", e.target.value)}>
              {SALES_STAGES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <textarea
            placeholder="Notes"
            rows={3}
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
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
        </div>
      </div>
    </div>
  );
}

function DealCard({
  deal,
  stages,
  onDragStart,
  onEdit,
  onAdvance,
}: {
  deal: Deal;
  stages: readonly string[];
  onDragStart: () => void;
  onEdit: () => void;
  onAdvance: (next: string) => void;
}) {
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
        <span style={{ fontWeight: 700, fontSize: "0.9rem", lineHeight: 1.35 }}>
          {deal.name}
        </span>
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

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
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
  const stages = PIPELINES.delivery;
  const [name, setName] = useState(deal?.name || "");
  const [stage, setStage] = useState(deal?.stage || stages[0]);
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
    if (deal) {
      await fetch(`/api/deals/${deal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      await fetch("/api/deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
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
            {stages.map((s) => (
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
