-- Do-not-call enforcement.
--
-- 0011 created the suppressions table but nothing ever read it, so a DNC
-- recorded against one lead left every duplicate record for the same business
-- dialable. This migration makes the list durable and back-fills the leads it
-- should already have been protecting.
--
-- Safe to run more than once.
--
-- NOTE ON QUOTING: named dollar-quote tags and no regex literals, because
-- some SQL editors mis-split on bare dollar quotes and report
-- "syntax error at end of input".

-- ---------------------------------------------------------------------------
-- 1. A suppression must outlive the lead it came from.
--
--    The original foreign key cascaded on delete: removing a lead silently
--    deleted the do-not-call record with it, which is exactly backwards for
--    a compliance list.
-- ---------------------------------------------------------------------------
alter table suppressions drop constraint if exists suppressions_lead_id_fkey;
alter table suppressions
  add constraint suppressions_lead_id_fkey
  foreign key (lead_id) references leads(id) on delete set null;

-- Where the request came from, so a number added by hand is distinguishable
-- from one a caller recorded on a live call.
alter table suppressions add column if not exists source text;
update suppressions set source = 'call' where source is null;
alter table suppressions alter column source set default 'call';

-- ---------------------------------------------------------------------------
-- 2. One row per number. Re-recording a DNC must not create a second entry.
-- ---------------------------------------------------------------------------
delete from suppressions s
using suppressions keep
where s.normalized_phone is not null
  and s.normalized_phone = keep.normalized_phone
  and s.created_at > keep.created_at;

create unique index if not exists suppressions_phone_unique
  on suppressions(normalized_phone)
  where normalized_phone is not null;

-- ---------------------------------------------------------------------------
-- 3. Back-fill: any lead sharing a suppressed number is suppressed too.
--
--    This is the bug being fixed. Until now only the single record a caller
--    happened to be looking at was flagged.
-- ---------------------------------------------------------------------------
update leads l
set do_not_call = true
from suppressions s
where s.normalized_phone is not null
  and l.normalized_phone = s.normalized_phone
  and l.do_not_call = false;

-- A suppression recorded directly against a lead must flag that lead even if
-- its phone number was never normalized.
update leads l
set do_not_call = true
from suppressions s
where s.lead_id = l.id
  and l.do_not_call = false;

-- Pull every newly suppressed lead out of the packets it is sitting in, so no
-- caller is handed one tomorrow morning.
update packet_leads pl
set status = 'done'
from leads l
where pl.lead_id = l.id
  and l.do_not_call = true
  and pl.status = 'pending';

-- ---------------------------------------------------------------------------
-- 4. Lookups used on every packet build and every lead served to a caller.
-- ---------------------------------------------------------------------------
create index if not exists suppressions_lead_idx on suppressions(lead_id);
create index if not exists leads_dnc_idx on leads(do_not_call);
