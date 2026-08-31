-- ══════════════════════════════════════════════════════════════════════════
--  fn_home_is_group_staff TOOK THE CALLER'S WORD FOR WHO THE CALLER WAS
-- ══════════════════════════════════════════════════════════════════════════
--
-- It is an RLS policy helper: 15 policies across 8 tables call it, and EVERY
-- ONE of them passes the same thing --
--
--     fn_home_is_group_staff((SELECT auth.uid()), <group>)
--
-- but the function itself never looked at auth.uid(). It trusted `p_caller`.
-- And because it is a policy helper, `anon` must hold EXECUTE on it (a policy
-- expression evaluates as the QUERYING role, and anon can SELECT 6 of those 8
-- tables), so an unauthenticated caller could also just call it directly:
--
--     POST /rest/v1/rpc/fn_home_is_group_staff
--     { "p_caller": "<any user uuid>", "p_group_id": "<any group uuid>" }
--
-- and get back a straight boolean. That is a membership oracle: name any user
-- and any private home-game group and learn whether that person runs it. Not a
-- write and not a chip, but it is somebody's private association, answerable
-- by a stranger, one uuid pair at a time.
--
-- REVOKING WAS NOT AVAILABLE. Taking EXECUTE away from anon would deny every
-- anon SELECT on commander_home_posts, _post_comments, _game_tables,
-- _game_reviews, _seat_reservations and home_game_vouches, because their
-- policies call this function and a policy runs as the caller. That is the trap
-- this sweep already walked into once and it is why the check now prints the
-- pg_policy query before it suggests a revoke.
--
-- SO THE FUNCTION LEARNS TO ASK INSTEAD. It derives the caller from auth.uid()
-- and ignores p_caller for anybody who has one. Behaviour through the policies
-- is BIT-IDENTICAL, because the policies were already passing auth.uid():
--
--   authenticated user   auth.uid() is their id -> same id the policy passed
--   anon                 auth.uid() is NULL, auth.role() is 'anon' -> false,
--                        which is exactly what p_caller = NULL returned before
--
-- The signature is kept so the 15 policies do not need rewriting, and p_caller
-- is still honoured for a TRUSTED BACKEND -- a connection with no JWT at all,
-- where auth.role() is NULL -- because that is the documented way this estate
-- recognises the engine, and current_user cannot be used for it (SECURITY
-- DEFINER rewrites current_user to the owner, so it reads the same for a
-- browser and for the engine).
--
-- Nothing in club-arena/src, club-arena/server/src or the World Hub calls this
-- function directly; the only references are two comments describing it.
--
-- Side effect, and a welcome one: it now consults auth.uid(), so it drops out
-- of the new `anon_readers` question in fn_definer_exposure_audit() on its own
-- merits rather than by sitting in a baseline.

CREATE OR REPLACE FUNCTION public.fn_home_is_group_staff(p_caller uuid, p_group_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  v_caller uuid;
BEGIN
    -- WHO IS ASKING is decided here, not by the argument.
    v_caller := auth.uid();

    -- A trusted backend has no JWT at all, so auth.role() is NULL. Only then
    -- may the caller name itself. A browser role ('anon', 'authenticated')
    -- never reaches this branch.
    IF v_caller IS NULL AND COALESCE(auth.role(), 'service_role') = 'service_role' THEN
        v_caller := p_caller;
    END IF;

    IF v_caller IS NULL OR p_group_id IS NULL THEN RETURN false; END IF;

    -- Group owner -> always staff
    IF EXISTS (SELECT 1 FROM commander_home_groups
               WHERE id = p_group_id AND owner_id = v_caller) THEN
        RETURN true;
    END IF;

    -- Approved member with elevated role
    IF EXISTS (SELECT 1 FROM commander_home_members
               WHERE group_id = p_group_id
                 AND user_id = v_caller
                 AND status = 'approved'
                 AND role IN ('owner','admin','co_host')) THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$function$;

DO $$
DECLARE
  v_group uuid; v_owner uuid; v_answer boolean;
BEGIN
  SELECT id, owner_id INTO v_group, v_owner
    FROM commander_home_groups WHERE owner_id IS NOT NULL LIMIT 1;

  IF v_group IS NULL THEN
    RAISE NOTICE 'no home-game group with an owner; behavioural assertions skipped';
    RETURN;
  END IF;

  -- 1. THE ORACLE IS CLOSED. A logged-out caller naming the real owner must
  --    now be told false. Before this migration it was told true.
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_answer := public.fn_home_is_group_staff(v_owner, v_group);
  IF v_answer THEN
    RAISE EXCEPTION 'anon can still probe group staff -- the oracle is open';
  END IF;

  -- 2. THE POLICIES ARE UNCHANGED. The real owner, presenting their own JWT,
  --    must still be staff. This is the exact shape all 15 policies produce.
  PERFORM set_config('request.jwt.claims',
    json_build_object('role','authenticated','sub', v_owner::text)::text, true);
  v_answer := public.fn_home_is_group_staff(v_owner, v_group);
  IF NOT v_answer THEN
    RAISE EXCEPTION 'the owner is no longer staff of their own group -- 15 policies just broke';
  END IF;

  -- 3. A LOGGED-IN CALLER CANNOT IMPERSONATE. Presenting their own JWT while
  --    naming the owner in p_caller must be answered for THEM, not the owner.
  PERFORM set_config('request.jwt.claims',
    json_build_object('role','authenticated',
                      'sub','00000000-0000-0000-0000-0000000000ff')::text, true);
  v_answer := public.fn_home_is_group_staff(v_owner, v_group);
  IF v_answer THEN
    RAISE EXCEPTION 'p_caller still overrides auth.uid() -- impersonation survives';
  END IF;

  PERFORM set_config('request.jwt.claims', NULL, true);
  RAISE NOTICE 'fn_home_is_group_staff: oracle closed, policies intact, impersonation refused';
END $$;
