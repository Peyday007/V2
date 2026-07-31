"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Item = {
  id: string;
  callId: string | null;
  leadId: string;
  kind: string;
  reason: string | null;
  target: string | null;
  draftSubject: string | null;
  draftBody: string | null;
  assignedTo: string | null;
  dueAt: string;
  status: string;
  urgency: "overdue" | "due_now" | "soon" | "later" | "done";
  urgencyLabel: string;
  minutesLate: number;
  lead: { business_name: string; phone: string; city: string; state: string } | null;
  timeline: Record<string, string | null>;
  needsAlert: boolean;
};

type Payload = {
  items: Item[];
  open: number;
  overdue: number;
  deadlineMinutes: number;
  automaticSending: boolean;
  medianResponseMinutes: number | null;
  sentCount: number;
  withinTarget: number;
};

const URGENCY_COLOR: Record<string, string> = {
  overdue: "var(--red)",
  due_now: "var(--amber)",
  soon: "var(--amber)",
  later: "var(--text-dim)",
  done: "var(--text-dim)",
};

export default function FollowupsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/followups");
    const j = await res.json();
    if (!res.ok) {
      setError(j.error || "Could not load the queue.");
      return;
    }
    setError(null);
    setData(j);
  }, []);

  useEffect(() => {
    load();
    // The queue is about minutes, so it has to move on its own.
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  async function act(id: string, action: string, extra: Record<string, unknown> = {}) {
    setBusy(id);
    const res = await fetch("/api/followups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action, ...extra }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || "That did not work.");
    }
    setBusy(null);
    load();
  }

  if (error) {
    return (
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <h1 style={{ marginBottom: 16 }}>Follow-ups</h1>
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>
          {error}
        </div>
      </div>
    );
  }
  if (!data) return <p className="muted">Loading…</p>;

  const open = data.items.filter((i) => i.urgency !== "done");
  const done = data.items.filter((i) => i.urgency === "done");

  return (
    <div style={{ maxWidth: 950, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>Follow-ups</h1>
      <p className="faint" style={{ marginBottom: 18, lineHeight: 1.6 }}>
        A warm prospect goes cold in minutes. Anything a caller promised, or any
        call that ended in real interest, lands here with a draft already
        written and <strong>{data.deadlineMinutes} minutes</strong> on the clock.
        {!data.automaticSending && " Nothing is sent until you press send."}
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <Stat label="Waiting" value={String(data.open)} accent={data.open > 0} />
        <Stat label="Overdue" value={String(data.overdue)} danger={data.overdue > 0} />
        <Stat
          label="Typical time to send"
          value={data.medianResponseMinutes === null ? "—" : `${data.medianResponseMinutes} min`}
          sub={data.sentCount > 0 ? `${data.sentCount} sent` : "nothing sent yet"}
        />
        <Stat
          label="Hit the target"
          value={
            data.sentCount > 0
              ? `${Math.round((data.withinTarget / data.sentCount) * 100)}%`
              : "—"
          }
          sub={`within ${data.deadlineMinutes} min`}
        />
      </div>

      <h2 style={{ marginBottom: 10 }}>Waiting on someone ({open.length})</h2>
      {open.length === 0 ? (
        <p className="muted" style={{ marginBottom: 28 }}>
          Nothing outstanding. Follow-ups appear the moment a caller logs an
          interested prospect.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 10, marginBottom: 30 }}>
          {open.map((i) => (
            <div
              key={i.id}
              className="card"
              style={{
                borderColor: i.urgency === "overdue" ? "var(--red)" : "var(--amber-dim)",
              }}
            >
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                <strong>{i.lead?.business_name || "(lead removed)"}</strong>
                <span
                  className="tag-dim"
                  style={{ color: URGENCY_COLOR[i.urgency], fontWeight: 700 }}
                >
                  {i.urgencyLabel}
                </span>
                <span className="faint">
                  {i.kind.replace(/_/g, " ")}
                  {i.assignedTo && ` · ${i.assignedTo}`}
                  {i.target && ` · ${i.target}`}
                </span>
                <div style={{ flex: 1 }} />
                <Link href={`/admin/leads/${i.leadId}`} className="faint">
                  full record →
                </Link>
              </div>

              {i.reason && (
                <div className="faint" style={{ marginTop: 3 }}>
                  {i.reason}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button
                  className="btn-ghost"
                  style={{ padding: "5px 12px", fontSize: "0.72rem" }}
                  onClick={() => setOpenId(openId === i.id ? null : i.id)}
                >
                  {openId === i.id ? "Hide draft" : "Open draft"}
                </button>
                <button
                  className="btn"
                  style={{ padding: "5px 12px", fontSize: "0.72rem" }}
                  disabled={busy === i.id}
                  onClick={() => act(i.id, "sent")}
                  title="Mark it sent. The clock stops here."
                >
                  Mark sent
                </button>
                <button
                  className="btn-ghost"
                  style={{ padding: "5px 12px", fontSize: "0.72rem" }}
                  disabled={busy === i.id}
                  onClick={() => act(i.id, "answered")}
                >
                  They replied
                </button>
                <button
                  className="btn-ghost"
                  style={{ padding: "5px 12px", fontSize: "0.72rem" }}
                  disabled={busy === i.id}
                  onClick={() => act(i.id, "converted")}
                >
                  Converted
                </button>
                <div style={{ flex: 1 }} />
                <button
                  className="btn-danger"
                  style={{ padding: "5px 12px", fontSize: "0.72rem" }}
                  disabled={busy === i.id}
                  onClick={() => act(i.id, "cancel")}
                >
                  Not needed
                </button>
              </div>

              {openId === i.id && (
                <DraftEditor
                  item={i}
                  onSave={(subject, body) => act(i.id, "save_draft", { subject, body })}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <>
          <h2 style={{ marginBottom: 10 }}>Handled ({done.length})</h2>
          <table>
            <thead>
              <tr>
                <th>Business</th>
                <th>Outcome</th>
                <th>Sent</th>
                <th>Replied</th>
              </tr>
            </thead>
            <tbody>
              {done.slice(0, 50).map((i) => (
                <tr key={i.id}>
                  <td style={{ fontWeight: 600 }}>{i.lead?.business_name || "—"}</td>
                  <td className="faint">{i.status}</td>
                  <td className="faint">
                    {i.timeline.sent ? new Date(i.timeline.sent).toLocaleString() : "—"}
                  </td>
                  <td className="faint">
                    {i.timeline.answered ? new Date(i.timeline.answered).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function DraftEditor({
  item,
  onSave,
}: {
  item: Item;
  onSave: (subject: string, body: string) => void;
}) {
  const [subject, setSubject] = useState(item.draftSubject || "");
  const [body, setBody] = useState(item.draftBody || "");
  const changed = subject !== (item.draftSubject || "") || body !== (item.draftBody || "");

  return (
    <div
      style={{
        marginTop: 12,
        paddingTop: 12,
        borderTop: "1px solid var(--border)",
      }}
    >
      <p className="faint" style={{ marginBottom: 8 }}>
        Written from what the call actually established — nothing invented. Edit
        it, copy it, send it from your own mail.
      </p>
      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject"
        style={{ width: "100%", marginBottom: 8 }}
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={10}
        style={{ width: "100%", fontFamily: "inherit", fontSize: "0.85rem", lineHeight: 1.6 }}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <button
          className="btn-ghost"
          style={{ padding: "5px 12px", fontSize: "0.72rem" }}
          onClick={() => {
            navigator.clipboard?.writeText(`${subject}\n\n${body}`);
          }}
        >
          Copy
        </button>
        {item.target && (
          <a
            className="btn-ghost"
            style={{ padding: "5px 12px", fontSize: "0.72rem" }}
            href={`mailto:${item.target}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}
          >
            Open in mail
          </a>
        )}
        <div style={{ flex: 1 }} />
        {changed && (
          <button
            className="btn"
            style={{ padding: "5px 12px", fontSize: "0.72rem" }}
            onClick={() => onSave(subject, body)}
          >
            Save changes
          </button>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
  danger,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="card" style={{ textAlign: "center" }}>
      <div
        style={{
          fontSize: "1.7rem",
          fontWeight: 700,
          color: danger ? "var(--red)" : accent ? "var(--amber)" : "var(--text)",
        }}
      >
        {value}
      </div>
      <div className="faint">{label}</div>
      {sub && <div className="faint">{sub}</div>}
    </div>
  );
}
