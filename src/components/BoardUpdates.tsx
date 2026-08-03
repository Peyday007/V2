"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toPlainText } from "@/lib/updates";

// The board's view of what the team has been told.
//
// Deliberately a summary strip rather than the full feed: the board is a
// kanban and the columns need the height. It answers one question — what is
// the current standing instruction — and links to the page where updates are
// written and managed.

type Row = { id: string; title: string; body: string; pinned: boolean; created_at: string };

export default function BoardUpdates() {
  const [updates, setUpdates] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/updates");
      const j = await res.json();
      setUpdates(j.updates ?? []);
      setError(j.error ?? null);
    } catch {
      // Never take the board down over a side panel.
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // A missing table is worth saying; anything else is noise on the board.
  if (updates.length === 0) {
    return error && /migration/i.test(error) ? (
      <div className="card" style={{ borderColor: "var(--red)", marginBottom: 14, flexShrink: 0 }}>
        <p style={{ color: "var(--red)", fontSize: "0.82rem" }}>{error}</p>
      </div>
    ) : null;
  }

  const top = updates[0];
  const rest = updates.length - 1;

  return (
    <div
      style={{
        border: "1px solid var(--border-strong)",
        borderLeft: "3px solid var(--amber)",
        borderRadius: 4,
        padding: "10px 14px",
        marginBottom: 14,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span
          className="faint"
          style={{ fontSize: "0.7rem", letterSpacing: "0.08em", fontWeight: 700 }}
        >
          TEAM UPDATE
        </span>
        {top.pinned && <span className="tag">pinned</span>}
        <strong style={{ fontSize: "0.88rem" }}>{top.title}</strong>
        <div style={{ flex: 1 }} />
        {rest > 0 && (
          <button
            className="btn-ghost"
            style={{ padding: "3px 10px", fontSize: "0.7rem" }}
            onClick={() => setOpen(!open)}
          >
            {open ? "Hide" : `${rest} more`}
          </button>
        )}
        <Link className="btn-ghost" href="/admin/updates" style={{ padding: "3px 10px", fontSize: "0.7rem" }}>
          Post / manage
        </Link>
      </div>

      <p className="faint" style={{ marginTop: 4, lineHeight: 1.5 }}>
        {toPlainText(top.body, 180)}
      </p>

      {open && rest > 0 && (
        <div style={{ marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          {updates.slice(1).map((u) => (
            <div key={u.id} style={{ marginBottom: 6 }}>
              <strong style={{ fontSize: "0.82rem" }}>{u.title}</strong>
              <p className="faint" style={{ lineHeight: 1.5 }}>
                {toPlainText(u.body, 120)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
