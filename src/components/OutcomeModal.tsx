"use client";

import { useState } from "react";
import {
  OUTCOME_FORM_MAP,
  fieldVisible,
  missingRequired,
  OutcomeField,
} from "@/lib/outcomeForms";

/**
 * Structured capture for one outcome. Enforces the same rules as the server.
 *
 * Lead intelligence lives here too, collapsed. It used to be a permanent panel
 * on the call screen — fifteen empty boxes visible during every conversation,
 * for something a caller only ever fills in once the call is over.
 */
export default function OutcomeModal({
  outcome,
  defaults,
  intel,
  onIntelChange,
  onCancel,
  onSave,
  saving,
}: {
  outcome: string;
  defaults?: Record<string, string>;
  intel?: Record<string, string>;
  onIntelChange?: (intel: Record<string, string>) => void;
  onCancel: () => void;
  onSave: (
    values: Record<string, string>,
    confirmed: boolean,
    intel: Record<string, string>
  ) => void;
  saving: boolean;
}) {
  const form = OUTCOME_FORM_MAP[outcome];
  const [values, setValues] = useState<Record<string, string>>(defaults || {});
  const [confirmed, setConfirmed] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [intelValues, setIntelValues] = useState<Record<string, string>>(intel || {});
  const [showIntel, setShowIntel] = useState(false);

  const intelFilled = Object.values(intelValues).filter((v) => String(v).trim()).length;

  function setIntel(name: string, v: string) {
    const next = { ...intelValues, [name]: v };
    setIntelValues(next);
    onIntelChange?.(next);
  }

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

        {/* lead intelligence — after the outcome, not during the call */}
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <button
            className="btn-ghost"
            style={{ padding: "4px 10px", fontSize: "0.7rem" }}
            onClick={() => setShowIntel(!showIntel)}
          >
            {showIntel ? "Hide" : "Anything new about the business?"}
            {intelFilled > 0 ? ` · ${intelFilled}` : ""}
          </button>
          {showIntel && (
            <>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  marginTop: 10,
                }}
              >
                {INTEL_FIELDS.map((f) => (
                  <input
                    key={f.name}
                    placeholder={f.label}
                    value={intelValues[f.name] || ""}
                    onChange={(e) => setIntel(f.name, e.target.value)}
                  />
                ))}
              </div>
              <p className="faint" style={{ marginTop: 8 }}>
                Saved with the outcome — every future caller sees it.
              </p>
            </>
          )}
        </div>

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
              onSave(values, confirmed, intelValues);
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

/** What is worth knowing about a business that a call can establish. */
const INTEL_FIELDS = [
  { name: "owner_name", label: "Owner name" },
  { name: "owner_title", label: "Owner title" },
  { name: "gatekeeper_name", label: "Gatekeeper name" },
  { name: "best_call_day", label: "Best calling day" },
  { name: "best_call_time", label: "Best calling time" },
  { name: "direct_number", label: "Direct number" },
  { name: "extension", label: "Extension" },
  { name: "email", label: "Email" },
  { name: "answering_setup", label: "Current answering setup" },
  { name: "existing_provider", label: "Existing provider" },
  { name: "office_staff_count", label: "Office staff count" },
  { name: "after_hours_process", label: "After-hours process" },
  { name: "other_decision_maker", label: "Other decision-maker" },
  { name: "ownership_type", label: "Independent or franchise" },
  { name: "company_notes", label: "Other company info" },
];
