-- ═══════════════════════════════════════════════════════════════════════════
-- AN AGENT'S BOOK IS NOT PUBLIC READING
-- ═══════════════════════════════════════════════════════════════════════════
-- The last item phase 7 left open, closed. fn_agent_unsettled_commission was
-- SECURITY DEFINER with EXECUTE to `authenticated` and NO authorization check:
-- any logged-in user could pass any other user's id and any club id and be told
-- what that club still owes that person. RLS on agent_commissions would have
-- refused the same read; the definer function walked straight past it.
--
-- The fix is a split, not a restriction. Two reads wore one function:
--   1. the CALLER'S OWN read (CommissionService.unsettledCommission always
--      passes user.id - the only client caller in the repo);
--   2. the OFFICER'S read inside fn_club_set_member_role, which is itself
--      SECURITY DEFINER and has ALREADY authorized its actor through
--      fn_club_grantable_roles before it gets here.
-- So the demotion path reads the sum inline, and the RPC gets the guard it
-- should always have had. The report cannot regress, because it no longer
-- depends on the guard.
--
-- ROLLBACK
--   CREATE OR REPLACE FUNCTION public.fn_agent_unsettled_commission(
--     p_club_id uuid, p_user_id uuid)
--   RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
--   AS $r$ SELECT COALESCE(SUM(amount),0)::numeric FROM public.agent_commissions
--      WHERE club_id=p_club_id AND user_id=p_user_id AND settled_at IS NULL; $r$;
--   -- and put the call back in fn_club_set_member_role:
--   --   v_commission := public.fn_agent_unsettled_commission(p_club_id, p_user_id);
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The demotion path stops depending on the RPC ─────────────────────────
DO $patch$
DECLARE
  v_src  text;
  v_old  text := '  v_commission := public.fn_agent_unsettled_commission(p_club_id, p_user_id);';
  v_new  text;
  v_hits int;
  v_args text;
BEGIN
  -- pg_get_function_ARGUMENTS, not _identity_arguments: the identity form
  -- strips DEFAULTs and this function has four, so CREATE OR REPLACE fed the
  -- identity form dies with 42P13. Caught by rehearsing this rolled back.
  SELECT p.prosrc, pg_get_function_arguments(p.oid)
    INTO v_src, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_club_set_member_role';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_club_set_member_role does not exist; refusing to guess';
  END IF;

  IF position('-- reads the ledger directly: this function has already' IN v_src) > 0 THEN
    RAISE NOTICE 'fn_club_set_member_role already reads the ledger inline; skipping';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 call to the commission rpc in fn_club_set_member_role, found %', v_hits;
  END IF;

  -- The comment must NOT name the RPC: the assertion below proves the call is
  -- gone by searching the source, and a comment naming it is indistinguishable
  -- from a call. Phase 7 hit this exact trap patching this exact function.
  v_new :=
    '  -- reads the ledger directly: this function has already authorized its' || E'\n' ||
    '  -- actor through fn_club_grantable_roles above, and it is SECURITY DEFINER,' || E'\n' ||
    '  -- so it does not need the guarded caller-facing RPC''s door. That RPC now' || E'\n' ||
    '  -- admits only self, club admin and above, an agent ancestor, or the' || E'\n' ||
    '  -- service role, and THIS report must not be able to fail on it. Same' || E'\n' ||
    '  -- SELECT, same partial index (agent_commissions_unsettled_idx).' || E'\n' ||
    '  SELECT COALESCE(SUM(ac.amount), 0)::numeric INTO v_commission' || E'\n' ||
    '    FROM public.agent_commissions ac' || E'\n' ||
    '   WHERE ac.club_id = p_club_id' || E'\n' ||
    '     AND ac.user_id = p_user_id' || E'\n' ||
    '     AND ac.settled_at IS NULL;';

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.fn_club_set_member_role(%s) RETURNS jsonb '
    'LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS %L',
    v_args, replace(v_src, v_old, v_new));

  RAISE NOTICE 'fn_club_set_member_role patched to read the ledger inline';
END
$patch$;

-- ── 2. One definition of who may look ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_agent_may_read_commission(
  p_club_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $may$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  -- The engine and the API routes.
  IF public.fn_is_service_context() THEN
    RETURN true;
  END IF;

  -- A logged-out caller reads nothing.
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  -- Yourself.
  IF v_uid = p_user_id THEN
    RETURN true;
  END IF;

  IF p_club_id IS NULL THEN
    RETURN false;
  END IF;

  -- An officer of that club. fn_role_rank: owner 7, co_owner 6, admin 5.
  IF public.fn_has_club_role(v_uid, p_club_id, 'admin') THEN
    RETURN true;
  END IF;

  -- Your own downline, at any depth - the same relationship
  -- fn_agent_downline_commission already reports on, so it grants nothing new.
  RETURN public.fn_is_agent_ancestor(v_uid, p_user_id, p_club_id);
END
$may$;

-- ── 3. The RPC gets the guard it should always have had ─────────────────────
CREATE OR REPLACE FUNCTION public.fn_agent_unsettled_commission(
  p_club_id uuid,
  p_user_id uuid
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF p_club_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'fn_agent_unsettled_commission needs a club and a user'
      USING ERRCODE = '22023';
  END IF;

  IF NOT public.fn_agent_may_read_commission(p_club_id, p_user_id) THEN
    -- Not a zero. A zero is indistinguishable from "owes nothing", and this
    -- caller is not entitled to know which of the two it is.
    RAISE EXCEPTION 'not authorized to read that member''s commission'
      USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT COALESCE(SUM(ac.amount), 0)::numeric
      FROM public.agent_commissions ac
     WHERE ac.club_id = p_club_id
       AND ac.user_id = p_user_id
       AND ac.settled_at IS NULL
  );
END
$fn$;

-- ── 4. Grants, written down rather than inherited ───────────────────────────
REVOKE ALL ON FUNCTION public.fn_agent_unsettled_commission(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_agent_unsettled_commission(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_agent_unsettled_commission(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_agent_unsettled_commission(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_agent_may_read_commission(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_agent_may_read_commission(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_agent_may_read_commission(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_agent_may_read_commission(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.fn_agent_unsettled_commission(uuid, uuid) IS
  'What a club still owes one member, from agent_commissions. Guarded by fn_agent_may_read_commission: self, club admin+, agent ancestor, or service role. Raises 42501 otherwise - never a zero, which would be a lie.';

COMMENT ON FUNCTION public.fn_agent_may_read_commission(uuid, uuid) IS
  'Who may see what a club owes a member. One definition, reused - do not write a second one next to a new commission surface.';

-- ── 5. Assertions. This migration refuses to lie about what it did ──────────
DO $verify$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_club_set_member_role';

  IF position('fn_agent_unsettled_commission' IN v_src) > 0 THEN
    RAISE EXCEPTION 'fn_club_set_member_role still names the guarded RPC';
  END IF;
  IF position('SELECT COALESCE(SUM(ac.amount), 0)::numeric INTO v_commission' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_club_set_member_role does not read the ledger inline';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_agent_unsettled_commission';
  IF position('fn_agent_may_read_commission' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_agent_unsettled_commission is still unguarded';
  END IF;

  IF NOT has_function_privilege('authenticated',
        'public.fn_agent_unsettled_commission(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost EXECUTE on fn_agent_unsettled_commission';
  END IF;
  IF has_function_privilege('anon',
        'public.fn_agent_unsettled_commission(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still execute fn_agent_unsettled_commission';
  END IF;

  RAISE NOTICE 'an agents book is not public reading: applied and verified';
END
$verify$;
