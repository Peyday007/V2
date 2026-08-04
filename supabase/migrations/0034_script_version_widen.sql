-- ---------------------------------------------------------------------------
-- 0034 — Let the gatekeeper test have more than three variants.
--
-- THE BUG THIS FIXES, because it cost real calls:
--
-- 0024 added `script_version` with `check (script_version in ('A','B','C'))`.
-- That was right at the time — the test had three openers. Then the brief was
-- "test as many as you see fit, don't anchor it down to just three", and
-- src/lib/gatekeeperScripts.ts grew to seven (A through G). The constraint did
-- not grow with it.
--
-- So assignment handed roughly four callers in seven a variant the database
-- refuses. When they pressed Save, the INSERT into `calls` was rejected
-- WHOLESALE — not the tagging, the whole call. Outcome, notes, next step,
-- duration, everything the caller had just typed, gone behind an alert box
-- reading `violates check constraint "calls_script_version_check"`. A field
-- that exists only to compare openers was destroying the record of the work.
--
-- WHY A SHAPE RATHER THAN A LONGER LIST:
--
-- Re-listing A..G fixes today and rebuilds the same trap for whoever adds H.
-- The enumeration was never the useful part of this constraint — nothing about
-- 'C' being valid and 'H' not is a fact about the database, it is a fact about
-- a TypeScript array that changes whenever somebody has a better opener idea.
-- What the column actually needs to guarantee is that it holds a variant tag
-- and not a paragraph of notes.
--
-- So: null, or one capital letter. Adding a variant is now a code change with
-- no migration behind it, which is what "don't make me hold its hand" means
-- here. The authority on which letters are LIVE stays in one place —
-- SCRIPT_VERSIONS in src/lib/gatekeeperScripts.ts — and the API still
-- validates against it before writing, so a stale letter cannot enter through
-- this widening. tests/schema.test.ts asserts the two cannot drift again.
--
-- Existing rows are unaffected: every value already stored is A, B or C, all
-- of which satisfy the new shape. Nothing is rewritten and nothing is dropped.
-- ---------------------------------------------------------------------------

alter table calls drop constraint if exists calls_script_version_check;

alter table calls add constraint calls_script_version_check
  check (script_version is null or script_version ~ '^[A-Z]$');

-- ---------------------------------------------------------------------------
-- Did it work?
--
-- The count is the reassuring part: it should equal the number of calls logged
-- before this ran. If tagged_calls is far below what the team remembers
-- making, that is the outage above — the rejected inserts were never rows, so
-- those calls are not in the table to be counted.
-- ---------------------------------------------------------------------------
select
  (select pg_get_constraintdef(oid)
     from pg_constraint
    where conname = 'calls_script_version_check') as new_constraint,
  (select count(*) from calls where script_version is not null) as tagged_calls,
  (select count(distinct script_version) from calls
    where script_version is not null) as variants_seen;
