-- ---------------------------------------------------------------------------
-- 0035 — Actually schedule the worker.
--
-- THE BUG THIS FIXES:
--
-- Everything this application does on its own — topping the email campaign up,
-- re-reading the sending inboxes, rebuilding what the house knows, and every
-- job queued when somebody presses a button — runs off one endpoint,
-- /api/worker/tick. Something has to CALL that endpoint on a schedule.
--
-- Nothing ever did. There is no vercel.json, so no Vercel Cron. There is no
-- GitHub Action. And 0007_cron.sql, the only scheduler in the repository,
-- shipped with placeholders nobody could have known to fill in:
--
--     url := 'https://YOUR-APP.vercel.app/api/worker/tick'
--
-- Run verbatim, that posts to a domain belonging to somebody else, every
-- minute, forever, and says nothing. So the email page reported "It has not
-- run yet" — which was exactly true — and the Instantly campaign sat at zero
-- leads with every panel reading "no data available".
--
-- This file has no placeholders. The URL below is the real deployment.
--
-- WHY pg_cron RATHER THAN VERCEL CRON: Vercel's cron frequency depends on the
-- plan — once a day on Hobby. A daily tick would look installed and would turn
-- "enrich these leads" into "results tomorrow". pg_cron runs every minute on
-- every Supabase plan, including free, so this works regardless.
--
-- BEFORE RUNNING: enable the two extensions in the Supabase dashboard under
-- Database -> Extensions. Search for `pg_cron` and `pg_net` and switch both
-- on. The lines below will do it too, but the dashboard is more reliable and
-- tells you if something went wrong.
--
-- AUTHENTICATION: no header is sent, because no WORKER_SECRET is set. The
-- worker accepts unauthenticated ticks in that case by design, and spending is
-- still bounded by the campaign caps. IF YOU EVER SET WORKER_SECRET IN VERCEL,
-- come back and uncomment the headers line below, or the worker will start
-- refusing every tick and everything silently stops again.
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replacing rather than adding. Running this file twice must leave one
-- schedule, not two — two ticks a minute is not a disaster (jobs are claimed
-- with SKIP LOCKED and the refill carries a per-tick idempotency key) but it
-- doubles the load for no benefit, and an accumulating list of near-identical
-- cron jobs is how nobody can tell which one is live.
select cron.unschedule('dispatch_worker_tick')
where exists (select 1 from cron.job where jobname = 'dispatch_worker_tick');

-- Also clear the broken one from 0007 if it is still sitting there posting
-- into the void. It has the same name, so the statement above already caught
-- it — this is belt and braces for a hand-edited copy under another name.
select cron.unschedule(jobname)
from cron.job
where command like '%YOUR-APP.vercel.app%';

select cron.schedule(
  'dispatch_worker_tick',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://v2-4-points.vercel.app/api/worker/tick',
    body := '{}'::jsonb,
    -- headers := '{"Content-Type":"application/json","x-worker-secret":"PUT_YOUR_SECRET_HERE"}'::jsonb,
    --
    -- 60 seconds, not the 5-second default. The tick works for up to 45
    -- seconds before it hands back, and at the default pg_net would hang up
    -- on it a fraction of the way in, every single minute.
    timeout_milliseconds := 60000
  );
  $$
);

-- ---------------------------------------------------------------------------
-- Did it work?
--
-- `schedule_active` should be one row saying '* * * * *'.
--
-- Then WAIT ABOUT TWO MINUTES and run the second query on its own. `status`
-- should read 'succeeded'. If it says 'failed', the message says why — the
-- usual cause is pg_net not being enabled.
-- ---------------------------------------------------------------------------
select jobid, jobname, schedule, active
from cron.job
where jobname = 'dispatch_worker_tick';

-- Run this one again in a couple of minutes:
--
--   select status, return_message, start_time
--     from cron.job_run_details
--    where jobname = 'dispatch_worker_tick'
--    order by start_time desc
--    limit 5;
--
-- And this is the one that proves the app is doing something, rather than
-- merely being poked. It should stop being empty within a few minutes:
--
--   select type, status, created_at
--     from jobs
--    order by created_at desc
--    limit 10;
