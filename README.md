# Dispatch Board

Cold-calling CRM for a small team selling AI Receptionist services to roofing companies.

- **Sourcing** (`/admin/sourcing`) — **the lead-generation engine.** Create a campaign (industry, city/ZIPs, search terms, target count, rating/review filters, franchise exclusion, API request cap) and press Start. The engine searches Google Places in the background, saves each business the moment it's returned, deduplicates it, runs quick qualification, and queues it for enrichment. Live progress: searches planned/completed, API requests used, businesses returned, unique saved, duplicates skipped, qualification failures, enrichment queued, errors. Pause/Resume/Stop at any time.
- **Board** (`/`) — the Sales board shows your **leads** as cards moving through New Lead → Contact Attempted → Qualified → Discovery Booked → Discovery Completed → Closed Won/Lost. Call outcomes logged in the dialer advance the card automatically. The Delivery board tracks won deals through onboarding.
- **Dial** (`/dial`) — caller signs in with a 6-digit PIN, works one lead at a time: sees who to ask for (recommended calling approach), known decision-maker contacts, previous call history, logs outcomes with one click, and saves anything learned on the call (names, extensions, callback times, transfer instructions) so it's never rediscovered
- **Metrics** (`/metrics`) — DM-conversations-per-100-dials and related rates
- **Campaigns** (`/admin/campaigns`) — create campaigns, generate locked lead packets per caller, "What to Attack Today" AI prioritizer
- **Import** (`/admin/import`) — upload any lead CSV, map its columns, and import with normalization (phone/domain/name/state) and duplicate linking (same phone, domain, or place ID links to the existing lead — nothing deleted, no duplicate calling)
- **Callers** (`/admin/callers`) — add callers (auto-generated PIN), revoke instantly

Leads marked "Do not call" are excluded from all future packets automatically.

There is **no login** on the app itself by design — anyone with the URL has access. Caller PINs only control the dialer.

## First-time setup (do these in order)

### 1. Create the Supabase project

1. Go to https://supabase.com and sign in.
2. Click **New project**, name it (e.g. `dispatch-board`), set a database password, click **Create new project**.
3. Wait for it to finish provisioning (~1 minute).

### 2. Run the database migrations

1. In your Supabase project, click **SQL Editor** in the left sidebar.
2. Click **New query**.
3. Open the file `supabase/migrations/0001_core.sql` from this repo, copy ALL of it, paste it into the editor, click **Run** (bottom right). You should see "Success".
4. Repeat with `supabase/migrations/0002_events.sql` (new query, paste, Run).
5. Repeat with `supabase/migrations/0003_enrichment.sql` (new query, paste, Run).
6. Repeat with `supabase/migrations/0004_lead_stages.sql` (new query, paste, Run).
7. Repeat with `supabase/migrations/0005_canonical_stages.sql` (new query, paste, Run).
8. Repeat with `supabase/migrations/0006_engine_foundation.sql` (new query, paste, Run).
9. Repeat with `supabase/migrations/0008_packets_from_sourcing.sql` (new query, paste, Run).
9b. Repeat with `supabase/migrations/0011_owner_intel.sql` (new query, paste, Run).
9c. Repeat with `supabase/migrations/0012_event_memory.sql` (new query, paste, Run).
10. **Optional:** `supabase/migrations/0007_cron.sql` makes the engine run headlessly with no browser open. Edit the two placeholders inside it first. Skip it if you're happy leaving the Sourcing page open while a campaign runs.

### How the engine works

Lead generation and enrichment are **separate asynchronous stages** — Places
never waits for enrichment:

```
Places search → business saved immediately (discovered)
              → normalized → quick qualification
              → enrichment job queued (enrichment_queued)
              → [Milestone 3] enrichment runs independently
              → ready_for_calling → eligible for caller packets
```

Every step is a separate persisted job: idempotent (a lead can never get two
enrichment jobs), retryable with exponential backoff, and resumable — a
deployment or crash mid-campaign loses nothing, because all state is in
Postgres. Only leads marked `ready_for_calling` can enter caller packets, so
freshly generated businesses never reach a caller before they're processed.

`0005` is self-healing: it creates anything missing, converts every historical
stage value to the canonical key, blocks invalid stages at the database level,
and sets explicit RLS policies. It is safe to run even if you skipped or
half-ran the earlier ones, and safe to run twice.

**If the board looks empty, click the ⓘ button in the board header.** It shows
which Supabase project this deployment is connected to, the real lead count,
counts per stage, and any database error — so you can tell an empty database
apart from a broken query.

### 3. Get your Supabase keys

1. In Supabase, click the **gear icon (Project Settings)** → **API**.
2. Copy **Project URL** — this is `NEXT_PUBLIC_SUPABASE_URL`.
3. Copy the **anon public** key — this is `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

### 4. Deploy to Vercel

1. Go to https://vercel.com, click **Add New… → Project**.
2. Import this GitHub repository.
3. Before clicking Deploy, open **Environment Variables** and add:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | from step 3 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from step 3 |
| `CALLER_SESSION_SECRET` | any long random string (30+ characters, mash the keyboard) |
| `ANTHROPIC_API_KEY` | from https://console.anthropic.com → API Keys |

4. Click **Deploy**.

If you skip `ANTHROPIC_API_KEY`, everything still works except "What to Attack Today" and the per-lead approach tips.

### 5. Local scripts setup (lead scraping / enrichment)

The scraper scripts run on your computer, not on Vercel.

1. Copy `.env.example` to `.env.local` in this folder and fill in every value. `GOOGLE_PLACES_API_KEY` comes from Google Cloud Console (enable **Places API (New)**); `SIGNALHIRE_API_KEY` from your SignalHire account.
2. Run `npm install` once.

**Scrape one search into a campaign:**

```
node scripts/scrape-leads.mjs "Metro Detroit Roofing" "roofing contractor" "Troy, MI" 20
```

**Refill a campaign across many keyword × city combinations** (with dedup by place/phone/domain and 14-day search coverage tracking):

```
cp scripts/campaign-config.example.json scripts/campaign-config.json
# edit campaign-config.json, then:
node scripts/refill-campaign.mjs
```

**Enrich leads with decision-maker contacts via SignalHire** (costs credits per reveal — capped at 5 leads per run by default):

```
node scripts/enrich-leads.mjs "Metro Detroit Roofing" 5
```

## Daily workflow

1. Admin refills campaign leads (scripts) and optionally enriches decision makers.
2. Admin opens **Campaigns**, generates a packet (e.g. 25 leads) assigned to a caller. A lead can only ever be in one packet — no duplicate calling.
3. Caller opens `/dial`, enters their PIN, and works the packet one lead at a time.
4. Admin watches **Metrics** and asks **What to Attack Today** on the Campaigns page.

## Organizational memory

Every meaningful action writes to an append-only `events` table. The database
blocks UPDATE and DELETE on it, so history can never be quietly rewritten.

Each event carries typed relationships (`lead_id`, `packet_id`, `call_id`,
`campaign_id`, `actor_caller_id`), what changed (`previous_value` /
`new_value`), who did it (`actor_type`), where it came from (`source`), how
sure we are (`confidence`, `verification_status`), when it happened
(`occurred_at`), and a `correlation_id` grouping every event produced by one
workflow — so a single logged call and everything it taught us can be read
back as one story.

**Where to look:** the **History** tab shows the whole feed and can be scoped
to one lead, caller, packet, call, campaign, or workflow. Opening a lead on the
board shows that lead's own history inline.

Writing an event never breaks the action it records: failures are logged, not
thrown.
