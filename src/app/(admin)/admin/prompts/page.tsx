"use client";

import { useCallback, useEffect, useState } from "react";
import {
  validateTemplate,
  renderTemplate,
  sampleValues,
  type PromptDef,
  type TemplateProblem,
} from "@/lib/prompts";
import { useConfirm } from "@/components/Confirm";

type LoadedPrompt = PromptDef & {
  override: string | null;
  note: string | null;
  updatedAt: string | null;
};

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<LoadedPrompt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/prompts");
    const j = await res.json();
    setPrompts(j.prompts || []);
    setError(j.error ?? null);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>Prompts</h1>
      <p className="faint" style={{ marginBottom: 20, lineHeight: 1.6 }}>
        The exact wording sent to the AI, for you to change without a code
        change. Each one shows the variables it can use — type{" "}
        <code>{"{{business_name}}"}</code> and the real value is substituted when
        it runs.
      </p>
      <p className="faint" style={{ marginBottom: 22, lineHeight: 1.6 }}>
        <strong>You cannot break anything permanently.</strong> Every prompt has
        the wording it shipped with, one button away. If a saved prompt ever
        fails to make sense, the app silently uses the original rather than
        sending something broken.
      </p>

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 16 }}>
          {error}
        </div>
      )}
      {msg && (
        <div className="card" style={{ borderColor: "var(--amber-dim)", color: "var(--amber)", marginBottom: 16 }}>
          {msg}
        </div>
      )}

      {!prompts && <p className="muted">Loading…</p>}

      <div style={{ display: "grid", gap: 16 }}>
        {(prompts || []).map((p) => (
          <PromptEditor key={p.key} p={p} onSaved={(m) => { setMsg(m); load(); }} />
        ))}
      </div>
    </div>
  );
}

function PromptEditor({ p, onSaved }: { p: LoadedPrompt; onSaved: (msg: string) => void }) {
  const [text, setText] = useState(p.override ?? p.default);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const { ask, dialog } = useConfirm();

  const problems: TemplateProblem[] = validateTemplate(p, text);
  const errors = problems.filter((x) => x.level === "error");
  const warnings = problems.filter((x) => x.level === "warning");
  const changed = text !== (p.override ?? p.default);
  const isCustom = p.override !== null;

  async function save() {
    setBusy(true);
    setErr("");
    const res = await fetch("/api/prompts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: p.key, template: text }),
    });
    const j = await res.json();
    setBusy(false);
    if (!res.ok) {
      setErr(j.error || "Could not save that.");
      return;
    }
    onSaved(`Saved. "${p.label}" now uses your wording.`);
  }

  async function reset() {
    const ok = await ask({
      title: `Put "${p.label}" back to the original?`,
      body: [
        "Your version is discarded and the wording the app shipped with takes over immediately.",
        "The old wording is kept in the History tab, so nothing is truly lost.",
      ],
      confirmLabel: "Restore the original",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    const res = await fetch(`/api/prompts?key=${encodeURIComponent(p.key)}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error || "Could not reset.");
      return;
    }
    setText(p.default);
    onSaved(`"${p.label}" is back to the original wording.`);
  }

  return (
    <div className="card">
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <h3 style={{ fontSize: "1.02rem" }}>{p.label}</h3>
        {isCustom ? (
          <span className="tag">edited</span>
        ) : (
          <span className="tag-dim">original</span>
        )}
        <div style={{ flex: 1 }} />
        <button
          className="btn-ghost"
          style={{ padding: "4px 12px", fontSize: "0.7rem" }}
          onClick={() => setOpen(!open)}
        >
          {open ? "Close" : "Edit"}
        </button>
      </div>

      <p className="faint" style={{ marginTop: 4, lineHeight: 1.55 }}>
        {p.usedFor}
      </p>
      <p className="faint" style={{ marginTop: 2, lineHeight: 1.55 }}>
        {p.affects}
      </p>

      {open && (
        <>
          <div style={{ marginTop: 14 }}>
            <div className="faint" style={{ fontWeight: 700, marginBottom: 6 }}>
              Variables you can use
            </div>
            <div style={{ display: "grid", gap: 4 }}>
              {p.variables.map((v) => (
                <div key={v.name} style={{ fontSize: "0.8rem" }}>
                  <button
                    className="tag-dim"
                    style={{ border: "none", cursor: "pointer", marginRight: 8 }}
                    onClick={() => setText((t) => `${t}{{${v.name}}}`)}
                    title="Click to add it to the end of the prompt"
                  >
                    {`{{${v.name}}}`}
                  </button>
                  <span className="faint">{v.description}</span>
                </div>
              ))}
            </div>
          </div>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={16}
            spellCheck={false}
            style={{
              width: "100%",
              marginTop: 12,
              fontFamily: "inherit",
              fontSize: "0.82rem",
              lineHeight: 1.55,
            }}
          />

          {errors.map((x, i) => (
            <p key={i} style={{ color: "var(--red)", fontSize: "0.82rem", marginTop: 6 }}>
              {x.message}
            </p>
          ))}
          {warnings.map((x, i) => (
            <p key={i} style={{ color: "var(--amber)", fontSize: "0.82rem", marginTop: 6 }}>
              {x.message}
            </p>
          ))}
          {err && (
            <p style={{ color: "var(--red)", fontSize: "0.82rem", marginTop: 6 }}>{err}</p>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button
              className="btn"
              onClick={save}
              disabled={busy || errors.length > 0 || !changed}
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              className="btn-ghost"
              onClick={() => setPreview(!preview)}
              disabled={errors.length > 0}
            >
              {preview ? "Hide preview" : "Preview with example data"}
            </button>
            {changed && (
              <button className="btn-ghost" onClick={() => setText(p.override ?? p.default)}>
                Undo my edits
              </button>
            )}
            <div style={{ flex: 1 }} />
            {isCustom && (
              <button className="btn-danger" onClick={reset} disabled={busy}>
                Restore the original
              </button>
            )}
          </div>

          {preview && errors.length === 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="faint" style={{ fontWeight: 700, marginBottom: 6 }}>
                This is exactly what the AI would receive
              </div>
              <pre
                style={{
                  padding: 12,
                  background: "var(--bg-inset)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: "0.78rem",
                  lineHeight: 1.55,
                  maxHeight: 320,
                  overflowY: "auto",
                }}
              >
                {renderTemplate(text, sampleValues(p))}
              </pre>
            </div>
          )}

          {p.updatedAt && (
            <p className="faint" style={{ marginTop: 10 }}>
              Last changed {new Date(p.updatedAt).toLocaleString()}. Previous
              wordings are in the History tab.
            </p>
          )}
        </>
      )}

      {dialog}
    </div>
  );
}
