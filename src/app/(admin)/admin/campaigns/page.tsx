"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Caller = { id: string; name: string; active: boolean };

type Packet = {
  id: string;
  name: string;
  status: string;
  caller_id: string | null;
  created_at: string;
  total: number;
  done: number;
  remaining: number;
  callsMade: number;
  canDelete: boolean;
  callers: { id: string; name: string; active: boolean } | null;
};

export default function PacketsAdmin() {
  const [callers, setCallers] = useState<Caller[]>([]);
  const [packets, setPackets] = useState<Packet[] | null>(null);
  const [ready, setReady] = useState(0);
  const [newCaller, setNewCaller] = useState("");
  const [newSize, setNewSize] = useState("50");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [attack, setAttack] = useState("");
  const [attackLoading, setAttackLoading] = useState(false);

  const load = useCallback(async () => {
    const [pRes, kRes, pipeRes] = await Promise.all([
      fetch("/api/packets"),
      fetch("/api/callers"),
      fetch("/api/pipeline"),
    ]);
    setPackets(await pRes.json());
    const cs: Caller[] = await kRes.json();
    const active = (cs || []).filter((k) => k.active);
    setCallers(active);
    setNewCaller((prev) => prev || active[0]?.id || "");
    if (pipeRes.ok) {
      const pipe = await pipeRes.json();
      setReady(pipe.counts?.readyToCall ?? 0);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(key: string, fn: () => Promise<Response>, success: (j: never) => string) {
    setBusy(key);
    setMsg("");
    setErr("");
    const res = await fn();
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setErr(j.error || "That did not work.");
    else setMsg(success(j as never));
    setBusy(null);
    await load();
  }

  function createPacket() {
    const name = callers.find((k) => k.id === newCaller)?.name || "the caller";
    return run(
      "create",
      () =>
        fetch("/api/packets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ caller_id: newCaller, size: Number(newSize) }),
        }),
      (j: { total: number; suppressed_excluded?: number }) =>
        `Sent ${j.total} leads to ${name}.` +
        (j.suppressed_excluded
          ? ` ${j.suppressed_excluded} were skipped — on the do-not-call list.`
          : "")
    );
  }

  function reassign(p: Packet, callerId: string) {
    const name = callers.find((k) => k.id === callerId)?.name || "that caller";
    return run(
      p.id,
      () =>
        fetch(`/api/packets/${p.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ caller_id: callerId }),
        }),
      () => `Moved to ${name}. It is in their dialer now.`
    );
  }

  function addLeads(p: Packet, size: number) {
    return run(
      p.id,
      () =>
        fetch(`/api/packets/${p.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "add_leads", size }),
        }),
      (j: { added: number }) => `Added ${j.added} more leads to ${p.name}.`
    );
  }

  function returnLeads(p: Packet) {
    if (
      !confirm(
        `Take back the ${p.remaining} un-dialed lead${p.remaining === 1 ? "" : "s"} in this packet?\n\n` +
          `They go back into the ready pool so you can send them to someone else. ` +
          `Calls already logged are kept. The packet closes.`
      )
    )
      return;
    return run(
      p.id,
      () =>
        fetch(`/api/packets/${p.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "return_leads" }),
        }),
      (j: { returned: number }) =>
        `${j.returned} leads are back in the pool and ready to send to someone else.`
    );
  }

  function remove(p: Packet) {
    if (
      !confirm(
        `Delete "${p.name}"?\n\nNobody has dialed from it, so all ${p.total} leads go straight back into the ready pool. Nothing is lost.`
      )
    )
      return;
    return run(
      p.id,
      () => fetch(`/api/packets/${p.id}`, { method: "DELETE" }),
      (j: { returned: number }) => `Packet deleted. ${j.returned} leads went back to the pool.`
    );
  }

  async function whatToAttack() {
    setAttackLoading(true);
    setAttack("");
    const res = await fetch("/api/prioritize");
    const j = await res.json();
    setAttack(res.ok ? j.recommendation : j.error || "Failed");
    setAttackLoading(false);
  }

  const open = (packets || []).filter((p) => p.status === "open");
  const closed = (packets || []).filter((p) => p.status !== "open");

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>Packets</h1>
      <p className="faint" style={{ marginBottom: 22, lineHeight: 1.6 }}>
        A packet is a caller&apos;s list of leads to work through. A lead can only
        be in one packet at a time, so nobody ever gets called twice. Everything
        here is reversible — taking leads back puts them straight into the ready
        pool for someone else.
      </p>

      {(msg || err) && (
        <div
          className="card"
          style={{
            marginBottom: 18,
            borderColor: err ? "var(--red)" : "var(--amber-dim)",
            color: err ? "var(--red)" : "var(--amber)",
          }}
        >
          {err || msg}
        </div>
      )}

      {/* ------------------------------ send a packet ----------------------------- */}
      <div className="card" style={{ marginBottom: 26, borderColor: "var(--amber-dim)" }}>
        <h3 style={{ marginBottom: 6, color: "var(--amber)" }}>Send out a packet</h3>
        <p className="faint" style={{ marginBottom: 12 }}>
          <strong>{ready}</strong> lead{ready === 1 ? "" : "s"} ready to send.
          {ready === 0 && (
            <>
              {" "}
              Generate more on the <Link href="/admin/sourcing">Leads</Link> tab.
            </>
          )}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select
            value={newCaller}
            onChange={(e) => setNewCaller(e.target.value)}
            style={{ maxWidth: 200 }}
          >
            <option value="">Choose a caller…</option>
            {callers.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
          <span className="faint">gets</span>
          <input
            type="number"
            value={newSize}
            onChange={(e) => setNewSize(e.target.value)}
            style={{ maxWidth: 80 }}
            min={1}
          />
          <span className="faint">leads</span>
          <button
            className="btn"
            onClick={createPacket}
            disabled={busy === "create" || !newCaller || ready === 0}
          >
            {busy === "create" ? "Sending…" : "Send it"}
          </button>
        </div>
        {callers.length === 0 && (
          <p className="faint" style={{ marginTop: 10 }}>
            No callers yet — add one on the <Link href="/admin/callers">Callers</Link> tab
            first.
          </p>
        )}
      </div>

      {/* ------------------------------- open packets ----------------------------- */}
      <h2 style={{ marginBottom: 10 }}>Being worked on ({open.length})</h2>
      {packets === null ? (
        <p className="muted">Loading…</p>
      ) : open.length === 0 ? (
        <p className="muted" style={{ marginBottom: 30 }}>
          Nothing out with a caller right now.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 10, marginBottom: 30 }}>
          {open.map((p) => (
            <PacketRow
              key={p.id}
              p={p}
              callers={callers}
              busy={busy === p.id}
              onReassign={reassign}
              onAdd={addLeads}
              onReturn={returnLeads}
              onDelete={remove}
            />
          ))}
        </div>
      )}

      {/* ------------------------------ closed packets ---------------------------- */}
      {closed.length > 0 && (
        <>
          <h2 style={{ marginBottom: 10 }}>Finished ({closed.length})</h2>
          <div style={{ display: "grid", gap: 10, marginBottom: 30 }}>
            {closed.map((p) => (
              <PacketRow
                key={p.id}
                p={p}
                callers={callers}
                busy={busy === p.id}
                onReassign={reassign}
                onAdd={addLeads}
                onReturn={returnLeads}
                onDelete={remove}
              />
            ))}
          </div>
        </>
      )}

      {/* ------------------------------ what to attack ---------------------------- */}
      <div className="card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: attack ? 12 : 0,
          }}
        >
          <div>
            <h3 style={{ color: "var(--amber)" }}>What to attack today</h3>
            <p className="faint">Claude reads your real numbers and suggests a focus.</p>
          </div>
          <button className="btn" onClick={whatToAttack} disabled={attackLoading}>
            {attackLoading ? "Thinking…" : "Ask Claude"}
          </button>
        </div>
        {attack && <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{attack}</p>}
      </div>
    </div>
  );
}

function PacketRow({
  p,
  callers,
  busy,
  onReassign,
  onAdd,
  onReturn,
  onDelete,
}: {
  p: Packet;
  callers: Caller[];
  busy: boolean;
  onReassign: (p: Packet, callerId: string) => void;
  onAdd: (p: Packet, size: number) => void;
  onReturn: (p: Packet) => void;
  onDelete: (p: Packet) => void;
}) {
  const [addSize, setAddSize] = useState("25");
  const [showAdd, setShowAdd] = useState(false);
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;

  return (
    <div className="card">
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>{p.name}</div>
          <div className="faint">
            {p.callers?.name || "unassigned"}
            {p.callers && !p.callers.active && " (this caller is deactivated)"}
            {" · "}
            {new Date(p.created_at).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </div>
          <div
            style={{
              height: 6,
              background: "var(--bg-inset)",
              borderRadius: 3,
              overflow: "hidden",
              margin: "8px 0 4px",
              maxWidth: 300,
            }}
          >
            <div style={{ width: `${pct}%`, height: "100%", background: "var(--amber)" }} />
          </div>
          <div className="faint">
            {p.done} of {p.total} worked · <strong>{p.remaining} still to dial</strong>
          </div>
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <select
            value={p.caller_id || ""}
            onChange={(e) => e.target.value && onReassign(p, e.target.value)}
            disabled={busy}
            style={{ maxWidth: 160, fontSize: "0.75rem" }}
            title="Move this packet to a different caller"
          >
            <option value="">Move to…</option>
            {callers.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>

          <button
            className="btn-ghost"
            style={{ padding: "5px 12px", fontSize: "0.72rem" }}
            onClick={() => setShowAdd(!showAdd)}
            disabled={busy}
            title="Top this packet up with more ready leads"
          >
            Add leads
          </button>

          {p.remaining > 0 && (
            <button
              className="btn-ghost"
              style={{ padding: "5px 12px", fontSize: "0.72rem" }}
              onClick={() => onReturn(p)}
              disabled={busy}
              title="Take the un-dialed leads back so someone else can have them"
            >
              Take back {p.remaining}
            </button>
          )}

          {p.canDelete && (
            <button
              className="btn-danger"
              style={{ padding: "5px 12px", fontSize: "0.72rem" }}
              onClick={() => onDelete(p)}
              disabled={busy}
              title="Nobody has dialed from this packet, so it can be removed entirely"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {showAdd && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid var(--border)",
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span className="faint">Add</span>
          <input
            type="number"
            value={addSize}
            onChange={(e) => setAddSize(e.target.value)}
            style={{ maxWidth: 80 }}
            min={1}
          />
          <span className="faint">more ready leads to this packet</span>
          <button
            className="btn"
            style={{ padding: "5px 14px", fontSize: "0.72rem" }}
            disabled={busy}
            onClick={() => {
              onAdd(p, Number(addSize));
              setShowAdd(false);
            }}
          >
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      )}
    </div>
  );
}
