-- 20260922153234_one_club_membership_cap_one_count_one_lock.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
/*
 * ===========================================================================
 *  ONE CLUB MEMBERSHIP CAP: ONE COUNT, ONE LOCK, ONE LIMIT
 *  2026-09-22
 * ===========================================================================
 *
 * WHAT IS WRONG RIGHT NOW. Production migration 20260908125235
 * (a_player_may_belong_to_ten_clubs, recorded in this repo as
 * 20260908125235_a_player_may_belong_to_ten_clubs.sql) raised the club
 * membership cap from 4 to 10 by retyping the literal in the four places that
 * ENFORCE it:
 *
 *   fn_enforce_four_club_limit()             trg_four_club_limit_ins/_upd
 *   fn_join_club_membership_impl(uuid)       the join path
 *   fn_join_club(uuid)                       rejoin after departure
 *   fn_create_club_atomic_membership_impl()  the create path
 *
 * and missed the one place that TELLS THE PLAYER:
 *
 *   fn_get_club_creation_eligibility()       still 'limit', 4 and
 *                                            'can_create', v_count < 4
 *
 * So a human who belongs to 4 to 9 clubs opens Create Club and is told the
 * allowance is full, while the server would create the club. The preflight
 * and the transaction disagree because each carries its own copy of the
 * number, its own copy of the count and, for the create path, its own copy of
 * the create_club rollout rule. The four copies of the count do not even
 * agree with each other: only fn_join_club leaves departed memberships out.
 *
 * THE LIMIT HAD NO LOCK EXCEPT ON ONE PATH. Only the create path serialised a
 * player's membership writes (pg_advisory_xact_lock on the player, 77431). The
 * join path and the trigger counted without it, so two joins for the same
 * player at 9 memberships, committed together, both saw 9 and both landed: 11.
 *
 * THE FIX IS ONE AUTHORITY, NOT A FIFTH COPY OF THE NUMBER.
 *
 *   fn_club_membership_cap()           the limit, 10, stated once
 *   fn_club_membership_count(u, excl)  what counts: status active or approved
 *                                      AND lifecycle active (a departed row is
 *                                      history, not a membership)
 *   fn_club_membership_lock(u)         the player's membership lock, the same
 *                                      key the create path already takes, so
 *                                      an old and a new caller still exclude
 *                                      each other
 *   fn_club_creation_open(u)           the create_club rollout rule, moved
 *                                      byte for byte out of the create path
 *
 * The four enforcing functions are edited by exact substitution against the
 * catalogue, never retyped, and each takes the player lock before it counts.
 * fn_join_club takes it before the cashier-hierarchy lock, so the player lock
 * comes first on every path. The preflight is rewritten on the same helpers
 * and now says WHY creation is refused: 'creation_unavailable' (the rollout
 * rule) or 'membership_cap', plus the limit and the remaining allowance the
 * client renders instead of a number of its own.
 *
 * WHAT DOES NOT CHANGE. Signatures, owners, ACLs, SECURITY DEFINER, every
 * search_path and lock_timeout. The horse exemption and both early returns in
 * the trigger. The owner bypass on both join paths. Every error message except
 * that the number in it now comes from fn_club_membership_cap(). The helpers
 * are SECURITY INVOKER with a fixed search_path and are executable by
 * service_role only: the browser reads the cap through the preflight.
 *
 * NOT IN SCOPE. fn_create_club_atomic (the wrapper) is untouched. The trigger
 * function keeps its misnomer; renaming it means rebuilding two triggers for
 * no behavioural gain. The VIP 'club_creation' catalogue row and its purchase
 * function belong to the commerce workstream; the client simply stops
 * offering a purchase nothing reads.
 *
 * Proven in an isolated cluster by scripts/ci/test-club-membership-cap.py:
 * preimage fidelity against these exact md5s, every cap boundary, departed
 * rows, the horse exemption, rejoin, two concurrent joins and a join racing a
 * create at 9 (exactly one lands), helper privileges, and a refused re-apply.
 */
--
-- HOW A READER SEES THIS IS LIVE. Each line below is read-only and must be true.
-- @live-proof: (SELECT btrim(prosrc) = 'SELECT 10' FROM pg_proc WHERE oid = to_regprocedure('public.fn_club_membership_cap()'))
-- @live-proof: md5(pg_get_functiondef(to_regprocedure('public.fn_enforce_four_club_limit()'))) = '6df4cf3478e10b3f108357567c25c98b'
-- @live-proof: md5(pg_get_functiondef(to_regprocedure('public.fn_join_club_membership_impl(uuid)'))) = 'dc9908bbe4447d2a455039efd2ff0137'
-- @live-proof: md5(pg_get_functiondef(to_regprocedure('public.fn_join_club(uuid)'))) = '005b11687350a0a98547a3593e556767'
-- @live-proof: md5(pg_get_functiondef(to_regprocedure('public.fn_create_club_atomic_membership_impl(uuid,text,text,text,boolean,boolean,text)'))) = 'c7c3d085e4cbd08af4f46974eca7ac3b'
-- @live-proof: md5(pg_get_functiondef(to_regprocedure('public.fn_get_club_creation_eligibility()'))) = '2c5c39204806455eff98dcdaf4d0b3a6'
-- @live-proof: (SELECT count(*) = 4 AND bool_and(NOT p.prosecdef AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE')) FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.fn_club_membership_cap()'), to_regprocedure('public.fn_club_membership_count(uuid,uuid)'), to_regprocedure('public.fn_club_membership_lock(uuid)'), to_regprocedure('public.fn_club_creation_open(uuid)')))
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The five functions this migration edits, pinned exactly as production
-- carries them on 2026-09-22 (scripts/ci/fixtures/club-membership-cap/preimage):
-- definition, owner, configuration, ACL and security mode. The substitutions
-- below are only correct against these bytes, so anything else stops here
-- rather than being patched blind. A second apply stops here too.
DO $pin$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.fn_enforce_four_club_limit()',
       '4c27b1c5f7b438dfa569699d19f2200a',
       ARRAY['search_path=public']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_join_club_membership_impl(uuid)',
       '3a88bf6f9a0bf5404b35bfd696f2df43',
       ARRAY['search_path=public, extensions']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_join_club(uuid)',
       'ee391ec320de04e62b71ebad8f97689d',
       ARRAY['search_path=public, extensions, pg_temp', 'lock_timeout=5s']::text[],
       '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
      ('public.fn_create_club_atomic_membership_impl(uuid,text,text,text,boolean,boolean,text)',
       '50f4cb747d53f6a1761732aff16734e7',
       ARRAY['search_path=public, extensions']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_get_club_creation_eligibility()',
       '61717e5a31cc3505b7bd41edd56dde6c',
       ARRAY['search_path=public']::text[],
       '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}')
    ) AS v(sig, def_md5, config, acl)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = to_regprocedure(r.sig)
         AND md5(pg_get_functiondef(p.oid)) = r.def_md5
         AND p.proowner = 'postgres'::regrole
         AND p.proconfig = r.config
         AND p.proacl::text = r.acl
         AND p.prosecdef
    ) THEN
      RAISE EXCEPTION 'CLUB_MEMBERSHIP_CAP_PREIMAGE_CHANGED: %', r.sig
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF to_regprocedure('public.fn_club_membership_cap()') IS NOT NULL
     OR to_regprocedure('public.fn_club_membership_count(uuid,uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_club_membership_lock(uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_club_creation_open(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'CLUB_MEMBERSHIP_CAP_HELPERS_ALREADY_EXIST' USING ERRCODE = '55000';
  END IF;
END $pin$;

-- ── The single authority ──────────────────────────────────────────────────
-- SECURITY INVOKER: every caller is a SECURITY DEFINER function owned by
-- postgres, so these read with the definer's rights and grant nothing new.

CREATE FUNCTION public.fn_club_membership_cap()
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $$ SELECT 10 $$;

-- A membership is a row the player holds now: active or approved, and not
-- departed. p_excluding_club leaves out the row being written, for the
-- trigger and for a rejoin.
CREATE FUNCTION public.fn_club_membership_count(p_user_id uuid, p_excluding_club uuid DEFAULT NULL)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $$
  SELECT count(*)::integer
    FROM public.club_members cm
   WHERE cm.user_id = p_user_id
     AND cm.status::text IN ('active', 'approved')
     AND COALESCE(cm.membership_lifecycle_status::text, 'active') = 'active'
     AND (p_excluding_club IS NULL OR cm.club_id <> p_excluding_club)
$$;

-- The key fn_create_club_atomic_membership_impl has taken since 2026-08-31,
-- kept so a caller on either side of this migration excludes the other.
CREATE FUNCTION public.fn_club_membership_lock(p_user_id uuid)
 RETURNS void
 LANGUAGE sql
 VOLATILE
 SET search_path TO 'pg_catalog'
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended(p_user_id::text, 77431))
$$;

-- The create_club rollout rule, exactly as fn_create_club_atomic_membership_impl
-- carried it inline, so the preflight and the create cannot disagree.
CREATE FUNCTION public.fn_club_creation_open(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.club_entry_feature_flags f WHERE f.key = 'create_club'
      AND (NOT f.enabled OR ((hashtextextended(p_user_id::text || ':' || f.key, 44119)
          & 9223372036854775807) % 100) >= f.rollout_percent)
  )
$$;

REVOKE ALL ON FUNCTION public.fn_club_membership_cap() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_club_membership_count(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_club_membership_lock(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_club_creation_open(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_membership_cap() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_membership_count(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_membership_lock(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_creation_open(uuid) TO service_role;

-- ── The four enforcing functions, by exact substitution ───────────────────
-- Each new text is pinned by md5 before it is executed and the installed
-- definition is pinned again after, so a substitution that matched nothing,
-- or matched twice, cannot install.
DO $patch$
DECLARE
  v_fn regprocedure;
  v_new text;
BEGIN
  -- 1. The trigger. The horse exemption and both early returns stay above it.
  v_fn := 'public.fn_enforce_four_club_limit()'::regprocedure;
  v_new := replace(pg_get_functiondef(v_fn),
$trg_old$  SELECT count(*) INTO v_count
    FROM club_members
   WHERE user_id = NEW.user_id
     AND status IN ('active', 'approved')
     AND club_id <> NEW.club_id;

  IF v_count >= 10 THEN
    RAISE EXCEPTION
      'You can only be a member of up to 10 clubs. Leave a club to join a new one.'
      USING ERRCODE = 'check_violation';
  END IF;
$trg_old$,
$trg_new$  PERFORM public.fn_club_membership_lock(NEW.user_id);
  v_count := public.fn_club_membership_count(NEW.user_id, NEW.club_id);

  IF v_count >= public.fn_club_membership_cap() THEN
    RAISE EXCEPTION
      'You can only be a member of up to % clubs. Leave a club to join a new one.',
      public.fn_club_membership_cap()
      USING ERRCODE = 'check_violation';
  END IF;
$trg_new$);
  IF md5(v_new) <> '6df4cf3478e10b3f108357567c25c98b' THEN
    RAISE EXCEPTION 'CLUB_MEMBERSHIP_CAP_PATCH_MISMATCH: %', v_fn USING ERRCODE = '55000';
  END IF;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> '6df4cf3478e10b3f108357567c25c98b' THEN
    RAISE EXCEPTION 'CLUB_MEMBERSHIP_CAP_INSTALL_MISMATCH: %', v_fn USING ERRCODE = '55000';
  END IF;

  -- 2. The join path. The owner branch still skips the cap.
  v_fn := 'public.fn_join_club_membership_impl(uuid)'::regprocedure;
  v_new := replace(pg_get_functiondef(v_fn),
$join_impl_old$    SELECT count(*) INTO v_active_count
      FROM club_members
      WHERE user_id = v_uid AND status IN ('active', 'approved');
    IF v_active_count >= 10 THEN
      RAISE EXCEPTION 'You can only be a member of up to 10 clubs. Leave a club to join a new one.';
    END IF;
$join_impl_old$,
$join_impl_new$    PERFORM public.fn_club_membership_lock(v_uid);
    v_active_count := public.fn_club_membership_count(v_uid);
    IF v_active_count >= public.fn_club_membership_cap() THEN
      RAISE EXCEPTION 'You can only be a member of up to % clubs. Leave a club to join a new one.',
        public.fn_club_membership_cap();
    END IF;
$join_impl_new$);
  IF md5(v_new) <> 'dc9908bbe4447d2a455039efd2ff0137' THEN
    RAISE EXCEPTION 'CLUB_MEMBERSHIP_CAP_PATCH_MISMATCH: %', v_fn USING ERRCODE = '55000';
  END IF;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> 'dc9908bbe4447d2a455039efd2ff0137' THEN
    RAISE EXCEPTION 'CLUB_MEMBERSHIP_CAP_INSTALL_MISMATCH: %', v_fn USING ERRCODE = '55000';
  END IF;

  -- 3. Rejoin after departure. The player lock is taken before the
  --    cashier-hierarchy lock, so it is first on every path.
  v_fn := 'public.fn_join_club(uuid)'::regprocedure;
  v_new := replace(replace(pg_get_functiondef(v_fn),
$join_lock_old$    IF coalesce(v_result ->> 'membership_lifecycle_status', 'active') = 'departed' THEN
      PERFORM pg_advisory_xact_lock(
$join_lock_old$,
$join_lock_new$    IF coalesce(v_result ->> 'membership_lifecycle_status', 'active') = 'departed' THEN
      PERFORM public.fn_club_membership_lock(v_uid);
      PERFORM pg_advisory_xact_lock(
$join_lock_new$),
$join_count_old$      SELECT count(*) INTO v_active_count
        FROM public.club_members cm
       WHERE cm.user_id = v_uid
         AND cm.club_id <> p_club_id
         AND cm.membership_lifecycle_status = 'active'
         AND cm.status::text IN ('active', 'approved');
      IF v_uid <> v_owner AND v_active_count >= 10 THEN
        RAISE EXCEPTION 'You can only be a member of up to 10 clubs. Leave a club to join a new one.';
      END IF;
$join_count_old$,
$join_count_new$      v_active_count := public.fn_club_membership_count(v_uid, p_club_id);
      IF v_uid <> v_owner AND v_active_count >= public.fn_club_membership_cap() THEN
        RAISE EXCEPTION 'You can only be a member of up to % clubs. Leave a club to join a new one.',
          public.fn_club_membership_cap();
      END IF;
$join_count_new$);
  IF md5(v_new) <> '005b11687350a0a98547a3593e556767' THEN
    RAISE EXCEPTION 'CLUB_MEMBERSHIP_CAP_PATCH_MISMATCH: %', v_fn USING ERRCODE = '55000';
  END IF;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> '005b11687350a0a98547a3593e556767' THEN
    RAISE EXCEPTION 'CLUB_MEMBERSHIP_CAP_INSTALL_MISMATCH: %', v_fn USING ERRCODE = '55000';
  END IF;

  -- 4. The create path: the rollout rule, the lock and the count.
  v_fn := 'public.fn_create_club_atomic_membership_impl(uuid,text,text,text,boolean,boolean,text)'::regprocedure;
  v_new := replace(replace(replace(pg_get_functiondef(v_fn),
$create_flag_old$  IF EXISTS (
    SELECT 1 FROM public.club_entry_feature_flags f WHERE f.key = 'create_club'
      AND (NOT f.enabled OR ((hashtextextended(v_uid::text || ':' || f.key, 44119)
          & 9223372036854775807) % 100) >= f.rollout_percent)
  ) THEN
$create_flag_old$,
$create_flag_new$  IF NOT public.fn_club_creation_open(v_uid) THEN
$create_flag_new$),
$create_lock_old$  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text, 77431));
$create_lock_old$,
$create_lock_new$  PERFORM public.fn_club_membership_lock(v_uid);
$create_lock_new$),
$create_count_old$  SELECT count(*) INTO v_memberships
    FROM public.club_members
   WHERE user_id = v_uid AND status IN ('active', 'approved');
  IF v_memberships >= 10 THEN
    RAISE EXCEPTION 'You can only be a member of up to 10 clubs. Leave a club to create a new one.'
      USING ERRCODE = '23514';
  END IF;
$create_count_old$,
$create_count_new$  v_memberships := public.fn_club_membership_count(v_uid);
  IF v_memberships >= public.fn_club_membership_cap() THEN
    RAISE EXCEPTION 'You can only be a member of up to % clubs. Leave a club to create a new one.',
      public.fn_club_membership_cap()
      USING ERRCODE = '23514';
  END IF;
$create_count_new$);
  IF md5(v_new) <> 'c7c3d085e4cbd08af4f46974eca7ac3b' THEN
    RAISE EXCEPTION 'CLUB_MEMBERSHIP_CAP_PATCH_MISMATCH: %', v_fn USING ERRCODE = '55000';
  END IF;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> 'c7c3d085e4cbd08af4f46974eca7ac3b' THEN
    RAISE EXCEPTION 'CLUB_MEMBERSHIP_CAP_INSTALL_MISMATCH: %', v_fn USING ERRCODE = '55000';
  END IF;
END $patch$;

-- ── The preflight, rewritten on the same helpers ──────────────────────────
-- Written in pg_get_functiondef's own form so its installed md5 is known in
-- advance. Same signature, STABLE, SECURITY DEFINER and search_path;
-- CREATE OR REPLACE keeps its owner and ACL, which the block below asserts.
CREATE OR REPLACE FUNCTION public.fn_get_club_creation_eligibility()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_cap integer := public.fn_club_membership_cap();
  v_count integer;
  v_open boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  v_count := public.fn_club_membership_count(v_uid);
  v_open := public.fn_club_creation_open(v_uid);
  RETURN jsonb_build_object(
    'membership_count', v_count,
    'limit', v_cap,
    'remaining', GREATEST(0, v_cap - v_count),
    'creation_open', v_open,
    'can_create', v_open AND v_count < v_cap,
    'reason', CASE
      WHEN NOT v_open THEN 'creation_unavailable'
      WHEN v_count >= v_cap THEN 'membership_cap'
    END
  );
END;
$function$;

-- ── The end state ─────────────────────────────────────────────────────────
DO $post$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.fn_enforce_four_club_limit()',
       '6df4cf3478e10b3f108357567c25c98b',
       ARRAY['search_path=public']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_join_club_membership_impl(uuid)',
       'dc9908bbe4447d2a455039efd2ff0137',
       ARRAY['search_path=public, extensions']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_join_club(uuid)',
       '005b11687350a0a98547a3593e556767',
       ARRAY['search_path=public, extensions, pg_temp', 'lock_timeout=5s']::text[],
       '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
      ('public.fn_create_club_atomic_membership_impl(uuid,text,text,text,boolean,boolean,text)',
       'c7c3d085e4cbd08af4f46974eca7ac3b',
       ARRAY['search_path=public, extensions']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_get_club_creation_eligibility()',
       '2c5c39204806455eff98dcdaf4d0b3a6',
       ARRAY['search_path=public']::text[],
       '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}')
    ) AS v(sig, def_md5, config, acl)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = to_regprocedure(r.sig)
         AND md5(pg_get_functiondef(p.oid)) = r.def_md5
         AND p.proowner = 'postgres'::regrole
         AND p.proconfig = r.config
         AND p.proacl::text = r.acl
         AND p.prosecdef
         -- One authority: the number, the count and the rollout rule live in
         -- the helpers and nowhere in these bodies.
         AND p.prosrc LIKE '%public.fn_club_membership_cap()%'
         AND p.prosrc LIKE '%public.fn_club_membership_count(%'
         AND p.prosrc NOT LIKE '%up to 10 clubs%'
         AND p.prosrc NOT LIKE '%count(*)%'
         AND p.prosrc NOT LIKE '%77431%'
         AND p.prosrc NOT LIKE '%club_entry_feature_flags%'
    ) THEN
      RAISE EXCEPTION 'CLUB_MEMBERSHIP_CAP_POSTIMAGE_REFUSED: %', r.sig
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF (SELECT provolatile FROM pg_proc
       WHERE oid = 'public.fn_get_club_creation_eligibility()'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'CLUB_MEMBERSHIP_CAP_PREFLIGHT_NOT_STABLE' USING ERRCODE = '55000';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('public.fn_club_membership_cap()', 'i'),
      ('public.fn_club_membership_count(uuid,uuid)', 's'),
      ('public.fn_club_membership_lock(uuid)', 'v'),
      ('public.fn_club_creation_open(uuid)', 's')
    ) AS v(sig, volatility)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = to_regprocedure(r.sig)
         AND NOT p.prosecdef
         AND p.provolatile = r.volatility
         AND p.proconfig = ARRAY['search_path=pg_catalog']::text[]
         AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
         AND has_function_privilege('service_role', p.oid, 'EXECUTE')
    ) THEN
      RAISE EXCEPTION 'CLUB_MEMBERSHIP_CAP_HELPER_REFUSED: %', r.sig
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF public.fn_club_membership_cap() IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION 'CLUB_MEMBERSHIP_CAP_IS_NOT_TEN' USING ERRCODE = '55000';
  END IF;
END $post$;

COMMIT;
