"use client";

import { useState } from "react";
import {
  OUTCOME_FORM_MAP,
  fieldVisible,
  missingRequired,
  OutcomeField,
} from "@/lib/outcomeForms";

/** Structured capture for one outcome. Enforces the same rules as the server. */
export default function OutcomeModal({
  outcome,
  defaults,
  onCancel,
  onSave,
  saving,
}: {
  outcome: string;
  defaults?: Record<string, string>;
  onCancel: () => void;
  onSave: (values: Record<string, string>, confirmed: boolean) => void;
  saving: boolean;
}) {
  const form = OUTCOME_FORM_MAP[outcome];
  const [values, setValues] = useState<Record<string, string>>(defaults || {});
  const [confirmed, setConfirmed] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  if (!form) return null;
  const missing = missingRequired(outcome, values);
  const blocked = missing.length > 0 || (!!form.confirmation && !confirmed);

  function set(name: string, v: string) {
    setValues((prev) => ({ ...prev, [name]: v }));
  }

  function renderField(f: OutcomeField) {
    if (!fieldVisible(f, values)) return null;
    const missingThis =
      showErrors && f.required && !String(values[f.name] || "").trim();
    const common = {
      value: values[f.name] || "",
      onChange: (
        e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
      ) => set(f.name, e.target.value),
      style: missingThis ? { borderColor: "var(--red)" } : undefined,
    };
    return (
      <label key={f.name} className="faint" style={{ display: "block" }}>
        {f.label}
        {f.required && <span style={{ color: "var(--amber)" }}> *</span>}
        {f.type === "select" ? (
          <select {...common}>
            <option value="">Choose…</option>
            {(f.options || []).map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        ) : f.type === "textarea" ? (
          <textarea rows={2} placeholder={f.placeholder} {...common} />
        ) : (
          <input
            type={f.type === "date" ? "date" : f.type === "time" ? "time" : "text"}
            placeholder={f.placeholder}
            {...common}
          />
        )}
      </label>
    );
  }

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
        padding: 20,
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 560, maxWidth: "95vw", maxHeight: "88vh", overflowY: "auto" }}
      >
        <h2 style={{ marginBottom: 4 }}>{form.label}</h2>
        {form.hint && (
          <p className="faint" style={{ marginBottom: 14 }}>
            {form.hint}
          </p>
        )}

        <div style={{ display: "grid", gap: 10 }}>{form.fields.map(renderField)}</div>

        {form.confirmation && (
          <label
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              marginTop: 14,
              padding: "10px 12px",
              background: "var(--amber-soft)",
              border: `1px solid ${
                showErrors && !confirmed ? "var(--red)" : "var(--amber-dim)"
              }`,
              borderRadius: 4,
              fontSize: "0.82rem",
            }}
          >
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              style={{ width: "auto", marginTop: 2 }}
            />
            <span>{form.confirmation}</span>
          </label>
        )}

        {showErrors && missing.length > 0 && (
          <p style={{ color: "var(--red)", marginTop: 10, fontSize: "0.82rem" }}>
            Still needed: {missing.join(", ")}
          </p>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button
            className="btn"
            disabled={saving}
            onClick={() => {
              if (blocked) {
                setShowErrors(true);
                return;
              }
              onSave(values, confirmed);
            }}
          >
            {saving ? "Saving…" : "Save & next lead"}
          </button>
          <button className="btn-ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
