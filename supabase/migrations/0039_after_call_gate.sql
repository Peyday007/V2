-- ---------------------------------------------------------------------------
-- 0039 — The after-call gate, switchable by the owner.
--
-- The gate stops a caller from opening a new lead while the last one has no
-- usable record. It is enforced server-side in /api/dial/next: no lead is
-- returned at all, so refreshing, a second tab, a stale client or a direct API
-- call cannot walk past it.
--
-- WHY THE DEFAULT IS ON: the failure it prevents is a whole shift of calls
-- recording nothing, which cannot be repaired afterwards — the conversations
-- are gone. A safety control that ships off protects nobody.
--
-- WHY THERE IS A SWITCH AT ALL: a caller in training, a demo, or a genuine
-- emergency where paperwork must wait. Turning it off is an owner's decision
-- and is recorded like any other setting change.
--
-- NOTE ON AN ABSENT COLUMN: loadGate() treats a missing column as ON rather
-- than OFF. An unrun migration must never silently disable a safety control —
-- that is the failure mode where everybody believes they are protected and
-- nobody is.
-- ---------------------------------------------------------------------------

alter table call_intelligence_settings
  add column if not exists after_call_gate_enabled boolean not null default true;

-- Every block the gate applies is written to `events` as call.gate_blocked,
-- and every save it could not complete as call.save_failed. Both are indexed
-- through the existing events indexes; this one makes "show me every time the
-- gate stopped somebody today" cheap.
create index if not exists events_gate_idx
  on events(event_type, occurred_at desc)
  where event_type in ('call.gate_blocked', 'call.save_failed');

-- ---------------------------------------------------------------------------
-- Did it work?
--
-- `after_call_gate_enabled` should be true. The second query is empty until
-- the gate actually stops somebody — which, if the team is recording their
-- calls properly, it never will.
-- ---------------------------------------------------------------------------
select after_call_gate_enabled from call_intelligence_settings;

select event_type, count(*), max(occurred_at) as most_recent
from events
where event_type in ('call.gate_blocked', 'call.save_failed')
group by 1;
