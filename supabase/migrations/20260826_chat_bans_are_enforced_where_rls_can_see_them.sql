-- ═══════════════════════════════════════════════════════════════════════════
-- CHAT BANS, ENFORCED WHERE THE CHECK CAN ACTUALLY SEE THE BAN
-- ───────────────────────────────────────────────────────────────────────────
-- 2026-08-26. `20260825_ban_chat_is_enforced_in_rls.sql` closed one of four
-- holes: it taught `table_chat_insert` about `tables.ban_chat`. Three were
-- still open, and all three were verified open against production today.
--
-- 1. TOURNAMENT CHAT BAN REACHED NOTHING. `tournaments.ban_chat` is read by
--    exactly one line of the whole estate - DetailOverviewTab.tsx:409, which
--    renders a "No Chat" badge. Nothing ever copies it onto the tournament's
--    `tables` rows, so the RLS check above never saw it. Measured: 3 live
--    tables belong to tournaments with ban_chat = true, and 0 of those 3 rows
--    carry ban_chat themselves. The badge said No Chat and the table chatted.
--
-- 2. `table_chat_mutes` WAS ENFORCED NOWHERE AT ALL. A real table - table_id,
--    user_id, muted_by, expires_at - with an admin-only management policy and
--    not one reader in `src/`, `server/` or any policy. Muting a player did
--    nothing to that player.
--
-- 3. `club_chat` HAD NO BAN CHECK OF ANY KIND. `blacklists` is the club-level
--    ban (club_id, user_id, expires_at) and the club chat INSERT policy never
--    looked at it.
--
-- WHY THESE ARE FUNCTIONS AND NOT INLINE SUBQUERIES
--
-- A subquery inside an RLS policy runs as the CALLER, so the caller's own RLS
-- applies to it. That turns two of these checks into no-ops written in a way
-- that looks correct:
--
--   * `table_chat_mutes` has ONE policy, `mutes_admin_manage`, restricted to
--     owner/admin/super_agent. A muted player selecting their own mute row
--     sees zero rows, so an inline `NOT EXISTS (... table_chat_mutes ...)`
--     is TRUE for exactly the people it is meant to stop.
--   * `blacklists_select` is restricted to club owners, admins and agents.
--     A blacklisted member cannot see their own blacklist row either, with
--     the same inversion.
--
-- So the reads happen in SECURITY DEFINER functions, which are not subject to
-- the caller's RLS. `search_path` is pinned on both, since a SECURITY DEFINER
-- function with a caller-controlled search_path is how you hand out postgres.
--
-- The functions return a boolean about the CALLER only - they take no user
-- parameter and resolve `auth.uid()` internally - so they cannot be used to
-- probe whether somebody else is muted or blacklisted.
--
-- NOT EXISTS semantics are preserved throughout: a chat row whose table_id no
-- longer resolves still inserts exactly as it does today (`table_chat` has no
-- FK on table_id), and a club with no blacklist row is not silenced.
--
-- DELIBERATELY NOT CHANGED, reported instead: the club_chat policies require
-- `club_members.status = 'active'`, and production holds 1480 members at
-- 'approved' against 20 at 'active'. `club_challenges_member_read` accepts
-- BOTH spellings, so 'approved' is a live membership state and club chat is
-- currently unusable for the large majority of members (club_chat has 0 rows).
-- Widening an RLS policy is not a change that belongs in a pull request about
-- bans, so the membership predicate below is carried over byte for byte.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Pre-flight: refuse to guess at rules that are not there ────────────────
DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'table_chat'
       AND policyname = 'table_chat_insert'
  ) THEN
    RAISE EXCEPTION 'table_chat_insert is missing - refusing to guess at the chat rule';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'club_chat'
       AND policyname = 'Members can insert club chat'
  ) THEN
    RAISE EXCEPTION 'the club chat insert policy is missing - refusing to guess at the membership rule';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'table_chat_mutes'
       AND column_name = 'expires_at'
  ) THEN
    RAISE EXCEPTION 'table_chat_mutes.expires_at is missing - the mute has no shape to enforce';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'blacklists'
       AND column_name = 'expires_at'
  ) THEN
    RAISE EXCEPTION 'blacklists.expires_at is missing - the club ban has no shape to enforce';
  END IF;
END
$preflight$;

-- ── Is the caller silenced at this table? ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_table_chat_is_silenced(p_table_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT
    -- the table's own switch, or the switch on the tournament it belongs to
    COALESCE((
      SELECT true
        FROM public.tables t
        LEFT JOIN public.tournaments tr ON tr.id = t.tournament_id
       WHERE t.id = p_table_id
         AND (t.ban_chat IS TRUE OR tr.ban_chat IS TRUE)
       LIMIT 1
    ), false)
    OR
    -- this player's own unexpired mute at this table
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

-- ── Is the caller banned from this club? ───────────────────────────────────
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
       -- a NULL expiry is a permanent ban, not an expired one
       AND (b.expires_at IS NULL OR b.expires_at > now())
     LIMIT 1
  ), false);
$fn$;

COMMENT ON FUNCTION public.fn_club_chat_is_silenced(uuid) IS
  'True when the caller holds an unexpired blacklists row for this club. SECURITY DEFINER because blacklists_select is restricted to owners, admins and agents, so a banned member cannot see their own ban and an inline RLS subquery would never fire. Answers about the caller only.';

REVOKE ALL ON FUNCTION public.fn_club_chat_is_silenced(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_club_chat_is_silenced(uuid) TO authenticated, service_role;

-- ── table_chat: same identity rule, same message_type rule, plus the bans ──
DROP POLICY IF EXISTS "table_chat_insert" ON public.table_chat;

CREATE POLICY "table_chat_insert" ON public.table_chat
FOR INSERT
WITH CHECK (
  user_id = auth.uid()
  AND message_type = 'player'
  AND NOT public.fn_table_chat_is_silenced(table_chat.table_id)
);

-- ── club_chat: membership predicate unchanged, plus the club ban ───────────
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

-- ── Post-apply assertions ──────────────────────────────────────────────────
DO $verify$
DECLARE v_check text;
BEGIN
  SELECT with_check INTO v_check
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'table_chat'
     AND policyname = 'table_chat_insert';

  IF v_check IS NULL THEN
    RAISE EXCEPTION 'the table_chat policy did not land';
  END IF;
  IF position('auth.uid()' IN v_check) = 0 THEN
    RAISE EXCEPTION 'the table_chat identity rule was lost';
  END IF;
  IF position('message_type' IN v_check) = 0 THEN
    RAISE EXCEPTION 'the table_chat message_type rule was lost';
  END IF;
  IF position('fn_table_chat_is_silenced' IN v_check) = 0 THEN
    RAISE EXCEPTION 'the table_chat ban check is not being called';
  END IF;

  SELECT with_check INTO v_check
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'club_chat'
     AND policyname = 'Members can insert club chat';

  IF v_check IS NULL THEN
    RAISE EXCEPTION 'the club_chat policy did not land';
  END IF;
  IF position('club_members' IN v_check) = 0 THEN
    RAISE EXCEPTION 'the club_chat membership rule was lost';
  END IF;
  IF position('fn_club_chat_is_silenced' IN v_check) = 0 THEN
    RAISE EXCEPTION 'the club_chat ban check is not being called';
  END IF;

  -- Both helpers must be SECURITY DEFINER with a pinned search_path, or they
  -- are back to being blind to the rows they exist to find.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'fn_table_chat_is_silenced'
       AND p.prosecdef IS TRUE
       AND array_to_string(p.proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'fn_table_chat_is_silenced is not SECURITY DEFINER with a pinned search_path';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'fn_club_chat_is_silenced'
       AND p.prosecdef IS TRUE
       AND array_to_string(p.proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'fn_club_chat_is_silenced is not SECURITY DEFINER with a pinned search_path';
  END IF;
END
$verify$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
--
--   DROP POLICY IF EXISTS "table_chat_insert" ON public.table_chat;
--   CREATE POLICY "table_chat_insert" ON public.table_chat FOR INSERT
--     WITH CHECK (
--       user_id = auth.uid()
--       AND message_type = 'player'
--       AND NOT EXISTS (
--         SELECT 1 FROM public.tables t
--          WHERE t.id = table_chat.table_id AND t.ban_chat IS TRUE
--       )
--     );
--
--   DROP POLICY IF EXISTS "Members can insert club chat" ON public.club_chat;
--   CREATE POLICY "Members can insert club chat" ON public.club_chat FOR INSERT
--     WITH CHECK (
--       EXISTS (
--         SELECT 1 FROM public.club_members
--          WHERE club_members.club_id = club_chat.club_id
--            AND club_members.user_id = (SELECT auth.uid())
--            AND club_members.status = 'active'
--       )
--     );
--
--   DROP FUNCTION IF EXISTS public.fn_table_chat_is_silenced(uuid);
--   DROP FUNCTION IF EXISTS public.fn_club_chat_is_silenced(uuid);
-- ═══════════════════════════════════════════════════════════════════════════
