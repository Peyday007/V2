-- ---------------------------------------------------------------------------
-- 0026 — A consent policy that skips two-party states entirely.
--
-- The existing options all RECORD everywhere and differ only in when they
-- announce. This adds one that does the opposite: record where a single
-- party's consent is enough, and do not record at all in the fourteen states
-- that need everyone to agree.
--
-- No announcement, ever. Callers never have to remember to say a line, and the
-- app can only ever record where the caller's own consent is sufficient. The
-- trade is no recordings from those fourteen states, and none where the
-- business has no state on file.
--
-- The column has a check constraint listing the permitted values, so the new
-- option has to be added here before the settings page can save it —
-- otherwise the save fails on a constraint violation rather than doing
-- nothing visible.
-- ---------------------------------------------------------------------------

alter table call_intelligence_settings
  drop constraint if exists cis_consent_policy_check;

alter table call_intelligence_settings
  add constraint cis_consent_policy_check
  check (consent_policy in ('all_party', 'one_party', 'per_state', 'one_party_only', 'disabled'));

-- ---------------------------------------------------------------------------
-- Did it land?
--
-- Run the whole file, then look for "0026 applied". If you do not see it, the
-- paste was cut short — scroll to the bottom and paste it again. Re-running is
-- safe.
-- ---------------------------------------------------------------------------
select
  '0026 applied' as migration,
  (select consent_policy from call_intelligence_settings limit 1) as current_policy,
  (select count(*) from pg_constraint where conname = 'cis_consent_policy_check') as constraint_present;
