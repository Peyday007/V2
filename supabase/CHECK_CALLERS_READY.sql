-- ---------------------------------------------------------------------------
-- CAN MY CALLERS WORK TOMORROW?
--
-- Paste into the Supabase SQL Editor and press Run. Read-only — it changes
-- nothing.
--
-- This is deliberately NOT the migration report. It asks one question: is there
-- anything that will stop a caller mid-shift or wake somebody up. Every check
-- below is something that has actually gone wrong here, not a hypothetical.
--
-- Read the `verdict` column. Anything that is not OK is worth acting on before
-- the shift starts.
-- ---------------------------------------------------------------------------

with

-- 1. THE ONE THAT LOST REAL WORK.
--
-- The gatekeeper test assigns openers A..G at random. Until 0034 the column
-- only accepted A, B and C, so roughly four callers in seven had their ENTIRE
-- outcome rejected on save — notes, next step, duration, all of it — behind an
-- alert box about a tracking column.
save_works as (
  select
    'Saving a call outcome' as check,
    case
      when (select count(*) from pg_constraint
             where conname = 'calls_script_version_check') = 0
        then 'NO CONSTRAINT — unexpected; tell your developer'
      when coalesce((select pg_get_constraintdef(oid) from pg_constraint
                      where conname = 'calls_script_version_check') like '%~%', false)
        then 'OK'
      else 'WILL FAIL — run 0034_script_version_widen.sql NOW. Callers on scripts D-G lose the whole call.'
    end as verdict
),

-- 2. Is there anybody able to log in.
callers_ready as (
  select
    'Callers who can log in' as check,
    case
      when count(*) filter (where active) = 0
        then 'NOBODY — every caller is deactivated'
      else count(*) filter (where active) || ' active'
    end as verdict
  from callers
),

-- 3. Is there work to serve.
--
-- A caller with no open packet is told "ask your admin for one" — not an
-- error, but it is a wasted morning if nobody knew.
work_waiting as (
  select
    'Leads waiting to be called' as check,
    case
      when coalesce(sum(pending), 0) = 0
        then 'NONE — every packet is empty or closed. Build a packet before the shift.'
      else coalesce(sum(pending), 0) || ' pending across ' || count(*) || ' open packet(s)'
    end as verdict
  from (
    select p.id, count(*) filter (where pl.status = 'pending') as pending
    from packets p
    left join packet_leads pl on pl.packet_id = p.id
    where p.status = 'open'
    group by p.id
  ) x
),

-- 4. Every caller individually, because one caller with nothing to do is
--    invisible in a total.
per_caller as (
  select
    'Callers with nothing to call' as check,
    case
      when count(*) = 0 then 'OK — every active caller has work'
      else count(*) || ' active caller(s) have no pending leads: ' ||
           string_agg(name, ', ')
    end as verdict
  from (
    select c.name
    from callers c
    where c.active
      and not exists (
        select 1 from packets p
        join packet_leads pl on pl.packet_id = p.id
        where p.caller_id = c.id and p.status = 'open' and pl.status = 'pending'
      )
  ) y
),

-- 5. The do-not-call list must be READABLE.
--
-- The dialer refuses to serve anybody at all when it cannot read this, which
-- is correct — being unable to check the list is exactly how somebody who
-- asked not to be called gets called — but it presents to a caller as an
-- empty queue with an error.
dnc_readable as (
  select
    'Do-not-call list' as check,
    case
      when to_regclass('public.suppressions') is null
        then 'MISSING TABLE — the dialer will serve NOTHING. Run 0014_dnc_enforcement.sql.'
      else (select count(*)::text from suppressions) || ' suppressed numbers, list readable'
    end as verdict
),

-- 6. Did anything actually save recently? The proof the loop works end to end.
recent_calls as (
  select
    'Calls logged in the last 7 days' as check,
    case
      when count(*) = 0
        then 'NONE — if the team was calling, saves were failing. See check 1.'
      else count(*) || ' saved, most recent ' ||
           to_char(max(created_at), 'Mon DD HH24:MI')
    end as verdict
  from calls
  where created_at > now() - interval '7 days'
)

select * from save_works
union all select * from callers_ready
union all select * from work_waiting
union all select * from per_caller
union all select * from dnc_readable
union all select * from recent_calls;

-- ---------------------------------------------------------------------------
-- WHAT CHANGED TONIGHT, and could act on its own while you sleep.
--
-- The worker is now scheduled for the first time. Things that were switched on
-- months ago but never ran because nothing was calling them will now actually
-- run. None of it touches the dialer, but it is better read than discovered.
-- ---------------------------------------------------------------------------
select
  'Auto-push leads into Instantly' as behaviour,
  case
    when to_regclass('public.instantly_settings') is null then 'not installed'
    when (select coalesce(bool_and(enabled and auto_push_enabled), false)
            from instantly_settings)
      then 'ON — will push up to ' ||
           (select daily_push_cap::text from instantly_settings limit 1) ||
           ' leads a day, on its own, as soon as they have addresses.'
    else 'off'
  end as tonight
union all
select
  'Auto-adjust sending limits',
  case
    when to_regclass('public.instantly_settings') is null then 'not installed'
    when (select coalesce(bool_and(auto_adjust_limits_enabled), false)
            from instantly_settings)
      then 'ON — will edit the daily limits on your Instantly inboxes.'
    else 'off'
  end
union all
select
  'Jobs queued and waiting for the worker',
  (select count(*)::text from jobs where status = 'pending') ||
  ' pending. These will start running now that the worker ticks.';
