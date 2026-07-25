"use client";

import { useEffect, useState } from "react";

type Campaign = {
  id: string;
  name: string;
  status: string;
  total_leads: number;
  available_leads: number;
};

type Caller = { id: string; name: string; active: boolean };

type Packet = {
  id: string;
  name: string;
  status: string;
  total: number;
  done: number;
  callers: { name: string } | null;
};

export default function CampaignsAdmin() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [callers, setCallers] = useState<Caller[]>([]);
  const [packets, setPackets] = useState<Packet[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [packetCaller, setPacketCaller] = useState("");
  const [packetSize, setPacketSize] = useState("25");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [attack, setAttack] = useState("");
  const [attackLoading, setAttackLoading] = useState(false);

  async function load() {
    const [cRes, kRes] = await Promise.all([
      fetch("/api/campaigns"),
      fetch("/api/callers"),
    ]);
    const cs = await cRes.json();
    setCampaigns(cs);
    setCallers((await kRes.json()).filter((k: Caller) => k.active));
    if (cs.length > 0 && !selected) setSelected(cs[0].id);
  }

  async function loadPackets(campaignId: string) {
    const res = await fetch(`/api/packets?campaign_id=${campaignId}`);
    setPackets(await res.json());
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selected) loadPackets(selected);
  }, [selected]);

  async function createCampaign() {
    if (!newName.trim()) return;
    setBusy(true);
    await fetch("/api/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    setNewName("");
    setBusy(false);
    load();
  }

  async function generatePacket() {
    if (!selected || !packetCaller) return;
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/packets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaign_id: selected,
        caller_id: packetCaller,
        size: Number(packetSize),
      }),
    });
    const j = await res.json();
    setMsg(res.ok ? `Packet created: ${j.name}` : j.error);
    setBusy(false);
    load();
    loadPackets(selected);
  }

  async function whatToAttack() {
    setAttackLoading(true);
    setAttack("");
    const res = await fetch("/api/prioritize");
    const j = await res.json();
    setAttack(res.ok ? j.recommendation : j.error || "Failed");
    setAttackLoading(false);
  }

  const current = campaigns.find((c) => c.id === selected);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 20 }}>Campaigns</h1>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: attack ? 12 : 0 }}>
          <h3 style={{ color: "var(--amber)" }}>What to Attack Today</h3>
          <button className="btn" onClick={whatToAttack} disabled={attackLoading}>
            {attackLoading ? "Thinking…" : "Ask Claude"}
          </button>
        </div>
        {attack && <p style={{ whiteSpace: "pre-wrap" }}>{attack}</p>}
      </div>

      <div className="card" style={{ marginBottom: 20, display: "flex", gap: 8 }}>
        <input
          placeholder="New campaign name (e.g. Metro Detroit Roofing)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && createCampaign()}
        />
        <button className="btn" onClick={createCampaign} disabled={busy || !newName.trim()}>
          Create
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {campaigns.map((c) => (
          <button
            key={c.id}
            className={c.id === selected ? "btn" : "btn-ghost"}
            onClick={() => setSelected(c.id)}
          >
            {c.name}
            <span style={{ opacity: 0.7, fontSize: "0.8rem" }}>
              {c.available_leads}/{c.total_leads}
            </span>
          </button>
        ))}
        {campaigns.length === 0 && (
          <p className="muted">No campaigns yet. Create one above, then load leads with the scraper scripts.</p>
        )}
      </div>

      {current && (
        <>
          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ marginBottom: 10 }}>Generate packet</h3>
            <p className="faint" style={{ marginBottom: 12 }}>
              {current.available_leads} leads available (not yet in any packet).
              Packets are locked once created — no duplicate calling.
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select
                value={packetCaller}
                onChange={(e) => setPacketCaller(e.target.value)}
                style={{ maxWidth: 220 }}
              >
                <option value="">Assign to caller…</option>
                {callers.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                value={packetSize}
                onChange={(e) => setPacketSize(e.target.value)}
                style={{ maxWidth: 90 }}
                min={1}
              />
              <button
                className="btn"
                onClick={generatePacket}
                disabled={busy || !packetCaller || current.available_leads === 0}
              >
                Generate
              </button>
            </div>
            {msg && <p style={{ marginTop: 10, color: "var(--amber)" }}>{msg}</p>}
          </div>

          <h2 style={{ marginBottom: 10 }}>Packets</h2>
          <table>
            <thead>
              <tr>
                <th>Packet</th>
                <th>Caller</th>
                <th>Progress</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {packets.map((p) => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 600 }}>{p.name}</td>
                  <td>{p.callers?.name || "—"}</td>
                  <td>
                    {p.done}/{p.total}
                  </td>
                  <td>
                    <span className={p.status === "open" ? "tag" : "tag-dim"}>
                      {p.status}
                    </span>
                  </td>
                </tr>
              ))}
              {packets.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No packets yet for this campaign.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
