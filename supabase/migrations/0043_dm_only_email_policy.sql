-- ---------------------------------------------------------------------------
-- 0043 — Decision-maker only, permanently.
--
-- WHAT WENT WRONG. Two settings governed who could be emailed:
-- `named_people_only` (0038) refused general inboxes, and
-- `require_named_person` (0042) refused a personal address with nobody named
-- behind it. Both shipped FALSE by default, on the reasoning that refusing
-- general inboxes refuses most of a typical list and should therefore be an
-- administrator's decision.
--
-- The consequence was the shipped behaviour: push anything with an address. A
-- campaign filled with info@, office@ and customercare@, addressed to nobody,
-- opening "Hi," because no name was on record. The switches existed, sat off,
-- and nobody had a reason to find them.
--
-- The rule is now enforced in emailPush.pushEligibleLeads and
-- emailPush.countEligible unconditionally, and the settings API refuses to
-- store `false` for either column. THIS MIGRATION IS THEREFORE NOT WHAT MAKES
-- THE RULE WORK — the code does that, and it is already true of every push
-- whether or not this has been run. What this does is stop the stored row
-- contradicting the behaviour, and make the default correct for any row
-- created later.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH: email_threads. Everything already
-- pushed stays exactly as it is. Those sends happened, the replies to them are
-- real, and rewriting history to match a rule adopted afterwards would destroy
-- the record of what was actually sent to whom.
-- ---------------------------------------------------------------------------

-- The live row, which on any deployment older than today holds false/false.
update instantly_settings
set named_people_only   = true,
    require_named_person = true,
    updated_at          = now()
where id = true;

-- And the default, so a row created later starts correct rather than starting
-- permissive and relying on the update above having been run.
alter table instantly_settings
  alter column named_people_only set default true;

alter table instantly_settings
  alter column require_named_person set default true;

-- ---------------------------------------------------------------------------
-- Did it work?
--
-- The first query should return true, true. The second is the cost of the
-- rule, stated plainly: how many contacts actually meet it versus how many
-- have an address of any kind. The gap is not a bug — it is the general
-- inboxes and the unnamed contacts that are no longer emailed, and the number
-- to move is the first one, by enriching.
-- ---------------------------------------------------------------------------
select named_people_only, require_named_person from instantly_settings;

select
  count(*) filter (
    where coalesce(direct_email, owner_email, website_email) !~* '^(info|contact|contactus|hello|hi|office|admin|sales|service|services|support|enquiries|inquiries|inquiry|enquiry|bookings|booking|schedule|scheduling|dispatch|team|help|accounts|accounting|billing|estimates|quotes|quote|jobs|careers|hr|mail|email|general|reception|frontdesk|front|main|orders|order|marketing|webmaster|postmaster|noreply|donotreply|newbusiness|feedback|customerservice|customercare|customersupport|custserv|custcare|clientcare|clientservices|clientservice|care)@'
      and coalesce(nullif(trim(decision_maker_name), ''), nullif(trim(owner_name), '')) is not null
  ) as meets_the_rule,
  count(*) filter (where coalesce(direct_email, owner_email, website_email) is not null)
                                                                as has_any_address,
  count(*)                                                       as leads_total
from leads
where archived_at is null
  and coalesce(do_not_call, false) = false;
