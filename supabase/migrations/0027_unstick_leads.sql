-- ---------------------------------------------------------------------------
-- 0027 — Give the callers their leads back.
--
-- WHAT WENT WRONG
--
-- The owner-enrichment work made a lead callable only once it had been graded
-- A or B. A lead reaches A or B only when a paid contact provider returns a
-- direct number for a named owner. With no provider configured, nothing can
-- ever grade above C — so the rule excluded every lead in the database, and
-- the dialer had nothing to hand out.
--
-- Three separate dead ends, all now fixed in the application code:
--
--   1. leadEligibility required grade A or B. It no longer does; the grade
--      decides the ORDER a packet is worked in, not whether a lead qualifies.
--   2. enrichLeadForOwner marked anything short of a direct number
--      'enrichment_failed' — i.e. "discarded, not worth calling".
--   3. When no decision-maker could be named at all, it never set
--      machine_status, so those leads sat on 'enriching' forever.
--
-- This file repairs the rows that are already stuck. The code fix only changes
-- what happens next; it cannot un-fail a lead that was failed last week.
--
-- WHAT THIS DOES NOT TOUCH
--
-- Leads with a qualification_failure_reason. Both legitimate rejection paths —
-- failing the campaign's rating/review/website rules, and having no usable
-- phone number — set that column, and those leads SHOULD stay out. Only leads
-- that were stopped by the grade gate are released.
--
-- Safe to run more than once.
-- ---------------------------------------------------------------------------

update leads
set machine_status = 'ready_for_calling'
where
  -- Stopped somewhere in enrichment...
  machine_status in ('enriching', 'enrichment_queued', 'enrichment_failed')
  -- ...but NOT for a reason that stands on its own.
  and qualification_failure_reason is null
  -- Still has to be a lead anybody could ring.
  and normalized_phone is not null
  and archived_at is null
  and coalesce(do_not_call, false) = false
  -- Never touch one that is already with a caller or already called.
  and status = 'new';

-- ---------------------------------------------------------------------------
-- Did it land, and how many did it free?
--
-- `now_callable` is what the dialer can hand out. If it is 0 and total_leads
-- is not, nothing here matched — check whether the leads carry a
-- qualification_failure_reason, which means they were rejected on their own
-- merits rather than by the grade gate.
-- ---------------------------------------------------------------------------
select
  '0027 applied' as migration,
  (select count(*) from leads) as total_leads,
  (select count(*) from leads
     where machine_status = 'ready_for_calling'
       and status = 'new'
       and archived_at is null
       and coalesce(do_not_call, false) = false
       and coalesce(phone_invalid, false) = false) as now_callable,
  (select count(*) from leads
     where qualification_failure_reason is not null) as rejected_on_their_own_merits,
  (select count(*) from leads where status <> 'new') as already_in_play;
