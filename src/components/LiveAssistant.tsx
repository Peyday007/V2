"use client";

import { useMemo, useState } from "react";
import {
  CALL_STAGES,
  STAGE_LABEL,
  SUGGESTION_TYPE_LABEL,
  suggestionsFor,
  suggestedOutcomeFor,
  type CallStage,
  type AssistantContext,
} from "@/lib/callStages";

/**
 * The caller's private panel. The prospect is on the phone and cannot see or
 * hear any of this.
 *
 * One suggestion at a time by design — a wall of advice mid-conversation is
 * worse than none. Everything else stays one click away.
 */
export default function LiveAssistant({
  ctx,
  onStageChange,
  onFeedback,
  recordingState,
}: {
  ctx: AssistantContext;
  onStageChange: (stage: CallStage) => void;
  onFeedback: (
    suggestionId: string,
    action: "used" | "dismissed" | "rated",
    rating?: number
  ) => void;
  recordingState?: { active: boolean; label: string } | null;
}) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [rated, setRated] = useState<Record<string, number>>({});

  const suggestions = useMemo(
    () => suggestionsFor(ctx).filter((s) => !dismissed.includes(s.id)),
    [ctx, dismissed]
  );
  const primary = suggestions[0] ?? null;
  const rest = suggestions.slice(1);
  const suggestedOutcome = suggestedOutcomeFor(ctx.stage);

  function dismiss(id: string) {
    setDismissed((d) => [...d, id]);
    onFeedback(id, "dismissed");
  }

  return (
    <div className="card" style={{ borderColor: "var(--amber-dim)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h3 style={{ color: "var(--amber)" }}>Assistant</h3>
        <span className="faint">only you can see this</span>
        <div style={{ flex: 1 }} />
        {recordingState && (
          <span
            className="tag-dim"
            style={{ color: recordingState.active ? "var(--red)" : "var(--text-dim)" }}
            title={recordingState.label}
          >
            {recordingState.active ? "● recording" : "not recording"}
          </span>
        )}
      </div>

      {/* ------------------------------ the stage ------------------------------ */}
      <div style={{ marginTop: 10 }}>
        <div className="faint" style={{ marginBottom: 5 }}>
          Where are you in the call?
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {CALL_STAGES.filter((s) => s !== "completed").map((s) => (
            <button
              key={s}
              onClick={() => {
                onStageChange(s);
                setDismissed([]);
                setShowAll(false);
              }}
              style={{
                padding: "3px 8px",
                borderRadius: 3,
                fontSize: "0.66rem",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                cursor: "pointer",
                border: `1px solid ${ctx.stage === s ? "var(--amber)" : "var(--border-strong)"}`,
                background: ctx.stage === s ? "var(--amber-soft)" : "transparent",
                color: ctx.stage === s ? "var(--amber)" : "var(--text-dim)",
              }}
            >
              {STAGE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {/* --------------------------- the one suggestion --------------------------- */}
      {primary ? (
        <div
          style={{
            marginTop: 12,
            padding: "12px 14px",
            background: "var(--bg-inset)",
            border: `1px solid ${
              primary.type === "compliance_warning" ? "var(--red)" : "var(--amber-dim)"
            }`,
            borderRadius: 4,
          }}
        >
          <div
            className="faint"
            style={{
              fontWeight: 700,
              color: primary.type === "compliance_warning" ? "var(--red)" : "var(--amber)",
              marginBottom: 4,
            }}
          >
            {SUGGESTION_TYPE_LABEL[primary.type]}
          </div>
          <div style={{ fontSize: "1rem", lineHeight: 1.45, fontWeight: 600 }}>
            {primary.headline}
          </div>
          {primary.detail && (
            <div className="faint" style={{ marginTop: 5, lineHeight: 1.45 }}>
              {primary.detail}
            </div>
          )}

          <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button
              className="btn"
              style={{ padding: "4px 12px", fontSize: "0.7rem" }}
              onClick={() => {
                onFeedback(primary.id, "used");
                setDismissed((d) => [...d, primary.id]);
              }}
            >
              Used it
            </button>
            <button
              className="btn-ghost"
              style={{ padding: "4px 12px", fontSize: "0.7rem" }}
              onClick={() => dismiss(primary.id)}
            >
              Not now
            </button>
            <div style={{ flex: 1 }} />
            <span className="faint">helpful?</span>
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                onClick={() => {
                  setRated((r) => ({ ...r, [primary.id]: n }));
                  onFeedback(primary.id, "rated", n);
                }}
                title={n === 1 ? "no" : n === 2 ? "some" : "yes"}
                style={{
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                  opacity: (rated[primary.id] ?? 0) >= n ? 1 : 0.3,
                  color: "var(--amber)",
                }}
              >
                ★
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="faint" style={{ marginTop: 12 }}>
          Nothing else to suggest here — you are on top of it.
        </p>
      )}

      {/* ------------------------------- the rest ------------------------------- */}
      {rest.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button
            className="btn-ghost"
            style={{ padding: "3px 10px", fontSize: "0.68rem" }}
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? "Hide" : `${rest.length} more`}
          </button>
          {showAll && (
            <div style={{ marginTop: 8, display: "grid", gap: 7 }}>
              {rest.map((s) => (
                <div key={s.id} style={{ fontSize: "0.82rem", lineHeight: 1.45 }}>
                  <span className="faint">{SUGGESTION_TYPE_LABEL[s.type]}: </span>
                  {s.headline}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {suggestedOutcome && (
        <p className="faint" style={{ marginTop: 10 }}>
          When you hang up, this probably logs as{" "}
          <strong>{suggestedOutcome.replace(/_/g, " ")}</strong>.
        </p>
      )}
    </div>
  );
}
