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
};

export default function KanbanBoard() {
  const [pipeline, setPipeline] = useState<Pipeline>("sales");
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<Deal | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const stages = PIPELINES[pipeline];

  async function load() {
    setLoading(true);
    const { data } = await supabase()
      .from("deals")
      .select("*")
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

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <h1>Board</h1>
        <div style={{ display: "flex", gap: 4 }}>
          {(Object.keys(PIPELINES) as Pipeline[]).map((p) => (
            <button
              key={p}
              className={p === pipeline ? "btn" : "btn-ghost"}
              onClick={() => setPipeline(p)}
              style={{ textTransform: "capitalize" }}
            >
              {p}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => setShowNew(true)}>
          + New deal
        </button>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${stages.length}, minmax(220px, 1fr))`,
            gap: 12,
            overflowX: "auto",
          }}
        >
          {stages.map((stage) => (
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
                padding: 10,
                minHeight: 300,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 10,
                  padding: "0 4px",
                }}
              >
                <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{stage}</span>
                <span className="faint">
                  {deals.filter((d) => d.stage === stage).length}
                </span>
              </div>
              {deals
                .filter((d) => d.stage === stage)
                .map((d) => (
                  <div
                    key={d.id}
                    draggable
                    onDragStart={() => setDragId(d.id)}
                    onClick={() => setEditing(d)}
                    style={{
                      background: "var(--bg)",
                      border: "1px solid var(--border-strong)",
                      borderRadius: 6,
                      padding: 10,
                      marginBottom: 8,
                      cursor: "grab",
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{d.name}</div>
                    {d.value != null && (
                      <div style={{ color: "var(--amber)", fontSize: "0.85rem" }}>
                        ${Number(d.value).toLocaleString()}
                      </div>
                    )}
                    {d.notes && (
                      <div className="faint" style={{ marginTop: 4 }}>
                        {d.notes.slice(0, 80)}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          ))}
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
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 440, maxWidth: "90vw" }}
      >
        <h2 style={{ marginBottom: 16 }}>{deal ? "Edit deal" : "New deal"}</h2>
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
