"use client";

import { useEffect, useState } from "react";

type Caller = {
  id: string;
  name: string;
  pin: string;
  active: boolean;
  created_at: string;
};

export default function CallersAdmin() {
  const [callers, setCallers] = useState<Caller[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch("/api/callers");
    setCallers(await res.json());
  }
  useEffect(() => {
    load();
  }, []);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    await fetch("/api/callers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setName("");
    setBusy(false);
    load();
  }

  async function toggle(c: Caller) {
    await fetch(`/api/callers/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !c.active }),
    });
    load();
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 20 }}>Callers</h1>

      <div className="card" style={{ marginBottom: 20, display: "flex", gap: 8 }}>
        <input
          placeholder="New caller name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn" onClick={add} disabled={busy || !name.trim()}>
          Add
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>PIN</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {callers.map((c) => (
            <tr key={c.id} style={{ opacity: c.active ? 1 : 0.5 }}>
              <td style={{ fontWeight: 600 }}>{c.name}</td>
              <td>
                <code
                  style={{
                    background: "var(--bg-hover)",
                    padding: "2px 8px",
                    borderRadius: 4,
                    letterSpacing: "0.15em",
                  }}
                >
                  {c.pin}
                </code>
              </td>
              <td>
                {c.active ? (
                  <span className="tag">Active</span>
                ) : (
                  <span className="tag-dim">Revoked</span>
                )}
              </td>
              <td style={{ textAlign: "right" }}>
                <button
                  className={c.active ? "btn-danger" : "btn-ghost"}
                  onClick={() => toggle(c)}
                  style={{ padding: "4px 12px" }}
                >
                  {c.active ? "Revoke" : "Reactivate"}
                </button>
              </td>
            </tr>
          ))}
          {callers.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No callers yet. Add one above — they sign in at /dial with their PIN.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
