-- Leads live on the sales board. Run after 0003_enrichment.sql.

alter table leads
  add column stage text not null default 'New Lead';

create index leads_stage_idx on leads(stage);

-- Any lead that's already been called starts at Contact Attempted.
update leads set stage = 'Contact Attempted' where status = 'called';
update leads set stage = 'Closed Lost' where do_not_call = true;
