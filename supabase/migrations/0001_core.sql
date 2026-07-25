-- Dispatch Board core schema
-- Run this in Supabase SQL Editor first.

create extension if not exists "pgcrypto";

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active', -- active | paused | archived
  config jsonb not null default '{}'::jsonb, -- sourcing config: keywords, locations, limits
  created_at timestamptz not null default now()
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references campaigns(id),
  business_name text not null,
  phone text,
  website text,
  domain text,
  address text,
  city text,
  state text,
  place_id text unique,
  rating numeric,
  review_count integer,
  source text not null default 'google_places',
  status text not null default 'new', -- new | in_packet | called | converted | disqualified
  dm_name text,
  dm_title text,
  dm_phone text,
  dm_email text,
  enrichment_status text not null default 'none', -- none | pending | enriched | not_found
  notes text,
  created_at timestamptz not null default now()
);

create index leads_campaign_idx on leads(campaign_id);
create index leads_phone_idx on leads(phone);
create index leads_domain_idx on leads(domain);

create table search_coverage (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id),
  keyword text not null,
  location text not null,
  results_found integer not null default 0,
  new_leads integer not null default 0,
  last_run_at timestamptz not null default now(),
  unique (campaign_id, keyword, location)
);

create table callers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  pin text not null unique, -- 6-digit
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table packets (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id),
  caller_id uuid references callers(id),
  name text not null,
  status text not null default 'open', -- open | completed | archived
  created_at timestamptz not null default now()
);

create table packet_leads (
  packet_id uuid not null references packets(id) on delete cascade,
  lead_id uuid not null references leads(id),
  position integer not null,
  status text not null default 'pending', -- pending | done
  primary key (packet_id, lead_id),
  unique (lead_id) -- a lead can only ever be in one packet: no duplicate calling
);

create table calls (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id),
  packet_id uuid references packets(id),
  caller_id uuid references callers(id),
  outcome text not null, -- no_answer | voicemail | gatekeeper | dm_conversation | appointment_set | callback | not_interested | bad_number
  reached_dm boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

create index calls_caller_idx on calls(caller_id);
create index calls_lead_idx on calls(lead_id);
create index calls_created_idx on calls(created_at);

create table deals (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id),
  name text not null,
  pipeline text not null default 'sales', -- sales | delivery
  stage text not null default 'New',
  value numeric,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index deals_pipeline_idx on deals(pipeline);
