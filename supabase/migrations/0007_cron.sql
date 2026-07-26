-- OPTIONAL: run the engine headlessly, without any browser tab open.
--
-- Edit the two placeholders below, then run this in the Supabase SQL Editor.
-- Skip this entirely if you're happy driving the engine from the Sourcing page
-- (it ticks the worker automatically while a campaign is running and you have
-- the page open).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any previous schedule so this file is safe to re-run.
select cron.unschedule('dispatch_worker_tick')
where exists (select 1 from cron.job where jobname = 'dispatch_worker_tick');

select cron.schedule(
  'dispatch_worker_tick',
  '* * * * *',          -- every minute
  $$
  select net.http_post(
    url := 'https://YOUR-APP.vercel.app/api/worker/tick',
    headers := '{"Content-Type":"application/json","x-worker-secret":"YOUR_WORKER_SECRET"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Replace:
--   YOUR-APP.vercel.app   -> your Vercel domain (e.g. v2-4-points.vercel.app)
--   YOUR_WORKER_SECRET    -> the value you set for WORKER_SECRET in Vercel.
--                            If you have not set WORKER_SECRET, delete the
--                            x-worker-secret header entirely.
--
-- To stop it later:  select cron.unschedule('dispatch_worker_tick');
