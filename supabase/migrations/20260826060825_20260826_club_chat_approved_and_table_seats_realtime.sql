-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826060825; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Fix 1: club_chat RLS — widen status predicate to include 'approved'
-- ═══════════════════════════════════════════════════════════════════════════
--
-- MEASURED BEFORE WRITING (2026-08-26):
--   club_members status distribution:
--     approved  1480
--     active      20
--   club_chat INSERT and SELECT policies both require status = 'active'
--   => 98.7% of members cannot read or post in club chat.
--
-- The model fix is club_challenges_member_read which already uses:
--   status = ANY (ARRAY['active', 'approved'])
-- We replicate that pattern here.
--
-- Fix 2: table_seats missing from supabase_realtime publication
-- ═══════════════════════════════════════════════════════════════════════════
--
-- MEASURED BEFORE WRITING (2026-08-26):
--   SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime'
--   => table_seats is NOT in the list.
--   TablePage.tsx channel('table-seats-live:${tableId}') has NEVER delivered
--   a row (no rows ever received from the postgres_changes subscription).
--   Fix: ADD TABLE to publication.
--
-- ═══════════════════════════════════════════════════════════════════════════

-- PART 1: club_chat SELECT policy

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'club_chat'
       AND policyname = 'Members can read club chat'
  ) THEN
    RAISE EXCEPTION 'club_chat SELECT policy is missing -- refusing to guess at the shape';
  END IF;
END
$guard$;

DROP POLICY IF EXISTS "Members can read club chat" ON public.club_chat;

CREATE POLICY "Members can read club chat" ON public.club_chat
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM public.club_members cm
       WHERE cm.club_id = club_chat.club_id
         AND cm.user_id = (SELECT auth.uid())
         AND cm.status = ANY (ARRAY['active'::text, 'approved'::text])
    )
  );

-- PART 2: club_chat INSERT policy

DO $guard2$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'club_chat'
       AND policyname = 'Members can insert club chat'
  ) THEN
    RAISE EXCEPTION 'club_chat INSERT policy is missing -- refusing to guess at the shape';
  END IF;
END
$guard2$;

DROP POLICY IF EXISTS "Members can insert club chat" ON public.club_chat;

CREATE POLICY "Members can insert club chat" ON public.club_chat
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
        FROM public.club_members cm
       WHERE cm.club_id = club_chat.club_id
         AND cm.user_id = (SELECT auth.uid())
         AND cm.status = ANY (ARRAY['active'::text, 'approved'::text])
    )
    AND NOT fn_club_chat_is_silenced(club_id)
  );

-- PART 3: Verify both policies

DO $verify$
DECLARE
  v_select_qual text;
  v_insert_check text;
BEGIN
  SELECT qual INTO v_select_qual
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'club_chat'
     AND policyname = 'Members can read club chat';

  IF v_select_qual IS NULL THEN
    RAISE EXCEPTION 'SELECT policy did not land';
  END IF;
  IF position('approved' IN v_select_qual) = 0 THEN
    RAISE EXCEPTION 'SELECT policy still missing approved: %', v_select_qual;
  END IF;

  SELECT with_check INTO v_insert_check
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'club_chat'
     AND policyname = 'Members can insert club chat';

  IF v_insert_check IS NULL THEN
    RAISE EXCEPTION 'INSERT policy did not land';
  END IF;
  IF position('approved' IN v_insert_check) = 0 THEN
    RAISE EXCEPTION 'INSERT policy still missing approved: %', v_insert_check;
  END IF;

  RAISE NOTICE 'club_chat policies verified -- both now allow active OR approved members';
END
$verify$;

-- PART 4: Add table_seats to realtime publication (idempotent)

DO $pub$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND tablename = 'table_seats'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.table_seats;
    RAISE NOTICE 'table_seats added to supabase_realtime publication';
  ELSE
    RAISE NOTICE 'table_seats was already in supabase_realtime publication -- no change';
  END IF;
END
$pub$;

-- PART 5: Verify table_seats is in the publication

DO $verify_pub$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND tablename = 'table_seats'
  ) THEN
    RAISE EXCEPTION 'table_seats is still NOT in the supabase_realtime publication after ALTER';
  END IF;
  RAISE NOTICE 'table_seats confirmed in supabase_realtime publication';
END
$verify_pub$;
