-- Caller tryouts.
--
-- A standard, deliberately unbiased packet given to a candidate so you can
-- decide whether to keep them. The bar is frozen at the moment the trial
-- starts: if the team improves while the candidate is dialing, they are still
-- judged against the team they actually joined, not a moving target.
--
-- Safe to run more than once.

create table if not exists caller_trials (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null references callers(id) on delete cascade,
  packet_id uuid references packets(id) on delete set null,

  target_calls integer not null default 100,

  -- running   — candidate is still dialing
  -- complete  — hit the target, waiting on your decision
  -- decided   — you made the call
  -- abandoned — cancelled before it finished
  status text not null default 'running',

  -- added | cut | extended
  decision text,
  decision_note text,

  -- Team performance at the moment the trial began, stored as COUNTS so the
  -- comparison can be significance-tested rather than eyeballed.
  benchmark jsonb not null default '{}'::jsonb,

  started_at timestamptz not null default now(),
  finished_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

alter table caller_trials drop constraint if exists caller_trials_status_check;
alter table caller_trials add constraint caller_trials_status_check check (
  status in ('running', 'complete', 'decided', 'abandoned')
);

alter table caller_trials drop constraint if exists caller_trials_decision_check;
alter table caller_trials add constraint caller_trials_decision_check check (
  decision is null or decision in ('added', 'cut', 'extended')
);

-- One live trial per caller. A second would split their calls across two
-- scorecards and make both wrong.
create unique index if not exists caller_trials_one_live
  on caller_trials(caller_id)
  where status in ('running', 'complete');

create index if not exists caller_trials_caller_idx on caller_trials(caller_id);
create index if not exists caller_trials_status_idx on caller_trials(status);

-- ---------------------------------------------------------------------------
-- RLS, matching the rest of the schema
-- ---------------------------------------------------------------------------
alter table caller_trials enable row level security;
drop policy if exists caller_trials_anon_all on caller_trials;
create policy caller_trials_anon_all on caller_trials
  for all to anon, authenticated using (true) with check (true);
