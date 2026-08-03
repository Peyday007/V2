"use client";

import { useCallback, useEffect, useState } from "react";
import UpdatesFeed, { type FeedUpdate } from "@/components/UpdatesFeed";
import { badgeLabel } from "@/lib/updates";

// What the caller sees.
//
// The brief asked for this to be impossible to miss on login, so unread
// updates OPEN THEMSELVES the first time a caller loads the dialer — a badge
// alone is something people learn to scroll past. It is not a modal and it
// does not block dialling; it sits above the lead until they press the button
// that says they have read it.
//
// Once read, it collapses to a button in the session bar. Nothing nags after
// that, which is the entire reason last_seen_at exists.

type Payload = {
  updates: FeedUpdate[];
  unseen: number;
  lastSeenAt: string | null;
  error: string | null;
};

export default function CallerUpdates() {
  const [data, setData] = useState<Payload | null>(null);
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  // The timestamp as it was when the panel loaded. Kept so the "new" markers
  // stay on screen while the caller is reading — marking as seen mid-read
  // should not make the markers vanish under their eyes.
  const [readingSince, setReadingSince] = useState<string | null>(null);
  const [autoOpened, setAutoOpened] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dial/updates");
      if (!res.ok) return;
      const j: Payload = await res.json();
      setData(j);
      setReadingSince((prev) => prev ?? j.lastSeenAt);
      // Open once per page load, not every poll.
      if (j.unseen > 0 && !autoOpened) {
        setOpen(true);
        setAutoOpened(true);
      }
    } catch {
      // A failure here must never interfere with dialling.
    }
  }, [autoOpened]);

  useEffect(() => {
    load();
  }, [load]);

  async function markRead() {
    setMarking(true);
    await fetch("/api/dial/updates", { method: "POST" }).catch(() => {});
    setMarking(false);
    setOpen(false);
    const res = await fetch("/api/dial/updates").catch(() => null);
    if (res?.ok) setData(await res.json());
  }

  if (!data || data.updates.length === 0) return null;

  const badge = badgeLabel(data.unseen);

  if (!open) {
    return (
      <button
        className={badge ? "btn" : "btn-ghost"}
        onClick={() => setOpen(true)}
        style={{ padding: "4px 12px" }}
        title="Process and script updates from the office"
      >
        Updates{badge ? ` · ${badge}` : ""}
      </button>
    );
  }

  return (
    <div
      style={{
        gridColumn: "1 / -1",
        width: "100%",
        border: `2px solid ${badge ? "var(--amber)" : "var(--border-strong)"}`,
        background: badge ? "var(--amber-soft)" : "transparent",
        borderRadius: 4,
        padding: "16px 18px",
        marginBottom: 12,
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", marginBottom: 12 }}>
        <strong style={{ color: badge ? "var(--amber)" : "var(--text)" }}>
          {badge ? "Read this before your shift" : "Team updates"}
        </strong>
        {badge && <span className="tag">{badge}</span>}
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={() => setOpen(false)} style={{ padding: "3px 10px" }}>
          Hide
        </button>
      </div>

      <UpdatesFeed updates={data.updates} unseenSince={readingSince} />

      {badge && (
        <button
          className="btn"
          onClick={markRead}
          disabled={marking}
          style={{ marginTop: 14 }}
        >
          {marking ? "…" : "Got it — don't show me again"}
        </button>
      )}
    </div>
  );
}
