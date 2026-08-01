"use client";

import { useMemo, useState } from "react";
import {
  SUGGESTION_TYPE_LABEL,
  suggestionsFor,
  type AssistantContext,
} from "@/lib/callStages";

/**
 * The one thing worth saying next. The prospect cannot see or hear any of it.
 *
 * Deliberately thin. It used to carry thirteen stage buttons, a "used it"
 * button, a "not now" button and a star rating — four controls asking the
 * caller to describe or grade the software while somebody was talking to them.
 * The stage is now inferred (see inferStage in dialerFocus), and grading moved
 * off the live screen entirely.
 */
export default function LiveAssistant({ ctx }: { ctx: AssistantContext }) {
  const [showAll, setShowAll] = useState(false);

  const suggestions = useMemo(() => suggestionsFor(ctx), [ctx]);
  const primary = suggestions[0] ?? null;
  const rest = suggestions.slice(1);

  if (!primary) return null;

  const urgent = primary.type === "compliance_warning";

  return (
    <div
      style={{
        padding: "10px 12px",
        background: "var(--bg-inset)",
        border: `1px solid ${urgent ? "var(--red)" : "var(--amber-dim)"}`,
        borderRadius: 4,
      }}
    >
      <div
        className="faint"
        style={{
          fontWeight: 700,
          color: urgent ? "var(--red)" : "var(--amber)",
          marginBottom: 3,
        }}
      >
        {SUGGESTION_TYPE_LABEL[primary.type]}
      </div>
      <div style={{ fontSize: "0.95rem", lineHeight: 1.4, fontWeight: 600 }}>
        {primary.headline}
      </div>
      {primary.detail && (
        <div className="faint" style={{ marginTop: 4, lineHeight: 1.45 }}>
          {primary.detail}
        </div>
      )}

      {rest.length > 0 && (
        <div style={{ marginTop: 7 }}>
          <button
            className="btn-ghost"
            style={{ padding: "2px 8px", fontSize: "0.66rem" }}
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? "Less" : `${rest.length} more`}
          </button>
          {showAll && (
            <div style={{ marginTop: 6, display: "grid", gap: 5 }}>
              {rest.map((s) => (
                <div key={s.id} style={{ fontSize: "0.8rem", lineHeight: 1.4 }}>
                  <span className="faint">{SUGGESTION_TYPE_LABEL[s.type]}: </span>
                  {s.headline}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
