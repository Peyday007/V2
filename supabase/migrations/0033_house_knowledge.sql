-- ---------------------------------------------------------------------------
-- 0033 — One place for what the house has learned, and a record of where it
-- changed a decision.
--
-- The system already learned things. It learned them in five places that never
-- spoke to each other: analytics knew which hours connect, script stats knew
-- which opener got past reception, caller profiles knew who was good at what,
-- benchmarks knew whether the numbers were any good, and the experiment engine
-- could run a test. None of it fed back. The diagnostic still ordered findings
-- by the weights someone typed in a priori, the packet was still ordered by
-- enrichment grade, and the sequence writer was told the same thing on day one
-- and day four hundred.
--
-- This is the substrate for the connective tissue. Two tables:
--
--   house_knowledge — a versioned snapshot. Append-only, never updated in
--   place, so "what did it believe when it made that call" always has an
--   answer. That matters more here than in most places: this thing changes
--   what the tools do, and a belief you cannot reconstruct is a decision you
--   cannot audit.
--
--   knowledge_applications — every time a prior actually moved something. A
--   learning system that cannot show you where it intervened is indisting-
--   uishable from one that does nothing, and both are indistinguishable from
--   one that is quietly making things worse.
--
-- WHAT THIS NEVER TOUCHES, restated because the whole point of the file is
-- that it reaches into everything else: prices, consent behaviour, whether a
-- message sends without a human, and anything about a person's job. It can
-- produce evidence about all four. It changes none of them.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The snapshots.
-- ---------------------------------------------------------------------------
create table if not exists house_knowledge (
  id bigserial primary key,

  -- The whole computed object. jsonb rather than a wide table because the
  -- shape is owned by src/lib/houseKnowledge.ts and will change as more is
  -- learned; a column per prior would mean a migration every time.
  knowledge jsonb not null default '{}'::jsonb,

  -- How much evidence went in. Denormalised so "is it getting smarter" is a
  -- query rather than a jsonb dig.
  total_facts integer not null default 0,
  -- How many priors cleared the bar and are actually being used.
  applied_priors integer not null default 0,
  -- How many questions it still cannot answer.
  blind_spots integer not null default 0,

  computed_at timestamptz not null default now()
);

create index if not exists house_knowledge_recent on house_knowledge(computed_at desc);

-- ---------------------------------------------------------------------------
-- 2. Where it actually changed something.
--
--    Append-only. One row per intervention, with the before, the after and
--    the evidence behind it.
-- ---------------------------------------------------------------------------
create table if not exists knowledge_applications (
  id bigserial primary key,

  -- diagnostic_order | script_weighting | packet_order | sequence_brief
  surface text not null,

  -- Which prior did it.
  prior_key text not null,
  -- How many observations were behind that prior at the time.
  samples integer not null default 0,
  lift numeric,

  lead_id uuid references leads(id) on delete set null,

  -- What changed, in words, for a person reading it later.
  detail text not null,

  created_at timestamptz not null default now()
);

create index if not exists knowledge_applications_recent
  on knowledge_applications(created_at desc);
create index if not exists knowledge_applications_surface
  on knowledge_applications(surface, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Settings.
-- ---------------------------------------------------------------------------
create table if not exists learning_settings (
  id boolean primary key default true check (id),

  /*
   * Whether the priors are allowed to change anything.
   *
   * Defaults TRUE, unlike most switches in this schema, and the reason is the
   * sample floor: with no evidence every prior is inert, so switching this on
   * before there is data changes precisely nothing. It becomes a real switch
   * only once the system has earned it, which is the right moment for it to
   * already be on.
   */
  apply_learning boolean not null default true,

  -- Below this many observations a prior is recorded and not acted on.
  min_samples integer not null default 30,

  /*
   * The share of traffic that keeps going to non-winning options, forever.
   *
   * The most important number here. A system that routes everything to today's
   * winner cannot notice when the market moves — it keeps winning a game
   * nobody is playing, and the data it would need to see that is data it
   * stopped collecting.
   */
  exploration_floor numeric not null default 0.2,

  last_computed_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into learning_settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 4. The evidence trail on a lead.
--
--    Which angles it was actually approached with, so an outcome can be
--    attributed back to them. Without this the diagnostic can never learn:
--    you know what converted, but not what was said.
-- ---------------------------------------------------------------------------
alter table leads add column if not exists approached_with text[];
alter table leads add column if not exists approached_at timestamptz;

-- What the lead was worth, when it became worth something. Feeds the size
-- calibration — reported to a human, never used to move a price by itself.
alter table deals add column if not exists closed_value_cents integer;

-- ---------------------------------------------------------------------------
-- 5. RLS, matching the rest of the schema.
-- ---------------------------------------------------------------------------
do $mig$
declare t text;
begin
  foreach t in array array['house_knowledge', 'knowledge_applications', 'learning_settings']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_anon_all', t);
    execute format(
      'create policy %I on %I for all to anon, authenticated using (true) with check (true)',
      t || '_anon_all', t
    );
  end loop;
end;
$mig$;

-- ---------------------------------------------------------------------------
-- 6. Did it land?
-- ---------------------------------------------------------------------------
select
  '0033 applied' as migration,
  (select count(*) from information_schema.tables
     where table_name in ('house_knowledge','knowledge_applications','learning_settings')) as tables_created,
  (select count(*) from learning_settings) as settings_row,
  (select count(*) from information_schema.columns
     where table_name = 'leads' and column_name in ('approached_with','approached_at')) as lead_columns;
