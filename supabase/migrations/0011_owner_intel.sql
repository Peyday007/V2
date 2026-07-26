-- Owner-first calling: durable lead intelligence, structured outcomes,
-- scheduled callbacks and retry windows. Safe to re-run.

-- ---------------------------------------------------------------------------
-- Lead intelligence that must survive and be visible to every future caller
-- ---------------------------------------------------------------------------
alter table leads add column if not exists owner_name text;
alter table leads add column if not exists owner_title text;
alter table leads add column if not exists owner_email text;
alter table leads add column if not exists gatekeeper_name text;
alter table leads add column if not exists best_call_day text;
alter table leads add column if not exists best_call_time text;
alter table leads add column if not exists direct_number text;
alter table leads add column if not exists extension text;
alter table leads add column if not exists answering_setup text;
alter table leads add column if not exists existing_provider text;
alter table leads add column if not exists office_staff_count text;
alter table leads add column if not exists after_hours_process text;
alter table leads add column if not exists other_decision_maker text;
alter table leads add column if not exists ownership_type text;      -- independent | franchise | unknown
alter table leads add column if not exists company_notes text;
alter table leads add column if not exists timezone text;
alter table leads add column if not exists business_hours jsonb;

-- Attempt tracking drives the retry schedule
alter table leads add column if not exists attempt_count integer not null default 0;
alter table leads add column if not exists last_attempted_at timestamptz;
alter table leads add column if not exists next_attempt_at timestamptz;
alter table leads add column if not exists last_next_step text;
alter table leads add column if not exists last_objection text;
alter table leads add column if not exists phone_invalid boolean not null default false;
alter table leads add column if not exists owner_reached boolean not null default false;

create index if not exists leads_next_attempt_idx on leads(next_attempt_at);

-- ---------------------------------------------------------------------------
-- Structured detail on every call
-- ---------------------------------------------------------------------------
alter table calls add column if not exists details jsonb not null default '{}'::jsonb;
alter table calls add column if not exists next_step text;
alter table calls add column if not exists spoke_with_role text;
-- owner | gatekeeper | employee | unknown  — lets us tell an owner "no"
-- apart from a gatekeeper brush-off.

-- ---------------------------------------------------------------------------
-- Scheduled callbacks. A callback is NOT an appointment.
-- ---------------------------------------------------------------------------
create table if not exists callbacks (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  caller_id uuid references callers(id),
  call_id uuid references calls(id),
  scheduled_for timestamptz not null,
  window_label text,
  requested_by_name text,
  requested_by_role text,
  reason text,
  status text not null default 'pending',   -- pending | done | missed | cancelled
  created_at timestamptz not null default now()
);

create index if not exists callbacks_due_idx on callbacks(status, scheduled_for);
create index if not exists callbacks_lead_idx on callbacks(lead_id);

-- ---------------------------------------------------------------------------
-- Appointments, kept separate so a vague follow-up can never become one
-- ---------------------------------------------------------------------------
create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  caller_id uuid references callers(id),
  call_id uuid references calls(id),
  decision_maker_name text not null,
  decision_maker_role text not null,
  scheduled_for timestamptz not null,
  timezone text,
  phone text,
  email text,
  product text,
  meeting_reason text,
  pain_point text,
  confirmation_method text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists appointments_lead_idx on appointments(lead_id);

-- ---------------------------------------------------------------------------
-- Suppression list — a DNC request blocks the company for every caller
-- ---------------------------------------------------------------------------
create table if not exists suppressions (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete cascade,
  normalized_phone text,
  requested_by text,     -- owner | employee | unknown
  reason text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists suppressions_phone_idx on suppressions(normalized_phone);

-- ---------------------------------------------------------------------------
-- RLS, matching the rest of the schema
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['callbacks', 'appointments', 'suppressions']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_anon_all', t);
    execute format(
      'create policy %I on %I for all to anon, authenticated using (true) with check (true)',
      t || '_anon_all', t
    );
  end loop;
end $$;
