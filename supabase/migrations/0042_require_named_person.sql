-- ---------------------------------------------------------------------------
-- 0042 — "I need them to be personal emails with their name attached."
--
-- Two conditions, and the existing setting only enforces one of them.
--
-- `named_people_only` (0038) refuses info@ and office@. It still allows
-- maria@rivera-plumbing.com with no name anywhere on the record — a personal
-- address, but one whose email opens "Hi," because there is nobody to greet.
--
-- This adds the second half: the lead must ALSO have a name we can use.
--
-- A SEPARATE COLUMN rather than a change of meaning to the first one. Somebody
-- ticked that box knowing what it did; quietly making it stricter would change
-- what is sent without anybody deciding to. Two switches, two numbers, two
-- decisions.
--
-- Off by default, like its neighbour, and for the same reason: turning it on
-- refuses leads, and how many it refuses depends entirely on how well
-- enrichment has done. The Email page shows the count before it is switched.
-- ---------------------------------------------------------------------------

alter table instantly_settings
  add column if not exists require_named_person boolean not null default false;

-- ---------------------------------------------------------------------------
-- Did it work?
--
-- The second query is what switching it on would cost, before switching it.
-- ---------------------------------------------------------------------------
select named_people_only, require_named_person from instantly_settings;

select
  count(*) filter (
    where coalesce(direct_email, owner_email, website_email) !~ '^(info|office|contact|admin|hello|sales|support|service|enquiries|inquiries|team)@'
      and coalesce(nullif(trim(decision_maker_name), ''), nullif(trim(owner_name), '')) is not null
  ) as personal_and_named,
  count(*) filter (
    where coalesce(direct_email, owner_email, website_email) !~ '^(info|office|contact|admin|hello|sales|support|service|enquiries|inquiries|team)@'
      and coalesce(nullif(trim(decision_maker_name), ''), nullif(trim(owner_name), '')) is null
  ) as personal_no_name,
  count(*) filter (
    where coalesce(direct_email, owner_email, website_email) ~ '^(info|office|contact|admin|hello|sales|support|service|enquiries|inquiries|team)@'
  ) as general_inbox
from leads
where archived_at is null
  and coalesce(do_not_call, false) = false
  and coalesce(direct_email, owner_email, website_email) is not null;
