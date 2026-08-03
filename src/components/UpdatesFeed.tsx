"use client";

import Markdown from "@/components/Markdown";

// The feed itself, shared by the admin page and the caller's panel so the two
// cannot drift into showing the updates in a different order or rendering the
// same body two different ways.

export type FeedUpdate = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  created_at: string;
  archived_at?: string | null;
};

export function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function UpdatesFeed({
  updates,
  unseenSince,
  emptyMessage = "Nothing posted yet.",
  children,
}: {
  updates: FeedUpdate[];
  /** Anything newer than this gets a "new" marker. */
  unseenSince?: string | null;
  emptyMessage?: string;
  /** Per-update admin controls, when there are any. */
  children?: (u: FeedUpdate) => React.ReactNode;
}) {
  if (updates.length === 0) {
    return <p className="faint">{emptyMessage}</p>;
  }

  const seenAt = unseenSince ? Date.parse(unseenSince) : NaN;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {updates.map((u) => {
        const isNew = !unseenSince || (Number.isFinite(seenAt) && Date.parse(u.created_at) > seenAt);
        return (
          <article
            key={u.id}
            style={{
              border: `1px solid ${u.pinned ? "var(--amber-dim)" : "var(--border)"}`,
              borderLeft: `3px solid ${u.pinned ? "var(--amber)" : "var(--border-strong)"}`,
              borderRadius: 4,
              padding: "14px 16px",
              background: u.archived_at ? "transparent" : "var(--bg-inset)",
              opacity: u.archived_at ? 0.6 : 1,
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "baseline",
                flexWrap: "wrap",
                marginBottom: 8,
              }}
            >
              <h3 style={{ margin: 0, fontSize: "1rem", textTransform: "none", letterSpacing: 0 }}>
                {u.title}
              </h3>
              {u.pinned && <span className="tag">pinned</span>}
              {isNew && !u.archived_at && (
                <span className="tag" style={{ color: "var(--amber)" }}>
                  new
                </span>
              )}
              {u.archived_at && <span className="tag-dim">retired</span>}
              <span className="faint">{when(u.created_at)}</span>
              <div style={{ flex: 1 }} />
              {children?.(u)}
            </div>
            <Markdown body={u.body} />
          </article>
        );
      })}
    </div>
  );
}
