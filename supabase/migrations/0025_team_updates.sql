-- ---------------------------------------------------------------------------
-- 0025 — Team updates.
--
-- One place to say a thing once, instead of texting five VAs the same
-- paragraph and discovering a week later that two of them never got it.
--
-- Two tables: the updates themselves, and how far each caller has read. The
-- read marker is deliberately one row per caller holding a timestamp rather
-- than a row per caller per update — the question being asked is only "is
-- there anything new since you last looked", and a join table would be a lot
-- of rows to answer that.
-- ---------------------------------------------------------------------------

create table if not exists updates (
  id uuid primary key default gen_random_uuid(),

  title text not null,
  -- Markdown, rendered by src/lib/updates.ts. Stored as written so it can be
  -- edited later without a lossy round trip through HTML.
  body text not null,

  -- Pinned updates sort above everything, however old they are. The process
  -- change everybody needs on day one should not sink under a fortnight of
  -- smaller notes.
  pinned boolean not null default false,

  -- Retired rather than deleted. A caller who asks "what did that update say
  -- again" three weeks later should still be able to find it, and deleting the
  -- row would also silently change what counts as unread.
  archived_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists updates_feed_idx
  on updates (pinned desc, created_at desc)
  where archived_at is null;

-- ---------------------------------------------------------------------------
-- How far each caller has read.
--
-- Not proof of reading, and not meant to be — it exists so the badge stops
-- nagging somebody who has already opened the panel, nothing more.
-- ---------------------------------------------------------------------------
create table if not exists caller_update_reads (
  caller_id uuid primary key references callers(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- The first update. Dollar-quoted so the apostrophes and quotation marks in
-- the script lines survive verbatim.
--
-- Fixed id so re-running this file cannot post it twice.
-- ---------------------------------------------------------------------------
insert into updates (id, title, body, pinned, created_at)
values (
  '00000000-0000-4000-8000-000000000001',
  'New process — free trial close + packets (read before your next shift)',
  $body$**What changed:** we're no longer booking a 15-minute meeting at the end of the call. Instead, we offer a free trial on the spot and text them a link.

Steps 1-3 stay exactly the same — pain-only, no mention of "AI" or naming the product. Just missed calls, cost, and how they currently handle it. Do not mention what we actually do until step 4.

**Step 4 (new close):** "Let me start it on your line right now — no cost, no commitment. Any call you miss today gets forwarded to you by text instead of going to voicemail. Sound fair?"

**Step 5 (new close):** "Perfect. What's the best cell to text the setup confirmation to?"

**What happens next:** once they give you their number, hit "Send Packet" on their lead — this automatically texts them a link. You don't need to type or send anything yourself, just click the button after step 5.

**What's in the packet** (for your own understanding, you don't need to walk them through it live):

- Their business name and a couple of specific gaps we found (like missed-call handling, review count)
- A link to see the AI receptionist actually working
- A button for them to confirm and officially start the trial

**Gatekeeper scripts:** you'll now see Script A / B / C options at the top of the call screen. Use whichever is assigned to that lead — don't switch scripts mid-batch on your own, we're comparing which one works best.

If you're not sure what to say at any point, hit "Objection Help" — don't freelance the pitch.$body$,
  true,
  now()
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- RLS, matching the rest of the schema.
-- ---------------------------------------------------------------------------
alter table updates enable row level security;
drop policy if exists updates_anon_all on updates;

create policy updates_anon_all
  on updates
  for all
  to anon, authenticated
  using (true)
  with check (true);

alter table caller_update_reads enable row level security;
drop policy if exists caller_update_reads_anon_all on caller_update_reads;

create policy caller_update_reads_anon_all
  on caller_update_reads
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- Did it land?
--
-- Run the whole file, then look for a row saying "0025 applied" with
-- seeded_updates = 1. If you do not see it, the paste was cut short — scroll
-- to the bottom of the editor and paste it again. Re-running is safe.
-- ---------------------------------------------------------------------------
select
  '0025 applied' as migration,
  (select count(*) from updates) as seeded_updates,
  (select count(*) from information_schema.tables
     where table_name = 'caller_update_reads') as read_table;
