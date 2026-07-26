-- ===========================================================================
-- DISPATCH BOARD — ONE-SHOT SETUP
-- ===========================================================================
-- Run THIS FILE ALONE in the Supabase SQL Editor. It replaces having to run
-- migrations 0003 through 0008 individually.
--
-- It is safe to run:
--   * on a database where some, all, or none of those migrations were applied
--   * more than once
-- It never deletes your data.
--
-- Steps: SQL Editor -> New query -> paste ALL of this -> Run.
-- Expect "Success. No rows returned."
-- ===========================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Shared trigger function
-- ---------------------------------------------------------------------------
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Lead columns (enrichment + engine)
-- ---------------------------------------------------------------------------
alter table leads add column if not exists normalized_name text;
alter table leads add column if not exists normalized_phone text;
alter table leads add column if not exists zip text;
alter table leads add column if not exists industry text;
alter table leads add column if not exists do_not_call boolean not null default false;
alter table leads add column if not exists pipeline_stage text;
alter table leads add column if not exists machine_status text;
alter table leads add column if not exists updated_at timestamptz not null default now();
alter table leads add column if not exists archived_at timestamptz;
alter table leads add column if not exists assigned_caller_id uuid references callers(id);
alter table leads add column if not exists sourcing_campaign_id uuid;
alter table leads add column if not exists latitude double precision;
alter table leads add column if not exists longitude double precision;
alter table leads add column if not exists business_status text;
alter table leads add column if not exists place_types text[];
alter table leads add column if not exists qualification_failure_reason text;
alter table leads add column if not exists enrichment_confidence numeric;
alter table leads add column if not exists recommended_ask text;

update leads
set normalized_phone = right(regexp_replace(phone, '\D', '', 'g'), 10)
where normalized_phone is null
  and phone is not null
  and length(regexp_replace(phone, '\D', '', 'g')) >= 10;

-- ---------------------------------------------------------------------------
-- 2. Supporting tables
-- ---------------------------------------------------------------------------
create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id),
  full_name text, title text,
  role_category text not null default 'unknown_decision_maker',
  email text, direct_phone text, extension text,
  contact_source text not null default 'manual',
  confidence numeric not null default 0.5,
  verified_status text not null default 'unverified',
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists source_records (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id),
  filename text,
  raw_data jsonb not null default '{}'::jsonb,
  duplicate_of_existing boolean not null default false,
  duplicate_reason text,
  created_at timestamptz not null default now()
);

create table if not exists call_discoveries (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id),
  call_id uuid references calls(id),
  caller_id uuid references callers(id),
  owner_name text, title text, direct_number text, extension text, email text,
  best_callback_time text, transfer_instructions text, gatekeeper_name text,
  created_at timestamptz not null default now()
);

create index if not exists contacts_lead_idx on contacts(lead_id);
create index if not exists source_records_lead_idx on source_records(lead_id);
create index if not exists call_discoveries_lead_idx on call_discoveries(lead_id);

-- Carry over any decision-maker data stored directly on leads.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_name='leads' and column_name='dm_name') then
    insert into contacts (lead_id, full_name, title, direct_phone, email,
                          contact_source, confidence, verified_status)
    select l.id, l.dm_name, l.dm_title, l.dm_phone, l.dm_email,
           'signalhire', 0.6, 'likely'
    from leads l
    where l.dm_name is not null
      and not exists (select 1 from contacts c where c.lead_id = l.id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Canonical sales pipeline stage
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_name='leads' and column_name='stage') then
    update leads set pipeline_stage = stage where pipeline_stage is null;
  end if;
end $$;

update leads set pipeline_stage = case
  lower(regexp_replace(coalesce(pipeline_stage, ''), '[\s-]+', '_', 'g'))
    when 'new_lead' then 'new_lead'
    when 'new' then 'new_lead'
    when 'lead' then 'new_lead'
    when 'contact_attempted' then 'contact_attempted'
    when 'contacted' then 'contact_attempted'
    when 'contact' then 'contact_attempted'
    when 'attempted' then 'contact_attempted'
    when 'qualified' then 'qualified'
    when 'discovery_booked' then 'discovery_booked'
    when 'appointment' then 'discovery_booked'
    when 'appointment_set' then 'discovery_booked'
    when 'discovery' then 'discovery_booked'
    when 'demo_booked' then 'discovery_booked'
    when 'discovery_completed' then 'discovery_completed'
    when 'proposal_sent' then 'proposal_sent'
    when 'proposal' then 'proposal_sent'
    when 'won' then 'won'
    when 'closed_won' then 'won'
    when 'lost' then 'lost'
    when 'closed_lost' then 'lost'
    when 'dead' then 'lost'
    when 'disqualified' then 'lost'
    when 'do_not_call' then 'lost'
    else null
  end;

update leads set pipeline_stage = 'new_lead' where pipeline_stage is null;
update leads set pipeline_stage = 'contact_attempted'
  where pipeline_stage = 'new_lead' and status = 'called';
update leads set pipeline_stage = 'lost'
  where do_not_call = true and pipeline_stage not in ('won','lost');

alter table leads alter column pipeline_stage set default 'new_lead';
alter table leads alter column pipeline_stage set not null;
alter table leads drop constraint if exists leads_pipeline_stage_check;
alter table leads add constraint leads_pipeline_stage_check check (
  pipeline_stage in ('new_lead','contact_attempted','qualified','discovery_booked',
                     'discovery_completed','proposal_sent','won','lost')
);
alter table leads drop column if exists stage;
create index if not exists leads_pipeline_stage_idx on leads(pipeline_stage);

-- ---------------------------------------------------------------------------
-- 4. Machine status (engine processing state)
-- ---------------------------------------------------------------------------
update leads set machine_status = case
  when archived_at is not null then 'archived'
  when status = 'called' then 'contacted'
  when status = 'in_packet' then 'assigned_to_packet'
  else 'ready_for_calling'
end
where machine_status is null;

alter table leads alter column machine_status set default 'discovered';
alter table leads alter column machine_status set not null;
alter table leads drop constraint if exists leads_machine_status_check;
alter table leads add constraint leads_machine_status_check check (
  machine_status in ('discovered','normalized','duplicate_review','enrichment_queued',
                     'enriching','decision_maker_found','role_only_found',
                     'enrichment_failed','ready_for_calling','assigned_to_packet',
                     'contacted','archived')
);
create index if not exists leads_machine_status_idx on leads(machine_status);
create index if not exists leads_archived_idx on leads(archived_at);
create index if not exists leads_norm_phone_idx on leads(normalized_phone);
create index if not exists leads_norm_name_idx on leads(normalized_name);

drop trigger if exists leads_touch_updated_at on leads;
create trigger leads_touch_updated_at before update on leads
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Sourcing engine
-- ---------------------------------------------------------------------------
create table if not exists sourcing_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  industry text, state text, city text, zips text[],
  latitude double precision, longitude double precision, radius_m integer,
  search_terms text[] not null default '{}',
  target_lead_count integer not null default 100,
  min_rating numeric, min_review_count integer, max_review_count integer,
  require_website boolean not null default false,
  exclude_franchises boolean not null default true,
  max_api_requests integer not null default 200,
  daily_api_request_cap integer not null default 500,
  status text not null default 'draft',
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
  started_at timestamptz, finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table sourcing_campaigns
  add column if not exists auto_assign_packets boolean not null default true;
alter table sourcing_campaigns
  add column if not exists packet_size integer not null default 50;
alter table sourcing_campaigns
  add column if not exists packets_created integer not null default 0;

alter table sourcing_campaigns drop constraint if exists sourcing_campaigns_status_check;
alter table sourcing_campaigns add constraint sourcing_campaigns_status_check check (
  status in ('draft','running','paused','completed','stopped','failed')
);

do $$
begin
  if not exists (select 1 from information_schema.table_constraints
                 where constraint_name='leads_sourcing_campaign_fk') then
    alter table leads add constraint leads_sourcing_campaign_fk
      foreign key (sourcing_campaign_id) references sourcing_campaigns(id);
  end if;
end $$;

create table if not exists search_tasks (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references sourcing_campaigns(id) on delete cascade,
  search_term text not null,
  location text not null,
  page_number integer not null default 1,
  page_token text,
  status text not null default 'pending',
  records_returned integer not null default 0,
  unique_added integer not null default 0,
  retry_count integer not null default 0,
  last_error text,
  executed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists search_tasks_campaign_idx on search_tasks(campaign_id, status);
create unique index if not exists search_tasks_unique_combo
  on search_tasks(campaign_id, search_term, location, page_number);

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  priority integer not null default 100,
  run_after timestamptz not null default now(),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  locked_at timestamptz, locked_by text, last_error text,
  idempotency_key text,
  campaign_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table jobs drop constraint if exists jobs_status_check;
alter table jobs add constraint jobs_status_check check (
  status in ('pending','running','done','failed','cancelled')
);
create unique index if not exists jobs_idempotency_key_uniq
  on jobs(idempotency_key) where idempotency_key is not null;
create index if not exists jobs_claim_idx on jobs(status, run_after, priority);
create index if not exists jobs_campaign_idx on jobs(campaign_id);

create or replace function claim_jobs(
  p_limit integer, p_worker text, p_lease_seconds integer default 300
) returns setof jobs language plpgsql as $$
begin
  update jobs set status='pending', locked_at=null, locked_by=null
  where status='running' and locked_at < now() - make_interval(secs => p_lease_seconds);

  return query
  with claimed as (
    select id from jobs
    where status='pending' and run_after <= now()
    order by priority asc, run_after asc
    limit p_limit for update skip locked
  )
  update jobs j
  set status='running', locked_at=now(), locked_by=p_worker,
      attempts=j.attempts+1, updated_at=now()
  from claimed c where j.id=c.id
  returning j.*;
end; $$;

create table if not exists enrichment_evidence (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  source_type text not null, source_url text,
  field text not null, value text, supporting_text text,
  extraction_method text,
  confidence numeric not null default 0.5,
  is_conflicting boolean not null default false,
  found_at timestamptz not null default now()
);
create index if not exists enrichment_evidence_lead_idx on enrichment_evidence(lead_id);

create table if not exists enrichment_runs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  steps_attempted text[] not null default '{}',
  succeeded_at_step text, success_level text,
  duration_ms integer, failure_reason text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists enrichment_runs_lead_idx on enrichment_runs(lead_id);

drop trigger if exists sourcing_campaigns_touch on sourcing_campaigns;
create trigger sourcing_campaigns_touch before update on sourcing_campaigns
  for each row execute function touch_updated_at();
drop trigger if exists jobs_touch on jobs;
create trigger jobs_touch before update on jobs
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- 6. Packets can come from a sourcing campaign
-- ---------------------------------------------------------------------------
alter table packets add column if not exists sourcing_campaign_id uuid;
do $$
begin
  if not exists (select 1 from information_schema.table_constraints
                 where constraint_name='packets_sourcing_campaign_fk') then
    alter table packets add constraint packets_sourcing_campaign_fk
      foreign key (sourcing_campaign_id) references sourcing_campaigns(id);
  end if;
end $$;
alter table packets alter column campaign_id drop not null;
create index if not exists packets_sourcing_campaign_idx on packets(sourcing_campaign_id);

-- ---------------------------------------------------------------------------
-- 7. Explicit RLS so reads can never silently return zero rows
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'leads','deals','campaigns','callers','packets','packet_leads','calls',
    'contacts','source_records','call_discoveries','search_coverage','events',
    'sourcing_campaigns','search_tasks','jobs','enrichment_evidence','enrichment_runs'
  ] loop
    if exists (select 1 from information_schema.tables where table_name=t) then
      execute format('alter table %I enable row level security', t);
      execute format('drop policy if exists %I on %I', t||'_anon_all', t);
      execute format(
        'create policy %I on %I for all to anon, authenticated using (true) with check (true)',
        t||'_anon_all', t);
    end if;
  end loop;
end $$;

-- Done. Next: redeploy in Vercel, then create a campaign on the Sourcing tab.
