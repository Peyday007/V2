"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useConfirm } from "@/components/Confirm";

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
  coverage?: {
    buckets: { status: string; label: string; count: number }[];
    callableNow: number;
    total: number;
  };
};

export default function PacketsAdmin() {
  const [callers, setCallers] = useState<Caller[]>([]);
  const [packets, setPackets] = useState<Packet[] | null>(null);
  const [ready, setReady] = useState(0);
  const [whyNone, setWhyNone] = useState<string | null>(null);
  const [newCaller, setNewCaller] = useState("");
  const [newSize, setNewSize] = useState("50");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [attack, setAttack] = useState("");
  const [attackLoading, setAttackLoading] = useState(false);
  const { ask, dialog } = useConfirm();

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
      setWhyNone(pipe.noneAvailableExplanation ?? null);
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
    // An expired admin session returns 401 from middleware. Silently doing
    // nothing is how these buttons looked broken, so say so and go sign in.
    if (res.status === 401) {
      window.location.href = `/admin-login?next=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setErr(j.error || `That did not work (HTTP ${res.status}).`);
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

  async function returnLeads(p: Packet) {
    const ok = await ask({
      title: `Take back ${p.remaining} un-dialed lead${p.remaining === 1 ? "" : "s"}?`,
      body: [
        "They go back into the ready pool, so you can send them to someone else.",
        "Calls already logged are kept. The packet closes.",
      ],
      confirmLabel: "Take them back",
    });
    if (!ok) return;
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

  async function discardLeads(p: Packet) {
    const ok = await ask({
      title: `Bin ${p.remaining} un-dialed lead${p.remaining === 1 ? "" : "s"}?`,
      body: [
        "Use this when the leads themselves are no good.",
        "They are archived — kept in the database with their history, but never handed to a caller again. They will NOT come back into the pool.",
        "Calls already logged are kept. The packet closes.",
      ],
      confirmLabel: "Bin them",
      danger: true,
    });
    if (!ok) return;
    return run(
      p.id,
      () =>
        fetch(`/api/packets/${p.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "discard_leads" }),
        }),
      (j: { discarded: number }) =>
        `${j.discarded} leads binned. They will not be handed to anyone again.`
    );
  }

  async function remove(p: Packet, discard: boolean) {
    const body = [
      discard
        ? `The ${p.remaining} un-dialed lead${p.remaining === 1 ? "" : "s"} will be BINNED — archived, and never handed to a caller again.`
        : `The ${p.remaining} un-dialed lead${p.remaining === 1 ? "" : "s"} go back into the ready pool, so you can send them to someone else.`,
    ];
    if (p.callsMade > 0) {
      body.push(
        `${p.callsMade} call${p.callsMade === 1 ? " was" : "s were"} logged from this packet. Every one is kept — who was called, when, by whom and what happened. They just stop showing which packet they came from.`
      );
    }
    const ok = await ask({
      title: `Delete "${p.name}"?`,
      body,
      confirmLabel: discard ? "Delete and bin the leads" : "Delete it",
      danger: true,
    });
    if (!ok) return;
    return run(
      p.id,
      () =>
        fetch(`/api/packets/${p.id}${discard ? "?discard=1" : ""}`, { method: "DELETE" }),
      (j: { returned: number; discarded: number; callsDetached: number }) =>
        `Packet deleted. ` +
        (j.discarded > 0
          ? `${j.discarded} leads binned.`
          : `${j.returned} leads went back to the pool.`) +
        (j.callsDetached > 0 ? ` ${j.callsDetached} logged calls kept.` : "")
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
        be in one packet at a time, so nobody ever gets called twice.
      </p>
      <p className="faint" style={{ marginBottom: 22, lineHeight: 1.6 }}>
        <strong>Take back</strong> returns the un-dialed leads to the ready pool
        so someone else can have them. <strong>Bin</strong> is for when the leads
        themselves are no good — they are archived and never handed to anyone
        again. Deleting a packet never deletes a logged call: every call keeps
        its lead, caller, outcome and timing, it just stops showing which packet
        it came from.
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
          <strong>{ready}</strong> lead{ready === 1 ? "" : "s"} free to hand out.
          {ready === 0 && whyNone && (
            <>
              {" "}
              {whyNone.replace(/Generate more on the Leads tab\.$/, "")}
              <Link href="/admin/sourcing">Generate more on the Leads tab.</Link>
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
              ready={ready}
              onReassign={reassign}
              onAdd={addLeads}
              onReturn={returnLeads}
              onDiscard={discardLeads}
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
                ready={ready}
                onReassign={reassign}
                onAdd={addLeads}
                onReturn={returnLeads}
                onDiscard={discardLeads}
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
      {dialog}
    </div>
  );
}

function PacketRow({
  p,
  callers,
  busy,
  ready,
  onReassign,
  onAdd,
  onReturn,
  onDiscard,
  onDelete,
}: {
  p: Packet;
  callers: Caller[];
  busy: boolean;
  /** Leads free to hand out right now, so the row can say so up front. */
  ready: number;
  onReassign: (p: Packet, callerId: string) => void;
  onAdd: (p: Packet, size: number) => void;
  onReturn: (p: Packet) => void;
  onDiscard: (p: Packet) => void;
  onDelete: (p: Packet, discard: boolean) => void;
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
            {p.callsMade > 0 && ` · ${p.callsMade} calls logged`}
          </div>
          {p.coverage && p.coverage.total > 0 && (
            <div
              className="faint"
              style={{
                marginTop: 4,
                color:
                  p.coverage.callableNow === 0 ? "var(--red)" : "var(--text-dim)",
              }}
              title={p.coverage.buckets.map((b) => `${b.count} ${b.label}`).join(" · ")}
            >
              {p.coverage.callableNow === 0
                ? "None of these are in business hours right now"
                : `${p.coverage.callableNow} of ${p.coverage.total} in business hours right now`}
            </div>
          )}
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
            <>
              <button
                className="btn-ghost"
                style={{ padding: "5px 12px", fontSize: "0.72rem" }}
                onClick={() => onReturn(p)}
                disabled={busy}
                title="Take the un-dialed leads back so someone else can have them"
              >
                Take back {p.remaining}
              </button>
              <button
                className="btn-ghost"
                style={{ padding: "5px 12px", fontSize: "0.72rem" }}
                onClick={() => onDiscard(p)}
                disabled={busy}
                title="These leads are no good — archive them so nobody is ever handed them again"
              >
                Bin {p.remaining}
              </button>
            </>
          )}

          <button
            className="btn-danger"
            style={{ padding: "5px 12px", fontSize: "0.72rem" }}
            onClick={() => onDelete(p, false)}
            disabled={busy}
            title="Remove the packet. Un-dialed leads go back to the pool; logged calls are kept."
          >
            Delete
          </button>
          {p.remaining > 0 && (
            <button
              className="btn-danger"
              style={{ padding: "5px 12px", fontSize: "0.72rem" }}
              onClick={() => onDelete(p, true)}
              disabled={busy}
              title="Remove the packet AND bin its un-dialed leads, so they never come back"
            >
              Delete + bin leads
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
          <span className="faint">
            more leads to this packet {ready > 0 ? `(${ready} free)` : "(none free)"}
          </span>
          <button
            className="btn"
            style={{ padding: "5px 14px", fontSize: "0.72rem" }}
            disabled={busy || ready === 0}
            onClick={() => {
              onAdd(p, Number(addSize));
              setShowAdd(false);
            }}
          >
            {busy ? "Adding…" : "Add"}
          </button>
          {ready === 0 && (
            <span className="faint">
              Nothing free to add — every lead is already out, called or binned.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
