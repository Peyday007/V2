-- ---------------------------------------------------------------------------
-- 0024 — Workshop packets, and the gatekeeper script test.
--
-- Two unrelated things ship together because they are two halves of the same
-- experiment: does a different opener get more owners on the phone, and does a
-- link sent mid-call turn those conversations into trials.
--
-- NAMING: the table is `workshop_packets`, NOT `packets`.
--
--   `packets` already exists and means something completely different — a batch
--   of leads handed to a caller for a shift. Reusing the name would have
--   collided with packet_leads, every packet query, and the caller's queue. The
--   name here matches the public URL the owner receives, /workshop/<token>.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The packet: one personalised page per business, reachable by token.
-- ---------------------------------------------------------------------------
create table if not exists workshop_packets (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,

  -- The whole security model of the public page. Long, random, and unguessable
  -- because there is no login on the other side of it. Generated in the app
  -- with crypto.randomBytes, never by the client.
  token text not null unique,

  -- not_sent | sent | opened | trial_requested
  --
  -- Deliberately a text column with a check rather than a Postgres enum:
  -- adding a value to an enum needs a migration and a deploy, and this list
  -- will change while the experiment runs.
  status text not null default 'not_sent'
    check (status in ('not_sent', 'sent', 'opened', 'trial_requested')),

  -- text | email | both. Only 'text' is wired today (Twilio); email has no
  -- provider yet, and the column exists so adding one needs no migration.
  delivery_method text check (delivery_method in ('text', 'email', 'both')),

  -- Captured at send time when the lead record does not already carry them.
  -- Never written back over the lead's own fields — a value typed into a send
  -- form is not evidence about the business.
  owner_name text,
  owner_phone text,
  owner_email text,

  -- Who sent it, so the board can say which VA to ask about it.
  sent_by_caller_id uuid references callers(id) on delete set null,
  sent_by_name text,

  -- What the owner confirmed on the form. No identity verification: this is a
  -- checkbox on a public page, and the value of it is that a human follows up,
  -- not that it is legally binding.
  agreed_name text,
  agreed_phone text,
  agreed_email text,
  agreed_text text,

  -- Set when a person has picked the trial request up. Nothing automates past
  -- this point by design.
  acknowledged_at timestamptz,
  acknowledged_note text,

  -- The provider's own id for the message, so a delivery question can be
  -- traced without guessing.
  last_send_error text,
  provider_message_id text,

  created_at timestamptz not null default now(),
  sent_at timestamptz,
  opened_at timestamptz,
  trial_requested_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists workshop_packets_lead_idx on workshop_packets(lead_id);
create index if not exists workshop_packets_status_idx
  on workshop_packets(status, trial_requested_at desc);

-- One live packet per lead. A second "Send" reuses the row and the token, so
-- an owner who was texted twice does not end up with two different links and
-- two different statuses.
create unique index if not exists workshop_packets_one_per_lead
  on workshop_packets(lead_id);

-- ---------------------------------------------------------------------------
-- 2. Which gatekeeper script the caller was running.
--
--    Nullable on purpose. Calls made outside the test, and every call already
--    in the table, have no version — and treating those as a fourth variant
--    would quietly poison the comparison.
-- ---------------------------------------------------------------------------
alter table calls add column if not exists script_version text
  check (script_version in ('A', 'B', 'C'));

create index if not exists calls_script_version_idx
  on calls(script_version, created_at desc)
  where script_version is not null;

-- ---------------------------------------------------------------------------
-- 3. RLS, matching the rest of the schema.
--
--    The public /workshop page does NOT read through this policy — it goes via
--    the service-role key on the server, which is what keeps token lookup off
--    the browser.
-- ---------------------------------------------------------------------------
alter table workshop_packets enable row level security;
drop policy if exists workshop_packets_anon_all on workshop_packets;
create policy workshop_packets_anon_all on workshop_packets
  for all to anon, authenticated using (true) with check (true);
