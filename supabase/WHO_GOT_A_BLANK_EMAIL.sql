-- ---------------------------------------------------------------------------
-- Who received an email with nothing in it.
--
-- WHY THIS EXISTS: the campaign published with every subject line intact and
-- every BODY empty, and it stayed that way for as long as nobody looked. Any
-- send that went out during that window was a blank email — a real first
-- impression, spent, on a real business.
--
-- This is read-only. It changes nothing and sends nothing. It answers one
-- question: which leads got one, so the decision about what to do for them is
-- made on a list rather than on a guess.
--
-- BEFORE YOU RUN IT: set the window. The end is when the fixed sequence was
-- published — the moment "What Instantly actually has" stopped reporting empty
-- bodies. The start is when the broken sequence went live. If you are not sure
-- of the start, leave it early; a lead that got a good email will not appear
-- as a blank one, because this only counts sends inside the window.
-- ---------------------------------------------------------------------------

with window_bounds as (
  select
    -- EDIT THESE TWO.
    timestamptz '2026-08-05 00:00:00+00' as broken_from,
    timestamptz '2026-08-08 00:00:00+00' as fixed_at
)

-- 1. HOW MANY, and over what period.
select
  'Sends during the blank-body window' as what,
  count(*)                             as emails,
  count(distinct e.lead_id)            as leads,
  min(e.occurred_at)                   as first_send,
  max(e.occurred_at)                   as last_send
from email_events e, window_bounds w
where e.event_type = 'sent'
  and e.occurred_at >= w.broken_from
  and e.occurred_at <  w.fixed_at;

-- 2. WHO. The list to actually decide about.
--
-- Ordered by whether they opened it: somebody who opened a blank email is the
-- one who noticed, and is both the most damaged and the most worth a personal
-- follow-up from a human rather than another sequence.
select
  l.business_name,
  t.email,
  min(sent.occurred_at)                                    as sent_at,
  count(*) filter (where opened.id is not null) > 0        as opened_it,
  count(*) filter (where replied.id is not null) > 0       as replied,
  t.status                                                 as thread_status
from email_events sent
join window_bounds w on true
join email_threads t on t.id = sent.thread_id
join leads l         on l.id = sent.lead_id
left join email_events opened
  on opened.thread_id = sent.thread_id and opened.event_type = 'opened'
left join email_events replied
  on replied.thread_id = sent.thread_id and replied.event_type = 'replied'
where sent.event_type = 'sent'
  and sent.occurred_at >= w.broken_from
  and sent.occurred_at <  w.fixed_at
group by l.business_name, t.email, t.status
order by opened_it desc, replied desc, sent_at;

-- ---------------------------------------------------------------------------
-- What to do with the answer is a judgement, not a query, so this stops here.
--
-- Worth knowing before deciding: these leads are still IN the campaign, so
-- they will keep receiving steps 2, 3 and 4 — which now have real copy in
-- them. Doing nothing is therefore not neutral. It means somebody who got a
-- blank email on Monday gets a polished follow-up on Friday referring to
-- something they never read.
-- ---------------------------------------------------------------------------
