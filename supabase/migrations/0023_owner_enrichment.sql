-- Owner-enriched leads with direct telephone numbers.
--
-- The problem this fixes, measured: in the last batch 111 calls reached a live
-- person and 6 reached an owner. Almost every "live answer" was a receptionist
-- on a switchboard nobody had a name for, because the pipeline marked any lead
-- with a working main line as ready_for_calling.
--
-- Google stays the source of businesses. What changes is that a business is no
-- longer call-ready until it carries a decision-maker AND a number that
-- reaches them. Everything Google gave is preserved unchanged alongside the
-- enriched fields, so every claim stays auditable.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. The decision-maker, and the evidence for them.
--
--    Kept separate from the legacy owner_name/dm_name columns rather than
--    overwriting them: those hold what a caller typed or an older run guessed,
--    and losing that would destroy the record of what was known when.
-- ---------------------------------------------------------------------------
alter table leads add column if not exists decision_maker_name text;
alter table leads add column if not exists decision_maker_first_name text;
alter table leads add column if not exists decision_maker_last_name text;
alter table leads add column if not exists decision_maker_title text;
-- owner | founder | co_owner | managing_partner | president | general_manager |
-- operations_manager | office_manager | unknown
alter table leads add column if not exists decision_maker_role text;
alter table leads add column if not exists decision_maker_confidence numeric;
alter table leads add column if not exists decision_maker_source_url text;
alter table leads add column if not exists decision_maker_evidence text;

-- ---------------------------------------------------------------------------
-- 2. The direct number, and where it came from.
-- ---------------------------------------------------------------------------
alter table leads add column if not exists direct_phone text;
-- mobile | landline | voip | toll_free | unknown
alter table leads add column if not exists direct_phone_type text;
-- verified_owner_mobile | probable_owner_mobile | verified_owner_direct |
-- probable_owner_direct | main_business_line | unknown
alter table leads add column if not exists direct_phone_class text;
alter table leads add column if not exists direct_phone_confidence numeric;
alter table leads add column if not exists direct_phone_provider text;
alter table leads add column if not exists direct_phone_source text;
alter table leads add column if not exists direct_phone_validated_at timestamptz;

-- The Google number, preserved under its own name so nothing downstream can
-- mistake it for a personal line. This is THE distinction the feature exists
-- to hold onto.
alter table leads add column if not exists main_business_phone text;

alter table leads add column if not exists direct_email text;
alter table leads add column if not exists professional_profile_url text;

-- ---------------------------------------------------------------------------
-- 3. Enrichment bookkeeping.
-- ---------------------------------------------------------------------------
-- See src/lib/enrichmentState.ts for the full list.
alter table leads add column if not exists enrichment_state text
  not null default 'pending_owner_identification';
-- A | B | C | D. Only A and B reach the direct-call queue.
alter table leads add column if not exists enrichment_grade text;
alter table leads add column if not exists enrichment_grade_reason text;
alter table leads add column if not exists enrichment_attempts integer not null default 0;
-- Whole cents. Integers, because floating-point money is how a budget silently
-- drifts.
alter table leads add column if not exists enrichment_cost_cents integer not null default 0;
alter table leads add column if not exists enrichment_sources text[] not null default array[]::text[];
alter table leads add column if not exists enriched_at timestamptz;
alter table leads add column if not exists enrichment_error text;
-- Set when a caller reports the contact details wrong. Forces re-enrichment
-- and keeps the lead out of the queue meanwhile.
alter table leads add column if not exists contact_reported_wrong_at timestamptz;

alter table leads drop constraint if exists leads_enrichment_grade_check;
alter table leads add constraint leads_enrichment_grade_check
  check (enrichment_grade is null or enrichment_grade in ('A', 'B', 'C', 'D'));

create index if not exists leads_grade_idx on leads(enrichment_grade)
  where archived_at is null and do_not_call = false;
create index if not exists leads_enrichment_state_idx on leads(enrichment_state);
-- The query the caller queue actually runs.
create index if not exists leads_call_ready_idx
  on leads(enrichment_grade, direct_phone_class, decision_maker_confidence desc)
  where archived_at is null and do_not_call = false and direct_phone is not null;

-- Backfill: everything Google already gave us keeps its main number under the
-- new name, so the "is this the switchboard" check works on existing rows.
update leads set main_business_phone = phone
  where main_business_phone is null and phone is not null;

-- ---------------------------------------------------------------------------
-- 4. Every provider call, with what it cost.
--
--    One row per attempt, including the ones that returned nothing — cost per
--    successful number is meaningless without the failures in the denominator.
-- ---------------------------------------------------------------------------
create table if not exists enrichment_attempts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,

  stage text not null,            -- owner_identification | direct_number | validation
  provider text not null,
  attempted boolean not null default true,
  skipped_reason text,
  error text,

  phones_returned integer not null default 0,
  accepted boolean not null default false,
  cost_cents integer not null default 0,

  request_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists enrichment_attempts_lead_idx on enrichment_attempts(lead_id);
create index if not exists enrichment_attempts_provider_idx
  on enrichment_attempts(provider, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. What callers found out about the contact details.
--
--    The best evidence about whether a number was right is somebody having
--    dialled it. This is what corrects confidence and reorders the waterfall.
-- ---------------------------------------------------------------------------
create table if not exists contact_feedback (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  call_id uuid references calls(id) on delete set null,
  caller_id uuid references callers(id) on delete set null,

  -- See CONTACT_OUTCOMES in src/lib/contactFeedback.ts
  outcome text not null,
  phone_dialed text,
  phone_class text,
  -- Which provider supplied the data being judged.
  provider text,

  confidence_before numeric,
  confidence_after numeric,
  suppressed_phone boolean not null default false,
  suppressed_decision_maker boolean not null default false,

  note text,
  created_at timestamptz not null default now()
);

create index if not exists contact_feedback_lead_idx on contact_feedback(lead_id);
create index if not exists contact_feedback_provider_idx on contact_feedback(provider, outcome);

-- ---------------------------------------------------------------------------
-- 6. Cost controls. One row, edited from the admin console.
--
--    Money is in whole cents throughout. A budget in floats drifts.
-- ---------------------------------------------------------------------------
create table if not exists enrichment_settings (
  id boolean primary key default true check (id),

  enabled boolean not null default false,

  max_cost_per_lead_cents integer not null default 50,
  max_provider_attempts integer not null default 2,
  monthly_budget_cents integer not null default 25000,
  per_run_budget_cents integer not null default 5000,
  min_confidence numeric not null default 0.4,
  data_expiry_days integer not null default 90,
  max_retries integer not null default 2,

  -- Ordered provider keys. Empty means "use the built-in order".
  provider_priority text[] not null default array[]::text[],

  updated_at timestamptz not null default now()
);

insert into enrichment_settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 7. Spend, per month, so a cap can be enforced rather than estimated.
-- ---------------------------------------------------------------------------
create table if not exists enrichment_spend (
  -- 'YYYY-MM'
  period text primary key,
  cents integer not null default 0,
  lookups integer not null default 0,
  hits integer not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 8. RLS, matching the rest of the schema.
-- ---------------------------------------------------------------------------
do $mig$
declare t text;
begin
  foreach t in array array[
    'enrichment_attempts', 'contact_feedback', 'enrichment_settings', 'enrichment_spend'
  ]
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
