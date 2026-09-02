-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901105416; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Deep Stack Society (club_id 11192, uuid 2a1132b9-5ba2-42e6-9f01-30a7fcffebe3) is a
-- synthetic house board: its 416 members are bots by design. The allow-list lost the
-- entry, so club_members_bot_house_only rejected every UPDATE against those rows.
-- Recorded as a migration this time so it cannot silently disappear again.
CREATE OR REPLACE FUNCTION public.fn_ca_house_board_allows_automation(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_club_id = ANY (ARRAY[
    'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,  -- SHARK CLUB
    'a0000000-0000-0000-0000-000000000001'::uuid,  -- Club JAQK
    'fade0000-0000-0000-0000-000000000001'::uuid,  -- Midway Union
    '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid   -- Deep Stack Society
  ]);
$$;
