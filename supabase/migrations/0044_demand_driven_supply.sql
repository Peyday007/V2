-- ---------------------------------------------------------------------------
-- 0044 — Supply driven by demand, not by numbers typed in by hand.
--
-- WHAT WENT WRONG. Ten inboxes could carry 850–1,000 emails a day. Twenty-two
-- went out in 24 hours, with 29 qualified contacts sitting unpushed. Every
-- switch was on and every panel was telling the truth. Three separate faults
-- produced it, and this migration supports the fix for all three.
--
--   1. A lead that finished its sequence counted as occupying a campaign slot
--      FOREVER — there is no "completed" status because Instantly never sends
--      one. Once the number of leads ever emailed passed the target of 200,
--      the top-up saw a full campaign and pushed nothing, permanently. Fixed
--      in code by ageing threads out past the sequence span; no schema needed.
--
--   2. Sourcing was gated behind "is anything awaiting enrichment", and leads
--      that can never be enriched held that above zero forever. `enrich_attempts`
--      below is what lets the system give up on a lead and buy a replacement
--      instead of re-crawling the same dead website every day.
--
--   3. The campaign target, the daily cap and the reserve were flat numbers
--      unrelated to what the inboxes could carry. `reserve_days` below
--      replaces them with a policy — how many SENDING DAYS of qualified
--      contacts to keep in hand — and the actual counts are computed from
--      real capacity every tick.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH: email_threads. Not one row is
-- updated, deleted or restatused. Everything already sent stays exactly as it
-- is; "finished its sequence" is worked out from created_at at read time
-- rather than written into history.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Enrichment can give up.
-- ---------------------------------------------------------------------------
alter table leads add column if not exists enrich_attempts integer not null default 0;

comment on column leads.enrich_attempts is
  'How many times enrichment has been run against this lead. At 3 the lead stops '
  'being counted as outstanding work so the funnel sources a replacement instead '
  'of re-crawling a site that will never name a human. The lead stays callable.';

-- Leads enriched before this column existed have been tried at least once, and
-- usually many times. Seeding them at 1 rather than 0 means the backlog does
-- not get three more full passes before the system is allowed to move on,
-- while still leaving room for two genuine retries.
update leads
set enrich_attempts = 1
where enrich_attempts = 0
  and (
    coalesce(website_email, '') <> ''
    or coalesce(direct_email, '') <> ''
    or coalesce(owner_name, '') <> ''
    or (diagnostic_findings is not null and jsonb_array_length(to_jsonb(diagnostic_findings)) > 0)
  );

-- The funnel counts still-workable leads on every hourly check.
create index if not exists leads_enrich_attempts_idx
  on leads (enrich_attempts)
  where archived_at is null;

-- Incremented from the enrichment job. A function rather than a read-then-write
-- from the application because two workers can enrich two leads at the same
-- moment, and `set x = <value we read a second ago> + 1` loses one of them.
-- Here the increment happens inside the row lock, so concurrent ticks cannot
-- undercount attempts and let a hopeless lead retry forever.
create or replace function increment_enrich_attempts(p_lead_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update leads
  set enrich_attempts = coalesce(enrich_attempts, 0) + 1
  where id = p_lead_id;
$$;

grant execute on function increment_enrich_attempts(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. The reserve, stated as days rather than as a count.
--
-- A count goes stale the moment an inbox is added. "Three sending days of
-- qualified contacts in hand" stays correct at any capacity, and is the
-- number a person can actually reason about.
-- ---------------------------------------------------------------------------
alter table instantly_settings
  add column if not exists reserve_days integer not null default 3;

alter table instantly_settings
  add column if not exists auto_scale_supply boolean not null default true;

comment on column instantly_settings.reserve_days is
  'Sending days of qualified contacts to keep banked ahead of demand. The '
  'campaign target, daily intake and sourcing volume are all derived from this '
  'and from measured capacity — none of them is set by hand any more.';

comment on column instantly_settings.auto_scale_supply is
  'When true the campaign target and daily intake are computed from real '
  'Instantly capacity and the sequence length. False pins them to the stored '
  'target_active_leads / daily_push_cap, which is the old behaviour and the '
  'reason the campaign stalled at 200.';

-- ---------------------------------------------------------------------------
-- 3. What recent sourcing actually yielded.
--
-- Sourcing volume is scaled by the measured share of sourced businesses that
-- become a personal address with a name on it. Guessing that ratio once and
-- never checking is how the reserve stayed empty however often sourcing ran.
-- ---------------------------------------------------------------------------
alter table funnel_settings
  add column if not exists last_yield_measured numeric;

alter table funnel_settings
  add column if not exists last_yield_sample integer;

comment on column funnel_settings.last_yield_measured is
  'Share of recently sourced leads that became qualified contacts, 0-1. Null '
  'until there is a large enough sample to believe.';

-- ---------------------------------------------------------------------------
-- Did it work?
--
-- First query: reserve_days = 3, auto_scale_supply = true.
--
-- Second: the supply picture in one row. `qualified` is what can be emailed
-- today. `still_workable` is what enrichment might still turn into a contact.
-- `given_up` is the backlog that was silently blocking sourcing — expect it to
-- be large, and that is the point: those leads are no longer counted as work
-- outstanding, so the funnel is free to source replacements.
-- ---------------------------------------------------------------------------
select reserve_days, auto_scale_supply, target_active_leads, daily_push_cap
from instantly_settings;

select
  count(*) filter (
    where coalesce(direct_email, owner_email, website_email) !~* '^(info|contact|contactus|hello|hi|office|admin|sales|service|services|support|enquiries|inquiries|inquiry|enquiry|bookings|booking|schedule|scheduling|dispatch|team|help|accounts|accounting|billing|estimates|quotes|quote|jobs|careers|hr|mail|email|general|reception|frontdesk|front|main|orders|order|marketing|webmaster|postmaster|noreply|donotreply|newbusiness|feedback|customerservice|customercare|customersupport|custserv|custcare|clientcare|clientservices|clientservice|care)@'
      and coalesce(nullif(trim(decision_maker_name), ''), nullif(trim(owner_name), '')) is not null
  )                                                              as qualified,
  count(*) filter (
    where enrich_attempts < 3
      and coalesce(website, '') <> ''
      and (
        coalesce(direct_email, owner_email, website_email) is null
        or coalesce(nullif(trim(decision_maker_name), ''), nullif(trim(owner_name), '')) is null
      )
  )                                                              as still_workable,
  count(*) filter (where enrich_attempts >= 3)                   as given_up,
  count(*)                                                       as leads_total
from leads
where archived_at is null
  and coalesce(do_not_call, false) = false;
