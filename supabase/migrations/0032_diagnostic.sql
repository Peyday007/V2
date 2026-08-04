-- ---------------------------------------------------------------------------
-- 0032 — Somewhere to put a real diagnosis, and a size for the business.
--
-- The problem: every packet said the same thing. "You are missing calls."
-- True of everyone, provable about nobody, and it gave a caller exactly one
-- thing to talk about — so a business ranking twentieth in the map pack with
-- no mobile site heard the identical opening to one ranking second with a
-- booking widget.
--
-- The reason it said the same thing is that the same thing was all the record
-- could support. A lead carried a rating, a review count and "has a website:
-- yes/no". Nothing else was ever collected, so nothing else could be claimed.
--
-- This adds the columns for what the crawl can actually see, plus where the
-- business came in its own map results, plus an internal size estimate.
--
-- ON THAT LAST ONE. `affordability_*` is INTERNAL. It is inferred from public
-- signals — review volume, whether they rank, whether somebody was paid to
-- build their site — and it is not revenue. It exists so a three-van outfit
-- and a regional company stop getting quoted the same number. It must never
-- appear on the owner's page, in an email or in a text: telling a business
-- what you think it earns is at best strange and converts nothing.
--
-- The tri-state columns below are boolean and NULLABLE on purpose, and the
-- distinction carries the whole honesty rule of the diagnostic: true means we
-- saw it, false means we looked and it is not there, NULL means we could not
-- tell. A booking widget injected by JavaScript never reaches our crawler, so
-- "no booking found" is null — and no claim is ever built from a null.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. What the crawl saw on their website.
-- ---------------------------------------------------------------------------
alter table leads add column if not exists site_https boolean;
alter table leads add column if not exists site_mobile_viewport boolean;
alter table leads add column if not exists site_contact_form boolean;
alter table leads add column if not exists site_online_booking boolean;
alter table leads add column if not exists site_click_to_call boolean;
alter table leads add column if not exists site_local_schema boolean;
alter table leads add column if not exists site_published_hours boolean;
alter table leads add column if not exists site_claims_emergency boolean;
alter table leads add column if not exists site_shows_reviews boolean;
alter table leads add column if not exists site_has_title boolean;
alter table leads add column if not exists site_has_meta_description boolean;
alter table leads add column if not exists site_copyright_year integer;
alter table leads add column if not exists site_landing_bytes integer;

-- Booking or field-service tools spotted in the markup. Knowing they already
-- pay for Housecall Pro changes what is worth selling them.
alter table leads add column if not exists site_tools text[] not null default array[]::text[];

alter table leads add column if not exists site_scanned_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Where they came in their own map results.
--
--    Captured at source: the Places search returns businesses in rank order
--    for "<trade> in <city>", so the position in that response IS their map
--    position for the query their customers actually type. Recorded with the
--    query and the result count, because a rank with no denominator is not a
--    fact.
-- ---------------------------------------------------------------------------
alter table leads add column if not exists map_rank integer;
alter table leads add column if not exists map_result_count integer;
alter table leads add column if not exists map_rank_query text;
alter table leads add column if not exists map_rank_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. The diagnosis itself, cached.
--
--    Recomputed from the columns above whenever they change, and stored so the
--    dialer and the packet page do not each redo it — and, more importantly,
--    so the caller and the owner are looking at the same findings.
-- ---------------------------------------------------------------------------

-- [{key, service, weight, headline, detail, basis, talkTrack}]
alter table leads add column if not exists diagnostic_findings jsonb
  not null default '[]'::jsonb;

-- The single strongest line, denormalised because script C and the email
-- personalization both want exactly this and nothing else.
alter table leads add column if not exists diagnostic_hook text;

-- How many genuinely different things we could sell them. The brief was two
-- to four; this is how "we only found one" becomes visible instead of silent.
alter table leads add column if not exists diagnostic_angles integer;

alter table leads add column if not exists diagnostic_at timestamptz;

create index if not exists leads_diagnostic_angles_idx
  on leads(diagnostic_angles desc nulls last);

-- ---------------------------------------------------------------------------
-- 4. How big they are. INTERNAL — see the header.
-- ---------------------------------------------------------------------------

-- solo | small | established | regional
alter table leads add column if not exists affordability_band text;
alter table leads add column if not exists affordability_monthly_low integer;
alter table leads add column if not exists affordability_monthly_high integer;
alter table leads add column if not exists affordability_one_off_ceiling integer;
alter table leads add column if not exists affordability_confidence numeric;
-- Every signal that moved it, so a caller can sanity-check the estimate
-- instead of trusting it.
alter table leads add column if not exists affordability_signals text[];

-- ---------------------------------------------------------------------------
-- 5. Which opener the lead was assigned, and whether the caller ran a
--    different one.
--
--    The assignment itself is derived from the lead id and needs no column —
--    but recording what was ACTUALLY run, and whether it differed, is what
--    lets the comparison exclude the overrides rather than quietly absorb them.
-- ---------------------------------------------------------------------------
alter table calls add column if not exists script_assigned text;
alter table calls add column if not exists script_overridden boolean not null default false;

-- ---------------------------------------------------------------------------
-- 6. Did it land?
-- ---------------------------------------------------------------------------
select
  '0032 applied' as migration,
  (select count(*) from information_schema.columns
     where table_name = 'leads' and column_name like 'site\_%') as site_columns,
  (select count(*) from information_schema.columns
     where table_name = 'leads' and column_name like 'diagnostic\_%') as diagnostic_columns,
  (select count(*) from information_schema.columns
     where table_name = 'leads' and column_name like 'affordability\_%') as affordability_columns,
  (select count(*) from information_schema.columns
     where table_name = 'leads' and column_name like 'map\_%') as map_columns;
