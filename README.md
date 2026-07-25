# Dispatch Board

Cold-calling CRM for a small team selling AI Receptionist services to roofing companies.

- **Board** (`/`) — Kanban for sales + delivery pipelines (drag deals between stages)
- **Dial** (`/dial`) — caller signs in with a 6-digit PIN, works one lead at a time, logs outcomes with one click, sees an AI approach tip per lead
- **Metrics** (`/metrics`) — DM-conversations-per-100-dials and related rates
- **Campaigns** (`/admin/campaigns`) — create campaigns, generate locked lead packets per caller, "What to Attack Today" AI prioritizer
- **Callers** (`/admin/callers`) — add callers (auto-generated PIN), revoke instantly

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

Every meaningful action writes to an append-only `events` table (lead created/enriched with before+after, packet lifecycle, calls logged, caller activated/revoked, deal stage changes). The database blocks updates/deletes on it.
