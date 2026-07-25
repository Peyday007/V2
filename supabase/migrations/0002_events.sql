-- Append-only organizational memory.
-- Run this in Supabase SQL Editor after 0001_core.sql.

create table events (
  id bigint generated always as identity primary key,
  event_type text not null,   -- e.g. lead.created, lead.enriched, packet.created, call.logged, caller.created, caller.deactivated
  entity_type text not null,  -- lead | packet | call | caller | campaign | deal
  entity_id text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index events_type_idx on events(event_type);
create index events_entity_idx on events(entity_type, entity_id);
create index events_created_idx on events(created_at);

-- Enforce append-only: block updates and deletes at the database level.
create or replace function events_block_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'events table is append-only';
end;
$$;

create trigger events_no_update
  before update or delete on events
  for each row execute function events_block_mutation();
