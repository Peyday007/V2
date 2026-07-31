-- Absolute targets, so "better than the team" can never masquerade as "good".
--
-- Every comparison in this platform was relative to the team's own average.
-- With a handful of callers that average is both noisy AND possibly just bad,
-- so a mediocre caller reads as strong and the team's own weak habits become
-- the standard everyone is judged against.
--
-- The fix is an absolute bar. Targets are set BY THE OPERATOR on /admin/targets.
-- That page also offers borrowed starting figures from published cold-calling
-- ranges for anyone with no numbers of their own — but they are written only
-- when someone explicitly asks for them, they are stored with source =
-- 'starting benchmark — general cold calling, not your data', and the app shows
-- that provenance everywhere the bar is used.
--
-- Safe to run more than once.

create table if not exists performance_targets (
  -- connect_rate | owner_reach_rate | qualified_rate | appointment_rate |
  -- attendance_rate | calls_per_day | followup_minutes
  metric text primary key,

  -- The bar. A rate 0-1, or an absolute number for count-style metrics.
  target numeric not null,

  -- Where the number came from, in the operator's own words. Recorded so
  -- nobody later mistakes a guess for a researched figure.
  source text not null default 'set_by_operator',
  note text,

  -- Below this many observations the team average is not reported at all,
  -- rather than computed from noise and treated as a bar.
  minimum_sample integer not null default 30,

  active boolean not null default true,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table performance_targets drop constraint if exists performance_targets_range;
alter table performance_targets add constraint performance_targets_range
  check (target >= 0);

-- Deliberately NO seed rows. An empty table means "no target set", which the
-- app reports honestly. A default written here would arrive with no provenance
-- attached and no record of anyone choosing it — which is exactly how a guess
-- gets mistaken for a researched figure later.

alter table performance_targets enable row level security;
drop policy if exists performance_targets_anon_all on performance_targets;
create policy performance_targets_anon_all on performance_targets
  for all to anon, authenticated using (true) with check (true);
