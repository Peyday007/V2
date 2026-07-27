-- Target callable leads, not saved businesses.
--
-- The engine stopped searching the moment it had SAVED the number of
-- businesses you asked for. But saving is not the finish line: roughly half of
-- what Google returns is then discarded — too big to be owner-operated, no
-- phone number we can dial, permanently closed. Asking for 100 produced about
-- 40 callable leads, and the operator had to learn to ask for double.
--
-- Safe to run more than once.

-- Why the campaign stopped, in plain language, so "completed" is never
-- mistaken for "got what you asked for".
alter table sourcing_campaigns add column if not exists completion_reason text;

-- Leads that actually came out callable. Kept alongside unique_saved so the
-- gap between the two is visible rather than inferred.
alter table sourcing_campaigns add column if not exists callable_leads integer;

-- Back-fill from the leads themselves, so existing campaigns report honestly
-- instead of showing a blank where the real number should be.
update sourcing_campaigns c
set callable_leads = (
  select count(*)
  from leads l
  where l.sourcing_campaign_id = c.id
    and l.machine_status in ('ready_for_calling', 'assigned_to_packet', 'contacted')
)
where callable_leads is null;

update sourcing_campaigns
set completion_reason = 'finished before callable-lead targeting existed'
where status = 'completed'
  and completion_reason is null;

create index if not exists leads_sourcing_campaign_status_idx
  on leads(sourcing_campaign_id, machine_status);
