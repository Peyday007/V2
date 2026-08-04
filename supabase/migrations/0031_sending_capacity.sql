-- ---------------------------------------------------------------------------
-- 0031 — Let the inboxes decide how much gets sent, and let them grow.
--
-- Two things, and the second one is the one to read carefully.
--
--   SMART CAPACITY. The daily push cap was a number somebody typed into a box,
--   and it was almost certainly wrong in one direction or the other. It should
--   be derived from what the sending accounts can actually carry, divided by
--   how many emails each lead is going to receive. That arithmetic is in
--   src/lib/sendingCapacity.ts and is explained there.
--
--   MOVING SOMEBODY ELSE'S SETTINGS. Accounts sitting at 30/day that have been
--   warm for months can carry 90, and nobody wants to go and change fourteen
--   of them by hand. So this application can change them — which makes it the
--   only place in the whole system that writes a setting into an external
--   account.
--
-- That second one is why account_limit_changes exists. Every change is written
-- down with the reason, the before, the after, and whether Instantly accepted
-- it, BEFORE the call is made. An automated system that adjusts somebody's
-- sending limits and keeps no record of it is not something anybody should
-- run.
--
-- The change is also bounded, not just logged: half again at a time, capped at
-- +20, two days apart, never past the ceiling, and never on an inbox that is
-- young, unhealthy or bouncing. Mailbox providers score the RATE of change as
-- well as the volume — an address that triples its output overnight looks
-- exactly like a compromised one.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The inboxes, as last seen in Instantly.
--
--    A cache, not a source of truth: Instantly owns these. It exists so the
--    page can show them without a round trip, and so "when did we last raise
--    this one" has somewhere to live.
-- ---------------------------------------------------------------------------
create table if not exists sending_accounts (
  email text primary key,

  -- What Instantly currently allows. Refreshed on every sync.
  daily_limit integer not null default 0,

  -- Instantly's own health score, 0-100.
  warmup_score integer,
  warmup_status text,

  active boolean not null default true,

  -- When the inbox was created, so its age can be judged.
  provider_created_at timestamptz,

  -- When WE last moved its limit. The cooldown is measured from here, not from
  -- Instantly's own updated_at, which moves for reasons that are not ours.
  last_changed_at timestamptz,
  last_change_reason text,

  /*
   * Set true to make this application leave the account completely alone.
   *
   * The escape hatch. Somebody will have one inbox that is special for a
   * reason the software cannot know, and the answer to that must not be
   * "switch the whole feature off".
   */
  excluded boolean not null default false,

  last_synced_at timestamptz not null default now()
);

create index if not exists sending_accounts_active_idx on sending_accounts(active, daily_limit desc);

-- ---------------------------------------------------------------------------
-- 2. Every limit change, append-only.
--
--    Written before the call to Instantly, then updated with what happened. So
--    a change that was attempted and refused leaves a row saying so, rather
--    than leaving no trace at all.
-- ---------------------------------------------------------------------------
create table if not exists account_limit_changes (
  id bigserial primary key,
  email text not null,

  limit_before integer not null,
  limit_after integer not null,

  -- raise | lower
  direction text not null check (direction in ('raise', 'lower')),

  -- In words. This is what somebody reads when they ask why their account
  -- changed, so it is not optional.
  reason text not null,

  -- admin | worker. A person pressing the button and the automatic ramp are
  -- different things and the log should not blur them.
  actor text not null default 'worker',

  applied boolean not null default false,
  error text,

  created_at timestamptz not null default now()
);

create index if not exists account_limit_changes_recent
  on account_limit_changes(created_at desc);
create index if not exists account_limit_changes_email
  on account_limit_changes(email, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. The settings for both.
-- ---------------------------------------------------------------------------

-- Derive the daily push cap from real capacity instead of the typed-in number.
-- Safe to default on: it only ever reads, and a derived cap is strictly better
-- informed than a guessed one. It has no effect until accounts have synced.
alter table instantly_settings
  add column if not exists smart_capacity_enabled boolean not null default false;

-- Change the accounts themselves. NOT safe to default on, and it does not:
-- this writes into an external system.
alter table instantly_settings
  add column if not exists auto_adjust_limits_enabled boolean not null default false;

-- Nothing is ever raised past this.
alter table instantly_settings
  add column if not exists account_limit_ceiling integer not null default 90;

-- Share of total capacity to actually plan against, leaving room for replies,
-- retries and the odd manual send. 0.85 = use 85%.
alter table instantly_settings
  add column if not exists capacity_headroom numeric not null default 0.85;

alter table instantly_settings add column if not exists last_capacity_sync_at timestamptz;

-- The last computed numbers, so the page and the refill planner agree without
-- either of them making a fresh request.
alter table instantly_settings add column if not exists computed_daily_sends integer;
alter table instantly_settings add column if not exists computed_leads_per_day integer;

-- ---------------------------------------------------------------------------
-- 4. RLS, matching the rest of the schema.
-- ---------------------------------------------------------------------------
do $mig$
declare t text;
begin
  foreach t in array array['sending_accounts', 'account_limit_changes']
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
-- 5. Did it land?
-- ---------------------------------------------------------------------------
select
  '0031 applied' as migration,
  (select count(*) from information_schema.tables
     where table_name in ('sending_accounts', 'account_limit_changes')) as tables_created,
  (select count(*) from information_schema.columns
     where table_name = 'instantly_settings'
       and column_name in ('smart_capacity_enabled','auto_adjust_limits_enabled',
                           'account_limit_ceiling','capacity_headroom')) as settings_columns;
