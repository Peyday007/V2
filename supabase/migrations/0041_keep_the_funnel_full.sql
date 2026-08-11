-- ---------------------------------------------------------------------------
-- 0041 — Keep the funnel full without anybody pressing anything.
--
-- WHAT WAS ACTUALLY BROKEN. The email top-up has been correct for weeks: it
-- checks every minute, and every minute it reports "No leads are eligible to
-- email right now." It is right. Every lead that has an address has already
-- been pushed.
--
-- The break is one stage further up. A sourcing campaign runs to its target
-- and then completes, permanently. Nothing ever starts another one. So the
-- supply of leads is a series of one-off manual events, and the moment the
-- last of them is enriched and pushed, the whole programme goes quiet — with
-- every switch downstream of it correctly switched on.
--
-- This adds the missing stage: when the pool of emailable leads runs dry, go
-- and get more.
--
-- OFF BY DEFAULT, and it must stay that way. Sourcing spends real money at
-- Google, on a schedule, without anybody watching. That is exactly the kind of
-- capability that waits for somebody to switch it on deliberately, and it
-- carries its own hard cap on requests per run.
-- ---------------------------------------------------------------------------

create table if not exists funnel_settings (
  id boolean primary key default true check (id),

  -- The switch. Nothing below happens while this is false.
  auto_source_enabled boolean not null default false,

  -- Go and find more when fewer than this many leads are left that could be
  -- emailed. Not zero: sourcing, enriching and crawling take time, so the
  -- refill has to start before the tank is empty or there is a silent gap.
  refill_when_below integer not null default 200,

  -- How many leads one automatic run asks for.
  leads_per_run integer not null default 300,

  -- The hard ceiling on Google requests for one automatic run. This is the
  -- number that bounds the bill.
  max_api_requests_per_run integer not null default 200,

  -- At most one automatic run per this many hours, whatever the pool says.
  -- Stops a stuck enrichment queue from starting a run every minute.
  min_hours_between_runs integer not null default 6,

  -- What it last decided, in its own words, on every exit path. Same rule as
  -- the email top-up's note: a decision nobody can read is a decision nobody
  -- can act on.
  last_check_note text,
  last_checked_at timestamptz,
  last_started_campaign_id uuid,
  last_started_at timestamptz,

  updated_at timestamptz not null default now()
);

insert into funnel_settings (id) values (true) on conflict (id) do nothing;

-- Which trade/metro combinations have already been searched automatically, so
-- a repeat run moves on instead of asking Google the same question again and
-- paying for a page of businesses already in the database.
create table if not exists auto_source_history (
  id bigserial primary key,
  trade text not null,
  metro text not null,
  campaign_id uuid references sourcing_campaigns(id) on delete set null,
  leads_added integer,
  created_at timestamptz not null default now()
);

create index if not exists auto_source_history_pair_idx
  on auto_source_history(trade, metro, created_at desc);

-- ---------------------------------------------------------------------------
-- Did it work?
-- ---------------------------------------------------------------------------
select auto_source_enabled, refill_when_below, leads_per_run, last_check_note
from funnel_settings;
