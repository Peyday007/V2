# Dispatch Board

Cold-calling CRM for a small team selling AI Receptionist services to roofing companies.

- **Leads** (`/admin/sourcing`) — **the lead-generation engine.** Opens with four plain numbers (ready to call, with your callers, being researched, called) and a single **Do this next** instruction, so there is never a question of which button to press. One button generates leads — you only choose how many. All engine internals (searches, API budget, job queues, machine statuses, Google errors) live behind **Show engine details**; you never need them to run the business. Nothing on the page can delete a lead.
- **Board** (`/`) — the Sales board shows your **leads** as cards moving through New Lead → Contact Attempted → Qualified → Discovery Booked → Discovery Completed → Closed Won/Lost. Call outcomes logged in the dialer advance the card automatically. The Delivery board tracks won deals through onboarding.
- **Dial** (`/dial`) — caller signs in with a 6-digit PIN, works one lead at a time: sees who to ask for (recommended calling approach), known decision-maker contacts, previous call history, logs outcomes with one click, and saves anything learned on the call (names, extensions, callback times, transfer instructions) so it's never rediscovered
- **Metrics** (`/metrics`) — DM-conversations-per-100-dials and related rates
- **Analytics** (`/admin/analytics`) — opens with a written read-out: what happened, what needs a decision today, what the calls taught you, observations so far, and which questions are close to answerable. Below it, the numbers, with confidence intervals and significance tests on every one
- **Appointments** (`/admin/appointments`) — mark each booked appointment held / no-show / cancelled, which is the only way show-rate can ever be measured
- **Packets** (`/admin/campaigns`) — a caller's list of leads to work. Send one out, move it to a different caller, top it up with more leads, take the un-dialed ones back so someone else can have them, or delete it if nobody has started. Everything is reversible: returned leads go straight back into the ready pool, and a packet with calls logged against it can be closed but never deleted, so history stays intact. Also holds the "What to Attack Today" AI prioritizer.
- **Import** (`/admin/import`) — upload any lead CSV, map its columns, and import with normalization (phone/domain/name/state) and duplicate linking (same phone, domain, or place ID links to the existing lead — nothing deleted, no duplicate calling)
- **Callers** (`/admin/callers`) — add callers (auto-generated PIN), revoke instantly, and see a **profile for each one**: whether they get through, get past the gatekeeper, and close, each scored separately against the rest of the team, plus which trades they are actually better at and what to do about it

- **Do Not Call** (`/admin/suppressions`) — the suppression list, and a box to add a number by hand for a request that didn't come in on a call

## Who can see what

The admin console is behind one shared passphrase. Set `ADMIN_PASSWORD` in
Vercel and every admin page and admin API requires it; you type it once per
device and the session lasts 30 days. Callers never need it — they go to
`/dial` and sign in with their 6-digit PIN, and that route is deliberately
never gated.

Changing `ADMIN_PASSWORD` signs everyone out immediately, because the session
cookie is signed with the passphrase itself.

**If `ADMIN_PASSWORD` is not set, nothing is gated** and a red banner says so
on every admin page. That is deliberate: Vercel environment variables only take
effect after a redeploy, so failing closed would lock you out of your own site
the moment you added the variable.

**What the passphrase does not cover:** the browser needs
`NEXT_PUBLIC_SUPABASE_ANON_KEY` to load the board, so that key is in the page
source — including on `/dial`. With the current wide-open RLS policies, someone
technical who found it could query the database directly. The passphrase keeps
people out of the console, not out of Postgres. Tightening RLS is the fix, and
has not been done yet.

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
9d. Repeat with `supabase/migrations/0013_call_analytics.sql` (new query, paste, Run).
9e. Repeat with `supabase/migrations/0014_dnc_enforcement.sql` (new query, paste, Run).
9f. Repeat with `supabase/migrations/0015_callable_target.sql` (new query, paste, Run).
9g. Repeat with `supabase/migrations/0016_caller_trials.sql` (new query, paste, Run).
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

**When you ask for 100 leads you get 100 callable leads.** Roughly half of what
Google returns gets discarded — too big to be owner-operated, no phone number
we can dial, permanently closed — so the engine targets the number that
survives, not the number it saved. While a run is going it projects how many of
the businesses still being processed will come out callable, using the yield
this campaign is actually converting at rather than a guess, and keeps
searching until the projection covers your target. If enrichment then finishes
worse than projected, the campaign re-arms its remaining searches and goes back
out. The only things that stop it short are the API request cap and genuinely
running out of places to look — and when either happens the campaign says so in
plain words instead of reporting "completed".

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
| `ADMIN_PASSWORD` | the passphrase you'll type to reach the admin console. Pick something you'll remember but nobody would guess. Without it, the console is open to anyone with the link. |
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

## Caller profiles

"Is this caller any good?" is several questions, and one conversion rate hides
all of them. Someone who never gets past a receptionist and someone who reaches
owners constantly but never books a meeting have identical
appointments-per-dial and need opposite coaching. So the profile scores the job
as the skills it consists of:

| Skill | What it measures |
|---|---|
| Getting through | how often a dial reaches a live person at all |
| Opening | once someone picks up, how often they get to the owner |
| Closing | once they have the owner, how often they book a meeting |
| Capture | how often they write down what they learned, for everyone else |

Each is compared against the rest of the team over the same calls and
significance-tested. **Praise needs p < 0.05; criticism needs p < 0.01** — a
deliberately harder bar, because acting on criticism costs somebody their job.
Below 20 calls nobody is judged at all, and each skill needs 15 of its own
denominator before it is scored. Every recommendation carries the numbers it
rests on.

The system will tell you to coach, to promote, or to sit in on someone's calls.
It will not tell you to fire anyone — it cannot know whether a gap is fixable,
and it says so.

### Tryouts

Give a candidate a standard packet (100 leads by default) and see how they do.
The leads are deliberately **not** weighted toward their strengths, so two
candidates face the same difficulty, and the bar is **frozen when the trial
starts** — if the team improves meanwhile, the candidate is still judged
against the team they actually joined.

The scorecard is honest about what a hundred calls can and cannot settle:

| Measure | Can a 100-call tryout settle it? |
|---|---|
| Effort — calls per day worked | Yes, on day one. It's a plain count. |
| Getting through — dials that reach a person | Yes, ~100 dials is plenty. |
| Opening — answered calls that reach the owner | Yes, ~70 answered calls. |
| Capture — how often they write down what they learned | Yes. |
| **Closing — owner conversations that become meetings** | **Usually not.** A tryout this size yields maybe 15 conversations. |

Anything it cannot settle is listed under *"This tryout could not settle:"*
rather than folded into a confident-looking average.

**Cut is recommended only when two independent measures fail** — effort *and*
opening. One weak area gets "extend the trial", because deciding on a single
signal is a coin toss on whatever the trial could not measure. Cutting revokes
their sign-in; nothing is deleted, and every call they made and everything they
learned about those businesses stays.

**Packets follow the profile.** Where a caller is measurably better in a trade,
new packets for them are weighted toward it. This only kicks in once the edge
clears the significance test; routing on noise just moves luck around. It
biases the order and never filters, so a specialist still gets a full packet.

## Callbacks

A booked callback used to drop out of the packet the moment its outcome was
logged, leaving you to put the lead back by hand. Callbacks are now their own
queue, served **ahead** of packet work — the caller promised a time, and that
promise outranks the list. The dialer shows a banner so they know to open by
referring back to it, and the callback closes itself once the call is logged.

A callback booked by someone who has since been deactivated can be picked up by
anyone, so a promise is never silently dropped.

## Do not call

A do-not-call request is about a **phone number**, not about a row in the
database. The same business is routinely in there more than once — imported
twice, sourced from two search terms, listed under a second trade — so
suppressing only the record the caller was looking at would leave every
duplicate dialable.

The list is enforced at four points, all matching on the number:

1. **When a caller logs Do Not Call** — the number is added to the list and
   every lead record sharing it is flagged and pulled out of its packet.
2. **When a packet is generated** — candidates are checked against the list
   before the packet is written. If the list can't be read, no packet is
   created; the build fails loudly rather than guessing.
3. **The moment before a lead reaches a caller's screen** — the final gate,
   which catches a number suppressed *after* the packet was built. Same rule:
   if the list can't be read, no lead is served.
4. **On CSV import** — a matching number is imported (so the record exists)
   but flagged uncallable, so re-importing a list can't resurrect a business
   that already asked you to stop.

A suppression outlives the lead it came from: deleting a lead sets the link to
null instead of deleting the request. Migration `0014` also back-fills every
lead that should already have been protected.

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

## Analytics

The **Analytics** tab answers operational questions from real calls only:
when to dial, which trades to buy more leads in, how many attempts are worth
making, who is converting, which objections end calls, and whether enrichment
pays for itself.

The page opens with a **briefing** — sentences, not tables. "No finding clears
the significance bar" is not the same as "nothing is known", and the second is
what you want each morning, so the briefing reports what *is* known: activity
per caller, callbacks overdue, appointments nobody has marked held or no-show,
packets running dry, a bad-number rate high enough to blame the lead source,
every owner name and best-call-time the team has captured, which objections
keep coming up, and raw observations with their counts. Observations are always
labelled as observations and carry the numbers behind them, so they can never
be read as proof.

Below the briefing, the numbers.

**Nothing is asserted that the data cannot support.** Every rate carries a
Wilson confidence interval ("could really be 12%–48%"), every comparison
carries a two-proportion significance test, and every dimension is labelled
*Not enough data* / *Early signal* / *Reliable*. A 100% success rate from one
call is never reported as a finding — it is reported as one call. Where a
comparison is too thin, the page states roughly how many more calls per group
would settle it.

**What is captured on every call**, because none of it can be recovered later:

| Fact | Why it has to be captured live |
|---|---|
| Call duration | Timed automatically in the dialer; nothing can infer it afterwards |
| Attempt number | Which attempt on that company this was |
| Hour and day, in the *business's* time zone | A Michigan caller dialing California at 8am is really calling at 5am |
| Industry, city, state, rating, review count | Snapshotted as they were at dial time, because the lead changes afterwards |
| Whether the owner's name was known *before* dialing | The measurement that tells you whether enrichment is worth its cost |
| Objections raised | Logged when a caller opens one in the dialer, plus anything typed into an outcome form |
| Appointment attendance | Recorded by hand on the Appointments page — a booked appointment is not a held one |

The **Data coverage** table at the bottom of the page shows what share of
logged calls actually carries each field, so a thin analysis is never mistaken
for a thorough one. Calls logged before this migration have no duration or
objection data and honestly report as blank rather than being back-filled with
guesses.
