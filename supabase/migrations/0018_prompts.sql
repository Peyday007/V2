-- Editable AI prompts.
--
-- The wording the models are given lives in code as a default. This table holds
-- an override per prompt, so the wording can be tweaked from the admin console
-- without a deploy. An empty table means every prompt is running its shipped
-- default, which is the normal state.
--
-- Safe to run more than once.

create table if not exists prompts (
  -- Matches a key in src/lib/prompts.ts. Unknown keys are ignored, so a
  -- renamed prompt falls back to its default rather than breaking.
  key text primary key,
  template text not null,
  note text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table prompts enable row level security;
drop policy if exists prompts_anon_all on prompts;
create policy prompts_anon_all on prompts
  for all to anon, authenticated using (true) with check (true);
