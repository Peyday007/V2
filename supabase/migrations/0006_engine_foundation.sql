-- Lead-generation engine: sourcing campaigns, search tasks, job queue.
-- Safe to run on any state of the database, and safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Machine status on leads (separate from sales pipeline_stage)
-- ---------------------------------------------------------------------------

alter table leads add column if not exists machine_status text;
alter table leads add column if not exists sourcing_campaign_id uuid;
alter table leads add column if not exists latitude double precision;
alter table leads add column if not exists longitude double precision;
alter table leads add column if not exists business_status text;
alter table leads add column if not exists place_types text[];
alter table leads add column if not exists qualification_failure_reason text;
alter table leads add column if not exists enrichment_confidence numeric;
alter table leads add column if not exists recommended_ask text;

-- Existing leads get a sensible machine status so nothing is stateless.
update leads set machine_status = case
  when archived_at is not null then 'archived'
  when status = 'called' then 'contacted'
  when status = 'in_packet' then 'assigned_to_packet'
  else 'ready_for_calling'   -- pre-engine leads were hand-vetted
end
where machine_status is null;

alter table leads alter column machine_status set default 'discovered';
alter table leads alter column machine_status set not null;

alter table leads drop constraint if exists leads_machine_status_check;
alter table leads add constraint leads_machine_status_check check (
  machine_status in (
    'discovered', 'normalized', 'duplicate_review', 'enrichment_queued',
    'enriching', 'decision_maker_found', 'role_only_found',
    'enrichment_failed', 'ready_for_calling', 'assigned_to_packet',
    'contacted', 'archived'
  )
);

create index if not exists leads_machine_status_idx on leads(machine_status);
create index if not exists leads_sourcing_campaign_idx on leads(sourcing_campaign_id);

-- ---------------------------------------------------------------------------
-- 2. Sourcing campaigns (typed config, replaces freeform campaigns.config)
-- ---------------------------------------------------------------------------

create table if not exists sourcing_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  industry text,
  state text,
  city text,
  zips text[],
  latitude double precision,
  longitude double precision,
  radius_m integer,
  search_terms text[] not null default '{}',
  target_lead_count integer not null default 100,
  min_rating numeric,
  min_review_count integer,
  max_review_count integer,
  require_website boolean not null default false,
  exclude_franchises boolean not null default true,
  max_api_requests integer not null default 200,
  daily_api_request_cap integer not null default 500,

  status text not null default 'draft',
  -- draft | running | paused | completed | stopped | failed

  -- live counters, updated by the worker
  searches_planned integer not null default 0,
  searches_completed integer not null default 0,
  api_requests_used integer not null default 0,
  businesses_returned integer not null default 0,
  unique_saved integer not null default 0,
  duplicates_skipped integer not null default 0,
  qualification_failures integer not null default 0,
  enrichment_queued integer not null default 0,
  error_count integer not null default 0,
  last_error text,

  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table sourcing_campaigns drop constraint if exists sourcing_campaigns_status_check;
alter table sourcing_campaigns add constraint sourcing_campaigns_status_check check (
  status in ('draft', 'running', 'paused', 'completed', 'stopped', 'failed')
);

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'leads_sourcing_campaign_fk'
  ) then
    alter table leads add constraint leads_sourcing_campaign_fk
      foreign key (sourcing_campaign_id) references sourcing_campaigns(id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Search tasks: one row per (campaign, term, location, page) — resumable
-- ---------------------------------------------------------------------------

create table if not exists search_tasks (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references sourcing_campaigns(id) on delete cascade,
  search_term text not null,
  location text not null,
  page_number integer not null default 1,
  page_token text,
  status text not null default 'pending',
  -- pending | running | done | failed | skipped
  records_returned integer not null default 0,
  unique_added integer not null default 0,
  retry_count integer not null default 0,
  last_error text,
  executed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists search_tasks_campaign_idx on search_tasks(campaign_id, status);
-- One row per campaign/term/location/page: prevents planning the same search twice.
create unique index if not exists search_tasks_unique_combo
  on search_tasks(campaign_id, search_term, location, page_number);

-- ---------------------------------------------------------------------------
-- 4. Job queue
-- ---------------------------------------------------------------------------

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  -- pending | running | done | failed | cancelled
  priority integer not null default 100,
  run_after timestamptz not null default now(),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  idempotency_key text,
  campaign_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table jobs drop constraint if exists jobs_status_check;
alter table jobs add constraint jobs_status_check check (
  status in ('pending', 'running', 'done', 'failed', 'cancelled')
);

-- Idempotency: the same logical job can never be enqueued twice.
create unique index if not exists jobs_idempotency_key_uniq
  on jobs(idempotency_key) where idempotency_key is not null;
create index if not exists jobs_claim_idx on jobs(status, run_after, priority);
create index if not exists jobs_campaign_idx on jobs(campaign_id);

-- Atomic batch claim. FOR UPDATE SKIP LOCKED lets multiple workers run
-- concurrently without ever handing the same job to two of them.
-- Also reclaims jobs whose worker died (lease older than p_lease_seconds).
create or replace function claim_jobs(
  p_limit integer,
  p_worker text,
  p_lease_seconds integer default 300
)
returns setof jobs
language plpgsql
as $$
begin
  -- Reclaim expired leases first.
  update jobs
  set status = 'pending', locked_at = null, locked_by = null
  where status = 'running'
    and locked_at < now() - make_interval(secs => p_lease_seconds);

  return query
  with claimed as (
    select id from jobs
    where status = 'pending' and run_after <= now()
    order by priority asc, run_after asc
    limit p_limit
    for update skip locked
  )
  update jobs j
  set status = 'running',
      locked_at = now(),
      locked_by = p_worker,
      attempts = j.attempts + 1,
      updated_at = now()
  from claimed c
  where j.id = c.id
  returning j.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Enrichment evidence + runs (populated in Milestone 3; created now so the
--    schema is stable and the dashboard can read counts)
-- ---------------------------------------------------------------------------

create table if not exists enrichment_evidence (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  source_type text not null,
  -- internal_db | website | registry | license_registry | directory | search_api | profile
  source_url text,
  field text not null,          -- owner_name | title | email | phone | extension | role
  value text,
  supporting_text text,
  extraction_method text,       -- deterministic | structured_data | llm_classified
  confidence numeric not null default 0.5,
  is_conflicting boolean not null default false,
  found_at timestamptz not null default now()
);

create index if not exists enrichment_evidence_lead_idx on enrichment_evidence(lead_id);

create table if not exists enrichment_runs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  steps_attempted text[] not null default '{}',
  succeeded_at_step text,
  success_level text,           -- A | B | C | null
  duration_ms integer,
  failure_reason text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists enrichment_runs_lead_idx on enrichment_runs(lead_id);

-- ---------------------------------------------------------------------------
-- 6. Keep updated_at honest
-- ---------------------------------------------------------------------------

drop trigger if exists sourcing_campaigns_touch on sourcing_campaigns;
create trigger sourcing_campaigns_touch before update on sourcing_campaigns
  for each row execute function touch_updated_at();

drop trigger if exists jobs_touch on jobs;
create trigger jobs_touch before update on jobs
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- 7. RLS (explicit, matching 0005)
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'sourcing_campaigns', 'search_tasks', 'jobs',
    'enrichment_evidence', 'enrichment_runs'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_anon_all', t);
    execute format(
      'create policy %I on %I for all to anon, authenticated using (true) with check (true)',
      t || '_anon_all', t
    );
  end loop;
end $$;
