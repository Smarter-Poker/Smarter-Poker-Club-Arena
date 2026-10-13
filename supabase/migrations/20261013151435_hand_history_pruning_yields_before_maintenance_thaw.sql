-- Hand-history pruning yields before the original maintenance thaw.
-- Repeated live witnesses showed this pruner holding the shared 530090/1
-- lane while the original thaw waited for exclusive admission. Return before
-- that lane and all policy/accounting reads during a known or unknown freeze,
-- then recheck after admission. Preserve the original retained-human and
-- accounting predicates, work bounds, schedule, invoker authority and grants.
-- Exact source and authority checks refuse drift and migration replay.
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid))='d899ca6bd7ded6ca33850c6d6e59ffed' AND pg_get_userbyid(p.proowner)='postgres' AND NOT p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp'] FROM pg_proc p WHERE p.oid=to_regprocedure('public.sp_prune_hand_history(integer)')) IS TRUE
BEGIN;
SET LOCAL lock_timeout = '4s';
DO $pruner_frozen_entry$
DECLARE
  source text;
  authority jsonb;
  post_authority jsonb;
  original_entry constant text := $original_entry$  -- Preserve the original maintenance/settlement owner before any ledger read.
  IF pg_catalog.pg_try_advisory_xact_lock_shared(530090,1) IS NOT TRUE THEN RETURN 0; END IF;
$original_entry$;
  guarded_entry constant text := $guarded_entry$  -- Retention never holds the maintenance lane while the platform is frozen.
  IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RETURN 0; END IF;
  -- Preserve the original maintenance/settlement owner before any ledger read.
  IF pg_catalog.pg_try_advisory_xact_lock_shared(530090,1) IS NOT TRUE THEN RETURN 0; END IF;
  -- Recheck after admission before the policy and accounting reads.
  IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RETURN 0; END IF;
$guarded_entry$;
BEGIN
  SELECT pg_get_functiondef(oid), jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'config',proconfig)
    INTO source, authority FROM pg_proc
   WHERE oid='public.sp_prune_hand_history(integer)'::regprocedure;
  IF md5(source) IS DISTINCT FROM 'c978edad9c8a6b2e93a4cb3016ab96ec' THEN
    RAISE EXCEPTION 'PRUNER_FROZEN_ENTRY_SOURCE_CHANGED' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.sp_prune_hand_history(integer)'::regprocedure
      AND proowner='postgres'::regrole AND NOT prosecdef
      AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'PRUNER_FROZEN_ENTRY_AUTHORITY_CHANGED';
  END IF;
  IF strpos(source,'horse_retention_days')=0 THEN
    RAISE EXCEPTION 'PRUNER_FROZEN_ENTRY_RETENTION_CONFIG_CHANGED';
  END IF;
  IF (length(source)-length(replace(source,original_entry,'')))/length(original_entry)<>1 THEN
    RAISE EXCEPTION 'PRUNER_FROZEN_ENTRY_ANCHOR_CHANGED';
  END IF;
  EXECUTE replace(source,original_entry,guarded_entry);
  SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'config',proconfig)
    INTO post_authority FROM pg_proc WHERE oid='public.sp_prune_hand_history(integer)'::regprocedure;
  IF authority IS DISTINCT FROM post_authority OR
      md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure)) IS DISTINCT FROM 'd899ca6bd7ded6ca33850c6d6e59ffed' THEN
    RAISE EXCEPTION 'PRUNER_FROZEN_ENTRY_POSTIMAGE_CHANGED';
  END IF;
END $pruner_frozen_entry$;
COMMIT;
