"use client";

import { useCallback, useEffect, useState } from "react";

/* -------------------------------------------------------------------------- */
/* types, mirroring src/lib/enrichmentReport.ts                                */
/* -------------------------------------------------------------------------- */

type Funnel = {
  businessesCollected: number;
  ownersIdentified: number;
  directNumbersFound: number;
  verifiedDirectNumbers: number;
  callReady: number;
  byGrade: Record<string, number>;
  ownerDiscoveryRate: number | null;
  directNumberDiscoveryRate: number | null;
  endToEndRate: number | null;
};

type CallOutcomes = {
  calls: number;
  livePersonReached: number;
  ownerConversations: number;
  meetings: number;
  ownerConversationsPer100: number | null;
  livePersonPer100: number | null;
  meetingsPer100: number | null;
  ownerShareOfLiveAnswers: number | null;
};

type Report = {
  days: number;
  headline: string;
  funnel: Funnel;
  cost: {
    totalCents: number;
    lookups: number;
    hits: number;
    costPerNumberCents: number | null;
    costPerVerifiedNumberCents: number | null;
    costPerCallReadyLeadCents: number | null;
  };
  overall: CallOutcomes;
  split: {
    enriched: CallOutcomes;
    mainLine: CallOutcomes;
    liftPer100: number | null;
    verdict: string;
  };
  accuracy: {
    judged: number;
    confirmed: number;
    wrongPerson: number;
    wrongNumber: number;
    wrongPersonRate: number | null;
    wrongNumberRate: number | null;
    accuracy: number | null;
  };
  byGrade: {
    grade: string;
    leads: number;
    calls: number;
    ownerConversations: number;
    meetings: number;
    ownerConversationsPer100: number | null;
    meetingsPer100: number | null;
  }[];
  byNumberType: {
    phoneClass: string;
    leads: number;
    calls: number;
    ownerConversations: number;
    ownerConversationsPer100: number | null;
  }[];
  byProvider: {
    provider: string;
    lookups: number;
    hits: number;
    errors: number;
    hitRate: number | null;
    costCents: number;
    costPerHitCents: number | null;
    ownerConversations: number;
    contradicted: number;
    costPerOwnerConversationCents: number | null;
    verdict: string;
  }[];
};

type Settings = {
  enabled: boolean;
  max_cost_per_lead_cents: number;
  max_provider_attempts: number;
  monthly_budget_cents: number;
  per_run_budget_cents: number;
  min_confidence: number;
  data_expiry_days: number;
  max_retries: number;
  /** From 0040. Absent on an older database — every read defaults it below. */
  auto_reenrich_enabled?: boolean;
  auto_reenrich_batch?: number;
  last_reenrich_note?: string | null;
  last_reenrich_at?: string | null;
  last_reenrich_queued?: number | null;
};

type ProviderStatus = {
  key: string;
  label: string;
  available: boolean;
  reason: string | null;
  billsOnlyOnHit: boolean;
  costPerHitCents: number;
};

type SpendRow = { period: string; cents: number; lookups: number; hits: number };

type Payload = {
  report: Report | null;
  settings: Settings | null;
  spend: SpendRow[];
  providers: ProviderStatus[];
  capability: { available: boolean; reason: string } | null;
  error: string | null;
};

/* -------------------------------------------------------------------------- */
/* formatting                                                                 */
/* -------------------------------------------------------------------------- */

const money = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? "—" : `$${(cents / 100).toFixed(2)}`;
const rate = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
const per100 = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : v.toFixed(1);

function Figure({
  label,
  value,
  note,
  strong,
}: {
  label: string;
  value: string;
  note?: string;
  strong?: boolean;
}) {
  return (
    <div>
      <div
        className="faint"
        style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.08em" }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: strong ? "2rem" : "1.4rem",
          fontWeight: 700,
          color: strong ? "var(--amber)" : "var(--text)",
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      {note && (
        <div className="faint" style={{ fontSize: "0.75rem", marginTop: 2 }}>
          {note}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** What a re-enrichment run would do. Shape from /api/enrichment/backfill. */
type Backfill = {
  error: string | null;
  capabilities: {
    directNumber: boolean;
    directNumberNote: string;
  };
  plan: {
    queue: number;
    waiting: number;
    summary: string;
    maxBatch: number;
    skipped: { reason: string; count: number }[];
  } | null;
};

export default function EnrichmentPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [draft, setDraft] = useState<Settings | null>(null);
  const [backfill, setBackfill] = useState<Backfill | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [confirmAutoReenrich, setConfirmAutoReenrich] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/enrichment?days=${days}`);
      const j = await res.json();
      // Every field defaulted here as well as on the server. A page that reads
      // a field off a partial payload is a white screen, which is how this
      // class of bug showed up on the review queue.
      setData({
        report: j.report ?? null,
        settings: j.settings ?? null,
        spend: j.spend ?? [],
        providers: j.providers ?? [],
        capability: j.capability ?? null,
        error: j.error ?? null,
      });
      if (j.settings) setDraft(j.settings);
      // Separate request: a failure here must not blank the report, which is
      // what this page is actually for.
      fetch("/api/enrichment/backfill")
        .then((r) => r.json())
        .then(setBackfill)
        .catch(() => setBackfill(null));
    } catch (e) {
      setData({
        report: null,
        settings: null,
        spend: [],
        providers: [],
        capability: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [days]);

  /*
   * Queue a re-enrichment batch.
   *
   * Nothing happens on screen when this succeeds, and that is correct — the
   * jobs are worked by the background worker, not by this request. Saying so
   * out loud matters: a button that appears to do nothing is the one people
   * press five times.
   */
  async function queueBackfill() {
    setQueueing(true);
    setMsg("");
    try {
      const res = await fetch("/api/enrichment/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.error) {
        setMsg(j.error || "Could not queue the re-enrichment.");
        return;
      }
      setMsg(
        `${j.note}${j.waiting ? ` ${j.waiting} more are waiting for the next run.` : ""}` +
          (j.capabilities && !j.capabilities.directNumber
            ? ` ${j.capabilities.directNumberNote}`
            : "")
      );
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not queue the re-enrichment.");
    } finally {
      setQueueing(false);
    }
  }

  useEffect(() => {
    load();
  }, [load]);

  async function save(patch: Partial<Settings>) {
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/enrichment", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const j = await res.json();
    setBusy(false);
    if (!res.ok || j.error) {
      setMsg(j.error || "Could not save that.");
      return;
    }
    setMsg("Saved.");
    load();
  }

  if (!data) return <p className="muted">Loading…</p>;

  const r = data.report;
  const thisMonth = data.spend[0];

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>Owner enrichment</h1>
      <p className="faint" style={{ marginBottom: 18, lineHeight: 1.6 }}>
        Whether finding the owner&rsquo;s own number is worth what it costs.{" "}
        <strong>One number decides that</strong> — owner conversations per 100
        calls. Everything else on this page is supporting evidence.
      </p>

      {data.error && (
        <div
          className="card"
          style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 16, lineHeight: 1.55 }}
        >
          {data.error}
        </div>
      )}
      {msg && (
        <div className="card" style={{ borderColor: "var(--amber-dim)", marginBottom: 16 }}>
          {msg}
        </div>
      )}

      {/* --------------------- leads enriched before we could -------------- */}
      {backfill?.plan && backfill.plan.queue > 0 && (
        <div className="card" style={{ borderColor: "var(--amber-dim)", marginBottom: 20 }}>
          <h2 style={{ marginTop: 0, marginBottom: 10 }}>Leads enriched before we could collect anything</h2>
          <p style={{ lineHeight: 1.7, marginTop: 0 }}>
            These were enriched successfully, against a version of this application that could
            not read an email address off a website, could not diagnose the business properly,
            and often did not find the owner&rsquo;s name. Nothing failed and nothing is stuck —
            the code simply did not exist yet.
          </p>
          <p className="faint" style={{ lineHeight: 1.7 }}>
            {backfill.plan.summary.replace(/^Queued/, "A run would queue")}
          </p>
          <p style={{ lineHeight: 1.7, color: backfill.capabilities.directNumber ? undefined : "var(--red)" }}>
            {backfill.capabilities.directNumberNote}
          </p>
          {backfill.plan.skipped.length > 0 && (
            <ul className="faint" style={{ lineHeight: 1.6, marginTop: 0 }}>
              {backfill.plan.skipped.map((s) => (
                <li key={s.reason}>
                  {s.count} skipped — {s.reason.toLowerCase()}
                </li>
              ))}
            </ul>
          )}
          {/*
            NOT gated behind the paid-enrichment switch.

            That switch controls whether a contact PROVIDER may be billed. The
            work that matters here — reading an email address and an owner's
            name off the business's own website, and diagnosing the site — is
            a crawl, and it costs nothing. Requiring the paid switch meant the
            only way to find email addresses was to also authorise spending,
            which is why the pool stayed dry. enrichLeadForOwner still gates
            the paid stage on its own, so nothing is billed by this button.
          */}
          <button className="btn" onClick={queueBackfill} disabled={queueing}>
            {queueing ? "Queueing…" : `Re-enrich ${backfill.plan.queue} leads`}
          </button>
          {!data.settings?.enabled && (
            <span className="faint" style={{ marginLeft: 12 }}>
              Finds emails, names and diagnoses for free. Paid direct-number
              lookups stay off until you switch enrichment on below.
            </span>
          )}
          {backfill.plan.waiting > 0 && (
            <span className="faint" style={{ marginLeft: 12 }}>
              {backfill.plan.waiting} more after that — press again tomorrow.
            </span>
          )}

          <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
            <p className="faint" style={{ lineHeight: 1.7, marginTop: 0, marginBottom: 10 }}>
              This button exists at all because these leads were processed by older code — new
              leads already get enriched automatically with nobody pressing anything. Switch this
              on and the same catch-up run happens on its own, once a day, until the backlog is
              gone.
              {data.settings?.last_reenrich_at
                ? ` Last run ${new Date(data.settings.last_reenrich_at).toLocaleString()}${
                    data.settings.last_reenrich_note ? ` — ${data.settings.last_reenrich_note}` : ""
                  }`
                : ""}
            </p>
            {!data.settings?.auto_reenrich_enabled && (
              <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer", marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={confirmAutoReenrich}
                  onChange={(e) => setConfirmAutoReenrich(e.target.checked)}
                />
                <span className="faint">
                  I understand it will crawl these websites on its own schedule.
                </span>
              </label>
            )}
            <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={!!data.settings?.auto_reenrich_enabled}
                disabled={busy || (!data.settings?.auto_reenrich_enabled && !confirmAutoReenrich)}
                onChange={(e) => save({ auto_reenrich_enabled: e.target.checked })}
              />
              <span>Catch these up without me pressing anything</span>
            </label>
          </div>
        </div>
      )}

      {/* ------------------------- is it even switched on ------------------- */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
          <strong>Enrichment is {data.settings?.enabled ? "ON" : "OFF"}</strong>
          <button
            className="btn"
            disabled={busy || !data.settings}
            onClick={() => save({ enabled: !data.settings?.enabled })}
          >
            {data.settings?.enabled ? "Turn it off" : "Turn it on"}
          </button>
        </div>
        <p className="faint" style={{ marginTop: 6, lineHeight: 1.55 }}>
          Off means no paid provider request can be made at all. It ships off, and
          nothing in the pipeline can switch it on — that is an administrator&rsquo;s
          decision, not the outcome of a run. Owner identification from public
          sources runs either way; without a provider, leads grade C at best.
        </p>
        {data.capability && (
          <p
            className="faint"
            style={{ marginTop: 8, lineHeight: 1.55, color: data.capability.available ? undefined : "var(--red)" }}
          >
            {data.capability.reason}
          </p>
        )}
      </div>

      {/* ----------------------------- the headline ------------------------- */}
      {r && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", marginBottom: 14 }}>
            <h2 style={{ margin: 0 }}>Last {r.days} days</h2>
            <div style={{ flex: 1 }} />
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                className={d === days ? "btn" : "btn-ghost"}
                style={{ padding: "4px 12px", fontSize: "0.7rem" }}
                onClick={() => setDays(d)}
              >
                {d}d
              </button>
            ))}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
              gap: 18,
            }}
          >
            <Figure
              strong
              label="Owner conversations / 100 calls"
              value={per100(r.overall.ownerConversationsPer100)}
              note={`${r.overall.ownerConversations} of ${r.overall.calls} calls`}
            />
            <Figure
              label="Live person / 100 calls"
              value={per100(r.overall.livePersonPer100)}
              note={`${r.overall.livePersonReached} answered`}
            />
            <Figure
              label="Owners as a share of answers"
              value={rate(r.overall.ownerShareOfLiveAnswers)}
              note="Was 5% in the batch that prompted this"
            />
            <Figure
              label="Meetings / 100 calls"
              value={per100(r.overall.meetingsPer100)}
              note={`${r.overall.meetings} booked`}
            />
          </div>

          <p style={{ marginTop: 16, lineHeight: 1.6 }}>{r.split.verdict}</p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: 18,
              marginTop: 12,
            }}
          >
            <Figure
              label="Calls to enriched records"
              value={per100(r.split.enriched.ownerConversationsPer100)}
              note={`owners / 100, over ${r.split.enriched.calls} calls`}
            />
            <Figure
              label="Calls to main-line records"
              value={per100(r.split.mainLine.ownerConversationsPer100)}
              note={`owners / 100, over ${r.split.mainLine.calls} calls`}
            />
          </div>
        </div>
      )}

      {/* ------------------------------ the funnel -------------------------- */}
      {r && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2 style={{ marginTop: 0, marginBottom: 12 }}>What the pipeline produced</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 18,
            }}
          >
            <Figure label="Businesses collected" value={String(r.funnel.businessesCollected)} />
            <Figure
              label="Owners identified"
              value={String(r.funnel.ownersIdentified)}
              note={`${rate(r.funnel.ownerDiscoveryRate)} of businesses`}
            />
            <Figure
              label="Direct numbers found"
              value={String(r.funnel.directNumbersFound)}
              note={`${rate(r.funnel.directNumberDiscoveryRate)} of owners`}
            />
            <Figure
              label="Provider-verified numbers"
              value={String(r.funnel.verifiedDirectNumbers)}
            />
            <Figure
              label="Call-ready (A + B)"
              value={String(r.funnel.callReady)}
              note={`${rate(r.funnel.endToEndRate)} end to end`}
            />
          </div>
          <p className="faint" style={{ marginTop: 12, lineHeight: 1.55 }}>
            A {r.funnel.byGrade.A ?? 0} · B {r.funnel.byGrade.B ?? 0} · C{" "}
            {r.funnel.byGrade.C ?? 0} · D {r.funnel.byGrade.D ?? 0}. Only A and B
            enter the direct-call queue; C leads have a named owner but only a
            switchboard, and belong to a main-line campaign.
          </p>
        </div>
      )}

      {/* ------------------------------ the cost ---------------------------- */}
      {r && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2 style={{ marginTop: 0, marginBottom: 12 }}>What it cost</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 18,
            }}
          >
            <Figure label="Spent" value={money(r.cost.totalCents)} note={`${r.cost.lookups} lookups`} />
            <Figure
              label="Per direct number"
              value={money(r.cost.costPerNumberCents)}
              note="Failed lookups included"
            />
            <Figure
              label="Per verified number"
              value={money(r.cost.costPerVerifiedNumberCents)}
            />
            <Figure label="Per call-ready lead" value={money(r.cost.costPerCallReadyLeadCents)} />
          </div>
          {thisMonth && (
            <p className="faint" style={{ marginTop: 12 }}>
              {thisMonth.period}: {money(thisMonth.cents)} of{" "}
              {money(data.settings?.monthly_budget_cents ?? null)} monthly budget ·{" "}
              {thisMonth.hits} hits from {thisMonth.lookups} lookups.
            </p>
          )}
        </div>
      )}

      {/* --------------------- what the callers found out -------------------- */}
      {r && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2 style={{ marginTop: 0, marginBottom: 12 }}>What the callers found out</h2>
          {r.accuracy.judged === 0 ? (
            <p className="faint" style={{ lineHeight: 1.55 }}>
              No caller has judged an enriched number yet. The &ldquo;Number
              wrong?&rdquo; button on the dialer is what fills this in, and it is
              the only evidence here that comes from actually dialling.
            </p>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: 18,
              }}
            >
              <Figure
                label="Data confirmed"
                value={rate(r.accuracy.accuracy)}
                note={`${r.accuracy.confirmed} of ${r.accuracy.judged} judged`}
              />
              <Figure
                label="Wrong person"
                value={rate(r.accuracy.wrongPersonRate)}
                note={`${r.accuracy.wrongPerson} calls`}
              />
              <Figure
                label="Wrong number"
                value={rate(r.accuracy.wrongNumberRate)}
                note={`${r.accuracy.wrongNumber} calls`}
              />
            </div>
          )}
        </div>
      )}

      {/* ------------------------------- by grade ---------------------------- */}
      {r && r.byGrade.some((g) => g.calls > 0) && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2 style={{ marginTop: 0, marginBottom: 12 }}>Results by grade</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr className="faint" style={{ textAlign: "left", fontSize: "0.72rem" }}>
                  <th style={{ padding: "4px 8px" }}>Grade</th>
                  <th style={{ padding: "4px 8px" }}>Leads</th>
                  <th style={{ padding: "4px 8px" }}>Calls</th>
                  <th style={{ padding: "4px 8px" }}>Owners / 100</th>
                  <th style={{ padding: "4px 8px" }}>Meetings / 100</th>
                </tr>
              </thead>
              <tbody>
                {r.byGrade.map((g) => (
                  <tr key={g.grade} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "6px 8px", fontWeight: 700 }}>{g.grade}</td>
                    <td style={{ padding: "6px 8px" }}>{g.leads}</td>
                    <td style={{ padding: "6px 8px" }}>{g.calls}</td>
                    <td style={{ padding: "6px 8px" }}>{per100(g.ownerConversationsPer100)}</td>
                    <td style={{ padding: "6px 8px" }}>{per100(g.meetingsPer100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------------------------- by number type ------------------------- */}
      {r && r.byNumberType.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2 style={{ marginTop: 0, marginBottom: 12 }}>Results by number type</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr className="faint" style={{ textAlign: "left", fontSize: "0.72rem" }}>
                  <th style={{ padding: "4px 8px" }}>Type</th>
                  <th style={{ padding: "4px 8px" }}>Leads</th>
                  <th style={{ padding: "4px 8px" }}>Calls</th>
                  <th style={{ padding: "4px 8px" }}>Owners / 100</th>
                </tr>
              </thead>
              <tbody>
                {r.byNumberType.map((n) => (
                  <tr key={n.phoneClass} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "6px 8px" }}>{n.phoneClass.replace(/_/g, " ")}</td>
                    <td style={{ padding: "6px 8px" }}>{n.leads}</td>
                    <td style={{ padding: "6px 8px" }}>{n.calls}</td>
                    <td style={{ padding: "6px 8px" }}>{per100(n.ownerConversationsPer100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ------------------------------ providers ---------------------------- */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0, marginBottom: 12 }}>Providers</h2>
        <div style={{ display: "grid", gap: 10 }}>
          {data.providers.map((p) => {
            const stats = r?.byProvider.find((x) => x.provider === p.key);
            return (
              <div key={p.key} style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  <strong>{p.label}</strong>
                  <span className="tag-dim">{money(p.costPerHitCents)} per hit</span>
                  <span className="tag-dim">
                    {p.billsOnlyOnHit ? "bills on hit" : "bills per request"}
                  </span>
                  <span
                    className="tag"
                    style={{ color: p.available ? "var(--amber)" : "var(--text-dim)" }}
                  >
                    {p.available ? "configured" : "not configured"}
                  </span>
                </div>
                {!p.available && p.reason && (
                  <p className="faint" style={{ marginTop: 4 }}>
                    {p.reason}
                  </p>
                )}
                {stats && (
                  <p className="faint" style={{ marginTop: 4, lineHeight: 1.5 }}>
                    {stats.lookups} lookups · {stats.hits} numbers ({rate(stats.hitRate)}) ·{" "}
                    {stats.errors} errors · {money(stats.costCents)} spent ·{" "}
                    {money(stats.costPerHitCents)} per number ·{" "}
                    {money(stats.costPerOwnerConversationCents)} per owner conversation.{" "}
                    {stats.verdict}
                  </p>
                )}
              </div>
            );
          })}
        </div>
        <p className="faint" style={{ marginTop: 12, lineHeight: 1.55 }}>
          Neither adapter has been run against a live account. Both were written
          from published request and response shapes, so verify the mapping and
          start with a small cap before trusting a bill.
        </p>
      </div>

      {/* ------------------------------- budget ------------------------------ */}
      {draft && (
        <div className="card" style={{ marginBottom: 40 }}>
          <h2 style={{ marginTop: 0, marginBottom: 6 }}>Budget</h2>
          <p className="faint" style={{ marginBottom: 14, lineHeight: 1.55 }}>
            Checked <strong>before</strong> each provider call, never after. A
            provider whose cost would breach a cap is not tried at all.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
              gap: 14,
            }}
          >
            {(
              [
                ["max_cost_per_lead_cents", "Most to spend on one lead (cents)"],
                ["max_provider_attempts", "Providers tried per lead"],
                ["per_run_budget_cents", "Most for one run (cents)"],
                ["monthly_budget_cents", "Monthly budget (cents)"],
                ["data_expiry_days", "Re-enrich after (days)"],
                ["max_retries", "Retries before leaving it alone"],
              ] as [keyof Settings, string][]
            ).map(([key, label]) => (
              <label key={String(key)} style={{ display: "block" }}>
                <span className="faint" style={{ fontSize: "0.75rem" }}>
                  {label}
                </span>
                <input
                  type="number"
                  value={String(draft[key] ?? "")}
                  onChange={(e) =>
                    setDraft({ ...draft, [key]: Number(e.target.value) } as Settings)
                  }
                  style={{ width: "100%", marginTop: 3 }}
                />
              </label>
            ))}
          </div>
          <button
            className="btn"
            disabled={busy}
            style={{ marginTop: 14 }}
            onClick={() =>
              save({
                max_cost_per_lead_cents: draft.max_cost_per_lead_cents,
                max_provider_attempts: draft.max_provider_attempts,
                per_run_budget_cents: draft.per_run_budget_cents,
                monthly_budget_cents: draft.monthly_budget_cents,
                data_expiry_days: draft.data_expiry_days,
                max_retries: draft.max_retries,
              })
            }
          >
            {busy ? "Saving…" : "Save budget"}
          </button>
        </div>
      )}
    </div>
  );
}
