-- Let the re-enrichment backfill run itself, the same way the email top-up
-- and the capacity sync already do: off by default, an explicit switch to
-- turn it on, and a note after every run so silence is never the only
-- signal that something is wrong.
--
-- Reuses enrichment_settings (0023) rather than a new table — this is a
-- setting about the SAME budget-gated enrichment pipeline, not a separate
-- system.

alter table enrichment_settings add column if not exists auto_reenrich_enabled boolean not null default false;
alter table enrichment_settings add column if not exists auto_reenrich_batch integer not null default 200;
alter table enrichment_settings add column if not exists last_reenrich_note text;
alter table enrichment_settings add column if not exists last_reenrich_at timestamptz;
alter table enrichment_settings add column if not exists last_reenrich_queued integer;

-- ---------------------------------------------------------------------------
-- Did it work?
-- ---------------------------------------------------------------------------
select auto_reenrich_enabled, auto_reenrich_batch, last_reenrich_note, last_reenrich_at, last_reenrich_queued
from enrichment_settings;
