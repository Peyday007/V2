-- Browser room recording.
--
-- The low-cost route to recorded calls: the caller puts their handset on
-- speaker and the laptop microphone captures the room. No telephony provider,
-- no change to the tel: workflow, no per-minute call cost.
--
-- What that buys and what it costs:
--   + works today, on the phones the team already uses
--   + one audio file per call, playable and transcribable
--   - one microphone hears both sides, so the prospect is quieter and
--     speaker labelling is unreliable. Segments store 'unknown' rather than
--     guessing (see SPEAKER_CONFIDENCE_FLOOR in src/lib/telephony.ts).
--
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. Columns for a capture that has no telephony provider behind it.
-- ---------------------------------------------------------------------------

-- browser_room — laptop mic, handset on speaker
-- telephony    — a provider leg, when one is eventually connected
alter table recordings add column if not exists capture_mode text not null
  default 'telephony';

-- The browser's own id for the capture. Uploads retry, and a retried part or
-- a repeated finalize must land on the SAME row rather than creating a second.
alter table recordings add column if not exists client_capture_id text;

alter table recordings add column if not exists mime_type text;
alter table recordings add column if not exists size_bytes bigint;
-- Parts arrive every few seconds while the call runs, so a refresh or a
-- dropped connection loses only the tail.
alter table recordings add column if not exists parts_uploaded integer not null default 0;
alter table recordings add column if not exists parts_expected integer;
alter table recordings add column if not exists finalized_at timestamptz;
-- Why a recording was thrown away, in words. Consent refusal is the important
-- one: the audio is deleted, and the fact that it was deleted is kept.
alter table recordings add column if not exists discard_reason text;

alter table recordings add column if not exists transcription_provider text;
alter table recordings add column if not exists transcription_error text;

do $mig$
begin
  if not exists (
    select 1 from pg_indexes
    where indexname = 'recordings_client_capture_uniq'
  ) then
    create unique index recordings_client_capture_uniq
      on recordings(client_capture_id) where client_capture_id is not null;
  end if;
end;
$mig$;

create index if not exists recordings_lead_live_idx
  on recordings(lead_id, created_at desc) where deleted_at is null;

alter table recordings drop constraint if exists recordings_capture_mode_check;
alter table recordings add constraint recordings_capture_mode_check
  check (capture_mode in ('browser_room', 'telephony'));

-- ---------------------------------------------------------------------------
-- 2. Where the audio lives.
--
--    PRIVATE bucket. Playback is a short-lived signed URL minted server-side,
--    never a public link — a recording of somebody's business call must not be
--    guessable from its filename.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('call-recordings', 'call-recordings', false)
on conflict (id) do nothing;

-- Matches the rest of this schema's posture. If your SQL editor lacks rights
-- over storage.objects this block is skipped with a notice rather than failing
-- the whole migration; set SUPABASE_SERVICE_ROLE_KEY in Vercel and the app
-- bypasses these policies anyway.
do $mig$
begin
  begin
    drop policy if exists call_recordings_anon_all on storage.objects;
    create policy call_recordings_anon_all on storage.objects
      for all to anon, authenticated
      using (bucket_id = 'call-recordings')
      with check (bucket_id = 'call-recordings');
  exception when insufficient_privilege or undefined_table then
    raise notice
      'Skipped storage.objects policy (no privilege). Set SUPABASE_SERVICE_ROLE_KEY in Vercel so the server writes recordings with the service role.';
  end;
end;
$mig$;

-- ---------------------------------------------------------------------------
-- 3. A recording starts before the call row exists.
--
--    The dialer creates the calls row only when the caller saves the outcome,
--    so a recording is born attached to the LEAD and is linked to the call
--    afterwards. Both directions are already nullable; this index makes the
--    "which recording is still open for this lead" lookup cheap.
-- ---------------------------------------------------------------------------
create index if not exists recordings_open_idx
  on recordings(caller_id, telephony_status)
  where deleted_at is null and finalized_at is null;
