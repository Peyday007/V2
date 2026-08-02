-- The AI gets the last word, and stays checkable.
--
-- Reviewing 300 calls a day by hand is not a thing anyone does. Asking for it
-- produces an ignored queue or a rubber stamp, and both are worse than letting
-- the machine decide. So the model's reading is APPLIED, and what this
-- migration adds is the record of that: what it decided, what it was not
-- allowed to decide, where it disagreed with the caller, and which small
-- fraction of calls a person should still look at.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. Settings.
-- ---------------------------------------------------------------------------
alter table call_intelligence_settings
  add column if not exists ai_decides boolean not null default true;

-- Below this the reading is escalated instead of applied unseen.
alter table call_intelligence_settings
  add column if not exists ai_confidence_floor numeric not null default 0.6;

-- Share of CONFIDENT calls surfaced anyway. Without this, "the AI decides"
-- becomes "nobody can tell whether the AI is any good" — accuracy stops being
-- measurable the moment every reading is accepted unseen. 0.02 of 300 calls is
-- about six a day.
alter table call_intelligence_settings
  add column if not exists ai_spot_check_rate numeric not null default 0.02;

alter table call_intelligence_settings drop constraint if exists cis_spot_check_range;
alter table call_intelligence_settings add constraint cis_spot_check_range
  check (ai_spot_check_rate >= 0 and ai_spot_check_rate <= 1);

alter table call_intelligence_settings drop constraint if exists cis_confidence_range;
alter table call_intelligence_settings add constraint cis_confidence_range
  check (ai_confidence_floor >= 0 and ai_confidence_floor <= 1);

-- ---------------------------------------------------------------------------
-- 2. What the model decided, and how.
-- ---------------------------------------------------------------------------

-- ai | human | form_only — who the record says had the last word.
alter table call_analysis add column if not exists authority text not null default 'form_only';

-- The reading that was actually written, after the authority rules ran.
alter table call_analysis add column if not exists applied_result jsonb;
alter table call_analysis add column if not exists applied_at timestamptz;

-- Fields the model wanted but did not get, with the reason. Small and worth
-- keeping: this is the evidence that the never-decide-alone list is real.
alter table call_analysis add column if not exists held_fields jsonb not null default '[]'::jsonb;

-- What the model read, kept beside the applied reading. Two readings survive
-- so accuracy can be measured after the fact rather than taken on faith.
alter table call_analysis add column if not exists transcript_result jsonb;
alter table call_analysis add column if not exists transcript_confidence numeric;

-- Where the model and the caller's form differ. Kept whether or not the call
-- was escalated, because this is what makes model accuracy measurable later.
alter table call_analysis add column if not exists disagreements jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- 3. The short queue a person actually sees.
-- ---------------------------------------------------------------------------
alter table call_analysis add column if not exists needs_review boolean not null default false;
alter table call_analysis
  add column if not exists review_reasons text[] not null default array[]::text[];
alter table call_analysis add column if not exists reviewed_at timestamptz;
alter table call_analysis add column if not exists reviewed_by text;
-- agreed | corrected — what the human concluded, when one looked.
alter table call_analysis add column if not exists review_verdict text;

create index if not exists call_analysis_review_idx
  on call_analysis(created_at desc) where needs_review and reviewed_at is null;

create index if not exists call_analysis_authority_idx on call_analysis(authority);

-- ---------------------------------------------------------------------------
-- 4. Actions the model asked for and was refused.
--
--    Separate from held_fields because these are not readings, they are
--    consequences: lifting a do-not-call, changing a price or a script,
--    messaging a prospect, judging a caller. No confidence score makes any of
--    them safe, so they are recorded here and done by a person or not at all.
-- ---------------------------------------------------------------------------
create table if not exists blocked_actions (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  analysis_id uuid references call_analysis(id) on delete cascade,

  action text not null,
  rationale text,
  -- pending | approved | rejected — never 'done automatically'.
  status text not null default 'pending',
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists blocked_actions_pending_idx
  on blocked_actions(created_at desc) where status = 'pending';

-- ---------------------------------------------------------------------------
-- 5. Learning proposals need a decision trail.
--
--    The engine in src/lib/learning.ts already writes proposals. It must never
--    apply one by itself — a system that rewrites its own script after a good
--    week is how a team ends up with a pitch nobody chose.
-- ---------------------------------------------------------------------------
alter table change_proposals add column if not exists decided_by text;
alter table change_proposals add column if not exists decided_at timestamptz;
alter table change_proposals add column if not exists decision_note text;

alter table experiments add column if not exists stopped_reason text;

-- ---------------------------------------------------------------------------
-- 6. RLS, matching the rest of the schema.
-- ---------------------------------------------------------------------------
alter table blocked_actions enable row level security;
drop policy if exists blocked_actions_anon_all on blocked_actions;
create policy blocked_actions_anon_all on blocked_actions
  for all to anon, authenticated using (true) with check (true);
