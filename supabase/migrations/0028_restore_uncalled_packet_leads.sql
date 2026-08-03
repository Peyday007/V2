-- ---------------------------------------------------------------------------
-- 0028 — Put back the leads that were closed without ever being called.
--
-- THE SYMPTOM
--
-- A caller's packet showed 104 of 200 calls made, and the dialer said there was
-- nothing left. The remaining 96 leads had been added to the packet that
-- morning and never touched. Their packet_leads rows were marked 'done', so
-- the packet auto-completed and the dialer stopped looking at it.
--
-- WHY THIS REPAIRS BY EVIDENCE RATHER THAN BY CAUSE
--
-- Several code paths could have marked those rows done — most likely the bulk
-- close-out of suppressed leads, which until now updated packet_leads by
-- lead_id alone without scoping to the packet, so removing one do-not-call lead
-- from one caller's packet closed that lead out of every packet containing it.
-- That is fixed in the application code.
--
-- Rather than guess which path did it, this asks a question the data can answer
-- on its own: WAS THIS LEAD EVER ACTUALLY CALLED? A packet row marked done with
-- no call logged against it was not worked — it was closed by something else.
--
-- WHAT IT WILL NOT TOUCH
--
--   * any lead with a call logged against it — that one really was worked
--   * anything on the do-not-call list, or flagged, or archived
--   * packets that are genuinely finished
--
-- Safe to run more than once.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Before: what the packets look like right now.
-- ---------------------------------------------------------------------------
select
  'BEFORE' as stage,
  c.name as caller,
  p.name as packet,
  p.status as packet_status,
  count(*) filter (where pl.status = 'pending') as pending,
  count(*) filter (where pl.status = 'done') as done,
  count(*) filter (
    where pl.status = 'done'
      and not exists (select 1 from calls k where k.lead_id = pl.lead_id)
  ) as done_but_never_called
from packets p
join packet_leads pl on pl.packet_id = p.id
left join callers c on c.id = p.caller_id
group by c.name, p.name, p.status
order by done_but_never_called desc, c.name;

-- ---------------------------------------------------------------------------
-- 2. Put them back on the queue.
-- ---------------------------------------------------------------------------
update packet_leads pl
set status = 'pending'
where
  pl.status = 'done'
  -- Never called. This is the whole test.
  and not exists (select 1 from calls k where k.lead_id = pl.lead_id)
  -- And still a lead anybody is allowed to ring.
  and exists (
    select 1 from leads l
    where l.id = pl.lead_id
      and l.archived_at is null
      and coalesce(l.do_not_call, false) = false
      and coalesce(l.phone_invalid, false) = false
      and l.normalized_phone is not null
  )
  -- Not one that a do-not-call request actually covers.
  and not exists (
    select 1 from suppressions s
    join leads l2 on l2.id = pl.lead_id
    where s.lead_id = pl.lead_id
       or (s.normalized_phone is not null and s.normalized_phone = l2.normalized_phone)
  );

-- ---------------------------------------------------------------------------
-- 3. Reopen any packet that now has work in it again.
--
--    A packet only ever auto-completes when its pending count reaches zero, so
--    one holding pending rows is a contradiction either way.
-- ---------------------------------------------------------------------------
update packets p
set status = 'open'
where p.status <> 'open'
  and exists (
    select 1 from packet_leads pl
    where pl.packet_id = p.id and pl.status = 'pending'
  );

-- ---------------------------------------------------------------------------
-- 4. After: what the callers will actually be served.
--
--    If `pending` is still 0 for the caller you expected, the leads WERE called
--    — check the calls table — or they are suppressed. This file will not
--    resurrect either, on purpose.
-- ---------------------------------------------------------------------------
select
  '0028 applied' as migration,
  c.name as caller,
  p.name as packet,
  p.status as packet_status,
  count(*) filter (where pl.status = 'pending') as now_servable,
  count(*) filter (where pl.status = 'done') as done
from packets p
join packet_leads pl on pl.packet_id = p.id
left join callers c on c.id = p.caller_id
group by c.name, p.name, p.status
order by now_servable desc, c.name;
