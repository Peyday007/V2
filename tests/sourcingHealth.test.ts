// A lock is not a heartbeat.
//
// THE PRODUCTION FAILURE THESE PROTECT AGAINST:
//
// /admin/email reported "A sourcing run is already going" alongside 0 qualified
// contacts, 0 days of reserve, and ~989 sends of capacity going unused. The run
// had been marked running for days and had been dead for nearly as long.
//
// sourcing_campaigns.status is set to 'running' when a run starts and cleared
// only by finishCampaignIfDone, which is called exclusively from inside a job
// handler for that campaign. Exhaust max_attempts on those jobs — a bad Places
// key, a quota wall, a worker that timed out — and nothing is left alive to
// clear it. The lock wedges permanently and every downstream check politely
// waits for a run that will never finish.
//
// The jobs table already solved this: claim_jobs reclaims any lease older than
// 300 seconds. These tests hold the campaign lock to the same standard.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  assessRun,
  productionStatus,
  STALE_AFTER_MINUTES,
  NEVER_STARTED_AFTER_MINUTES,
  type RunFacts,
  type RunCounters,
} from "../src/lib/sourcingHealth";

const NOW = new Date("2026-08-15T12:00:00Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

const counters = (over: Partial<RunCounters> = {}): RunCounters => ({
  searchesPlanned: 12,
  searchesCompleted: 5,
  apiRequestsUsed: 40,
  businessesReturned: 300,
  uniqueSaved: 120,
  duplicatesSkipped: 180,
  qualificationFailures: 10,
  enrichmentQueued: 120,
  errorCount: 0,
  lastError: null,
  ...over,
});

const run = (over: Partial<RunFacts> = {}): RunFacts => ({
  id: "run-1",
  name: "Auto — plumbers in Detroit MI",
  status: "running",
  startedAt: minutesAgo(20),
  updatedAt: minutesAgo(2),
  counters: counters(),
  ...over,
});

/* -------------------------------------------------------------------------- */

describe("A LOCK ONLY COUNTS WHILE SOMETHING IS BEHIND IT", () => {
  it("a run that moved two minutes ago is progressing", () => {
    const a = assessRun(run(), NOW);
    expect(a.state).toBe("progressing");
    expect(a.blocksNewRun).toBe(true);
    expect(a.shouldRecover).toBe(false);
  });

  it("THE WEDGED RUN: marked running, nothing moved for days", () => {
    // The exact production state: counters advanced once, then stopped.
    const a = assessRun(
      run({ startedAt: minutesAgo(4320), updatedAt: minutesAgo(4000) }),
      NOW
    );
    expect(a.state).toBe("stalled");
    expect(a.shouldRecover).toBe(true);
    expect(a.blocksNewRun).toBe(false); // the whole point — it stops blocking
    expect(a.minutesSinceProgress).toBe(4000);
    expect(a.reason).toMatch(/nothing has changed/i);
  });

  it("the boundary is exactly STALE_AFTER_MINUTES", () => {
    expect(assessRun(run({ updatedAt: minutesAgo(STALE_AFTER_MINUTES - 1) }), NOW).state).toBe(
      "progressing"
    );
    expect(assessRun(run({ updatedAt: minutesAgo(STALE_AFTER_MINUTES) }), NOW).state).toBe(
      "stalled"
    );
  });

  it("a run that never moved at all is dead on arrival", () => {
    const a = assessRun(
      run({
        startedAt: minutesAgo(NEVER_STARTED_AFTER_MINUTES + 5),
        updatedAt: minutesAgo(NEVER_STARTED_AFTER_MINUTES + 5),
        counters: counters({ searchesCompleted: 0, uniqueSaved: 0 }),
      }),
      NOW
    );
    expect(a.state).toBe("never_started");
    expect(a.shouldRecover).toBe(true);
    expect(a.blocksNewRun).toBe(false);
  });

  it("but a run that has only just started is given a moment", () => {
    const a = assessRun(
      run({
        startedAt: minutesAgo(2),
        updatedAt: minutesAgo(2),
        counters: counters({ searchesCompleted: 0, uniqueSaved: 0 }),
      }),
      NOW
    );
    expect(a.state).toBe("progressing");
    expect(a.shouldRecover).toBe(false);
  });

  it("a dead run surfaces the error that killed it", () => {
    const a = assessRun(
      run({
        startedAt: minutesAgo(60),
        updatedAt: minutesAgo(60),
        counters: counters({
          searchesCompleted: 0,
          uniqueSaved: 0,
          errorCount: 5,
          lastError: "Places API: REQUEST_DENIED (quota exceeded)",
        }),
      }),
      NOW
    );
    expect(a.state).toBe("never_started");
    expect(a.reason).toMatch(/REQUEST_DENIED/);
  });

  it("nothing running is not a fault", () => {
    const a = assessRun(null, NOW);
    expect(a.state).toBe("not_running");
    expect(a.blocksNewRun).toBe(false);
    expect(a.shouldRecover).toBe(false);
  });

  it("a completed or failed run never blocks", () => {
    for (const status of ["completed", "failed", "stopped", "paused", "draft"]) {
      expect(assessRun(run({ status }), NOW).blocksNewRun, status).toBe(false);
    }
  });

  it("an unparseable timestamp does not wedge or crash", () => {
    const a = assessRun(run({ updatedAt: "not a date", startedAt: null }), NOW);
    expect(a.minutesSinceProgress).toBeNull();
    expect(typeof a.blocksNewRun).toBe("boolean");
  });
});

/* -------------------------------------------------------------------------- */

describe("RECOVERY IS WIRED IN, NOT MERELY AVAILABLE", () => {
  const store = readFileSync(new URL("../src/lib/funnelStore.ts", import.meta.url), "utf8");

  it("the bare count of running campaigns is gone", () => {
    // The old gate: `.eq("status", "running")` counted, nothing else asked.
    expect(store).not.toMatch(/async function sourcingIsRunning/);
    expect(store).toMatch(/export async function activeSourcingRun/);
  });

  it("the funnel gates on the ASSESSMENT, not on the row existing", () => {
    expect(store).toMatch(/assessRun\(/);
    expect(store).toMatch(/const running = active\.assessment\.blocksNewRun/);
  });

  it("a dead run is actually released, and the release is guarded", () => {
    expect(store).toMatch(/shouldRecover/);
    expect(store).toMatch(/status: "failed"/);
    // Guarded on status='running' so two workers cannot both recover it.
    expect(store).toMatch(/\.eq\("status", "running"\)/);
  });

  it("the release is recorded rather than done silently", () => {
    expect(store).toMatch(/campaign\.recovered/);
  });

  it("an unreadable table still refuses to spend", () => {
    // Not knowing must never authorise starting a run.
    expect(store).toMatch(/blocksNewRun: true/);
  });

  it("the status view reports PROGRESS, not the presence of a lock", () => {
    expect(store).toMatch(/const progressing = active\?\.assessment\.state === "progressing"/);
    expect(store).toMatch(/sourcingRunning: progressing/);
  });
});

/* -------------------------------------------------------------------------- */

describe("THE PRODUCTION STATUS SAYS WHAT IS ACTUALLY HAPPENING", () => {
  const base = {
    qualifiedReady: 0,
    run: assessRun(null, NOW),
    enrichmentResolved: 0,
    enrichmentQualified: 0,
    providerBlocker: null as string | null,
    sourcingEnabled: true,
  };

  it("a blocked provider outranks everything, because it explains it", () => {
    const s = productionStatus({
      ...base,
      providerBlocker: "GOOGLE_PLACES_API_KEY is not set on this deployment",
      qualifiedReady: 500,
    });
    expect(s.status).toBe("PROVIDER BLOCKED");
    expect(s.needsHuman).toBe(true);
    expect(s.detail).toMatch(/GOOGLE_PLACES_API_KEY/);
  });

  it("A STALLED RUN IS NEVER REPORTED AS RUNNING", () => {
    const stalled = assessRun(
      run({ startedAt: minutesAgo(4320), updatedAt: minutesAgo(4000) }),
      NOW
    );
    const s = productionStatus({ ...base, run: stalled });
    expect(s.status).toBe("SOURCING STALLED");
    expect(s.status).not.toBe("SOURCING AND MAKING PROGRESS");
  });

  it("contacts ready outranks a healthy run", () => {
    const s = productionStatus({ ...base, qualifiedReady: 400, run: assessRun(run(), NOW) });
    expect(s.status).toBe("QUALIFIED CONTACTS READY");
    expect(s.detail).toMatch(/400/);
  });

  it("a live run with nothing yet is progress", () => {
    const s = productionStatus({ ...base, run: assessRun(run(), NOW) });
    expect(s.status).toBe("SOURCING AND MAKING PROGRESS");
    expect(s.needsHuman).toBe(false);
  });

  it("ENRICHMENT PRODUCING ZERO, once there is enough to say so", () => {
    const s = productionStatus({
      ...base,
      run: assessRun(run(), NOW),
      enrichmentResolved: 400,
      enrichmentQualified: 0,
    });
    expect(s.status).toBe("ENRICHMENT PRODUCING ZERO");
    expect(s.needsHuman).toBe(true);
    expect(s.detail).toMatch(/400 leads/);
  });

  it("a handful of misses is noise, not a verdict", () => {
    const s = productionStatus({
      ...base,
      run: assessRun(run(), NOW),
      enrichmentResolved: 4,
      enrichmentQualified: 0,
    });
    expect(s.status).not.toBe("ENRICHMENT PRODUCING ZERO");
  });

  it("idle with sourcing switched off is a human's problem", () => {
    const s = productionStatus({ ...base, sourcingEnabled: false });
    expect(s.status).toBe("IDLE — NOTHING TO DO");
    expect(s.needsHuman).toBe(true);
  });

  it("idle with sourcing on is not", () => {
    expect(productionStatus({ ...base, sourcingEnabled: true }).needsHuman).toBe(false);
  });

  it("EVERY STATUS CARRIES ITS NUMBERS", () => {
    for (const facts of [
      { ...base, qualifiedReady: 12 },
      { ...base, run: assessRun(run(), NOW) },
      { ...base, enrichmentResolved: 99, enrichmentQualified: 0, run: assessRun(run(), NOW) },
    ]) {
      const s = productionStatus(facts);
      expect(s.detail.length).toBeGreaterThan(20);
      expect(s.detail).toMatch(/\d/); // a bare headline is what this replaces
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("THE PAGE STOPS CLAIMING 'RUNNING' FROM A LOCK", () => {
  const page = readFileSync(
    new URL("../src/app/(admin)/admin/email/page.tsx", import.meta.url),
    "utf8"
  );

  it("the headline is the production status", () => {
    expect(page).toMatch(/funnel\.status\?\.status/);
    // The old unconditional claim is gone.
    expect(page).not.toMatch(/\? "Automation is running" :/);
  });

  it("the run's counters are on the page, open when it is not progressing", () => {
    expect(page).toMatch(/Sourcing run —/);
    expect(page).toMatch(/open=\{funnel\.sourcingRun\.state !== "progressing"\}/);
    for (const field of [
      "searchesCompleted",
      "businessesFound",
      "duplicatesRejected",
      "leadsInserted",
      "enrichmentQueued",
      "lastError",
    ]) {
      expect(page, field).toContain(field);
    }
  });

  it("a recovered lock is announced, not hidden", () => {
    expect(page).toMatch(/staleLockRecovered/);
  });
});
