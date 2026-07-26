"use client";

import { useCallback, useEffect, useState } from "react";

type Rel<T> = T | T[] | null;

type Appointment = {
  id: string;
  lead_id: string;
  decision_maker_name: string;
  decision_maker_role: string;
  scheduled_for: string;
  timezone: string | null;
  phone: string | null;
  email: string | null;
  product: string | null;
  pain_point: string | null;
  confirmation_method: string | null;
  notes: string | null;
  attendance_status: string;
  attendance_recorded_at: string | null;
  attendance_note: string | null;
  leads: Rel<{ business_name: string; industry: string | null; city: string | null; state: string | null }>;
  callers: Rel<{ name: string }>;
};

const OPTIONS: { value: string; label: string; tone?: "good" | "bad" }[] = [
  { value: "held", label: "Held", tone: "good" },
  { value: "no_show", label: "No-show", tone: "bad" },
  { value: "rescheduled", label: "Rescheduled" },
  { value: "cancelled", label: "Cancelled", tone: "bad" },
];

const STATUS_LABEL: Record<string, string> = {
  scheduled: "Awaiting outcome",
  held: "Held",
  no_show: "No-show",
  cancelled: "Cancelled",
  rescheduled: "Rescheduled",
};

function one<T>(rel: Rel<T>): T | null {
  return Array.isArray(rel) ? (rel[0] ?? null) : rel;
}

export default function AppointmentsPage() {
  const [rows, setRows] = useState<Appointment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/appointments");
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "Could not load appointments.");
      setRows([]);
      return;
    }
    setError(null);
    setRows(json.appointments);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function mark(id: string, status: string) {
    setSaving(id);
    const res = await fetch("/api/appointments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, attendance_status: status }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error || "Could not save that.");
    }
    setSaving(null);
    load();
  }

  if (rows === null && !error) return <p className="muted">Loading…</p>;

  const pending = (rows || []).filter((a) => a.attendance_status === "scheduled");
  const settled = (rows || []).filter((a) => a.attendance_status !== "scheduled");
  const held = settled.filter((a) => a.attendance_status === "held").length;
  const noShow = settled.filter((a) => a.attendance_status === "no_show").length;

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>Appointments</h1>
      <p className="faint" style={{ marginBottom: 20 }}>
        A booked appointment is not a held appointment. Marking what actually
        happened is the only way show-rate can ever be measured — nothing else
        in the system can infer it.
      </p>

      {error && (
        <div
          className="card"
          style={{ borderColor: "var(--red)", marginBottom: 20, color: "var(--red)" }}
        >
          {error}
        </div>
      )}

      {settled.length > 0 && (
        <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
          <div className="card" style={{ textAlign: "center", minWidth: 130 }}>
            <div style={{ fontSize: "1.6rem", fontWeight: 700 }}>{held}</div>
            <div className="faint">Held</div>
          </div>
          <div className="card" style={{ textAlign: "center", minWidth: 130 }}>
            <div style={{ fontSize: "1.6rem", fontWeight: 700 }}>{noShow}</div>
            <div className="faint">No-shows</div>
          </div>
          <div className="card" style={{ textAlign: "center", minWidth: 130 }}>
            <div style={{ fontSize: "1.6rem", fontWeight: 700, color: "var(--amber)" }}>
              {held + noShow > 0 ? Math.round((held / (held + noShow)) * 100) : 0}%
            </div>
            <div className="faint">Show rate</div>
          </div>
        </div>
      )}

      <h2 style={{ marginBottom: 10 }}>Awaiting an outcome ({pending.length})</h2>
      {pending.length === 0 ? (
        <p className="muted" style={{ marginBottom: 28 }}>
          Nothing waiting. Appointments appear here the moment a caller books one.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 10, marginBottom: 32 }}>
          {pending.map((a) => (
            <Row key={a.id} a={a} saving={saving === a.id} onMark={mark} />
          ))}
        </div>
      )}

      {settled.length > 0 && (
        <>
          <h2 style={{ marginBottom: 10 }}>Recorded</h2>
          <div style={{ display: "grid", gap: 10 }}>
            {settled.map((a) => (
              <Row key={a.id} a={a} saving={saving === a.id} onMark={mark} settled />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Row({
  a,
  saving,
  onMark,
  settled,
}: {
  a: Appointment;
  saving: boolean;
  onMark: (id: string, status: string) => void;
  settled?: boolean;
}) {
  const lead = one(a.leads);
  const caller = one(a.callers);
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>{lead?.business_name || "(lead removed)"}</div>
          <div className="faint">
            {a.decision_maker_name} ({a.decision_maker_role})
            {caller?.name ? ` · booked by ${caller.name}` : ""}
            {lead?.industry ? ` · ${lead.industry}` : ""}
            {lead?.city ? ` · ${lead.city}, ${lead.state || ""}` : ""}
          </div>
          <div style={{ color: "var(--amber)", fontSize: "0.85rem", marginTop: 4 }}>
            {new Date(a.scheduled_for).toLocaleString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
            {a.timezone ? ` ${a.timezone}` : ""}
          </div>
          {a.pain_point && <div className="faint">Pain point: {a.pain_point}</div>}
        </div>

        <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap" }}>
          {settled && (
            <span className="tag-dim" style={{ alignSelf: "center" }}>
              {STATUS_LABEL[a.attendance_status] || a.attendance_status}
            </span>
          )}
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              className={
                a.attendance_status === o.value
                  ? "btn"
                  : o.tone === "bad"
                    ? "btn-danger"
                    : "btn-ghost"
              }
              disabled={saving}
              onClick={() => onMark(a.id, o.value)}
              style={{ padding: "5px 12px", fontSize: "0.72rem" }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
