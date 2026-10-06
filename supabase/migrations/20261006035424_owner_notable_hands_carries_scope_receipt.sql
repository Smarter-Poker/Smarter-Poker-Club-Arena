-- 20261006035424_owner_notable_hands_carries_scope_receipt.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The club-scoped notable-hands reader already returns a v2 envelope naming
-- target user, club, asset and owner visibility. The all-clubs wrapper still
-- returned the inner reader's bare array, so the client could not prove that a
-- successful response belonged to the request before rendering evidence links.
-- Return the same scoped envelope from the all-clubs owner door. The inner
-- hand query, ordering, cap, self assertion, owner, grants and search path do
-- not change.
--
-- @live-proof: (SELECT position('''contract_version'', 2' in p.prosrc) > 0 AND position('''target_user_id'', p_user' in p.prosrc) > 0 AND position('''club_id'', NULL' in p.prosrc) > 0 AND position('''hands'', v_hands' in p.prosrc) > 0 AND pg_get_userbyid(p.proowner) = 'postgres' AND p.prosecdef AND p.provolatile = 's' AND p.proparallel = 'u' AND p.proconfig::text = '{search_path=public}' AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}' AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.oid = 'public.ca_player_hands_v2(uuid,text,integer,text)'::regprocedure)
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $owner_notable_hands_preimage$
DECLARE
  v_sig regprocedure := 'public.ca_player_hands_v2(uuid,text,integer,text)'::regprocedure;
  v_body text;
  v_expected constant text := $body$
BEGIN
  PERFORM public.ca_assert_self(p_user);
  IF p_asset IS NULL OR p_asset NOT IN ('chips', 'diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';
  END IF;
  RETURN public.ca_player_hands(p_user, p_mode, p_limit, p_asset);
END;
$body$;
BEGIN
  SELECT p.prosrc
    INTO STRICT v_body
    FROM pg_proc p
   WHERE p.oid = v_sig
     AND md5(p.prosrc) = 'cdd7a58bc4b701536dd30829454d8de7'
     AND md5(pg_get_functiondef(p.oid)) = '73e224ac3c79cbb564ea45ae9cebb14f'
     AND pg_get_userbyid(p.proowner) = 'postgres'
     AND p.prosecdef
     AND p.provolatile = 's'
     AND p.proparallel = 'u'
     AND p.proconfig::text = '{search_path=public}'
     AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}'
     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND has_function_privilege('service_role', p.oid, 'EXECUTE');

  IF v_body IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'OWNER_NOTABLE_HANDS_PREIMAGE_DRIFT: %', v_sig;
  END IF;
END
$owner_notable_hands_preimage$;

CREATE OR REPLACE FUNCTION public.ca_player_hands_v2(
  p_user uuid,
  p_mode text DEFAULT 'recent'::text,
  p_limit integer DEFAULT 25,
  p_asset text DEFAULT 'chips'::text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_hands jsonb;
BEGIN
  PERFORM public.ca_assert_self(p_user);
  IF p_asset IS NULL OR p_asset NOT IN ('chips', 'diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';
  END IF;

  v_hands := public.ca_player_hands(p_user, p_mode, p_limit, p_asset);
  IF jsonb_typeof(v_hands) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'owner notable hands returned a malformed inner payload';
  END IF;

  RETURN jsonb_build_object(
    'contract_version', 2,
    'scope', jsonb_build_object(
      'target_user_id', p_user,
      'club_id', NULL,
      'asset', p_asset,
      'visibility', 'owner'
    ),
    'hands', v_hands,
    'generated_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_player_hands_v2(uuid,text,integer,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_player_hands_v2(uuid,text,integer,text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ca_player_hands_v2(uuid,text,integer,text) IS
  'Owner-only notable-hand evidence in one asset. Returns contract v2 request scope and a bounded all-clubs hand list; hole cards remain the owner''s own only.';

DO $owner_notable_hands_postimage$
DECLARE
  v_sig regprocedure := 'public.ca_player_hands_v2(uuid,text,integer,text)'::regprocedure;
  v_body text;
BEGIN
  SELECT p.prosrc
    INTO STRICT v_body
    FROM pg_proc p
   WHERE p.oid = v_sig
     AND pg_get_userbyid(p.proowner) = 'postgres'
     AND p.prosecdef
     AND p.provolatile = 's'
     AND p.proparallel = 'u'
     AND p.proconfig::text = '{search_path=public}'
     AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}'
     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND has_function_privilege('service_role', p.oid, 'EXECUTE');

  IF position('v_hands := public.ca_player_hands(p_user, p_mode, p_limit, p_asset);' in v_body) = 0
     OR position('jsonb_typeof(v_hands) IS DISTINCT FROM ''array''' in v_body) = 0
     OR position('''contract_version'', 2' in v_body) = 0
     OR position('''target_user_id'', p_user' in v_body) = 0
     OR position('''club_id'', NULL' in v_body) = 0
     OR position('''asset'', p_asset' in v_body) = 0
     OR position('''visibility'', ''owner''' in v_body) = 0
     OR position('''hands'', v_hands' in v_body) = 0 THEN
    RAISE EXCEPTION 'OWNER_NOTABLE_HANDS_POSTIMAGE_DRIFT: %', v_sig;
  END IF;
END
$owner_notable_hands_postimage$;

COMMIT;
