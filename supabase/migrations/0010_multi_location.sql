-- Campaigns can target many metros at once, not just one city.
-- Safe to run more than once.

alter table sourcing_campaigns add column if not exists locations text[];
