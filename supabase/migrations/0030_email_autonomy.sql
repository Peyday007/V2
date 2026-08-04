-- ---------------------------------------------------------------------------
-- 0030 — Three things, all in service of the email programme running itself.
--
--   1. SOMEWHERE TO PUT AN EMAIL ADDRESS. The reason this migration exists.
--      993 of 1000 leads had no address, so the programme had nobody to write
--      to. Not a bug: nothing in the application had ever looked for one.
--      Google Places returns a phone and a website, never an email, and the
--      only other path was the paid contact-provider waterfall, which has no
--      keys. The enrichment crawler already reads each business's contact and
--      about pages to find the owner's name; it now also reads the address
--      that is usually sitting on the same page, and it goes here.
--
--   2. SEQUENCES THE APPLICATION WROTE. Plain language in, a whole sequence
--      out — how many emails, how far apart, and what each one says.
--
--   3. TOPPING THE CAMPAIGN UP WITHOUT BEING ASKED. A target, a daily cap,
--      and a worker job that keeps the campaign fed.
--
-- What is still not automatic: a generated sequence does not go live until
-- somebody publishes it, and a reply is not answered without a person unless
-- auto_reply_enabled was deliberately switched on in 0029.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The address the crawl found, and where it found it.
--
--    Its own columns rather than writing straight into owner_email: an address
--    a caller typed in after speaking to somebody must never be overwritten by
--    one a regex found in a footer. The enrichment code fills owner_email only
--    when it is empty.
-- ---------------------------------------------------------------------------
alter table leads add column if not exists website_email text;

-- personal | role | generic. maria@ is worth more than info@.
alter table leads add column if not exists website_email_kind text;

-- The page it was on and when, so the claim can be checked later.
alter table leads add column if not exists website_email_source_url text;
alter table leads add column if not exists website_email_found_at timestamptz;
alter table leads add column if not exists website_email_confidence numeric;

create index if not exists leads_website_email_idx
  on leads(website_email) where website_email is not null;

-- ---------------------------------------------------------------------------
-- 2. Sequences.
--
--    `steps` is jsonb rather than a child table on purpose: a sequence is
--    edited, regenerated and published as one whole thing, and there is no
--    query that wants a single step on its own.
-- ---------------------------------------------------------------------------
create table if not exists email_sequences (
  id uuid primary key default gen_random_uuid(),

  name text not null,

  -- What was actually asked for, in the words it was asked in. Kept so a
  -- sequence can be regenerated later, and so it is obvious which brief
  -- produced which copy.
  brief text not null,

  /*
   * [{ step, delay_days, subject, body, rationale }]
   *
   * The application chose how many and how far apart. The bounds live in
   * src/lib/sequencePlan.ts, not in a check constraint here, because they are
   * judgement calls that will be tuned and a constraint would turn a tuning
   * change into a migration.
   */
  steps jsonb not null default '[]'::jsonb,

  -- draft | active | archived. Only one may be active at a time; enforced by
  -- the partial unique index below rather than by hoping.
  status text not null default 'draft'
    check (status in ('draft', 'active', 'archived')),

  -- Which model wrote it, so a change in quality can be traced to a change in
  -- model rather than guessed at.
  model text,

  -- What the writer was told about the business, condensed. Kept because the
  -- same brief with different context produces different copy, and without
  -- this that difference is invisible.
  context_summary text,

  created_at timestamptz not null default now(),
  published_at timestamptz,
  published_by text,
  archived_at timestamptz
);

-- At most one active sequence. Two would mean nobody could say what a lead
-- pushed today would receive.
create unique index if not exists email_sequences_one_active
  on email_sequences((status)) where status = 'active';

create index if not exists email_sequences_recent
  on email_sequences(created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Running itself.
-- ---------------------------------------------------------------------------

-- Off. Turning it on is the administrator deliberately enabling autonomous
-- pushing, which is the condition the rest of the system is built around.
alter table instantly_settings
  add column if not exists auto_push_enabled boolean not null default false;

-- How many leads to keep alive in the campaign. The refill tops up to this.
alter table instantly_settings
  add column if not exists target_active_leads integer not null default 200;

-- The ceiling that makes a runaway cost a day rather than a list. Deliverability
-- is the real reason for it: a domain that goes from nothing to a thousand
-- emails in an afternoon gets filtered, and no sequence recovers from that.
alter table instantly_settings
  add column if not exists daily_push_cap integer not null default 100;

alter table instantly_settings add column if not exists last_auto_push_at timestamptz;
alter table instantly_settings add column if not exists pushed_today integer not null default 0;
alter table instantly_settings add column if not exists pushed_today_date date;

-- The sequence currently in force, for the record. Instantly holds the live
-- copy; this is how the application knows which one it published.
alter table instantly_settings add column if not exists active_sequence_id uuid;

-- ---------------------------------------------------------------------------
-- 4. RLS on the new table, matching the rest of the schema.
-- ---------------------------------------------------------------------------
do $mig$
begin
  execute 'alter table email_sequences enable row level security';
  execute 'drop policy if exists email_sequences_anon_all on email_sequences';
  execute
    'create policy email_sequences_anon_all on email_sequences '
    'for all to anon, authenticated using (true) with check (true)';
end;
$mig$;

-- ---------------------------------------------------------------------------
-- 5. Did it land?
-- ---------------------------------------------------------------------------
select
  '0030 applied' as migration,
  (select count(*) from information_schema.columns
     where table_name = 'leads' and column_name like 'website_email%') as lead_email_columns,
  (select count(*) from information_schema.tables
     where table_name = 'email_sequences') as sequences_table,
  (select count(*) from information_schema.columns
     where table_name = 'instantly_settings'
       and column_name in ('auto_push_enabled','target_active_leads','daily_push_cap')) as autopush_columns;
