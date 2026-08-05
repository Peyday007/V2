-- ---------------------------------------------------------------------------
-- WHICH MIGRATIONS HAVE I ACTUALLY RUN?
--
-- Paste this whole file into the Supabase SQL Editor and press Run. It changes
-- nothing — every line is a read. It answers the question that has been
-- answered from memory until now, which is how the answer drifted.
--
-- You get one row per migration, in order, with a verdict:
--
--   RUN          nothing to do
--   NOT RUN      open the file it names and run it
--
-- The "why it matters" column says what breaks while it is missing, so you can
-- decide what is urgent rather than treating eight files as one wall.
--
-- HOW IT KNOWS: each migration creates something specific — a table, a column,
-- a constraint. This looks for that thing. It does not consult a list of what
-- was supposedly run, because that list is exactly what turned out to be
-- unreliable.
-- ---------------------------------------------------------------------------

with checks as (

  -- helper shorthand, inlined per row below:
  --   to_regclass('public.x') is not null   -> table x exists
  --   a row in information_schema.columns   -> column exists
  --   pg_get_constraintdef                  -> constraint says what it should

  select 1 as ord, '0023_owner_enrichment' as migration,
    exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='leads' and column_name='direct_email') as present,
    'Email addresses on leads. Without it the email system has nobody to send to.' as why
  union all
  select 2, '0024_workshop_packets',
    to_regclass('public.workshop_packets') is not null,
    'The packet pages themselves. Without it no packet link opens.'
  union all
  select 3, '0025_team_updates',
    to_regclass('public.updates') is not null,
    'The Updates page.'
  union all
  select 4, '0026_one_party_only_consent',
    coalesce((select pg_get_constraintdef(oid) from pg_constraint
               where conname='cis_consent_policy_check') like '%one_party_only%', false),
    'Only needed to switch recording to "one-party states only". Nothing else uses it.'
  union all
  select 5, '0029_instantly_email',
    to_regclass('public.instantly_settings') is not null,
    'The whole Instantly email integration.'
  union all
  select 6, '0030_email_autonomy',
    to_regclass('public.email_sequences') is not null,
    'Writing sequences and auto-refilling the campaign.'
  union all
  select 7, '0031_sending_capacity',
    to_regclass('public.sending_accounts') is not null,
    'Smart sending limits and the auto-adjust of account caps.'
  union all
  select 8, '0032_diagnostic',
    exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='leads' and column_name='diagnostic_findings'),
    'The deeper diagnostic. IMPORTANT: while this is missing, packet pages fail to open at all.'
  union all
  select 9, '0033_house_knowledge',
    to_regclass('public.house_knowledge') is not null,
    'The shared learning layer that feeds the diagnostic, packets and email.'
  union all
  select 10, '0034_script_version_widen',
    coalesce((select pg_get_constraintdef(oid) from pg_constraint
               where conname='calls_script_version_check') like '%~%', false),
    'URGENT. While this is missing, callers who draw script D-G lose the entire call when they save.'
  union all
  /*
   * 0035 is checked by its EFFECT, not by its presence.
   *
   * Two reasons. A cron row can exist and still be posting into the void —
   * that is precisely what 0007 did for months — so "is it scheduled" was
   * never the useful question. And referencing cron.job directly makes this
   * whole report error out when pg_cron is not installed, because Postgres
   * validates every branch at parse time, including ones guarded off.
   *
   * The worker enqueues these three on every single tick. A row from the last
   * fifteen minutes means something really is calling the endpoint.
   */
  select 11, '0035_schedule_worker',
    exists (select 1 from jobs
             where type in ('recompute_house_knowledge','sync_sending_accounts','refill_email_campaign')
               and created_at > now() - interval '15 minutes'),
    'THE BIG ONE. No tick in the last 15 min = nothing automatic is running: no campaign refill, no enrichment, no learning.'
  union all
  select 12, '0036_email_audience',
    exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='email_threads'
               and column_name='email_audience'),
    'Records whether each email reached a person or a front desk. Adds columns only — it does not find addresses.'
)
select
  migration,
  case when present then 'RUN' else 'NOT RUN' end as status,
  why as why_it_matters
from checks
order by ord;

-- ---------------------------------------------------------------------------
-- The two that are NOT schema, and are not on the list above.
--
-- 0027 and 0028 are one-time repairs, not features. Running them when you do
-- not have the symptom does nothing; the point is to check whether you have
-- the symptom. Both numbers below should normally be 0.
-- ---------------------------------------------------------------------------
select
  '0027_unstick_leads' as repair,
  (select count(*) from leads
    where machine_status in ('enriching','enrichment_queued','enrichment_failed')
      and qualification_failure_reason is null
      and normalized_phone is not null
      and archived_at is null
      and coalesce(do_not_call,false) = false
      and status = 'new') as leads_stuck_mid_enrichment,
  'If this is above 0, those leads are callable but hidden. Run 0027.' as meaning
union all
select
  '0028_restore_uncalled_packet_leads',
  (select count(*) from packet_leads pl
    where pl.status = 'done'
      and not exists (select 1 from calls k where k.lead_id = pl.lead_id)),
  'If this is above 0, leads are marked done that nobody ever rang. Run 0028.';

-- ---------------------------------------------------------------------------
-- WHY IS NOTHING HAPPENING?
--
-- Running a migration adds columns. It does not go and fill them in. If the
-- Email page says "0 of 1000 leads have an address", the addresses were never
-- COLLECTED, and no migration will change that — the crawler that reads them
-- off each business's contact page runs as a background job, and background
-- jobs only run when the worker ticks.
--
-- These four queries find where the chain is broken. Read them in order; the
-- first one that looks wrong is the cause of everything after it.
-- ---------------------------------------------------------------------------

-- 1. Is the worker alive? Jobs are queued by the app and drained by the tick.
--    A large `waiting` next to an old `newest_job` means work is piling up
--    with nothing running it — that is the scheduler (0035), not a migration.
select
  count(*) filter (where status = 'pending')  as waiting,
  count(*) filter (where status = 'running')  as running,
  count(*) filter (where status = 'done')     as finished,
  count(*) filter (where status = 'failed')   as failed,
  max(created_at)                             as newest_job,
  max(created_at) filter (where status = 'done') as last_finished
from jobs;

-- 2. What is waiting, by type. `enrich_owner_contact` is the one that finds
--    email addresses, owner names and direct numbers.
select type, status, count(*)
from jobs
where status in ('pending', 'running', 'failed')
group by 1, 2
order by 3 desc
limit 20;

-- 3. Where the leads actually are.
--
--    WATCH FOR THIS: leads sitting at 'ready_for_calling' that never finished
--    enrichment. 0027 was a repair that moved stuck leads to callable so the
--    team could work — which was right at the time, and it means those leads
--    are callable WITHOUT an email address, without a direct number and
--    without a diagnostic. They will never gain one on their own, because the
--    job that would have done it is no longer queued for them.
select
  coalesce(machine_status, '(none)') as machine_status,
  count(*)                                                as leads,
  count(*) filter (where website_email is not null)        as have_email,
  count(*) filter (where direct_phone is not null)         as have_direct_number,
  count(*) filter (where diagnostic_findings is not null)  as have_diagnostic
from leads
where archived_at is null
group by 1
order by 2 desc;

-- 4. Has enrichment ever actually run to completion?
--    An empty table means it has never run at all.
select
  count(*)                                              as enrichment_runs_recorded,
  count(*) filter (where success_level is not null)      as with_a_result,
  max(started_at)                                       as most_recent
from enrichment_runs;
