-- Hand-history retention uses the existing settlement installation lane.
-- The periodic pruner held a chip-ledger reader for about 21 seconds every
-- 30 seconds, preventing the qualified scoped launch schema from acquiring
-- its bounded DDL lock. Honor the original lane at the original entry point;
-- an existing prune completes naturally, and a new prune returns zero while
-- the installer owns the exclusive lane. Schedule, retention, budget, deletion
-- predicates, owner, permissions and SECURITY INVOKER remain unchanged.
-- Exact original definition and authority refuse drift or replay.
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid))='c978edad9c8a6b2e93a4cb3016ab96ec' AND pg_get_userbyid(p.proowner)='postgres' AND NOT p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp'] FROM pg_proc p WHERE p.oid=to_regprocedure('public.sp_prune_hand_history(integer)')) IS TRUE
BEGIN;
SET LOCAL lock_timeout = '4s';
DO $pruner_lane$
DECLARE d text; authority jsonb; post_authority jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'config',proconfig) INTO d,authority FROM pg_proc WHERE oid='public.sp_prune_hand_history(integer)'::regprocedure;
 IF md5(d) IS DISTINCT FROM '3f757199522df9cc1bea6d3b4d378129' THEN RAISE EXCEPTION 'PRUNER_SETTLEMENT_LANE_SOURCE_CHANGED' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.sp_prune_hand_history(integer)'::regprocedure AND proowner='postgres'::regrole AND NOT prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'PRUNER_SETTLEMENT_LANE_AUTHORITY_CHANGED'; END IF;
 IF position('horse_retention_days' in d)=0 OR position('hand_history_retention_policy' in d)=0 THEN RAISE EXCEPTION 'PRUNER_RETENTION_POLICY_SOURCE_CHANGED'; END IF;
 IF (length(d)-length(replace(d,E'BEGIN\n','')))/length(E'BEGIN\n')<>1 THEN RAISE EXCEPTION 'PRUNER_SETTLEMENT_LANE_ANCHOR_CHANGED'; END IF;
 EXECUTE replace(d,E'BEGIN\n',E'BEGIN\n  -- Preserve the original maintenance/settlement owner before any ledger read.\n  IF pg_catalog.pg_try_advisory_xact_lock_shared(530090,1) IS NOT TRUE THEN RETURN 0; END IF;\n');
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'config',proconfig) INTO post_authority FROM pg_proc WHERE oid='public.sp_prune_hand_history(integer)'::regprocedure;
 IF authority IS DISTINCT FROM post_authority THEN RAISE EXCEPTION 'PRUNER_SETTLEMENT_LANE_AUTHORITY_CHANGED'; END IF;
END $pruner_lane$;

COMMIT;
