-- Organizational memory, Milestone 1.
--
-- Extends the existing append-only events table in place. Purely additive:
-- every column is nullable or defaulted, so all existing logEvent() call
-- sites keep working unchanged and no row is rewritten or lost.
--
-- Safe to run more than once.
--
-- NOTE ON QUOTING: this file uses named dollar-quote tags and contains no
-- regex literals, because some SQL editors mis-split on bare dollar quotes
-- and report "syntax error at end of input".

-- ---------------------------------------------------------------------------
-- 1. Drop the append-only guard so the backfill can run. Restored at step 6.
-- ---------------------------------------------------------------------------
drop trigger if exists events_no_update on events;

-- ---------------------------------------------------------------------------
-- 2. A safe text-to-uuid cast. Returns null instead of raising, so the
--    backfill cannot fail on a malformed historical id.
-- ---------------------------------------------------------------------------
create or replace function try_uuid(t text)
returns uuid
language plpgsql
immutable
as $mig$
begin
  return t::uuid;
exception
  when others then
    return null;
end;
$mig$;

-- ---------------------------------------------------------------------------
-- 3. Typed relationships + provenance
-- ---------------------------------------------------------------------------
alter table events add column if not exists occurred_at timestamptz;

-- Who did it. There is no admin login yet, so admin actions record
-- actor_type='admin' with a null actor id -- an honest gap, not a fake user.
alter table events add column if not exists actor_type text;
alter table events add column if not exists actor_caller_id uuid;

-- Strongly typed for relationships that really exist today.
alter table events add column if not exists lead_id uuid;
alter table events add column if not exists campaign_id uuid;
alter table events add column if not exists packet_id uuid;
alter table events add column if not exists call_id uuid;

-- Before/after, kept separate from the free-form payload.
alter table events add column if not exists previous_value jsonb;
alter table events add column if not exists new_value jsonb;

-- correlation_id ties one workflow together (a whole call, one campaign run);
-- causation_event_id points at the event that caused this one.
alter table events add column if not exists correlation_id uuid;
alter table events add column if not exists causation_event_id bigint;

alter table events add column if not exists source text;
alter table events add column if not exists confidence numeric;
alter table events add column if not exists verification_status text;

-- ---------------------------------------------------------------------------
-- 4. Backfill existing rows. Runs while the guard is dropped.
-- ---------------------------------------------------------------------------

-- Every historical event happened when it was written.
update events set occurred_at = created_at where occurred_at is null;

-- Recover typed ids that were previously buried in the data payload.
update events
set lead_id = coalesce(
      case when entity_type = 'lead' then try_uuid(entity_id) end,
      try_uuid(data ->> 'lead_id')
    )
where lead_id is null;

update events
set packet_id = coalesce(
      case when entity_type = 'packet' then try_uuid(entity_id) end,
      try_uuid(data ->> 'packet_id')
    )
where packet_id is null;

update events
set call_id = case when entity_type = 'call' then try_uuid(entity_id) end
where call_id is null;

update events
set campaign_id = coalesce(
      case
        when entity_type in ('campaign', 'sourcing_campaign') then try_uuid(entity_id)
      end,
      try_uuid(data ->> 'campaign_id')
    )
where campaign_id is null;

update events
set actor_caller_id = coalesce(
      case when entity_type = 'caller' then try_uuid(entity_id) end,
      try_uuid(data ->> 'caller_id')
    )
where actor_caller_id is null;

-- Rows referencing records that have since been deleted would break the
-- foreign keys added in step 5.
update events e set lead_id = null
where lead_id is not null
  and not exists (select 1 from leads l where l.id = e.lead_id);

update events e set packet_id = null
where packet_id is not null
  and not exists (select 1 from packets p where p.id = e.packet_id);

update events e set call_id = null
where call_id is not null
  and not exists (select 1 from calls c where c.id = e.call_id);

update events e set actor_caller_id = null
where actor_caller_id is not null
  and not exists (select 1 from callers c where c.id = e.actor_caller_id);

-- Historical rows predate provenance tracking; label them honestly rather
-- than guessing a source.
update events set source = 'legacy' where source is null;
update events set actor_type = 'system' where actor_type is null;
update events set verification_status = 'unverified' where verification_status is null;

alter table events alter column occurred_at set default now();
alter table events alter column occurred_at set not null;

-- ---------------------------------------------------------------------------
-- 5. Foreign keys, added only after the data is known to be clean.
--    campaign_id is intentionally NOT constrained: it may reference either
--    campaigns or sourcing_campaigns.
-- ---------------------------------------------------------------------------
do $mig$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'events_lead_fk'
  ) then
    alter table events add constraint events_lead_fk
      foreign key (lead_id) references leads(id) on delete set null;
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'events_caller_fk'
  ) then
    alter table events add constraint events_caller_fk
      foreign key (actor_caller_id) references callers(id) on delete set null;
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'events_packet_fk'
  ) then
    alter table events add constraint events_packet_fk
      foreign key (packet_id) references packets(id) on delete set null;
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'events_call_fk'
  ) then
    alter table events add constraint events_call_fk
      foreign key (call_id) references calls(id) on delete set null;
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'events_causation_fk'
  ) then
    alter table events add constraint events_causation_fk
      foreign key (causation_event_id) references events(id) on delete set null;
  end if;
end;
$mig$;

-- ---------------------------------------------------------------------------
-- 6. Indexes for the history views
-- ---------------------------------------------------------------------------
create index if not exists events_lead_idx on events(lead_id, occurred_at desc);
create index if not exists events_caller_idx on events(actor_caller_id, occurred_at desc);
create index if not exists events_packet_idx on events(packet_id, occurred_at desc);
create index if not exists events_call_idx on events(call_id, occurred_at desc);
create index if not exists events_campaign_idx on events(campaign_id, occurred_at desc);
create index if not exists events_correlation_idx on events(correlation_id);
create index if not exists events_occurred_idx on events(occurred_at desc);
create index if not exists events_entity_lookup_idx on events(entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- 7. Restore the append-only guard
-- ---------------------------------------------------------------------------
create or replace function events_block_mutation()
returns trigger
language plpgsql
as $mig$
begin
  raise exception 'events table is append-only';
end;
$mig$;

create trigger events_no_update
  before update or delete on events
  for each row execute function events_block_mutation();

-- ---------------------------------------------------------------------------
-- 8. RLS, matching the rest of the schema
-- ---------------------------------------------------------------------------
alter table events enable row level security;
drop policy if exists events_anon_all on events;
create policy events_anon_all on events
  for all to anon, authenticated using (true) with check (true);
