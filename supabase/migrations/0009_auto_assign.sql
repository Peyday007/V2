-- Campaigns can hand finished leads straight to callers with no manual step.
-- Safe to run more than once.

alter table sourcing_campaigns
  add column if not exists auto_assign_packets boolean not null default true;
alter table sourcing_campaigns
  add column if not exists packet_size integer not null default 50;
alter table sourcing_campaigns
  add column if not exists packets_created integer not null default 0;
