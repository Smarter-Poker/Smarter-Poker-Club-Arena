-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826054618; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='table_chat' AND policyname='table_chat_insert') THEN
    RAISE EXCEPTION 'table_chat_insert is missing - refusing to guess at the chat rule';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='club_chat' AND policyname='Members can insert club chat') THEN
    RAISE EXCEPTION 'the club chat insert policy is missing - refusing to guess at the membership rule';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='table_chat_mutes' AND column_name='expires_at') THEN
    RAISE EXCEPTION 'table_chat_mutes.expires_at is missing - the mute has no shape to enforce';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='blacklists' AND column_name='expires_at') THEN
    RAISE EXCEPTION 'blacklists.expires_at is missing - the club ban has no shape to enforce';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_table_chat_is_silenced(p_table_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT
    COALESCE((
      SELECT true
        FROM public.tables t
        LEFT JOIN public.tournaments tr ON tr.id = t.tournament_id
       WHERE t.id = p_table_id
         AND (t.ban_chat IS TRUE OR tr.ban_chat IS TRUE)
       LIMIT 1
    ), false)
    OR
    COALESCE((
      SELECT true
        FROM public.table_chat_mutes m
       WHERE m.table_id = p_table_id
         AND m.user_id = auth.uid()
         AND m.expires_at > now()
       LIMIT 1
    ), false);
$fn$;

COMMENT ON FUNCTION public.fn_table_chat_is_silenced(uuid) IS
  'True when the caller may not post in this table chat: the table has ban_chat, its parent tournament has ban_chat, or the caller holds an unexpired table_chat_mutes row. SECURITY DEFINER because table_chat_mutes is admin-read-only, so an inline RLS subquery would be blind to exactly the people it must stop. Answers about the caller only.';

REVOKE ALL ON FUNCTION public.fn_table_chat_is_silenced(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_table_chat_is_silenced(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_club_chat_is_silenced(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT COALESCE((
    SELECT true
      FROM public.blacklists b
     WHERE b.club_id = p_club_id
       AND b.user_id = auth.uid()
       AND (b.expires_at IS NULL OR b.expires_at > now())
     LIMIT 1
  ), false);
$fn$;

COMMENT ON FUNCTION public.fn_club_chat_is_silenced(uuid) IS
  'True when the caller holds an unexpired blacklists row for this club. SECURITY DEFINER because blacklists_select is restricted to owners, admins and agents, so a banned member cannot see their own ban and an inline RLS subquery would never fire. Answers about the caller only.';

REVOKE ALL ON FUNCTION public.fn_club_chat_is_silenced(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_club_chat_is_silenced(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS "table_chat_insert" ON public.table_chat;

CREATE POLICY "table_chat_insert" ON public.table_chat
FOR INSERT
WITH CHECK (
  user_id = auth.uid()
  AND message_type = 'player'
  AND NOT public.fn_table_chat_is_silenced(table_chat.table_id)
);

DROP POLICY IF EXISTS "Members can insert club chat" ON public.club_chat;

CREATE POLICY "Members can insert club chat" ON public.club_chat
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1
      FROM public.club_members
     WHERE club_members.club_id = club_chat.club_id
       AND club_members.user_id = (SELECT auth.uid())
       AND club_members.status = 'active'
  )
  AND NOT public.fn_club_chat_is_silenced(club_chat.club_id)
);

DO $verify$
DECLARE v_check text;
BEGIN
  SELECT with_check INTO v_check FROM pg_policies
   WHERE schemaname='public' AND tablename='table_chat' AND policyname='table_chat_insert';
  IF v_check IS NULL THEN RAISE EXCEPTION 'the table_chat policy did not land'; END IF;
  IF position('auth.uid()' IN v_check) = 0 THEN RAISE EXCEPTION 'the table_chat identity rule was lost'; END IF;
  IF position('message_type' IN v_check) = 0 THEN RAISE EXCEPTION 'the table_chat message_type rule was lost'; END IF;
  IF position('fn_table_chat_is_silenced' IN v_check) = 0 THEN RAISE EXCEPTION 'the table_chat ban check is not being called'; END IF;

  SELECT with_check INTO v_check FROM pg_policies
   WHERE schemaname='public' AND tablename='club_chat' AND policyname='Members can insert club chat';
  IF v_check IS NULL THEN RAISE EXCEPTION 'the club_chat policy did not land'; END IF;
  IF position('club_members' IN v_check) = 0 THEN RAISE EXCEPTION 'the club_chat membership rule was lost'; END IF;
  IF position('fn_club_chat_is_silenced' IN v_check) = 0 THEN RAISE EXCEPTION 'the club_chat ban check is not being called'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_table_chat_is_silenced'
       AND p.prosecdef IS TRUE AND array_to_string(p.proconfig,',') LIKE '%search_path%'
  ) THEN RAISE EXCEPTION 'fn_table_chat_is_silenced is not SECURITY DEFINER with a pinned search_path'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_club_chat_is_silenced'
       AND p.prosecdef IS TRUE AND array_to_string(p.proconfig,',') LIKE '%search_path%'
  ) THEN RAISE EXCEPTION 'fn_club_chat_is_silenced is not SECURITY DEFINER with a pinned search_path'; END IF;
END
$verify$;
