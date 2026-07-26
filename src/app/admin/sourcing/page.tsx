"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MACHINE_STATUS_LABELS, MachineStatus } from "@/lib/machineStatus";

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
  recent_errors: { type: string; last_error: string; attempts: number }[];
};

export default function SourcingPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [keyOk, setKeyOk] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  const [ticking, setTicking] = useState(false);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadCampaigns = useCallback(async () => {
    const res = await fetch("/api/sourcing");
    const j = await res.json();
    if (!res.ok) {
      setError(j.error || "Could not load campaigns");
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
        <button className="btn" onClick={() => setShowForm(true)}>
          + New Campaign
        </button>
      </div>

      {!keyOk && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <h3 style={{ color: "var(--red)", marginBottom: 6 }}>
            Google Places key not detected
          </h3>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Add <code>GOOGLE_PLACES_API_KEY</code> in Vercel → Settings →
            Environment Variables (Production), then redeploy. Campaigns cannot
            start without it.
          </p>
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <p style={{ color: "var(--red)", fontSize: "0.85rem" }}>{error}</p>
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
                  <h3 style={{ color: "var(--red)", marginBottom: 6 }}>Recent errors</h3>
                  {progress.recent_errors.map((e, i) => (
                    <div key={i} className="faint" style={{ marginBottom: 4 }}>
                      <strong>{e.type}</strong> (attempt {e.attempts}):{" "}
                      {e.last_error?.slice(0, 120)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
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

function CampaignForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState({
    name: "",
    industry: "",
    city: "",
    state: "",
    zips: "",
    search_terms: "",
    target_lead_count: "500",
    min_rating: "",
    min_review_count: "",
    max_review_count: "",
    max_api_requests: "200",
    require_website: false,
    exclude_franchises: true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function set(k: string, v: string | boolean) {
    setForm({ ...form, [k]: v });
  }

  async function save() {
    setSaving(true);
    setError("");
    const res = await fetch("/api/sourcing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const j = await res.json();
    if (!res.ok) {
      setError(j.error || "Could not create campaign");
      setSaving(false);
      return;
    }
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
        <h2 style={{ marginBottom: 14 }}>New Sourcing Campaign</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            placeholder="Campaign name (e.g. Metro Detroit Roofing)"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            autoFocus
          />
          <input
            placeholder="Industry (e.g. Roofing)"
            value={form.industry}
            onChange={(e) => set("industry", e.target.value)}
          />
          <textarea
            placeholder="Search terms, one per line (e.g. roofer / roofing contractor / roof repair / commercial roofing)"
            rows={4}
            value={form.search_terms}
            onChange={(e) => set("search_terms", e.target.value)}
          />
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
            <input
              placeholder="City / metro (e.g. Detroit)"
              value={form.city}
              onChange={(e) => set("city", e.target.value)}
            />
            <input
              placeholder="State (MI)"
              value={form.state}
              onChange={(e) => set("state", e.target.value)}
            />
          </div>
          <textarea
            placeholder="Optional: ZIP codes, comma separated. More ZIPs = better coverage than one city search."
            rows={2}
            value={form.zips}
            onChange={(e) => set("zips", e.target.value)}
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label className="faint">
              Target leads
              <input
                type="number"
                value={form.target_lead_count}
                onChange={(e) => set("target_lead_count", e.target.value)}
              />
            </label>
            <label className="faint">
              Max API requests
              <input
                type="number"
                value={form.max_api_requests}
                onChange={(e) => set("max_api_requests", e.target.value)}
              />
            </label>
            <label className="faint">
              Min rating
              <input
                type="number"
                step="0.1"
                placeholder="any"
                value={form.min_rating}
                onChange={(e) => set("min_rating", e.target.value)}
              />
            </label>
            <label className="faint">
              Min reviews
              <input
                type="number"
                placeholder="any"
                value={form.min_review_count}
                onChange={(e) => set("min_review_count", e.target.value)}
              />
            </label>
            <label className="faint">
              Max reviews
              <input
                type="number"
                placeholder="any"
                value={form.max_review_count}
                onChange={(e) => set("max_review_count", e.target.value)}
              />
            </label>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }} className="faint">
            <input
              type="checkbox"
              checked={form.require_website}
              onChange={(e) => set("require_website", e.target.checked)}
              style={{ width: "auto" }}
            />
            Require a website
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }} className="faint">
            <input
              type="checkbox"
              checked={form.exclude_franchises}
              onChange={(e) => set("exclude_franchises", e.target.checked)}
              style={{ width: "auto" }}
            />
            Exclude franchises / big-box chains
          </label>
          <p className="faint">
            Each API request returns up to 20 businesses and costs money on your
            Google account. The request cap is a hard stop.
          </p>
          {error && <p style={{ color: "var(--red)" }}>{error}</p>}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button className="btn" onClick={save} disabled={saving || !form.name.trim()}>
            {saving ? "Creating…" : "Create campaign"}
          </button>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
