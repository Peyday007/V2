-- Analytics capture layer.
--
-- Everything here exists because it CANNOT be reconstructed after the fact.
-- Nothing in this file computes a metric; it only records the facts that a
-- metric would need. Every column is nullable or defaulted, so existing rows
-- and existing code keep working unchanged.
--
-- Safe to run more than once.
--
-- NOTE ON QUOTING: named dollar-quote tags and no regex literals, because
-- some SQL editors mis-split on bare dollar quotes and report
-- "syntax error at end of input".

-- ---------------------------------------------------------------------------
-- 1. Call timing
--
--    Duration is the single most predictive call feature and there is no way
--    to recover it later. started_at is stamped when the caller opens the
--    lead; ended_at when the outcome is saved.
-- ---------------------------------------------------------------------------
alter table calls add column if not exists started_at timestamptz;
alter table calls add column if not exists ended_at timestamptz;
alter table calls add column if not exists duration_seconds integer;

-- Which attempt on this company this call was (1 = first ever).
alter table calls add column if not exists attempt_number integer;

-- Local to the business, not to the caller: "call roofers at 7am" is only
-- meaningful in the roofer's time zone.
alter table calls add column if not exists dialed_hour smallint;
alter table calls add column if not exists dialed_dow smallint;   -- 0 = Sunday
alter table calls add column if not exists lead_timezone text;

-- ---------------------------------------------------------------------------
-- 2. Snapshot of the lead AS IT WAS when the call happened.
--
--    Deliberately denormalized. A lead's industry, review count and owner
--    status all change after the call; joining back to leads later would
--    silently rewrite history and make every historical comparison wrong.
-- ---------------------------------------------------------------------------
alter table calls add column if not exists lead_industry text;
alter table calls add column if not exists lead_city text;
alter table calls add column if not exists lead_state text;
alter table calls add column if not exists lead_rating numeric;
alter table calls add column if not exists lead_review_count integer;

-- Did we know who the owner was BEFORE dialing? This is the measurement that
-- tells you whether enrichment is worth what it costs.
alter table calls add column if not exists owner_known_before boolean;
alter table calls add column if not exists enrichment_confidence numeric;

-- Which script the caller was shown. One variant exists today; the column
-- makes a second one measurable the day it is added.
alter table calls add column if not exists script_variant text;

create index if not exists calls_outcome_idx on calls(outcome);
create index if not exists calls_industry_idx on calls(lead_industry);
create index if not exists calls_hour_idx on calls(dialed_hour);
create index if not exists calls_attempt_idx on calls(attempt_number);

-- ---------------------------------------------------------------------------
-- 3. Objections actually raised on a call.
--
--    Previously the objection panel was UI-only: a caller could hit the same
--    objection two hundred times and the system would never know.
-- ---------------------------------------------------------------------------
create table if not exists call_objections (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls(id) on delete cascade,
  lead_id uuid references leads(id) on delete cascade,
  caller_id uuid references callers(id),
  objection_key text not null,
  objection_label text,
  -- true when the caller opened the scripted rebuttal, false when the
  -- objection was recorded from the outcome form without one.
  rebuttal_shown boolean not null default false,
  -- the outcome of the call this objection was part of, copied so objection
  -- effectiveness can be measured without a join
  outcome text,
  reached_dm boolean,
  created_at timestamptz not null default now()
);

create index if not exists call_objections_key_idx on call_objections(objection_key);
create index if not exists call_objections_call_idx on call_objections(call_id);
create index if not exists call_objections_lead_idx on call_objections(lead_id);

-- ---------------------------------------------------------------------------
-- 4. Appointment attendance.
--
--    A booked appointment is not a held appointment. Without this, "appointments
--    per 100 dials" can rise while the business gets nothing.
-- ---------------------------------------------------------------------------
alter table appointments add column if not exists attendance_status text;
alter table appointments add column if not exists attendance_recorded_at timestamptz;
alter table appointments add column if not exists attendance_note text;

update appointments set attendance_status = 'scheduled' where attendance_status is null;
alter table appointments alter column attendance_status set default 'scheduled';
alter table appointments alter column attendance_status set not null;

alter table appointments drop constraint if exists appointments_attendance_check;
alter table appointments add constraint appointments_attendance_check check (
  attendance_status in ('scheduled', 'held', 'no_show', 'cancelled', 'rescheduled')
);

create index if not exists appointments_attendance_idx
  on appointments(attendance_status, scheduled_for);

-- ---------------------------------------------------------------------------
-- 5. Backfill what CAN honestly be recovered for calls logged before today.
--
--    attempt_number is recoverable from the call order per lead. Duration,
--    objections and the lead snapshot are not, and are deliberately left null
--    rather than guessed — a null reads as "not measured", an invented value
--    reads as fact.
-- ---------------------------------------------------------------------------
with ordered as (
  select id, row_number() over (partition by lead_id order by created_at) as n
  from calls
)
update calls c
set attempt_number = ordered.n
from ordered
where ordered.id = c.id
  and c.attempt_number is null;

-- created_at is a real observation, so the UTC hour/day of week are real too.
update calls
set dialed_hour = extract(hour from created_at)::smallint,
    dialed_dow  = extract(dow  from created_at)::smallint
where dialed_hour is null;

-- ---------------------------------------------------------------------------
-- 6. RLS, matching the rest of the schema
-- ---------------------------------------------------------------------------
alter table call_objections enable row level security;
drop policy if exists call_objections_anon_all on call_objections;
create policy call_objections_anon_all on call_objections
  for all to anon, authenticated using (true) with check (true);
