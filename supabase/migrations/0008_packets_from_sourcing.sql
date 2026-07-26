-- Let caller packets be generated from sourcing campaigns.
-- Safe to run more than once.

alter table packets add column if not exists sourcing_campaign_id uuid;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'packets_sourcing_campaign_fk'
  ) then
    alter table packets add constraint packets_sourcing_campaign_fk
      foreign key (sourcing_campaign_id) references sourcing_campaigns(id);
  end if;
end $$;

-- A packet now belongs to EITHER an old campaign or a sourcing campaign,
-- so the original column can no longer be mandatory.
alter table packets alter column campaign_id drop not null;

create index if not exists packets_sourcing_campaign_idx
  on packets(sourcing_campaign_id);
