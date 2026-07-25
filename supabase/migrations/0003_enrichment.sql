-- Enrichment & decision-maker discovery, folded into Dispatch Board.
-- Run this in Supabase SQL Editor after 0002_events.sql.

-- Normalized matching columns + import fields on leads
alter table leads
  add column normalized_name text,
  add column normalized_phone text,
  add column zip text,
  add column industry text,
  add column do_not_call boolean not null default false;

create index leads_norm_phone_idx on leads(normalized_phone);
create index leads_norm_name_idx on leads(normalized_name);

-- Backfill normalized_phone (last 10 digits) for existing leads
update leads
set normalized_phone = right(regexp_replace(phone, '\D', '', 'g'), 10)
where phone is not null and length(regexp_replace(phone, '\D', '', 'g')) >= 10;

-- Every imported CSV row is preserved and linked to its canonical lead.
-- Duplicates are linked with a reason, never deleted.
create table source_records (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id),
  filename text,
  raw_data jsonb not null default '{}'::jsonb,
  duplicate_of_existing boolean not null default false,
  duplicate_reason text,
  created_at timestamptz not null default now()
);

create index source_records_lead_idx on source_records(lead_id);

-- Decision-maker contacts: a lead can have several, each with provenance.
create table contacts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id),
  full_name text,
  title text,
  role_category text not null default 'unknown_decision_maker',
  -- owner | founder | president | general_manager | operations_manager |
  -- office_manager | phone_system_decision_maker | unknown_decision_maker |
  -- gatekeeper | employee | other
  email text,
  direct_phone text,
  extension text,
  contact_source text not null default 'manual',
  -- import | website | caller_discovered | provider | manual | signalhire
  confidence numeric not null default 0.5,
  verified_status text not null default 'unverified',
  -- unverified | likely | verified_by_public_source | verified_by_live_call |
  -- verified_by_provider | stale | invalid
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index contacts_lead_idx on contacts(lead_id);

-- Facts discovered by callers during real calls. The company never
-- rediscovers what a caller already learned.
create table call_discoveries (
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

create index call_discoveries_lead_idx on call_discoveries(lead_id);

-- Migrate any dm_* data already enriched onto leads into contacts
insert into contacts (lead_id, full_name, title, direct_phone, email, contact_source, confidence, verified_status)
select id, dm_name, dm_title, dm_phone, dm_email, 'signalhire', 0.6, 'likely'
from leads
where dm_name is not null;
