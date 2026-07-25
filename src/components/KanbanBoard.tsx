"use client";

import { useEffect, useState } from "react";
import { PIPELINES, Pipeline } from "@/lib/constants";
import { supabase } from "@/lib/supabase";

type Deal = {
  id: string;
  name: string;
  pipeline: Pipeline;
  stage: string;
  value: number | null;
  notes: string | null;
  created_at: string;
  leads: { phone: string | null; city: string | null; state: string | null } | null;
};

export default function KanbanBoard() {
  const [pipeline, setPipeline] = useState<Pipeline>("sales");
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<Deal | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [attack, setAttack] = useState("");
  const [attackLoading, setAttackLoading] = useState(false);

  const stages = PIPELINES[pipeline];

  async function load() {
    setLoading(true);
    const { data } = await supabase()
      .from("deals")
      .select("*, leads(phone, city, state)")
      .eq("pipeline", pipeline)
      .order("created_at", { ascending: false });
    setDeals((data as Deal[]) || []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline]);

  async function moveDeal(id: string, stage: string) {
    setDeals((d) => d.map((x) => (x.id === id ? { ...x, stage } : x)));
    await fetch(`/api/deals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage }),
    });
  }

  async function whatToAttack() {
    setAttackLoading(true);
    const res = await fetch("/api/prioritize");
    const j = await res.json();
    setAttack(res.ok ? j.recommendation : j.error || "Failed");
    setAttackLoading(false);
  }

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
        <h1>{pipeline === "sales" ? "Sales Board" : "Delivery Board"}</h1>
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
          + New Deal
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
          {stages.map((stage) => {
            const inStage = deals.filter((d) => d.stage === stage);
            return (
              <div
                key={stage}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragId) moveDeal(dragId, stage);
                  setDragId(null);
                }}
                style={{
                  background: "var(--bg-raised)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: 12,
                  minWidth: 290,
                  width: 290,
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
                    {inStage.length}
                  </span>
                </div>

                <div style={{ overflowY: "auto", flex: 1 }}>
                  {inStage.length === 0 && (
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
                  {inStage.map((d) => (
                    <DealCard
                      key={d.id}
                      deal={d}
                      stages={stages}
                      onDragStart={() => setDragId(d.id)}
                      onEdit={() => setEditing(d)}
                      onAdvance={(next) => moveDeal(d.id, next)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(showNew || editing) && (
        <DealModal
          deal={editing}
          pipeline={pipeline}
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
  const terminal = deal.stage === "Closed Won" || deal.stage === "Closed Lost";
  const phone = deal.leads?.phone;
  const location = [deal.leads?.city, deal.leads?.state].filter(Boolean).join(", ");

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

      {phone && (
        <a
          href={`tel:${phone}`}
          style={{
            display: "block",
            color: "var(--amber)",
            fontWeight: 600,
            fontSize: "0.85rem",
            marginBottom: 4,
          }}
        >
          {phone}
        </a>
      )}
      {location && (
        <div className="faint" style={{ marginBottom: 8 }}>
          {location}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
        {next && !terminal && (
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
  pipeline,
  onClose,
  onSaved,
}: {
  deal: Deal | null;
  pipeline: Pipeline;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(deal?.name || "");
  const [stage, setStage] = useState(deal?.stage || PIPELINES[pipeline][0]);
  const [value, setValue] = useState(deal?.value?.toString() || "");
  const [notes, setNotes] = useState(deal?.notes || "");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    const payload = {
      name: name.trim(),
      pipeline,
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
            {PIPELINES[pipeline].map((s) => (
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
