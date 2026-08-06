-- ---------------------------------------------------------------------------
-- 0038 — Let an administrator refuse general inboxes.
--
-- WHAT WENT WRONG: a campaign filled up with repair@, sales@, contact@,
-- office@ and service@ while named people sat unpushed behind them, and the
-- CONTACT column in Instantly was empty for nearly every row.
--
-- The ordering half of that is a code fix and needs no setting — the push now
-- sends decision-makers first, then named people, then general inboxes, where
-- before it sent whatever order the database happened to return.
--
-- This column is the other half: refusing general inboxes ENTIRELY.
--
-- It is off by default and must stay off by default. Most one-van operations
-- publish only info@, so switching this on refuses the majority of a typical
-- list — that is a decision about who the business talks to, not a technical
-- default, and it belongs to a person.
-- ---------------------------------------------------------------------------

alter table instantly_settings
  add column if not exists named_people_only boolean not null default false;

-- ---------------------------------------------------------------------------
-- Did it work?
--
-- `named_people_only` should be false. If you switch it on, the second query
-- tells you what it would cost before you find out the hard way.
-- ---------------------------------------------------------------------------
select named_people_only from instantly_settings;

select
  count(*) filter (where direct_email is not null and direct_email <> '')      as decision_makers,
  count(*) filter (where website_email_kind = 'personal')                       as named_people,
  count(*) filter (
    where website_email is not null and website_email <> ''
      and coalesce(website_email_kind, '') <> 'personal'
  )                                                                            as general_inboxes
from leads
where archived_at is null
  and coalesce(do_not_call, false) = false;
