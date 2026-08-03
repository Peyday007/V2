"use client";

import { useCallback, useEffect, useState } from "react";
import UpdatesFeed, { type FeedUpdate } from "@/components/UpdatesFeed";
import Markdown from "@/components/Markdown";
import { MAX_BODY, MAX_TITLE } from "@/lib/updates";

type Payload = {
  updates: FeedUpdate[];
  archived: FeedUpdate[];
  error: string | null;
};

export default function UpdatesPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/updates");
      const j = await res.json();
      setData({ updates: j.updates ?? [], archived: j.archived ?? [], error: j.error ?? null });
    } catch (e) {
      setData({
        updates: [],
        archived: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function post() {
    setBusy(true);
    setErr("");
    setMsg("");
    const res = await fetch("/api/updates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, pinned }),
    });
    const j = await res.json();
    setBusy(false);
    if (!res.ok || j.error) {
      setErr(j.error || "Could not post that.");
      return;
    }
    setTitle("");
    setBody("");
    setPinned(false);
    setPreview(false);
    setMsg("Posted. Every caller sees it the next time they open the dialer.");
    load();
  }

  async function patch(patchBody: Record<string, unknown>) {
    setBusy(true);
    setErr("");
    const res = await fetch("/api/updates", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patchBody),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || j.error) {
      setErr(j.error || "Could not save that.");
      return;
    }
    load();
  }

  if (!data) return <p className="muted">Loading…</p>;

  return (
    <div style={{ maxWidth: 860, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>Team updates</h1>
      <p className="faint" style={{ marginBottom: 20, lineHeight: 1.6 }}>
        Say it once here instead of texting every VA the same paragraph. Unread
        updates open by themselves the next time a caller loads the dialer, and
        stop nagging once they have pressed the button that says they read it.
        Anyone new starts with the whole history, so this doubles as onboarding.
      </p>

      {data.error && (
        <div
          className="card"
          style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 16, lineHeight: 1.55 }}
        >
          {data.error}
        </div>
      )}
      {err && (
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 16 }}>
          {err}
        </div>
      )}
      {msg && (
        <div className="card" style={{ borderColor: "var(--amber-dim)", color: "var(--amber)", marginBottom: 16 }}>
          {msg}
        </div>
      )}

      {/* ------------------------------ post one ---------------------------- */}
      <div className="card" style={{ marginBottom: 28 }}>
        <h2 style={{ marginTop: 0, marginBottom: 12 }}>Post an update</h2>
        <div style={{ display: "grid", gap: 10 }}>
          <input
            placeholder="Title — what changed, in one line"
            value={title}
            maxLength={MAX_TITLE}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            placeholder={"What changed, and what to do about it.\n\n**Bold** and *italic* work. Start a line with - for a bullet, or # for a heading."}
            rows={12}
            value={body}
            maxLength={MAX_BODY}
            onChange={(e) => setBody(e.target.value)}
            style={{ fontFamily: "inherit", lineHeight: 1.6 }}
          />
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
              <span>Pin to the top</span>
            </label>
            <span className="faint">Pinned updates sit above everything, however old.</span>
            <div style={{ flex: 1 }} />
            <button
              className={preview ? "btn" : "btn-ghost"}
              onClick={() => setPreview(!preview)}
              disabled={!body.trim()}
            >
              {preview ? "Hide preview" : "Preview"}
            </button>
            <button className="btn" onClick={post} disabled={busy || !title.trim() || !body.trim()}>
              {busy ? "Posting…" : "Post update"}
            </button>
          </div>
        </div>

        {preview && body.trim() && (
          <div
            style={{
              marginTop: 14,
              paddingTop: 14,
              borderTop: "1px solid var(--border)",
            }}
          >
            <div className="faint" style={{ marginBottom: 8 }}>
              This is exactly what the callers will see:
            </div>
            <div
              style={{
                border: "1px solid var(--amber-dim)",
                borderLeft: "3px solid var(--amber)",
                borderRadius: 4,
                padding: "14px 16px",
                background: "var(--bg-inset)",
              }}
            >
              <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: "1rem", textTransform: "none", letterSpacing: 0 }}>
                {title || "(no title yet)"}
              </h3>
              <Markdown body={body} />
            </div>
          </div>
        )}
      </div>

      {/* ------------------------------ the feed ---------------------------- */}
      <h2 style={{ marginBottom: 12 }}>
        Live ({data.updates.length})
      </h2>
      <div style={{ marginBottom: 28 }}>
        <UpdatesFeed
          updates={data.updates}
          emptyMessage="Nothing posted yet. The first one you post is what a new caller reads on day one."
        >
          {(u) => (
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="btn-ghost"
                style={{ padding: "3px 10px", fontSize: "0.7rem" }}
                disabled={busy}
                onClick={() => patch({ id: u.id, pinned: !u.pinned })}
              >
                {u.pinned ? "Unpin" : "Pin"}
              </button>
              <button
                className="btn-ghost"
                style={{ padding: "3px 10px", fontSize: "0.7rem" }}
                disabled={busy}
                onClick={() => patch({ id: u.id, archived: true })}
                title="Removes it from the callers' panel. Nothing is deleted."
              >
                Retire
              </button>
            </div>
          )}
        </UpdatesFeed>
      </div>

      {/* ------------------------------ retired ----------------------------- */}
      {data.archived.length > 0 && (
        <>
          <button
            className="btn-ghost"
            onClick={() => setShowArchived(!showArchived)}
            style={{ marginBottom: 12 }}
          >
            {showArchived ? "Hide" : "Show"} retired ({data.archived.length})
          </button>
          {showArchived && (
            <div style={{ marginBottom: 40 }}>
              <UpdatesFeed updates={data.archived}>
                {(u) => (
                  <button
                    className="btn-ghost"
                    style={{ padding: "3px 10px", fontSize: "0.7rem" }}
                    disabled={busy}
                    onClick={() => patch({ id: u.id, archived: false })}
                  >
                    Put back
                  </button>
                )}
              </UpdatesFeed>
            </div>
          )}
        </>
      )}
    </div>
  );
}
