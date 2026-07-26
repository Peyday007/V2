"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MACHINE_STATUS_LABELS, MachineStatus } from "@/lib/machineStatus";
import { INDUSTRIES, searchTermsFor } from "@/lib/industries";

type Campaign = {
  id: string;
  name: string;
  industry: string | null;
  city: string | null;
  state: string | null;
  status: string;
  target_lead_count: number;
  searches_planned: number;
  searches_completed: number;
  api_requests_used: number;
  max_api_requests: number;
  businesses_returned: number;
  unique_saved: number;
  duplicates_skipped: number;
  qualification_failures: number;
  enrichment_queued: number;
  error_count: number;
  last_error: string | null;
};

type Progress = {
  campaign: Campaign;
  places_key_configured: boolean;
  search_tasks: Record<string, number>;
  jobs: Record<string, number>;
  outstanding_jobs: number;
  leads_by_machine_status: Record<string, number>;
  recent_errors: { type: string; last_error: string; count: number }[];
  env?: { places_key: boolean; caller_session_secret: boolean; anthropic_key: boolean };
};

export default function SourcingPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [keyOk, setKeyOk] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showMix, setShowMix] = useState(false);
  const [error, setError] = useState("");
  const [ticking, setTicking] = useState(false);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadCampaigns = useCallback(async () => {
    const res = await fetch("/api/sourcing");
    const j = await res.json();
    if (!res.ok) {
      setError(j.error || "Could not load campaigns");
      if (typeof j.places_key_configured === "boolean") {
        setKeyOk(j.places_key_configured);
      }
      return;
    }
    setCampaigns(j.campaigns || []);
    setKeyOk(j.places_key_configured);
    if (!selected && j.campaigns?.length) setSelected(j.campaigns[0].id);
  }, [selected]);

  const loadProgress = useCallback(async (id: string) => {
    const res = await fetch(`/api/sourcing/${id}`);
    if (res.ok) setProgress(await res.json());
  }, []);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  useEffect(() => {
    if (selected) loadProgress(selected);
  }, [selected, loadProgress]);

  // While a campaign is running, drive the worker from this page and poll
  // progress. The engine also runs headlessly via pg_cron — this just makes
  // it immediate while an admin is watching.
  useEffect(() => {
    const running = progress?.campaign.status === "running";
    if (tickTimer.current) {
      clearInterval(tickTimer.current);
      tickTimer.current = null;
    }
    if (running && selected) {
      tickTimer.current = setInterval(async () => {
        await fetch("/api/worker/tick", { method: "POST" }).catch(() => {});
        loadProgress(selected);
        loadCampaigns();
      }, 5000);
    }
    return () => {
      if (tickTimer.current) clearInterval(tickTimer.current);
    };
  }, [progress?.campaign.status, selected, loadProgress, loadCampaigns]);

  async function act(id: string, action: string) {
    setError("");
    const res = await fetch(`/api/sourcing/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const j = await res.json();
    if (!res.ok) setError(j.error || `${action} failed`);
    await loadCampaigns();
    await loadProgress(id);
  }

  async function runWorkerOnce() {
    setTicking(true);
    await fetch("/api/worker/tick", { method: "POST" }).catch(() => {});
    if (selected) await loadProgress(selected);
    await loadCampaigns();
    setTicking(false);
  }

  const c = progress?.campaign;
  const pct = c
    ? Math.min(100, Math.round((c.unique_saved / Math.max(1, c.target_lead_count)) * 100))
    : 0;

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h1>Sourcing Campaigns</h1>
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={runWorkerOnce} disabled={ticking}>
          {ticking ? "Running…" : "Run worker now"}
        </button>
        <button
          className="btn-ghost"
          onClick={() => setShowForm(true)}
          title="Choose specific trades and a city"
        >
          Custom…
        </button>
        <button className="btn" onClick={() => setShowMix(true)}>
          ⚡ Generate Leads
        </button>
      </div>

      {!keyOk && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <h3 style={{ color: "var(--red)", marginBottom: 6 }}>
            Google Places key not detected
          </h3>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            If you already added <code>GOOGLE_PLACES_API_KEY</code> in Vercel,
            you still need to <strong>redeploy</strong> — environment variables
            are baked in at build time and do not reach a deployment that was
            built before you added them. Vercel → Deployments → ⋯ on the newest
            one → <strong>Redeploy</strong>. Campaigns cannot start until this
            shows as detected.
          </p>
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <p style={{ color: "var(--red)", fontSize: "0.85rem" }}>{error}</p>
        </div>
      )}

      {progress?.env && !progress.env.caller_session_secret && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <h3 style={{ color: "var(--red)", marginBottom: 6 }}>
            Callers cannot sign in
          </h3>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            <code>CALLER_SESSION_SECRET</code> is not set on this deployment, so
            the dialer can&apos;t create a login session — entering a correct PIN
            will still fail. Add it in Vercel → Settings → Environment Variables
            (any long random string, 30+ characters), then redeploy.
          </p>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {campaigns.map((cam) => (
          <button
            key={cam.id}
            className={cam.id === selected ? "btn" : "btn-ghost"}
            onClick={() => setSelected(cam.id)}
          >
            {cam.name}
            <span style={{ opacity: 0.7, fontSize: "0.72rem" }}>
              {cam.unique_saved}/{cam.target_lead_count}
            </span>
          </button>
        ))}
        {campaigns.length === 0 && (
          <p className="muted">
            No sourcing campaigns yet. Create one to start generating leads.
          </p>
        )}
      </div>

      {c && progress && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 12,
                flexWrap: "wrap",
              }}
            >
              <h2>{c.name}</h2>
              <span className={c.status === "running" ? "tag" : "tag-dim"}>
                {c.status}
              </span>
              <div style={{ flex: 1 }} />
              {(c.status === "draft" || c.status === "completed") && (
                <button className="btn" onClick={() => act(c.id, "start")}>
                  ▶ Start
                </button>
              )}
              {c.status === "running" && (
                <>
                  <button className="btn-ghost" onClick={() => act(c.id, "pause")}>
                    ⏸ Pause
                  </button>
                  <button className="btn-danger" onClick={() => act(c.id, "stop")}>
                    ■ Stop
                  </button>
                </>
              )}
              {(c.status === "paused" || c.status === "stopped") && (
                <button className="btn" onClick={() => act(c.id, "resume")}>
                  ▶ Resume
                </button>
              )}
            </div>

            <div
              style={{
                height: 8,
                background: "var(--bg-inset)",
                borderRadius: 4,
                overflow: "hidden",
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  background: "var(--amber)",
                  transition: "width .4s",
                }}
              />
            </div>
            <p className="faint" style={{ marginBottom: 14 }}>
              {c.unique_saved} of {c.target_lead_count} leads · {pct}%
              {c.status === "running" && " · worker running…"}
            </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                gap: 10,
              }}
            >
              <Stat label="Searches planned" value={c.searches_planned} />
              <Stat label="Searches completed" value={c.searches_completed} />
              <Stat
                label="API requests"
                value={`${c.api_requests_used}/${c.max_api_requests}`}
                warn={c.api_requests_used >= c.max_api_requests}
              />
              <Stat label="Businesses returned" value={c.businesses_returned} />
              <Stat label="Unique saved" value={c.unique_saved} accent />
              <Stat label="Duplicates skipped" value={c.duplicates_skipped} />
              <Stat label="Failed qualification" value={c.qualification_failures} />
              <Stat label="Enrichment queued" value={c.enrichment_queued} accent />
              <Stat label="Jobs outstanding" value={progress.outstanding_jobs} />
              <Stat label="Errors" value={c.error_count} warn={c.error_count > 0} />
            </div>
          </div>

          <ReleaseAndPacket
            campaignId={c.id}
            readyCount={progress.leads_by_machine_status.ready_for_calling || 0}
            onDone={() => {
              loadProgress(c.id);
              loadCampaigns();
            }}
          />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div className="card">
              <h3 style={{ marginBottom: 10 }}>Leads by machine status</h3>
              {Object.keys(progress.leads_by_machine_status).length === 0 && (
                <p className="muted" style={{ fontSize: "0.85rem" }}>
                  No leads generated yet.
                </p>
              )}
              {Object.entries(progress.leads_by_machine_status).map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "0.82rem",
                    padding: "3px 0",
                  }}
                >
                  <span className="muted">
                    {MACHINE_STATUS_LABELS[k as MachineStatus] || k}
                  </span>
                  <strong>{v}</strong>
                </div>
              ))}
            </div>

            <div className="card">
              <h3 style={{ marginBottom: 10 }}>Search tasks / jobs</h3>
              <div style={{ fontSize: "0.82rem" }}>
                <div className="muted" style={{ marginBottom: 6 }}>
                  Tasks:{" "}
                  {Object.entries(progress.search_tasks)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(" · ") || "none"}
                </div>
                <div className="muted">
                  Jobs:{" "}
                  {Object.entries(progress.jobs)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(" · ") || "none"}
                </div>
              </div>
              {progress.recent_errors.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <h3 style={{ color: "var(--red)", marginBottom: 6 }}>What went wrong</h3>
                  {progress.recent_errors.map((e, i) => (
                    <div
                      key={i}
                      style={{
                        marginBottom: 8,
                        padding: "8px 10px",
                        background: "var(--bg-inset)",
                        border: "1px solid var(--border)",
                        borderRadius: 4,
                        fontSize: "0.78rem",
                        lineHeight: 1.5,
                      }}
                    >
                      <strong>{e.type}</strong>
                      {e.count > 1 && (
                        <span className="faint"> · {e.count} more like this</span>
                      )}
                      <div style={{ marginTop: 4 }}>{e.last_error}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {showMix && (
        <MixDialog
          onClose={() => setShowMix(false)}
          onCreated={(id) => {
            setShowMix(false);
            setSelected(id);
            loadCampaigns();
          }}
        />
      )}

      {showForm && (
        <CampaignForm
          onClose={() => setShowForm(false)}
          onCreated={(id) => {
            setShowForm(false);
            setSelected(id);
            loadCampaigns();
          }}
        />
      )}
    </div>
  );
}

/** Turn generated businesses into callable packets without leaving this page. */
function ReleaseAndPacket({
  campaignId,
  readyCount,
  onDone,
}: {
  campaignId: string;
  readyCount: number;
  onDone: () => void;
}) {
  const [callers, setCallers] = useState<{ id: string; name: string }[]>([]);
  const [callerId, setCallerId] = useState("");
  const [size, setSize] = useState("50");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/callers")
      .then((r) => r.json())
      .then((cs) => {
        const active = (cs || []).filter((k: { active: boolean }) => k.active);
        setCallers(active);
        if (active.length) setCallerId(active[0].id);
      })
      .catch(() => {});
  }, []);

  async function release() {
    setBusy(true);
    setErr("");
    setMsg("");
    const res = await fetch("/api/leads/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourcing_campaign_id: campaignId }),
    });
    const j = await res.json();
    if (!res.ok) {
      setErr(j.error || "Release failed");
      setBusy(false);
      return;
    }
    // Drive the worker so the leads actually move now.
    for (let i = 0; i < 3; i++) {
      await fetch("/api/worker/tick", { method: "POST" }).catch(() => {});
    }
    setMsg(j.message || "Done.");
    setBusy(false);
    onDone();
  }

  async function makePacket() {
    setBusy(true);
    setErr("");
    setMsg("");
    const res = await fetch("/api/packets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourcing_campaign_id: campaignId,
        caller_id: callerId,
        size: Number(size),
      }),
    });
    const j = await res.json();
    if (!res.ok) setErr(j.error || "Could not create packet");
    else setMsg(`Packet created: ${j.name}`);
    setBusy(false);
    onDone();
  }

  return (
    <div className="card" style={{ marginBottom: 16, borderColor: "var(--amber-dim)" }}>
      <h3 style={{ marginBottom: 8, color: "var(--amber)" }}>Caller packets</h3>
      <p className="faint" style={{ marginBottom: 12 }}>
        Packets are built and assigned automatically as leads finish processing.
        <strong> {readyCount}</strong> ready and not yet assigned. Use these only if
        you want to force it along or assign a specific caller yourself.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn-ghost" onClick={release} disabled={busy}>
          Reprocess stuck leads
        </button>
        <select
          value={callerId}
          onChange={(e) => setCallerId(e.target.value)}
          style={{ maxWidth: 190 }}
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
          value={size}
          onChange={(e) => setSize(e.target.value)}
          style={{ maxWidth: 80 }}
          min={1}
        />
        <button
          className="btn"
          onClick={makePacket}
          disabled={busy || !callerId || readyCount === 0}
        >
          Assign manually
        </button>
      </div>
      {callers.length === 0 && (
        <p className="faint" style={{ marginTop: 8 }}>
          No active callers yet — add them on the Callers tab first.
        </p>
      )}
      {msg && <p style={{ color: "var(--amber)", marginTop: 10 }}>{msg}</p>}
      {err && <p style={{ color: "var(--red)", marginTop: 10 }}>{err}</p>}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  warn,
}: {
  label: string;
  value: number | string;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div
      style={{
        background: "var(--bg-inset)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "10px 12px",
      }}
    >
      <div
        style={{
          fontSize: "1.2rem",
          fontWeight: 700,
          color: warn ? "var(--red)" : accent ? "var(--amber)" : "var(--text)",
        }}
      >
        {value}
      </div>
      <div className="faint">{label}</div>
    </div>
  );
}

/**
 * The default path: no trades, no city, no settings. Pick how many leads and
 * the engine spreads the run across a curated mix of phone-driven home-service
 * trades and major metros, so the data comes back varied enough to learn from.
 */
function MixDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [target, setTarget] = useState(300);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function go() {
    setSaving(true);
    setError("");
    const res = await fetch("/api/sourcing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mix: true, target_lead_count: target }),
    });
    const j = await res.json();
    if (!res.ok) {
      setError(j.error || "Could not start");
      setSaving(false);
      return;
    }
    if (j.start_error) setError(j.start_error);
    onCreated(j.campaign.id);
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        padding: 20,
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 460, maxWidth: "94vw", textAlign: "center" }}
      >
        <h2 style={{ marginBottom: 6 }}>How many leads?</h2>
        <p className="faint" style={{ marginBottom: 20 }}>
          A mix of home-service trades across major metros. Everything else is
          automatic.
        </p>

        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "center",
            marginBottom: 20,
            flexWrap: "wrap",
          }}
        >
          {[100, 300, 500, 1000].map((n) => (
            <button
              key={n}
              className={target === n ? "btn" : "btn-ghost"}
              style={{ padding: "10px 20px", fontSize: "0.9rem" }}
              onClick={() => setTarget(n)}
            >
              {n}
            </button>
          ))}
        </div>

        {error && (
          <p style={{ color: "var(--red)", marginBottom: 12, fontSize: "0.85rem" }}>
            {error}
          </p>
        )}

        <button
          className="btn"
          onClick={go}
          disabled={saving}
          style={{ width: "100%", justifyContent: "center", padding: "12px" }}
        >
          {saving ? "Starting…" : `Generate ${target} leads`}
        </button>
        <button
          className="btn-ghost"
          onClick={onClose}
          style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function CampaignForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [target, setTarget] = useState("300");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const label =
    picked.length === 1
      ? INDUSTRIES.find((i) => i.key === picked[0])!.label
      : picked.length > 1
        ? "Home Services"
        : "";

  const ready = picked.length > 0 && (city.trim() || state.trim());

  async function save() {
    setSaving(true);
    setError("");
    const res = await fetch("/api/sourcing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        industry: label,
        search_terms: searchTermsFor(picked),
        city,
        state,
        target_lead_count: Number(target) || 300,
      }),
    });
    const j = await res.json();
    if (!res.ok) {
      setError(j.error || "Could not create campaign");
      setSaving(false);
      return;
    }
    if (j.start_error) setError(j.start_error);
    onCreated(j.campaign.id);
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        padding: 20,
        overflowY: "auto",
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 560, maxWidth: "94vw" }}
      >
        <h2 style={{ marginBottom: 4 }}>Generate Leads</h2>
        <p className="faint" style={{ marginBottom: 16 }}>
          Pick the trades and where. Everything after that runs by itself.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <h3 style={{ marginBottom: 8 }}>1 · Which trades?</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {INDUSTRIES.map((ind) => {
                const on = picked.includes(ind.key);
                return (
                  <button
                    key={ind.key}
                    type="button"
                    title={ind.whyFit}
                    onClick={() =>
                      setPicked(
                        on
                          ? picked.filter((k) => k !== ind.key)
                          : [...picked, ind.key]
                      )
                    }
                    style={{
                      padding: "5px 11px",
                      borderRadius: 3,
                      fontSize: "0.72rem",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      border: `1px solid ${on ? "var(--amber)" : "var(--border-strong)"}`,
                      background: on ? "var(--amber-soft)" : "transparent",
                      color: on ? "var(--amber)" : "var(--text-dim)",
                    }}
                  >
                    {ind.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <h3 style={{ marginBottom: 8 }}>2 · Where?</h3>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
              <input
                placeholder="City or metro (e.g. Detroit)"
                value={city}
                onChange={(e) => setCity(e.target.value)}
              />
              <input
                placeholder="State (MI)"
                value={state}
                onChange={(e) => setState(e.target.value)}
                maxLength={2}
              />
            </div>
          </div>

          <div>
            <h3 style={{ marginBottom: 8 }}>3 · How many leads?</h3>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              {["100", "300", "500", "1000"].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={target === n ? "btn" : "btn-ghost"}
                  style={{ padding: "5px 14px" }}
                  onClick={() => setTarget(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <input
              type="number"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              min={1}
            />
          </div>

          {error && <p style={{ color: "var(--red)" }}>{error}</p>}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 20, alignItems: "center" }}>
          <button className="btn" onClick={save} disabled={saving || !ready}>
            {saving ? "Starting…" : "Generate leads"}
          </button>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <div style={{ flex: 1 }} />
          {!ready && (
            <span className="faint">Pick a trade and a location</span>
          )}
        </div>
      </div>
    </div>
  );
}
