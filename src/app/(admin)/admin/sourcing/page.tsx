"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MACHINE_STATUS_LABELS, MachineStatus } from "@/lib/machineStatus";
import { INDUSTRIES, searchTermsFor } from "@/lib/industries";
import { campaignStatusText, type NextAction, type PipelineCounts } from "@/lib/pipelineState";
import { callableProgressPercent } from "@/lib/leadYield";
import { useConfirm } from "@/components/Confirm";

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
  completion_reason: string | null;
  callable_leads: number | null;
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

type Pipeline = {
  counts: PipelineCounts;
  pendingInPackets: number;
  activeCallers: number;
  openPackets: number;
  campaignRunning: boolean;
  placesKeyConfigured: boolean;
  callerSecretConfigured: boolean;
  discardReasons: { reason: string; count: number }[];
  next: NextAction;
};

const TONE_COLOR: Record<NextAction["tone"], string> = {
  blocked: "var(--red)",
  action: "var(--amber)",
  waiting: "var(--text-dim)",
  good: "var(--amber)",
};

export default function SourcingPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showMix, setShowMix] = useState(false);
  const [showTest, setShowTest] = useState(false);
  const [showEngine, setShowEngine] = useState(false);
  const [editing, setEditing] = useState(false);
  const { ask, dialog } = useConfirm();
  const [error, setError] = useState("");
  const [ticking, setTicking] = useState(false);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadPipeline = useCallback(async () => {
    const res = await fetch("/api/pipeline");
    if (!res.ok) return;
    const j = await res.json().catch(() => null);
    // `counts` is read straight away by the render; an error payload has none.
    if (j && j.counts) setPipeline(j);
  }, []);

  const loadCampaigns = useCallback(async () => {
    const res = await fetch("/api/sourcing");
    const j = await res.json();
    if (!res.ok || j.error) {
      setError(j.error || "Could not load campaigns");
      setCampaigns([]);
      return;
    }
    setCampaigns(j.campaigns || []);
    if (!selected && j.campaigns?.length) setSelected(j.campaigns[0].id);
  }, [selected]);

  const loadProgress = useCallback(async (id: string) => {
    const res = await fetch(`/api/sourcing/${id}`);
    if (res.ok) setProgress(await res.json());
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([loadPipeline(), loadCampaigns()]);
    if (selected) await loadProgress(selected);
  }, [loadPipeline, loadCampaigns, loadProgress, selected]);

  useEffect(() => {
    loadPipeline();
    loadCampaigns();
  }, [loadPipeline, loadCampaigns]);

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
        loadPipeline();
      }, 5000);
    }
    return () => {
      if (tickTimer.current) clearInterval(tickTimer.current);
    };
  }, [progress?.campaign.status, selected, loadProgress, loadCampaigns, loadPipeline]);

  async function act(id: string, action: string) {
    setError("");
    const res = await fetch(`/api/sourcing/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const j = await res.json();
    if (!res.ok) setError(j.error || `${action} failed`);
    await refresh();
  }

  /**
   * The one "unstick it" button. Re-queues anything sitting before
   * ready_for_calling, then runs the worker a few times so the work actually
   * happens while the admin is watching. Both halves are idempotent: a lead
   * cannot end up with two enrichment jobs, so pressing this twice is safe.
   */
  async function pushEngine() {
    setTicking(true);
    await fetch("/api/leads/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).catch(() => {});
    // Several passes, because one tick only claims a batch of jobs.
    for (let i = 0; i < 4; i++) {
      await fetch("/api/worker/tick", { method: "POST" }).catch(() => {});
    }
    await refresh();
    setTicking(false);
  }

  function handleCta(goes: string) {
    if (goes === "#generate") setShowMix(true);
    else if (goes === "#push") pushEngine();
    else if (goes === "#assign") {
      document.getElementById("assign")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  const c = progress?.campaign;
  // Progress is measured in CALLABLE leads, not businesses saved — otherwise
  // the bar reads 100% while the packet is empty.
  const byStatus = progress?.leads_by_machine_status || {};
  const callable =
    (byStatus.ready_for_calling || 0) +
    (byStatus.assigned_to_packet || 0) +
    (byStatus.contacted || 0);
  const stillProcessing = c
    ? Math.max(0, c.unique_saved - callable - (byStatus.enrichment_failed || 0) - (byStatus.archived || 0))
    : 0;
  const pct = c ? callableProgressPercent(callable, c.target_lead_count) : 0;
  // Finished, but did not deliver what was asked for. Offer the fix rather
  // than just reporting the shortfall.
  const isShort =
    !!c &&
    (c.status === "completed" || c.status === "stopped") &&
    callable < c.target_lead_count &&
    stillProcessing === 0;
  const legacyBatch = !!c?.completion_reason?.includes("before callable-lead targeting");

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <h1>Leads</h1>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => setShowMix(true)}>
          ⚡ Generate leads
        </button>
      </div>
      <p className="faint" style={{ marginBottom: 22 }}>
        This page finds businesses and gets them ready for your callers.{" "}
        <strong>Nothing on this page can delete a lead or lose your data</strong> — the
        worst any button here does is make the engine repeat work it has already done.
      </p>

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <p style={{ color: "var(--red)", fontSize: "0.85rem" }}>{error}</p>
        </div>
      )}

      {/* ------------------------- where things stand ------------------------- */}
      {pipeline && (
        <>
          <h2 style={{ marginBottom: 10 }}>Where things stand</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 12,
              marginBottom: 12,
            }}
          >
            <Big
              value={pipeline.counts.readyToCall}
              label="Ready to call"
              sub="processed, nobody has them yet"
              accent
            />
            <Big
              value={pipeline.pendingInPackets}
              label="With your callers"
              sub="handed out, still to be dialed"
            />
            <Big
              value={pipeline.counts.beingResearched}
              label="Being researched"
              sub="engine still working on these"
            />
            <Big
              value={pipeline.counts.called}
              label="Called"
              sub="dialed at least once"
            />
            <Big
              value={pipeline.counts.notUsable}
              label="Discarded"
              sub="not worth calling"
              dim
            />
          </div>

          {pipeline.discardReasons.length > 0 && (
            <details style={{ marginBottom: 22 }}>
              <summary
                className="faint"
                style={{ cursor: "pointer", padding: "6px 0", userSelect: "none" }}
              >
                Why were {pipeline.counts.notUsable} leads discarded?
              </summary>
              <div className="card" style={{ marginTop: 8 }}>
                <p className="faint" style={{ marginBottom: 10 }}>
                  These are decisions the engine made on purpose, not failures.
                  A discarded lead is kept in the database — it is just never
                  given to a caller.
                </p>
                {pipeline.discardReasons.map((r) => (
                  <div
                    key={r.reason}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "0.85rem",
                      padding: "4px 0",
                    }}
                  >
                    <span className="muted">{r.reason}</span>
                    <strong>{r.count}</strong>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* ---------------------------- do this next --------------------------- */}
          <h2 style={{ marginBottom: 10 }}>Do this next</h2>
          <div
            className="card"
            style={{
              marginBottom: 26,
              borderColor:
                pipeline.next.tone === "blocked" ? "var(--red)" : "var(--amber-dim)",
            }}
          >
            <div
              style={{
                fontSize: "1.05rem",
                fontWeight: 700,
                color: TONE_COLOR[pipeline.next.tone],
                marginBottom: 6,
              }}
            >
              {pipeline.next.tone === "waiting" && "⏳ "}
              {pipeline.next.tone === "blocked" && "⚠ "}
              {pipeline.next.headline}
            </div>
            <p style={{ fontSize: "0.88rem", lineHeight: 1.6, marginBottom: 12 }}>
              {pipeline.next.detail}
            </p>
            {pipeline.next.cta &&
              (pipeline.next.cta.goes.startsWith("/") ? (
                <Link href={pipeline.next.cta.goes} className="btn">
                  {pipeline.next.cta.label}
                </Link>
              ) : (
                <button
                  className="btn"
                  disabled={ticking}
                  onClick={() => handleCta(pipeline.next.cta!.goes)}
                >
                  {ticking ? "Working…" : pipeline.next.cta.label}
                </button>
              ))}
          </div>
        </>
      )}

      {/* ---------------------------- assign to caller ------------------------ */}
      <div id="assign">
        <AssignPanel
          campaignId={selected}
          readyCount={pipeline?.counts.readyToCall ?? 0}
          activeCallers={pipeline?.activeCallers ?? 0}
          onDone={refresh}
        />
      </div>

      {/* -------------------------------- batches ----------------------------- */}
      <h2 style={{ marginBottom: 4 }}>Lead batches</h2>
      <p className="faint" style={{ marginBottom: 10 }}>
        Each batch is one run of the engine. Old finished batches are just
        history — you can ignore them.
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
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
          <p className="muted">No batches yet. Press Generate leads above.</p>
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
                {campaignStatusText(c.status)}
              </span>
              <button
                className="btn-ghost"
                style={{ padding: "3px 10px", fontSize: "0.7rem" }}
                onClick={() => setEditing(!editing)}
              >
                {editing ? "Done" : "Edit"}
              </button>
              <div style={{ flex: 1 }} />
              {(c.status === "draft" || c.status === "completed") && (
                <button
                  className="btn"
                  onClick={() => act(c.id, "start")}
                  title="Runs this batch again, looking for businesses it has not already saved."
                >
                  ▶ Run again
                </button>
              )}
              {c.status === "running" && (
                <>
                  <button
                    className="btn-ghost"
                    onClick={() => act(c.id, "pause")}
                    title="Stops the searching. Everything already found is kept, and Resume picks up where it left off."
                  >
                    ⏸ Pause
                  </button>
                  <button
                    className="btn-danger"
                    onClick={async () => {
                      const ok = await ask({
                        title: "Stop this batch?",
                        body: [
                          "Every lead already found is kept and stays callable. Only the remaining searches are cancelled.",
                          "You can start it again later.",
                        ],
                        confirmLabel: "Stop it",
                        danger: true,
                      });
                      if (ok) act(c.id, "stop");
                    }}
                    title="Cancels the remaining searches. Leads already found are kept."
                  >
                    ■ Stop
                  </button>
                </>
              )}
              {(c.status === "paused" || c.status === "stopped") && (
                <button className="btn" onClick={() => act(c.id, "resume")}>
                  ▶ Resume
                </button>
              )}
              <button
                className="btn-danger"
                title="Archive every lead from this batch that nobody is holding, so they are never handed to a caller"
                onClick={async () => {
                  const ok = await ask({
                    title: "Bin the unused leads from this batch?",
                    body: [
                      "Every lead from this batch that is not already with a caller gets archived — kept in the database with its history, but never handed to anyone again.",
                      "Leads already in a packet or already called are left alone. To clear those, use the Packets tab.",
                    ],
                    confirmLabel: "Bin them",
                    danger: true,
                  });
                  if (ok) act(c.id, "discard_leads");
                }}
              >
                Bin unused leads
              </button>
            </div>

            {editing && (
              <BatchEditor
                campaign={c}
                onSaved={async () => {
                  setEditing(false);
                  await refresh();
                }}
              />
            )}

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
            <p className="faint">
              <strong>{callable}</strong> callable leads out of the{" "}
              {c.target_lead_count} you asked for
              {stillProcessing > 0 && ` · ${stillProcessing} still processing`}
              {c.status === "running" && " · still searching…"}
            </p>
            <p className="faint" style={{ marginTop: 4 }}>
              It looked at {c.unique_saved} businesses to get there
              {c.duplicates_skipped > 0 && `, skipping ${c.duplicates_skipped} it already had`}
              .
            </p>

            {isShort && (
              <div
                style={{
                  marginTop: 12,
                  padding: "10px 12px",
                  background: "var(--amber-soft)",
                  border: "1px solid var(--amber-dim)",
                  borderRadius: 4,
                }}
              >
                <div style={{ color: "var(--amber)", fontWeight: 700, fontSize: "0.85rem" }}>
                  {c.target_lead_count - callable} short of what you asked for
                </div>
                <p className="faint" style={{ margin: "4px 0 10px", lineHeight: 1.55 }}>
                  {legacyBatch
                    ? "This batch finished under the old rule that stopped at businesses found rather than leads you can actually call. Go get the rest — it will re-run the searches it skipped."
                    : `It stopped because: ${c.completion_reason}`}
                </p>
                <button
                  className="btn"
                  style={{ padding: "6px 14px", fontSize: "0.75rem" }}
                  onClick={() => act(c.id, "topup")}
                >
                  Go get the rest
                </button>
              </div>
            )}

            {c.error_count > 0 && (
              <p style={{ color: "var(--red)", fontSize: "0.82rem", marginTop: 8 }}>
                {c.error_count} search{c.error_count === 1 ? "" : "es"} hit an error.
                Open the engine details below to see what Google said.
              </p>
            )}
          </div>

          {/* --------------------------- engine details -------------------------- */}
          <button
            className="btn-ghost"
            onClick={() => setShowEngine(!showEngine)}
            style={{ marginBottom: 12 }}
          >
            {showEngine ? "Hide engine details" : "Show engine details"}
          </button>

          {showEngine && (
            <>
              <p className="faint" style={{ marginBottom: 12, lineHeight: 1.6 }}>
                Diagnostics. You never need these to run the business — they are
                here so a problem can be identified instead of guessed at.
              </p>

              <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                <button className="btn-ghost" onClick={() => setShowTest(true)}>
                  Test the Google key
                </button>
                <button className="btn-ghost" onClick={pushEngine} disabled={ticking}>
                  {ticking ? "Working…" : "Push the engine along"}
                </button>
                <button className="btn-ghost" onClick={() => setShowForm(true)}>
                  Pick trades and a city yourself
                </button>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                  gap: 10,
                  marginBottom: 16,
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
                      <h3 style={{ color: "var(--red)", marginBottom: 6 }}>
                        What went wrong
                      </h3>
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
        </>
      )}

      {showTest && <PlacesTestDialog onClose={() => setShowTest(false)} />}

      {showMix && (
        <MixDialog
          onClose={() => setShowMix(false)}
          onCreated={(id) => {
            setShowMix(false);
            setSelected(id);
            refresh();
          }}
        />
      )}

      {showForm && (
        <CampaignForm
          onClose={() => setShowForm(false)}
          onCreated={(id) => {
            setShowForm(false);
            setSelected(id);
            refresh();
          }}
        />
      )}

      {dialog}
    </div>
  );
}

/** Rename a batch, or change how many callable leads it should deliver. */
function BatchEditor({
  campaign,
  onSaved,
}: {
  campaign: Campaign;
  onSaved: () => void;
}) {
  const [name, setName] = useState(campaign.name);
  const [target, setTarget] = useState(String(campaign.target_lead_count));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setBusy(true);
    setErr("");
    const res = await fetch(`/api/sourcing/${campaign.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, target_lead_count: Number(target) }),
    });
    const j = await res.json();
    setBusy(false);
    if (!res.ok) {
      setErr(j.error || "Could not save that.");
      return;
    }
    onSaved();
  }

  const raised = Number(target) > campaign.target_lead_count;

  return (
    <div
      style={{
        marginBottom: 14,
        padding: "12px 14px",
        background: "var(--bg-inset)",
        border: "1px solid var(--border)",
        borderRadius: 4,
      }}
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Batch name"
          style={{ flex: "1 1 220px" }}
        />
        <span className="faint">wants</span>
        <input
          type="number"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          style={{ maxWidth: 90 }}
          min={1}
        />
        <span className="faint">callable leads</span>
        <button className="btn" onClick={save} disabled={busy || !name.trim()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {raised && (
        <p className="faint" style={{ marginTop: 8 }}>
          Raising the target also raises this batch&apos;s Google request budget so it
          can actually reach the new number. Press <strong>Go get the rest</strong>{" "}
          afterwards to send it back out.
        </p>
      )}
      {err && <p style={{ color: "var(--red)", marginTop: 8 }}>{err}</p>}
    </div>
  );
}

/** Hand finished leads to a caller. The one action on this page that matters. */
function AssignPanel({
  campaignId,
  readyCount,
  activeCallers,
  onDone,
}: {
  campaignId: string | null;
  readyCount: number;
  activeCallers: number;
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
  }, [activeCallers]);

  async function makePacket() {
    setBusy(true);
    setErr("");
    setMsg("");
    const res = await fetch("/api/packets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourcing_campaign_id: campaignId || undefined,
        caller_id: callerId,
        size: Number(size),
      }),
    });
    const j = await res.json();
    if (!res.ok) setErr(j.error || "Could not create the packet");
    else {
      const name = callers.find((k) => k.id === callerId)?.name || "the caller";
      setMsg(
        `Done. ${j.total} leads are now in ${name}'s dialer` +
          (j.suppressed_excluded
            ? ` (${j.suppressed_excluded} skipped — on the do-not-call list).`
            : ".")
      );
    }
    setBusy(false);
    onDone();
  }

  const canAssign = !!callerId && readyCount > 0;

  return (
    <div className="card" style={{ marginBottom: 26, borderColor: "var(--amber-dim)" }}>
      <h3 style={{ marginBottom: 6, color: "var(--amber)" }}>Hand leads to a caller</h3>
      <p className="faint" style={{ marginBottom: 14, lineHeight: 1.6 }}>
        This is the only step between a finished lead and someone dialing it.
        Packets are also built automatically as leads finish, so most days you
        will not need this — it is here for when you want a specific caller to
        get a specific number of leads. A lead can only ever be in one packet,
        so nobody gets called twice.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select
          value={callerId}
          onChange={(e) => setCallerId(e.target.value)}
          style={{ maxWidth: 200 }}
        >
          <option value="">Choose a caller…</option>
          {callers.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
        <span className="faint">get</span>
        <input
          type="number"
          value={size}
          onChange={(e) => setSize(e.target.value)}
          style={{ maxWidth: 80 }}
          min={1}
        />
        <span className="faint">leads</span>
        <button className="btn" onClick={makePacket} disabled={busy || !canAssign}>
          {busy ? "Assigning…" : "Hand them over"}
        </button>
      </div>
      {callers.length === 0 && (
        <p className="faint" style={{ marginTop: 10 }}>
          No callers yet — add one on the <Link href="/admin/callers">Callers</Link> tab
          first.
        </p>
      )}
      {callers.length > 0 && readyCount === 0 && (
        <p className="faint" style={{ marginTop: 10 }}>
          Nothing is ready to hand over right now.
        </p>
      )}
      {msg && <p style={{ color: "var(--amber)", marginTop: 12 }}>{msg}</p>}
      {err && <p style={{ color: "var(--red)", marginTop: 12 }}>{err}</p>}
    </div>
  );
}

function Big({
  value,
  label,
  sub,
  accent,
  dim,
}: {
  value: number;
  label: string;
  sub: string;
  accent?: boolean;
  dim?: boolean;
}) {
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div
        style={{
          fontSize: "2rem",
          fontWeight: 700,
          lineHeight: 1.1,
          color: dim ? "var(--text-dim)" : accent ? "var(--amber)" : "var(--text)",
        }}
      >
        {value}
      </div>
      <div style={{ fontWeight: 700, fontSize: "0.8rem", marginTop: 2 }}>{label}</div>
      <div className="faint">{sub}</div>
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

/** Makes one real Places call and shows Google's complete answer. */
function PlacesTestDialog({ onClose }: { onClose: () => void }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/diagnostics/places")
      .then((r) => r.json())
      .then(setResult)
      .catch((e) => setErr(String(e)));
  }, []);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
        padding: 20,
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 720, maxWidth: "95vw", maxHeight: "85vh", overflowY: "auto" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <h2>Google Places key test</h2>
          <button className="btn-ghost" style={{ padding: "2px 10px" }} onClick={onClose}>
            ✕
          </button>
        </div>

        {err && <p style={{ color: "var(--red)" }}>{err}</p>}
        {!result && !err && <p className="muted">Calling Google…</p>}

        {result && (
          <div style={{ fontSize: "0.82rem", display: "grid", gap: 10 }}>
            <div>
              Result:{" "}
              <strong style={{ color: result.ok ? "var(--green)" : "var(--red)" }}>
                {result.ok ? "WORKING" : `HTTP ${result.http_status || result.stage}`}
              </strong>
            </div>

            {result.key_fingerprint && (
              <div className="faint">
                Key: {result.key_fingerprint.length} chars,{" "}
                {result.key_fingerprint.starts_with}…{result.key_fingerprint.ends_with}
                {result.key_fingerprint.looks_like_google_key
                  ? " · format looks right"
                  : " · ⚠ does NOT look like a Google API key"}
                {result.key_fingerprint.has_whitespace && " · ⚠ contains whitespace"}
                {result.key_fingerprint.has_quotes && " · ⚠ contains quote characters"}
              </div>
            )}

            {result.likely_cause && (
              <div
                style={{
                  padding: "10px 12px",
                  background: "var(--amber-soft)",
                  border: "1px solid var(--amber-dim)",
                  borderRadius: 4,
                  color: "var(--text)",
                  lineHeight: 1.55,
                }}
              >
                <strong style={{ color: "var(--amber)" }}>Most likely cause: </strong>
                {result.likely_cause}
              </div>
            )}

            {result.google_message && (
              <div>
                <strong>Google says:</strong>
                <div className="muted" style={{ marginTop: 3 }}>
                  {result.google_message}
                </div>
              </div>
            )}

            {result.raw_response && (
              <div>
                <strong>Full response from Google:</strong>
                <pre
                  style={{
                    marginTop: 4,
                    padding: 10,
                    background: "var(--bg-inset)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontSize: "0.72rem",
                    maxHeight: 300,
                    overflowY: "auto",
                  }}
                >
                  {result.raw_response}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
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
          This is how many <strong>callable</strong> leads you get. Roughly half
          of what Google returns is discarded — too big to be owner-operated, no
          phone number, closed down — so the engine keeps searching until it has
          made up the difference. Ask for the number you actually want.
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
          {!ready && <span className="faint">Pick a trade and a location</span>}
        </div>
      </div>
    </div>
  );
}
