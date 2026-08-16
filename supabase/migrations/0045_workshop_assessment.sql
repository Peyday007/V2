-- ---------------------------------------------------------------------------
-- 0045 — The workshop becomes a business assessment.
--
-- WHAT CHANGES. The workshop used to lead with a product: an AI receptionist,
-- a website, an SEO score, a review count. Every prospect got the same four
-- headings in a different order, which is why it read as a template however
-- accurate the numbers were.
--
-- It now leads with a CONSTRAINT — uncaptured demand, estimates that are never
-- recovered, work that cannot happen without the owner — and a product appears
-- only underneath it, as the matched response. That inverts the data model:
-- findings stop being classified by what we would sell and start being
-- classified by where the business leaks.
--
-- ADDITIVE ONLY, AND THAT IS THE POINT. Every existing workshop_packets row
-- keeps its token, so every link already texted to an owner still resolves.
-- Nothing is deleted, no status is rewritten in place, and the four original
-- statuses stay legal values forever — `trial_requested` is mapped forward to
-- `interested` when it is READ, never when it is stored, so the history of what
-- somebody actually agreed to is not quietly restated as something else.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The lifecycle widens.
--
-- The original migration chose a text column with a check rather than an enum,
-- specifically so this list could grow without a deploy. Taking it up on that.
--
-- Interest, a demo request, permission to touch a system and a paid engagement
-- are four different things and are four different states. Collapsing them was
-- how "they clicked the button" could be mistaken for "they said yes".
-- ---------------------------------------------------------------------------
alter table workshop_packets drop constraint if exists workshop_packets_status_check;

alter table workshop_packets
  add constraint workshop_packets_status_check check (status in (
    'not_sent',
    'sent',
    'opened',
    -- Read a finding, expanded evidence, started the audit. Not yet a signal.
    'engaged',
    -- Pressed "I'm interested in seeing more". NOT permission, NOT a trial.
    'interested',
    'demo_requested',
    'walkthrough_requested',
    'walkthrough_scheduled',
    -- Explicitly allowed us to change something live. Always a separate act.
    'live_change_approved',
    'converted',
    'expired',
    'revoked',
    -- Kept legal forever: rows written before today hold it, and rewriting
    -- them would destroy the record of what was actually agreed to.
    'trial_requested'
  ));

comment on column workshop_packets.status is
  'Lifecycle. `trial_requested` is historical only — no new row takes it. '
  'Interest, demo request, walkthrough, live-change permission and conversion '
  'are deliberately separate states; pressing "I am interested" is none of the '
  'others.';

-- The stable experiment variant, assigned once at creation and never re-rolled
-- per visit. Existing rows get the control, which is the safe default: they
-- were built against the original layout.
alter table workshop_packets add column if not exists variant text not null default 'control';

-- The lead's own journey through the assessment, kept alongside the status so
-- a record can be read without replaying its whole event stream.
alter table workshop_packets add column if not exists first_opened_at timestamptz;
alter table workshop_packets add column if not exists last_seen_at timestamptz;
alter table workshop_packets add column if not exists interested_at timestamptz;
alter table workshop_packets add column if not exists demo_requested_at timestamptz;
alter table workshop_packets add column if not exists walkthrough_requested_at timestamptz;
alter table workshop_packets add column if not exists walkthrough_kind text
  check (walkthrough_kind is null or walkthrough_kind in ('phone', 'video', 'recorded'));
alter table workshop_packets add column if not exists walkthrough_scheduled_at timestamptz;
alter table workshop_packets add column if not exists live_change_approved_at timestamptz;
alter table workshop_packets add column if not exists converted_at timestamptz;

-- How the owner asked to be reached, captured only when they tell us.
alter table workshop_packets add column if not exists preferred_contact text
  check (preferred_contact is null or preferred_contact in ('phone', 'email', 'text'));

-- Operator workspace. Never rendered on the public page — see the RLS note and
-- the `internal_note` exclusion in the API layer.
alter table workshop_packets add column if not exists operator_note text;
alter table workshop_packets add column if not exists next_action text;
alter table workshop_packets add column if not exists follow_up_done_at timestamptz;

-- Which generation of the packet this is. Regenerating writes a new row in
-- workshop_packet_versions rather than overwriting what the prospect saw.
alter table workshop_packets add column if not exists packet_version integer not null default 1;

-- ---------------------------------------------------------------------------
-- 2. The opportunities themselves.
--
-- One row per finding, per packet, frozen at generation time. Frozen matters:
-- the lead's rating and review count move, and a finding shown to an owner in
-- March must still read in June as what they were actually shown.
-- ---------------------------------------------------------------------------
create table if not exists workshop_opportunities (
  id uuid primary key default gen_random_uuid(),
  packet_id uuid not null references workshop_packets(id) on delete cascade,

  -- Where in the business journey this leaks. Demand → discovery → evaluation
  -- → contact → qualification → booking → fulfilment → payment → review →
  -- retention → visibility. Deliberately NOT a product name.
  stage text not null,
  category text not null,

  title text not null,
  summary text not null,

  -- What we actually saw, and where. Evidence is never optional: a finding
  -- with nothing behind it is an opinion and must not be shown as an
  -- observation.
  evidence text not null,
  source_type text not null,
  source_detail text,
  observed_at timestamptz not null default now(),

  -- THE SEPARATION THAT KEEPS THIS HONEST. Three columns rather than one prose
  -- blob, because the public page renders them under three different headings
  -- and an inference that drifts into the "known" column is the single most
  -- damaging thing this system could do.
  known_facts text[] not null default '{}',
  inferences text[] not null default '{}',
  needs_confirmation text[] not null default '{}',
  would_verify_next text[] not null default '{}',

  -- low | medium | high. Restrained on purpose; nothing here is certain.
  confidence text not null default 'medium'
    check (confidence in ('low', 'medium', 'high')),

  -- Prose only. No fabricated pounds, calls, or conversion rates — see the
  -- forbidden-claims test in tests/opportunityModel.test.ts.
  potential_effect text,

  -- What we could build privately, without touching their live business.
  demonstrable boolean not null default false,
  demo_label text,
  solution_directions text[] not null default '{}',
  custom_build_potential text,

  -- Ranking inputs and the score they produced, stored so a ranking can be
  -- explained months later rather than re-derived from moved data.
  rank_score numeric,
  priority text not null default 'supporting'
    check (priority in ('primary', 'supporting', 'context')),
  position integer not null default 0,

  -- NEVER RENDERED PUBLICLY. Selected out at the API boundary, not merely
  -- hidden in the component.
  internal_note text,

  created_at timestamptz not null default now()
);

create index if not exists workshop_opportunities_packet_idx
  on workshop_opportunities (packet_id, position);

comment on column workshop_opportunities.internal_note is
  'Operator-only. The public API must never select this column.';

-- ---------------------------------------------------------------------------
-- 3. What the owner told us from the inside.
-- ---------------------------------------------------------------------------
create table if not exists workshop_bottleneck_answers (
  id uuid primary key default gen_random_uuid(),
  packet_id uuid not null references workshop_packets(id) on delete cascade,

  area text not null,
  detail text,
  frequency text check (frequency is null or frequency in ('daily', 'weekly', 'occasionally', 'unsure')),
  affects text check (affects is null or affects in ('revenue', 'time', 'customers', 'employees', 'costs', 'visibility')),

  -- Partial progress. An owner half way through the audit who refreshes must
  -- not lose what they typed, so answers are saved as they go and only marked
  -- complete on submit.
  completed boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (packet_id, area)
);

-- ---------------------------------------------------------------------------
-- 4. Every interaction, first-party.
--
-- No third-party analytics on a page a prospect opens from a text message.
-- Admin previews are recorded with is_admin_preview so they can be excluded
-- from every conversion number rather than quietly inflating it.
-- ---------------------------------------------------------------------------
create table if not exists workshop_events (
  id uuid primary key default gen_random_uuid(),
  packet_id uuid not null references workshop_packets(id) on delete cascade,

  event_type text not null,
  -- Which finding, section or control. Structured, never free-form HTML.
  target text,
  metadata jsonb not null default '{}'::jsonb,

  variant text,
  is_admin_preview boolean not null default false,

  -- Deduplication. A browser that fires the same view twice, or an owner who
  -- double-taps the interest button, must not produce two conversions.
  idempotency_key text,

  occurred_at timestamptz not null default now()
);

create unique index if not exists workshop_events_idem_idx
  on workshop_events (packet_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists workshop_events_packet_idx
  on workshop_events (packet_id, occurred_at desc);

create index if not exists workshop_events_type_idx
  on workshop_events (event_type, occurred_at desc)
  where is_admin_preview = false;

-- ---------------------------------------------------------------------------
-- 5. Regeneration without destruction.
--
-- Revising a packet keeps the old one. An owner who was shown one thing in
-- March and rings up in June must be answerable with what they actually saw.
-- ---------------------------------------------------------------------------
create table if not exists workshop_packet_versions (
  id uuid primary key default gen_random_uuid(),
  packet_id uuid not null references workshop_packets(id) on delete cascade,
  version integer not null,
  snapshot jsonb not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (packet_id, version)
);

-- ---------------------------------------------------------------------------
-- 6. Row level security, matching the pattern the rest of the schema uses.
--
-- The public page reaches these tables only through the server, which uses the
-- service role. Nothing here is readable by anon.
-- ---------------------------------------------------------------------------
alter table workshop_opportunities enable row level security;
alter table workshop_bottleneck_answers enable row level security;
alter table workshop_events enable row level security;
alter table workshop_packet_versions enable row level security;

-- ---------------------------------------------------------------------------
-- Did it work?
--
-- 1. Every existing packet still has its token and is untouched. `variant`
--    should read 'control' for all of them and `packet_version` 1.
-- 2. The four new tables exist and are empty.
-- 3. The status check accepts the new values AND still accepts the old ones.
-- ---------------------------------------------------------------------------
select
  count(*)                                                as packets_total,
  count(*) filter (where token is not null)               as still_have_links,
  count(*) filter (where variant = 'control')             as on_control,
  count(*) filter (where status = 'trial_requested')      as historical_trial_rows
from workshop_packets;

select
  (select count(*) from workshop_opportunities)      as opportunities,
  (select count(*) from workshop_bottleneck_answers) as bottleneck_answers,
  (select count(*) from workshop_events)             as events,
  (select count(*) from workshop_packet_versions)    as versions;
