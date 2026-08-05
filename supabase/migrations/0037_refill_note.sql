-- ---------------------------------------------------------------------------
-- 0037 — Write down what the automatic top-up decided.
--
-- THE SILENCE THIS FIXES:
--
-- refillEmailCampaign runs on every worker tick and almost always decides to
-- do nothing, which is correct. But a decision of nothing went to a server log
-- and nowhere else:
--
--     if (decision.count === 0) {
--       console.log(`[refill] ${decision.reason}`);
--       return;
--     }
--
-- So a top-up that declines sixty times an hour tells nobody, forever. The
-- campaign was Active, 92 leads had addresses, auto-push was on and the worker
-- was alive — and the campaign stayed empty with no indication why.
--
-- The most likely reason is the worst kind: activeLeadCount() returns null
-- when Instantly's response carries no total/total_count/count key, and
-- planRefill treats null as DO NOT PUSH — deliberately, because pushing blind
-- double-fills a campaign. Right and invisible.
--
-- WHY A COLUMN AND NOT AN EVENT: an event per tick is 1,440 rows a day of
-- "decided not to", which buries the events table and answers nothing faster.
-- What anybody actually wants is the CURRENT state, so this overwrites.
-- ---------------------------------------------------------------------------

-- What it decided, in the same words planRefill produced.
alter table instantly_settings add column if not exists last_refill_note text;

-- When it last considered the question — distinct from last_auto_push_at,
-- which only moves when leads actually went. The gap between the two is the
-- whole diagnosis: recently checked but never pushed means it is declining.
alter table instantly_settings add column if not exists last_refill_checked_at timestamptz;

-- How many were in the campaign at that moment, or null when unreadable.
-- Null here is the signature of the failure above.
alter table instantly_settings add column if not exists last_refill_active_count integer;

-- ---------------------------------------------------------------------------
-- Did it work?
--
-- The columns appear immediately. The VALUES stay null until the worker ticks
-- once more, so give it a minute and run the second query.
-- ---------------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'instantly_settings'
      and column_name in
        ('last_refill_note', 'last_refill_checked_at', 'last_refill_active_count')
  ) as new_columns;

-- Run this a minute or two later — it is the answer to "why is the campaign
-- still empty":
--
--   select last_refill_checked_at, last_refill_active_count, last_refill_note
--     from instantly_settings;
