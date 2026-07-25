-- Canonical pipeline stages, required lead columns, and explicit RLS.
--
-- SAFE TO RUN ON ANY STATE OF THE DATABASE. This script repairs whatever is
-- missing, whether or not 0003_enrichment.sql and 0004_lead_stages.sql were
-- ever run, and it is safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. Tables the app queries (created only if missing)
-- ---------------------------------------------------------------------------

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id),
  full_name text,
  title text,
  role_category text not null default 'unknown_decision_maker',
  email text,
  direct_phone text,
  extension text,
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
  owner_name text,
  title text,
  direct_number text,
  extension text,
  email text,
  best_callback_time text,
  transfer_instructions text,
  gatekeeper_name text,
  created_at timestamptz not null default now()
);

create index if not exists contacts_lead_idx on contacts(lead_id);
create index if not exists source_records_lead_idx on source_records(lead_id);
create index if not exists call_discoveries_lead_idx on call_discoveries(lead_id);

-- ---------------------------------------------------------------------------
-- 2. Every column the app expects on leads
-- ---------------------------------------------------------------------------

alter table leads add column if not exists normalized_name text;
alter table leads add column if not exists normalized_phone text;
alter table leads add column if not exists zip text;
alter table leads add column if not exists industry text;
alter table leads add column if not exists do_not_call boolean not null default false;
alter table leads add column if not exists pipeline_stage text;
alter table leads add column if not exists updated_at timestamptz not null default now();
alter table leads add column if not exists archived_at timestamptz;
alter table leads add column if not exists assigned_caller_id uuid references callers(id);

-- ---------------------------------------------------------------------------
-- 3. Migrate any earlier stage values into canonical pipeline_stage
-- ---------------------------------------------------------------------------

-- Carry over 0004's display-text `stage` column if it exists.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'leads' and column_name = 'stage'
  ) then
    update leads set pipeline_stage = stage where pipeline_stage is null;
  end if;
end $$;

-- Normalize every historical spelling to the canonical key.
update leads set pipeline_stage = case
  lower(regexp_replace(coalesce(pipeline_stage, ''), '[\s-]+', '_', 'g'))
    when 'new_lead'              then 'new_lead'
    when 'new'                   then 'new_lead'
    when 'lead'                  then 'new_lead'
    when 'contact_attempted'     then 'contact_attempted'
    when 'contacted'             then 'contact_attempted'
    when 'contact'               then 'contact_attempted'
    when 'attempted'             then 'contact_attempted'
    when 'qualified'             then 'qualified'
    when 'discovery_booked'      then 'discovery_booked'
    when 'appointment'           then 'discovery_booked'
    when 'appointment_set'       then 'discovery_booked'
    when 'discovery'             then 'discovery_booked'
    when 'demo_booked'           then 'discovery_booked'
    when 'discovery_completed'   then 'discovery_completed'
    when 'proposal_sent'         then 'proposal_sent'
    when 'proposal'              then 'proposal_sent'
    when 'won'                   then 'won'
    when 'closed_won'            then 'won'
    when 'lost'                  then 'lost'
    when 'closed_lost'           then 'lost'
    when 'dead'                  then 'lost'
    when 'disqualified'          then 'lost'
    when 'do_not_call'           then 'lost'
    else null
  end;

-- Anything still unresolved (null, blank, unrecognized) becomes a new lead,
-- so no lead can be invisible to the board.
update leads set pipeline_stage = 'new_lead' where pipeline_stage is null;

-- Leads already worked or suppressed get a sensible starting stage.
update leads set pipeline_stage = 'contact_attempted'
  where pipeline_stage = 'new_lead' and status = 'called';
update leads set pipeline_stage = 'lost'
  where do_not_call = true and pipeline_stage not in ('won', 'lost');

-- ---------------------------------------------------------------------------
-- 4. Lock the column down: never null, never an unrecognized value
-- ---------------------------------------------------------------------------

alter table leads alter column pipeline_stage set default 'new_lead';
alter table leads alter column pipeline_stage set not null;

alter table leads drop constraint if exists leads_pipeline_stage_check;
alter table leads add constraint leads_pipeline_stage_check check (
  pipeline_stage in (
    'new_lead', 'contact_attempted', 'qualified', 'discovery_booked',
    'discovery_completed', 'proposal_sent', 'won', 'lost'
  )
);

-- The old display-text column is now dead weight; drop it so there is exactly
-- one source of truth.
alter table leads drop column if exists stage;

create index if not exists leads_pipeline_stage_idx on leads(pipeline_stage);
create index if not exists leads_archived_idx on leads(archived_at);

-- Keep updated_at honest.
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists leads_touch_updated_at on leads;
create trigger leads_touch_updated_at
  before update on leads
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Explicit RLS policies
--
-- This app is intentionally open (no login on the admin side; caller PINs are
-- checked in the API layer). These policies make anon access EXPLICIT so reads
-- can never silently return zero rows because RLS was toggled on somewhere.
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'leads', 'deals', 'campaigns', 'callers', 'packets', 'packet_leads',
    'calls', 'contacts', 'source_records', 'call_discoveries',
    'search_coverage', 'events'
  ]
  loop
    if exists (select 1 from information_schema.tables where table_name = t) then
      execute format('alter table %I enable row level security', t);
      execute format('drop policy if exists %I on %I', t || '_anon_all', t);
      execute format(
        'create policy %I on %I for all to anon, authenticated using (true) with check (true)',
        t || '_anon_all', t
      );
    end if;
  end loop;
end $$;

-- The events table stays append-only: the 0002 trigger still blocks
-- UPDATE/DELETE at the row level regardless of the policy above.
