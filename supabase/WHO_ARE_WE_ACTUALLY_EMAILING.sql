-- ---------------------------------------------------------------------------
-- Is there a person's name on it, and is it a person's address?
--
-- Read-only. Two separate questions that get confused with each other:
--
--   A NAME is what makes the email open "Hi Maria," instead of "Hi,". It comes
--   from decision_maker_name or owner_name on the lead, and it is independent
--   of the address — a general inbox can still belong to a business whose
--   owner we have named.
--
--   A PERSONAL ADDRESS is maria@ rather than info@. That decides whether the
--   email lands with the person who can say yes, or with whoever answers the
--   front desk.
--
-- The app never refuses a general inbox unless "Only email named people" is
-- switched on, on the Email page. It orders named people FIRST, but it sends
-- to both. So the numbers below are the truth, not the intention.
-- ---------------------------------------------------------------------------

-- 1. THE HEADLINE. What is actually in the campaign right now.
select
  count(*)                                                         as pushed_total,
  count(*) filter (where t.email !~ '^(info|office|contact|admin|hello|sales|support|service|enquiries|inquiries|team|mail|book|bookings|dispatch|scheduling)@')
                                                                   as personal_address,
  count(*) filter (where t.email ~  '^(info|office|contact|admin|hello|sales|support|service|enquiries|inquiries|team|mail|book|bookings|dispatch|scheduling)@')
                                                                   as general_inbox,
  count(*) filter (where coalesce(nullif(trim(l.decision_maker_name), ''), nullif(trim(l.owner_name), '')) is not null)
                                                                   as has_a_name,
  count(*) filter (where coalesce(nullif(trim(l.decision_maker_name), ''), nullif(trim(l.owner_name), '')) is null)
                                                                   as no_name_at_all
from email_threads t
join leads l on l.id = t.lead_id
where t.status in ('pushed', 'sent', 'opened', 'replied');

-- 2. THE FOUR COMBINATIONS, which is the answer to the question as asked.
--
-- "personal address AND a name" is the only row that is unambiguously what you
-- want. Everything else is a compromise you are currently making.
select
  case
    when t.email ~ '^(info|office|contact|admin|hello|sales|support|service|enquiries|inquiries|team|mail|book|bookings|dispatch|scheduling)@'
      then 'general inbox'
    else 'personal address'
  end as address_kind,
  case
    when coalesce(nullif(trim(l.decision_maker_name), ''), nullif(trim(l.owner_name), '')) is not null
      then 'name known'
    else 'NO NAME — opens "Hi,"'
  end as name_known,
  count(*) as leads
from email_threads t
join leads l on l.id = t.lead_id
where t.status in ('pushed', 'sent', 'opened', 'replied')
group by 1, 2
order by 3 desc;

-- 3. WHAT SWITCHING "Only email named people" ON WOULD COST.
--
-- Run this before flipping it. It refuses general inboxes entirely, and for
-- most one-van operations a general inbox is the only address published.
select
  named_people_only as currently_on,
  (select count(*) from leads
     where archived_at is null
       and coalesce(do_not_call, false) = false
       and coalesce(direct_email, owner_email, website_email) is not null
       and coalesce(direct_email, owner_email, website_email) !~ '^(info|office|contact|admin|hello|sales|support|service|enquiries|inquiries|team)@'
  ) as would_still_be_sendable,
  (select count(*) from leads
     where archived_at is null
       and coalesce(do_not_call, false) = false
       and coalesce(direct_email, owner_email, website_email) is not null
  ) as sendable_today
from instantly_settings;

-- ---------------------------------------------------------------------------
-- Reading the result
--
-- If "no_name_at_all" is anything other than zero, that many prospects opened
-- an email that began "Hi," — or, before this was fixed, "Hey ,".
--
-- If "general inbox" is the larger group, the campaign is mostly reaching
-- front desks. That is not necessarily wrong for cold email, but it is a
-- different thing from what "each email gets a person's name attached" means,
-- and the reply rate should be read with it in mind.
--
-- The lever for both is enrichment, not the push: an address and a name are
-- found before a lead is ever pushed, and no setting here can invent either.
-- ---------------------------------------------------------------------------
