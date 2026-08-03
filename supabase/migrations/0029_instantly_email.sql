-- ---------------------------------------------------------------------------
-- 0029 — Instantly: cold email alongside the calling.
--
-- The division of labour matters, so it is written down here rather than
-- inferred from the code:
--
--   INSTANTLY SENDS. It is a cold-email platform with warmed inboxes, spam
--   handling and sequencing. This application does not send a single email and
--   should never grow the ability to.
--
--   THIS APPLICATION DECIDES WHO. It already knows who the decision-maker is,
--   what the business looks like, who is on the do-not-call list and what a
--   caller learned on the phone. That is the part Instantly cannot do.
--
--   REPLIES COME BACK HERE. A reply is the most valuable event in the whole
--   system and it must not sit unread in a separate tool.
--
-- Nothing in this migration enables automatic sending of anything. The reply
-- drafts below are drafts: a person approves each one, unless an administrator
-- deliberately turns that off.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Settings. One row, edited from the admin console.
--
--    The API key is NOT here. It lives in the environment, so it cannot be
--    read out of a database backup or shown on a page by accident.
-- ---------------------------------------------------------------------------
create table if not exists instantly_settings (
  id boolean primary key default true check (id),

  -- Off until somebody turns it on. Nothing is pushed while this is false.
  enabled boolean not null default false,

  -- The Instantly campaign new leads are pushed into.
  campaign_id text,
  campaign_name text,

  -- Most leads to push in one run, so a mistake costs a batch and not a list.
  max_push_per_run integer not null default 50,

  /*
   * Whether a drafted reply may be sent without a person reading it.
   *
   * Default false and it should stay false. An automated reply to a prospect
   * is an autonomous communication in our name — the kind of thing that is
   * fine 95 times and unrecoverable the other five.
   */
  auto_reply_enabled boolean not null default false,

  -- Below this the model's reading of a reply is never acted on at all.
  reply_confidence_floor numeric not null default 0.7,

  updated_at timestamptz not null default now()
);

insert into instantly_settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. One row per lead that has been pushed into a campaign.
-- ---------------------------------------------------------------------------
create table if not exists email_threads (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,

  -- Instantly's own identifiers, so an event can be traced back.
  instantly_lead_id text,
  campaign_id text,

  email text not null,

  -- pushed | sent | opened | replied | bounced | unsubscribed | failed
  status text not null default 'pushed'
    check (status in ('pushed','sent','opened','replied','bounced','unsubscribed','failed')),

  push_error text,
  reply_count integer not null default 0,
  last_event_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A lead belongs to one thread. Pushing twice must not create a second.
create unique index if not exists email_threads_one_per_lead on email_threads(lead_id);
create index if not exists email_threads_status_idx on email_threads(status, last_event_at desc);

-- ---------------------------------------------------------------------------
-- 3. Every event Instantly reports, append-only.
--
--    Kept raw as well as parsed: when a webhook shape changes, the parsed
--    columns go wrong quietly and the payload is the only way to find out.
-- ---------------------------------------------------------------------------
create table if not exists email_events (
  id bigserial primary key,
  thread_id uuid references email_threads(id) on delete cascade,
  lead_id uuid references leads(id) on delete cascade,

  event_type text not null,
  subject text,
  body text,
  from_email text,

  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists email_events_thread_idx on email_events(thread_id, occurred_at desc);
create index if not exists email_events_lead_idx on email_events(lead_id, occurred_at desc);

-- Instantly can retry a webhook. The same delivery must not be counted twice.
alter table email_events add column if not exists idempotency_key text;
create unique index if not exists email_events_idempotency
  on email_events(idempotency_key) where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- 4. Replies waiting on a human.
--
--    A draft is a suggestion. `status` starts 'pending' and only a person
--    moves it, unless auto_reply_enabled has been deliberately switched on.
-- ---------------------------------------------------------------------------
create table if not exists email_drafts (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references email_threads(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  event_id bigint references email_events(id) on delete set null,

  -- What the model made of the prospect's reply.
  intent text,
  intent_confidence numeric,
  intent_reason text,

  subject text,
  body text not null,

  -- pending | approved | sent | rejected | superseded
  status text not null default 'pending'
    check (status in ('pending','approved','sent','rejected','superseded')),

  decided_by text,
  decided_at timestamptz,
  decision_note text,
  send_error text,

  created_at timestamptz not null default now()
);

create index if not exists email_drafts_pending_idx
  on email_drafts(status, created_at desc) where status = 'pending';

-- ---------------------------------------------------------------------------
-- 5. On the lead itself: whether email is off limits.
--
--    Separate from do_not_call. Someone can unsubscribe from email and still
--    be perfectly callable, and somebody on the do-not-call list must not be
--    emailed either — the two suppress each other in one direction only.
-- ---------------------------------------------------------------------------
alter table leads add column if not exists email_unsubscribed_at timestamptz;
alter table leads add column if not exists email_bounced_at timestamptz;

-- ---------------------------------------------------------------------------
-- 6. RLS, matching the rest of the schema.
-- ---------------------------------------------------------------------------
do $mig$
declare t text;
begin
  foreach t in array array[
    'instantly_settings', 'email_threads', 'email_events', 'email_drafts'
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

-- ---------------------------------------------------------------------------
-- 7. Did it land?
-- ---------------------------------------------------------------------------
select
  '0029 applied' as migration,
  (select count(*) from instantly_settings) as settings_row,
  (select count(*) from information_schema.tables
     where table_name in ('email_threads','email_events','email_drafts')) as tables_created,
  (select count(*) from information_schema.columns
     where table_name = 'leads' and column_name = 'email_unsubscribed_at') as lead_columns;
