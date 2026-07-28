-- Fix leads that were called but never marked as such.
--
-- Logging a call set leads.status to 'called' but left machine_status at
-- 'assigned_to_packet', because nothing ever wrote 'contacted'. Two things
-- went wrong as a result:
--
--   * "Called" read zero on every dashboard, forever.
--   * "With your callers" counted people who had already been rung.
--
-- The code now sets it at the moment the outcome is saved. This repairs the
-- history that was written before that.
--
-- Safe to run more than once.

-- Anything with a call logged against it has, by definition, been contacted.
update leads l
set machine_status = 'contacted'
where l.machine_status = 'assigned_to_packet'
  and exists (select 1 from calls c where c.lead_id = l.id);

-- Belt and braces: a lead marked called by the older code path, even if its
-- call row was later detached from a deleted packet.
update leads
set machine_status = 'contacted'
where status = 'called'
  and machine_status = 'assigned_to_packet';

-- The reverse case: a lead sitting in an open packet that nobody has dialed
-- must not be left looking free to hand out to a second caller.
update leads l
set machine_status = 'assigned_to_packet'
where l.machine_status = 'ready_for_calling'
  and exists (
    select 1
    from packet_leads pl
    join packets p on p.id = pl.packet_id
    where pl.lead_id = l.id
      and pl.status = 'pending'
      and p.status = 'open'
  );

-- And leads flagged as held that are in no packet at all are genuinely free.
update leads l
set status = 'new', machine_status = 'ready_for_calling'
where l.machine_status = 'assigned_to_packet'
  and l.do_not_call = false
  and l.archived_at is null
  and not exists (select 1 from calls c where c.lead_id = l.id)
  and not exists (select 1 from packet_leads pl where pl.lead_id = l.id);
