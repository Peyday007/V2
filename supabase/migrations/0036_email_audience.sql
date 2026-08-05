-- ---------------------------------------------------------------------------
-- 0036 — Record WHO each email was aimed at, not just where the address came
-- from.
--
-- The question that could not be answered: of the addresses about to be
-- emailed, how many reach a person and how many reach a reception desk? The
-- list said "120 leads have an address", which reads as healthy whether those
-- are 120 owners or 120 front desks — and those are completely different
-- programmes with completely different reply rates.
--
-- email_threads recorded the address and nothing about it. So after a send,
-- "did personal addresses reply more than generic ones" was unanswerable too,
-- and that is the one measurement that decides whether paying a contact
-- provider is worth it.
--
-- Two columns, written at push time from the same chooseEmail() decision that
-- picked the address, so the record cannot disagree with what was actually
-- sent.
--
-- Nothing here changes who gets emailed. The waterfall lives in
-- src/lib/emailEligibility.ts; this only writes down what it decided.
-- ---------------------------------------------------------------------------

-- Which column the address came out of: direct_email | owner_email |
-- website_email. Deliberately not constrained to a list — see 0034, where
-- exactly that pattern threw away real work when the code grew a fourth value
-- and the constraint did not.
alter table email_threads add column if not exists email_source text;

-- Who it reaches: decision_maker | personal | generic.
--
-- Read off the ADDRESS, not off the column. A contact provider that returns
-- info@ has not found a decision-maker, and recording it as one because of
-- where it arrived from is how the measurement lies to you.
alter table email_threads add column if not exists email_audience text;

create index if not exists email_threads_audience_idx
  on email_threads(email_audience, status)
  where email_audience is not null;

-- ---------------------------------------------------------------------------
-- Did it work?
--
-- Both columns should appear. Existing rows keep null: they were pushed before
-- this existed and backfilling them would mean re-deriving an audience from an
-- address whose classification may since have changed — a guess written down
-- as a fact. Null honestly means "pushed before we recorded this".
-- ---------------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'email_threads'
      and column_name in ('email_source', 'email_audience')) as new_columns,
  (select count(*) from email_threads) as threads_total,
  (select count(*) from email_threads where email_audience is not null) as threads_classified;

-- ---------------------------------------------------------------------------
-- THE NUMBER THIS WAS BUILT FOR — run it before sending anything.
--
-- How many of the leads you could email today reach a person, and how many
-- reach a front desk. This reads the leads table directly, so it works before
-- a single push has happened.
-- ---------------------------------------------------------------------------
select
  case
    when direct_email is not null and direct_email <> '' then 'decision maker (provider)'
    when website_email_kind = 'personal' then 'personal (published on their site)'
    when owner_email is not null and owner_email <> '' then 'personal (owner recorded)'
    when website_email is not null and website_email <> '' then 'generic (info@ / office@)'
    else 'no address'
  end as reaches,
  count(*)
from leads
where coalesce(do_not_call, false) = false
  and archived_at is null
group by 1
order by 2 desc;
