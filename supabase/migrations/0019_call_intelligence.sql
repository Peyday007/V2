-- Call Intelligence.
--
-- Recording, transcription, post-call analysis, follow-up, and a versioned
-- coaching engine that proposes changes rather than rewriting itself.
--
-- Safe to run more than once.
--
-- NOTE ON QUOTING: named dollar-quote tags and no regex literals, because some
-- SQL editors mis-split on bare dollar quotes and report "syntax error at end
-- of input".

-- ---------------------------------------------------------------------------
-- 1. Settings. One row, created here, edited from the admin console.
--
--    Nothing in this feature acts without an explicit setting. Recording is
--    OFF until switched on, and automatic sending is off separately from
--    automatic drafting, so drafting can be enabled without ever letting the
--    system message a prospect by itself.
-- ---------------------------------------------------------------------------
create table if not exists call_intelligence_settings (
  id boolean primary key default true check (id),

  recording_enabled boolean not null default false,
  -- all_party  — announce and require consent everywhere (safest, and required
  --              in CA, FL, PA, IL, WA, MA and others)
  -- one_party  — record where one-party consent is lawful
  -- per_state  — decide from the lead's state
  consent_policy text not null default 'all_party',
  consent_announcement text not null default
    'This call may be recorded for quality and training purposes.',
  retention_days integer not null default 90,
  recording_listener_roles text[] not null default array['admin'],

  transcription_enabled boolean not null default false,
  live_coaching_enabled boolean not null default true,

  followup_deadline_minutes integer not null default 10,
  automatic_drafting boolean not null default true,
  -- Deliberately separate from drafting, and default false: nothing reaches a
  -- prospect without a human pressing send.
  automatic_sending boolean not null default false,

  minimum_learning_sample integer not null default 40,
  experiment_traffic_percent integer not null default 50,
  experiment_industries text[],
  experiment_caller_ids uuid[],
  required_approval_role text not null default 'admin',

  updated_at timestamptz not null default now()
);

insert into call_intelligence_settings (id) values (true)
on conflict (id) do nothing;

alter table call_intelligence_settings
  drop constraint if exists cis_consent_policy_check;
alter table call_intelligence_settings add constraint cis_consent_policy_check
  check (consent_policy in ('all_party', 'one_party', 'per_state', 'disabled'));

alter table call_intelligence_settings
  drop constraint if exists cis_traffic_check;
alter table call_intelligence_settings add constraint cis_traffic_check
  check (experiment_traffic_percent between 0 and 100);

-- ---------------------------------------------------------------------------
-- 2. Recordings. One per telephony leg.
-- ---------------------------------------------------------------------------
create table if not exists recordings (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  caller_id uuid references callers(id) on delete set null,

  -- The provider's own identifiers, so a retried webhook is recognised.
  provider text not null default 'none',
  provider_call_sid text,
  provider_recording_sid text unique,

  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,

  storage_url text,
  storage_expires_at timestamptz,

  -- pending | granted | refused | not_required | unknown
  consent_status text not null default 'unknown',
  consent_captured_at timestamptz,
  consent_policy_applied text,

  -- queued | ringing | in_progress | completed | failed | no_answer | busy
  telephony_status text not null default 'queued',
  -- pending | transcribing | analyzed | failed | skipped
  processing_status text not null default 'pending',
  failure_reason text,

  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists recordings_call_idx on recordings(call_id);
create index if not exists recordings_lead_idx on recordings(lead_id);
create index if not exists recordings_status_idx on recordings(processing_status);
create index if not exists recordings_retention_idx on recordings(created_at)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 3. Transcript segments, one row per utterance.
-- ---------------------------------------------------------------------------
create table if not exists transcript_segments (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null references recordings(id) on delete cascade,
  call_id uuid references calls(id) on delete set null,

  sequence integer not null,
  start_ms integer not null,
  end_ms integer,
  -- caller | prospect | unknown. Never guessed silently: low confidence stays
  -- 'unknown' so the reviewer can see the machine was not sure.
  speaker text not null default 'unknown',
  speaker_confidence numeric,
  text text not null,

  created_at timestamptz not null default now(),
  unique (recording_id, sequence)
);

create index if not exists transcript_recording_idx
  on transcript_segments(recording_id, sequence);

-- ---------------------------------------------------------------------------
-- 4. Call analysis. The machine's reading, kept apart from the human's.
--
--    Two columns for every conclusion would be unwieldy, so the AI result and
--    the confirmed result are two JSONB documents plus the fields worth
--    querying. Accuracy is measurable because both survive.
-- ---------------------------------------------------------------------------
create table if not exists call_analysis (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  recording_id uuid references recordings(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  caller_id uuid references callers(id) on delete set null,

  -- transcript | outcome_form. Says what the reading was based on, because a
  -- reading from a form is weaker than one from a recording and must not be
  -- presented as equivalent.
  source text not null default 'outcome_form',

  ai_result jsonb not null default '{}'::jsonb,
  ai_confidence numeric,
  ai_model text,

  confirmed_result jsonb,
  confirmed_by uuid references callers(id),
  confirmed_at timestamptz,
  -- Which fields the human changed. This is the accuracy measurement.
  corrections jsonb,

  -- Promoted for querying.
  person_reached text,
  live_answer boolean,
  owner_reached boolean,
  interest_level text,
  qualification_status text,
  meeting_status text,
  meeting_at timestamptz,
  followup_requested boolean,
  followup_deadline timestamptz,
  do_not_call_requested boolean,
  coaching_point text,

  created_at timestamptz not null default now(),
  unique (call_id)
);

create index if not exists call_analysis_lead_idx on call_analysis(lead_id);
create index if not exists call_analysis_unconfirmed_idx
  on call_analysis(created_at) where confirmed_at is null;

-- ---------------------------------------------------------------------------
-- 5. Live coaching suggestions and what the caller did with them.
-- ---------------------------------------------------------------------------
create table if not exists coaching_suggestions (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  caller_id uuid references callers(id) on delete set null,
  coaching_version_id uuid,

  call_stage text not null,
  -- next_sentence | question | objection_detected | info_captured |
  -- missing_qualification | ask_for_owner | request_meeting |
  -- compliance_warning | confirm_followup
  suggestion_type text not null,
  headline text not null,
  detail text,
  priority integer not null default 0,

  shown_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists coaching_suggestions_call_idx on coaching_suggestions(call_id);

create table if not exists suggestion_feedback (
  id uuid primary key default gen_random_uuid(),
  suggestion_id uuid not null references coaching_suggestions(id) on delete cascade,
  caller_id uuid references callers(id) on delete set null,
  -- used | dismissed | rated
  action text not null,
  rating smallint,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists suggestion_feedback_suggestion_idx
  on suggestion_feedback(suggestion_id);

-- ---------------------------------------------------------------------------
-- 6. Follow-up tasks, with the full lifecycle timestamped.
-- ---------------------------------------------------------------------------
create table if not exists followup_tasks (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls(id) on delete set null,
  lead_id uuid not null references leads(id) on delete cascade,
  assigned_to uuid references callers(id) on delete set null,

  -- email | call_back | send_info | other
  kind text not null default 'email',
  reason text,
  channel_target text,

  draft_subject text,
  draft_body text,

  due_at timestamptz not null,
  -- pending | drafted | approved | sent | answered | converted | cancelled | overdue
  status text not null default 'pending',

  drafted_at timestamptz,
  approved_at timestamptz,
  sent_at timestamptz,
  opened_at timestamptz,
  answered_at timestamptz,
  converted_at timestamptz,
  cancelled_at timestamptz,

  alerted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists followup_due_idx on followup_tasks(status, due_at);
create index if not exists followup_lead_idx on followup_tasks(lead_id);
-- One live follow-up per call: a retried webhook must not create a second.
create unique index if not exists followup_one_live_per_call
  on followup_tasks(call_id)
  where call_id is not null and status not in ('cancelled', 'converted');

-- ---------------------------------------------------------------------------
-- 7. Confirmed outcomes — the ground truth the learning engine is allowed to
--    optimise toward. Deliberately separate from calls: a call is an activity,
--    an outcome is a result, and conflating them is how activity gets mistaken
--    for profit.
-- ---------------------------------------------------------------------------
create table if not exists confirmed_outcomes (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls(id) on delete set null,
  lead_id uuid not null references leads(id) on delete cascade,
  caller_id uuid references callers(id) on delete set null,

  -- live_answer | owner_conversation | qualified_opportunity | meeting_booked |
  -- meeting_attended | sale | refund | complaint | do_not_call
  outcome_type text not null,
  occurred_at timestamptz not null default now(),

  -- Money, when the outcome is financial. Null everywhere else.
  revenue_cents bigint,
  gross_profit_cents bigint,
  currency text default 'USD',

  -- human | system. A financial outcome must be entered by a person.
  recorded_by text not null default 'human',
  recorded_by_caller_id uuid references callers(id),
  note text,
  created_at timestamptz not null default now()
);

create index if not exists confirmed_outcomes_lead_idx on confirmed_outcomes(lead_id);
create index if not exists confirmed_outcomes_type_idx
  on confirmed_outcomes(outcome_type, occurred_at);

-- ---------------------------------------------------------------------------
-- 8. Versioned coaching. Production instructions change only through an
--    approved, tested proposal.
-- ---------------------------------------------------------------------------
create table if not exists coaching_versions (
  id uuid primary key default gen_random_uuid(),
  version integer not null,
  -- Which body of guidance this is: opening, objection_response, question_bank…
  scope text not null,
  content jsonb not null,

  -- draft | proposed | approved | live | superseded | rolled_back
  status text not null default 'draft',
  is_baseline boolean not null default false,

  parent_version_id uuid references coaching_versions(id),
  deployed_at timestamptz,
  retired_at timestamptz,
  rolled_back_at timestamptz,
  rollback_reason text,

  created_at timestamptz not null default now(),
  unique (scope, version)
);

create index if not exists coaching_versions_live_idx on coaching_versions(scope, status);

-- ---------------------------------------------------------------------------
-- 9. Learning: observations, proposals, experiments.
-- ---------------------------------------------------------------------------
create table if not exists learning_observations (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls(id) on delete cascade,
  caller_id uuid references callers(id) on delete set null,
  coaching_version_id uuid references coaching_versions(id),

  -- opening | question | objection_response | followup_pattern | timing
  dimension text not null,
  variant text not null,
  industry text,
  lead_source text,
  local_hour smallint,

  -- The outcome this observation is paired with, once known.
  outcome_type text,
  succeeded boolean,

  created_at timestamptz not null default now()
);

create index if not exists learning_obs_dimension_idx
  on learning_observations(dimension, variant);

create table if not exists change_proposals (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  baseline_version_id uuid references coaching_versions(id),
  candidate_version_id uuid references coaching_versions(id),

  exact_change text not null,
  reason text not null,
  supporting_call_ids uuid[] not null default '{}',
  sample_size integer not null,
  baseline_rate numeric,
  candidate_rate numeric,
  confidence numeric,
  p_value numeric,
  controlled_for text[],

  -- pending | approved | rejected | testing | promoted | rolled_back
  status text not null default 'pending',
  approved_by text,
  approved_at timestamptz,
  rejected_reason text,
  deployed_at timestamptz,
  rolled_back_at timestamptz,

  created_at timestamptz not null default now()
);

create index if not exists change_proposals_status_idx on change_proposals(status, created_at);

create table if not exists experiments (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid references change_proposals(id) on delete cascade,
  scope text not null,
  baseline_version_id uuid references coaching_versions(id),
  candidate_version_id uuid references coaching_versions(id),

  primary_metric text not null default 'owner_conversation',
  -- Metrics that must NOT get worse, whatever the primary metric does.
  guardrail_metrics text[] not null
    default array['complaint', 'do_not_call', 'meeting_attended', 'sale'],

  traffic_percent integer not null default 50,
  minimum_sample integer not null default 40,

  -- running | stopped | promoted | abandoned
  status text not null default 'running',
  started_at timestamptz not null default now(),
  stopped_at timestamptz,
  conclusion text,

  created_at timestamptz not null default now()
);

create table if not exists experiment_assignments (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references experiments(id) on delete cascade,
  call_id uuid references calls(id) on delete cascade,
  caller_id uuid references callers(id) on delete set null,
  -- baseline | candidate
  arm text not null,
  assigned_at timestamptz not null default now(),
  unique (experiment_id, call_id)
);

create index if not exists experiment_assignments_exp_idx
  on experiment_assignments(experiment_id, arm);

-- ---------------------------------------------------------------------------
-- 10. Compliance events. Append-only in spirit; never deleted by the app.
-- ---------------------------------------------------------------------------
create table if not exists compliance_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  caller_id uuid references callers(id) on delete set null,
  recording_id uuid references recordings(id) on delete set null,

  -- consent_announced | consent_granted | consent_refused |
  -- recording_started | recording_stopped | recording_blocked |
  -- dnc_requested | recording_accessed | recording_deleted | retention_purge
  event_type text not null,
  state text,
  policy_applied text,
  actor text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists compliance_events_call_idx on compliance_events(call_id);
create index if not exists compliance_events_type_idx
  on compliance_events(event_type, created_at);

-- ---------------------------------------------------------------------------
-- 11. Link the new work back to the existing calls table.
-- ---------------------------------------------------------------------------
alter table calls add column if not exists recording_id uuid references recordings(id);
alter table calls add column if not exists call_stage text;
alter table calls add column if not exists coaching_version_id uuid references coaching_versions(id);

-- ---------------------------------------------------------------------------
-- 12. RLS, matching the rest of the schema
-- ---------------------------------------------------------------------------
do $mig$
declare t text;
begin
  foreach t in array array[
    'call_intelligence_settings', 'recordings', 'transcript_segments',
    'call_analysis', 'coaching_suggestions', 'suggestion_feedback',
    'followup_tasks', 'confirmed_outcomes', 'coaching_versions',
    'learning_observations', 'change_proposals', 'experiments',
    'experiment_assignments', 'compliance_events'
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
