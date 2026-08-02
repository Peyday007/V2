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
9h. Repeat with `supabase/migrations/0017_contacted_backfill.sql` (new query, paste, Run).
9i. Repeat with `supabase/migrations/0018_prompts.sql` (new query, paste, Run).
9j. Repeat with `supabase/migrations/0019_call_intelligence.sql` (new query, paste, Run).
9k. Repeat with `supabase/migrations/0020_performance_targets.sql` (new query, paste, Run).
9l. Repeat with `supabase/migrations/0021_browser_recordings.sql` (new query, paste, Run).
9m. Repeat with `supabase/migrations/0022_ai_authority.sql` (new query, paste, Run).
9n. Repeat with `supabase/migrations/0023_owner_enrichment.sql` (new query, paste, Run).
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

## Client relationship

Open any lead from the board (**Open the full record**) for `/admin/leads/<id>`:
every conversation with its structured detail, everything learned about the
business, contacts, what's in the diary, and the full event history.

At the top is the **client relationship** — assembled from the record, not
inferred:

- where this stands, in one line
- who we've actually spoken to
- how they run calls today, and what they said their problem is
- what we pitched, and the pushback we heard
- what we promised, and what's booked
- **what we still don't know** — which drives the questions to ask next

Below that, **the read**: a written analysis covering where it stands, whether
what we pitched matches what they actually told us their problem is, numbered
next moves with timeframes, and what would most likely kill the deal.

The read is fed the assembled record **and nothing else**, and is instructed
never to invent a conversation, a name, a price or a product that isn't in it.
If we haven't learned enough to judge fit, it says so instead of guessing. When
`ANTHROPIC_API_KEY` isn't set, or too little has happened yet, the facts above
are still complete — the panel does not depend on the AI.

Callers see the same relationship facts in the dialer, above the call history,
so they know where they stand before dialing. The written read stays on the
admin page, since it costs an API call per lead.

## Prompts

The **Prompts** tab holds the exact wording sent to the AI, editable without a
deploy. Three of them: the call tip in the dialer, the client relationship read,
and What to attack today.

Each shows the variables it can use — write `{{business_name}}` and the real
value is substituted when it runs. Click a variable to insert it. **Preview with
example data** shows exactly what the model would receive.

Nothing here can be broken permanently:

- The wording each prompt shipped with is always one button away.
- A misspelled variable is caught **before** saving, because
  `{{busines_name}}` would otherwise be sent to the model literally.
- If a saved prompt ever fails to make sense at runtime, the app quietly uses
  the original rather than sending something broken. A prompt edit cannot take
  a feature offline.
- Every previous wording is kept in the History tab, so any edit can be read
  back and restored by hand.

Dropping a variable is allowed — it only warns, since deliberately simplifying
a prompt is a legitimate edit.

## Adaptive packets

A packet is **not** worked in the order it was built. Every remaining lead is
scored at the moment one is served, against the **business's own clock** — so a
caller starting at 9am in Michigan is never handed California plumbers at 6am
their time, burning an attempt each and making good leads look bad.

What moves a lead up or down:

- **Their local hour.** 8–11 and 1–4 is prime, lunch and late afternoon are
  workable, 7–8am and 5–7pm are fringe, everything else is closed. A closed
  business sits at the bottom no matter what else is true of it.
- **A promised callback** outranks everything — except a closed business,
  because nothing justifies a 4am call.
- **What they told us.** "Call before 9am" or "Tuesdays" is read and matched
  against the hour it is there now.
- **The retry schedule** from the last outcome.
- **What the team has learned** about when a trade answers, once the data
  supports it — never before.
- **Attempt fatigue.** Fresh leads first among equals; a lead on its eighth
  attempt waits.

None of this reaches the caller. The ordering is real work and it happens on
every request, but a caller cannot act on it — they get the lead they get — and
it was taking up the top of the call screen. It is an admin concern, so it is
shown to admins.

Admins see it per packet on the Packets tab — *"3 of 47 in business
hours right now"*, or a red *"None of these are in business hours right now"*
before a caller wastes their morning.

## The call screen

`/dial` answers three questions and refuses the rest:

| | |
|---|---|
| **Who am I calling?** | one header line: name, number, where, their local time, which attempt this is |
| **What do I say next?** | one line at a time, with *Next line* and *Objection help* |
| **What happened?** | six outcomes pinned to the bottom of the screen |

Everything else — research, previous calls, AI notes, what earlier callers
learned — is behind **Lead details**. It is real and occasionally decisive, so
it is one click away, not gone.

**The caller is asked one question: who picked up.** Nobody yet, reception, or
the owner. It is the only question that changes both what to say next and what
gets saved, so it is the only one worth interrupting a conversation for. The
call stage — thirteen of them — is worked out from that plus whether an
objection came up (`inferStage` in `src/lib/dialerFocus.ts`). Where the outcome
form settles who was on the phone, the form wins; the chip only fills a gap the
outcome could not.

The six outcomes on screen cover almost every call. **Gatekeeper only, bad
number, decision-maker conversation and do not call** sit behind *More* — not
because they matter less, but because a rare button beside a common one is how
the wrong one gets pressed.

Lead intelligence is asked for **after** the outcome is chosen, inside the same
dialog. Fifteen empty boxes during a live call was never going to get filled.

## Time

The **Time** tab rebuilds each caller's working day from the work itself.
Nobody clocks in. Every call outcome carries a **server** timestamp the caller
cannot edit, so hours are derived rather than reported — which is harder to
inflate than a self-reported timesheet.

A stretch of work ends when there is no logged outcome for 20 minutes, so
breaks are excluded from active time instead of being billed as work. Per
caller and per day you get: active hours, first call to last, total gap time
and how many stints it was split into, calls, calls per **active** hour, and
measured phone time.

Reconcile the active hours against what you are invoiced elsewhere.

**Flags are questions, not proof.** The app sees logged work; it cannot see
whether someone was at their desk between two calls, or whether a number was
really dialed rather than an outcome clicked. So each flag states the evidence
*and* the innocent explanation:

| Flag | What it asks |
|---|---|
| Outcomes too fast | Several saved under 25 seconds apart — were these separate calls? |
| Long span, little activity | Under 40% of the day had any logged work — what was happening in the gaps? |
| One outcome dominates | Nearly everything logged the same way, well above the team rate — is the dialing going as it should? Check the lead source before the person. |
| Short days | Most days under an hour of activity — are these full days being billed? |
| Nothing timed | Most calls have no duration recorded. |

A lopsided outcome mix is compared **against the team**, so when everyone is
having a bad week nobody gets singled out for it.

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

## Targets

Everything above compares a caller to **the rest of your team**. That answers
"who is stronger" and not "is this any good". With a handful of callers the team
average is noisy and may simply be low, so the best of a weak group reads as
strong — and the team's own habits quietly become the standard everyone is
judged against.

`/admin/targets` fixes that with an absolute bar for each metric. Once a metric
has one:

- The caller profile gains an **Against the bar** block, and where someone beats
  the team while missing the target the card says *the team is under the bar
  too* rather than calling them strong.
- The **headline** on a profile leads with the missed target, however far ahead
  of the team they are.
- A **tryout** that would have said "add them" says "extend the trial" instead
  when the candidate only beat a team that is itself under the bar. Hiring on
  that basis is how a weak team stays weak.
- The Analytics briefing gains an **Against your targets** section.

Where no target is set, every one of those says so rather than assuming one.

**Starting figures.** If you have no numbers of your own, the Targets page
offers a set borrowed from published cold-calling ranges — connect ~25%,
owner-reached ~12%, appointments ~2% of dials, 50 calls a day, follow-up within
10 minutes. Each shows the range it came from and why. These are **not measured
on this business**: most published cold-call benchmarks come from software teams
calling office workers, while this team rings owner-operated trades where the
owner often answers their own phone — connect and owner-reach should run higher
here. So a borrowed bar is labelled borrowed everywhere it appears, and once a
metric has ~500 calls behind it the app asks you to replace it with your own.

Two things never move: a target you set yourself is never overwritten by a
borrowed one, and a trial never rules on appointment rate — at a 2% bar, a
hundred dials expects two bookings, and missing that is indistinguishable from
bad luck.

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

## Recording calls

Callers keep dialling from their own phones. Recording works by putting the
handset on **speaker** and capturing the room through the laptop microphone —
no phone system, no per-minute call cost, no change to how anyone dials.

Turn it on at **Admin → Recording**. It ships off.

### What the caller sees

A recorder appears under the business name on the call screen:

1. **Setup instructions** — phone on speaker, headphones off. Headphones break
   this completely: the prospect's voice goes into the caller's ear and never
   reaches the microphone, so you get half a conversation and nobody notices
   until playback.
2. **A microphone check** before the first call. Three seconds of listening,
   and it refuses to start on a level too faint for the prospect's side to
   survive. Checking afterwards is how you discover a week of silence.
3. **The consent notice**, where one is required, with *They agreed* / *They
   said no* buttons.
4. **A running timer** and a live status line.

### What it does about things going wrong

| What happens | What the app does |
|---|---|
| Microphone blocked | Says which browser control to use, and the outcome form carries on working |
| Prospect refuses | Stops **and deletes** the audio — not a flag, a deletion |
| Page refreshed mid-call | Keeps everything already uploaded, says the last few seconds were lost |
| Connection drops | Retries each chunk with a backoff, then reports the gap |
| Upload fails | Says so; the outcome form is untouched |

Audio uploads in ~20-second chunks *during* the call, which is what makes a
refresh survivable. The chunks are stitched back into one file server-side,
in sorted order — get that order wrong and you have a file no player will
open, so the ordering is enforced on the server and covered by a test.

### Consent

Recording a call without the consent the law requires is a criminal offence in
some states, not a policy breach. Fourteen need everyone on the call to agree:
CA, CT, DE, FL, IL, MD, MA, MI, MT, NV, NH, OR, PA, WA.

The default policy announces on **every** call, everywhere. That is the safest
setting and it costs a sentence at the top of each call; `per_state` only
announces where the law requires it. Under any policy:

- A lead with **no state on file is never recorded** — the law that applies is
  unknown, and it is not guessed.
- An all-party state **overrides** a one-party setting. A business preference
  does not outrank a state's law.
- A refusal deletes the audio and leaves a `compliance_events` row saying it
  was deleted and why.

### Playback

On a lead's page, under **Recordings**. Playback links are signed and expire in
15 minutes; the storage bucket is private, so a recording is never reachable by
guessing a filename. Every play is written to `compliance_events`.

Deleted recordings still appear as a row saying they were deleted and why —
disappearing rows are how a compliance question becomes unanswerable later.

### Transcripts

**Needs a provider you pay for.** Anthropic has no speech-to-text, so this uses
Deepgram or OpenAI Whisper. Set `TRANSCRIPTION_PROVIDER` to `deepgram` or
`openai`, add `DEEPGRAM_API_KEY` or `OPENAI_API_KEY`, redeploy, then switch it
on at Admin → Recording. Both charge per minute of audio.

Recording and playback work fine without it. Where no provider is set, the app
says so rather than silently producing nothing.

**Speaker labels are mostly left blank, on purpose.** One microphone hears your
caller directly and the prospect through a phone speaker across a desk. Telling
them apart from that is guesswork, so a label is only kept where the
transcriber was confident. A transcript that confidently puts the prospect's
words in your caller's mouth is worse than one that admits it does not know.

### The AI decides what happened

Three hundred calls a day cannot be confirmed by hand. Asking for it produces
an ignored queue or a rubber stamp, and both are worse than letting the machine
decide. So once a call is transcribed, **the model reads it and its reading is
written to the call record. Nobody confirms it.**

Three things stop that being reckless, and none of them need you to review 300
calls:

**A short queue.** `/admin/review` shows only what the model could not settle:
a transcript too thin to be sure, a contradiction with the caller on something
that matters, or anything touching do-not-call or a complaint. The page states
its own load — *"7 of 300 calls need a look — 2% of them"* — so the promise
stays checkable.

**A spot check.** A random 2% is surfaced whatever the confidence. Without it,
"the AI decides" quietly becomes "nobody can tell whether the AI is any good" —
accuracy stops being measurable the moment every reading is accepted unseen. At
300 calls that is about six a day. You can turn it down; setting it to zero
needs a deliberate confirmation.

**A list it never decides alone.** Lifting a do-not-call, changing a price or
the script, messaging a prospect, judging a caller. These are consequence
problems, not confidence problems, and no score makes them safe. The model can
*ask*; the request lands on the Review page and happens because you said so, or
not at all.

Two smaller rules, both of which exist because of how this audio is captured:

- **Suppression applies immediately, release never does.** A do-not-call heard
  on a call is acted on at once — that direction is safe. Undoing one is the
  dangerous direction and it is blocked.
- **A typed email beats a transcribed one.** Where your caller wrote down an
  email or a meeting time, theirs stands. A transcript of "d-a-v-e at north
  side" is exactly where speech-to-text fails, and this is a phone speaker
  across a desk.

Confidence comes from the transcript — how much usable speech there was, how
much of it could be attributed — not from asking the model how sure it feels. A
model asked that will say 0.9 about three words.

Both readings are kept: what the caller's form said, and what the model heard.
That pair is the only thing that makes accuracy measurable after the fact.

## Learning

`/admin/learning` is what the calls suggest might work better. **Nothing there
applies itself.** A platform that rewrites its own pitch after a good week is
how a team ends up with a script nobody chose and nobody can explain to a new
hire.

Press *Look for something worth changing* and it examines every recorded
approach. It refuses far more often than it proposes, which is correct — most
differences between two openers are noise, and it ranks by the lower bound of
the interval so a lucky run of six calls cannot beat a steady four hundred.

Approving a proposal starts a **test**, not a rollout. Traffic splits between
the current approach and the candidate, and the candidate is only promoted if
the primary metric improves **and** nothing on the guardrail list gets worse.
More meetings booked with fewer attended is a regression wearing a win's
clothes, and the guardrails are there to catch exactly that.

### What this is not

It is not in-platform telephony. There is no dialling from the browser, no
call control, no live transcription and no real-time coaching. Those need a
provider like Twilio, and the adapter interface for one is already in
`src/lib/telephony.ts` — everything downstream reads from the `recordings` and
`transcript_segments` tables, so adding a provider changes nothing else.

## Callbacks

A booked callback used to drop out of the packet the moment its outcome was
logged, leaving you to put the lead back by hand. Callbacks are now their own
queue, served **ahead** of packet work — the caller promised a time, and that
promise outranks the list. The dialer shows a banner so they know to open by
referring back to it, and the callback closes itself once the call is logged.

A callback booked by someone who has since been deactivated can be picked up by
anyone, so a promise is never silently dropped.

## Finding the owner

A batch measured before this existed: **111 calls reached a live person, and
six of them reached an owner.** Nearly every other answer was a receptionist,
on a switchboard, at a business nobody had a name for. The callers were fine.
The leads were a business name and a main number, which is a list of front
desks.

So a Google business record is now the *start* of a lead, not the finished
article. Every lead goes through:

    Google business record
      -> owner identification      (who can actually say yes)
      -> direct-number discovery   (a number that reaches them)
      -> number validation
      -> enrichment grading        (A / B / C / D)
      -> caller assignment         (A and B only)

Google collection is untouched. Nothing was replaced; a stage was added after
it.

### The grade

| Grade | What it means | Goes to callers |
|---|---|---|
| **A** | Verified decision-maker, verified mobile or direct line | yes |
| **B** | Confidently identified decision-maker, probable direct number | yes |
| **C** | Decision-maker identified, but only the main business number | no — main-line campaign |
| **D** | No confidently identified decision-maker | no |

C and D leads are **not** thrown away and not hidden. They are worked through a
main-line campaign where the expectations are different. Mixing them into the
direct queue is precisely what produced the six-out-of-111 figure, so the
availability rule in `src/lib/leadEligibility.ts` now requires an A or a B.

### What it refuses to do

- **It never hands back the main business number as the owner's mobile.** That
  is the most expensive kind of wrong: it looks like progress and changes
  nothing. It is checked in the adapter, checked again in the waterfall, and
  checked a third time when the number is classified.
- **It never asserts a person on one signal.** A name needs at least two
  independent ties to *this* business — the company's own domain, the business
  name in the evidence, the city, a decision-making title. One is a
  coincidence. Where the evidence is thin or two names are claimed, the lead is
  graded D and stays out of the queue, which is better than a caller asking for
  somebody who does not work there.
- **It never claims a number is verified because it was found.** "Verified"
  means a provider asserted the number belongs to that person, at high
  confidence. Anything else is "probable", and the grade says so.
- **It never guesses mobile versus landline from the digits.** Number
  portability made that undecidable in North America. Toll-free is decidable
  from the area code and is rejected outright.
- **It never dials anything on its own.** A discovered number goes through the
  same do-not-call, suppression and eligibility checks as every other number
  before it can reach a caller.

### Providers

Direct numbers come from a contact-data provider through the adapter interface
in `src/lib/contactProviders/`. Two adapters ship — People Data Labs and
Apollo — and **neither has been run against a live account.** Both were written
from published request and response shapes; there were no credentials here to
test with. Check the response mapping against current vendor docs and start
with a small budget cap before trusting a bill.

With no provider configured, owner identification from public sources still
runs; leads simply grade C at best, and the Enrichment page says so in words.

Environment variables, all optional:

| Variable | What it does |
|---|---|
| `PDL_API_KEY` | Enables the People Data Labs adapter |
| `PDL_COST_CENTS` | What one matched record costs you (default 20) |
| `APOLLO_API_KEY` | Enables the Apollo adapter |
| `APOLLO_COST_CENTS` | What one lookup costs you |
| `CONTACT_PROVIDERS` | Comma-separated allow-list, e.g. `people_data_labs`. Omit to use every configured provider |

Vercel bakes environment variables in at build time, so **redeploy** after
adding them.

### Money

Enrichment ships **off**. `enrichment_settings.enabled` defaults to false and
nothing in the pipeline can switch it on — that is an administrator's decision
on **Admin -> Enrichment**, not the outcome of a run.

The budget is checked **before** each provider call, never after; stopping
after the spend is not stopping. A provider whose cost would take a lead past
the per-lead cap is not tried at all. There are four caps — per lead, per
provider-attempt count, per run, per month — and the waterfall stops at the
first sufficiently confident number rather than asking everyone.

Re-enrichment needs a named reason: never enriched, data expired, the business
record changed, an admin asked, a new provider appeared, or **a caller reported
the contact was wrong**. Paying twice for an unchanged record is the easiest
money in this system to waste.

### What the caller sees, and says back

The dialer leads with the direct number and who it belongs to, with the main
line demoted to a labelled fallback. Under it is a **Number wrong?** button
with nine outcomes — reached the right owner, wrong person, wrong number,
disconnected, it was the main line, gatekeeper, owner has left, owner declined,
appointment booked.

That button is the most valuable data in the whole feature, because a caller
who dialled the number is better evidence than any provider's confidence score.
It corrects the lead's confidence, stops a bad number being handed out again,
re-grades the lead — which can take it straight out of the queue — queues it
for another look, and counts for or against the provider that supplied it.

The correction is deliberately asymmetric: a confirmation nudges confidence up
a little, a contradiction drops it a lot. "Wrong number" is near-certain;
"right person" could be a caller ticking the easy box.

A provider's record is **not** used to reorder the waterfall until at least
twenty calls have settled either way. Re-ranking spend off four calls is how a
good provider gets dropped for a bad run.

### Admin -> Enrichment

One page, leading with the only number that decides whether any of this was
worth it: **owner conversations per 100 calls to enriched records**, next to
the same figure for main-line records. Below that: the funnel (collected,
owners identified, direct numbers found, verified, call-ready), cost per
number and per verified number and per call-ready lead, what callers reported,
results broken down by grade, by number type and by provider, and the budget.

Where a rate has nothing in the denominator it reads "—", not "0". No data and
a zero rate are different answers, and this page exists to tell them apart. No
verdict is offered on fewer than fifty calls a side.

## When is a lead free to hand out?

One rule, in `src/lib/leadEligibility.ts`, used by every screen and every query.
A lead can go into a packet only when it is **all** of: finished processing,
held by nobody, not on the do-not-call list, reachable by phone, and not
binned.

That rule used to be written out by hand in three places and they drifted — the
dashboards counted anything the engine had finished with, while the packet
queries also demanded the other four. So a page could say "47 ready to call"
while Add answered "none are available". The predicate and the SQL filter now
come from the same module, and a test asserts they check the same columns.

When nothing is free, the app says **where the leads went** — "None of your 142
leads are free to hand out: 103 already with a caller, 27 already called, 12
discarded" — rather than a bare "none available", and the Add button is
disabled instead of failing when pressed.

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
