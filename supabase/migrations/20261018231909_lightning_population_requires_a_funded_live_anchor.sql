-- Version reserved by scripts/new-migration.mjs.
-- Phase 4 defines live eligibility as players who can be dealt right now:
-- a busted anchor is not eligible. The pool UNION bypassed that same rule.
-- Reuse the existing authoritative anchor predicate in both scalar and
-- breakdown readers. Keep the board count, thresholds, actors and money.
-- Count only live instances in the in-hand breakdown; abandoned hands are
-- historical records, not players still in a hand.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_cash_cluster_live_eligible(uuid,timestamp with time zone,integer)'::regprocedure))='fd042fee12ec1e87f8380de382d5203d' AND md5(pg_get_functiondef('public.fn_cash_cluster_population(uuid,timestamp with time zone,integer)'::regprocedure))='72b9f512aff4bb327d29ece2fd57dcf9')
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
    OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL THEN
   RAISE EXCEPTION 'funded_population_operator_refused';
 END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL
    OR public.fn_platform_frozen() IS DISTINCT FROM false
    OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN
   RAISE EXCEPTION 'funded_population_freeze_or_override_refused';
 END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261018231909') THEN
   RAISE EXCEPTION 'funded_population_migration_replay_refused';
 END IF;
END $guard$;
CREATE FUNCTION pg_temp.funded_population_patch(sig regprocedure, pre text, post text,
                                                old text[], new text[], expected integer[])
RETURNS void LANGUAGE plpgsql AS $body$
DECLARE before text:=pg_get_functiondef(sig); after text; security_before jsonb; k integer;
BEGIN
 IF md5(before)<>pre THEN RAISE EXCEPTION 'funded_population_preimage_refused: %',sig; END IF;
 SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl)
   INTO security_before FROM pg_proc WHERE oid=sig;
 IF cardinality(old) IS DISTINCT FROM cardinality(new)
    OR cardinality(old) IS DISTINCT FROM cardinality(expected) THEN
   RAISE EXCEPTION 'funded_population_patch_shape_refused';
 END IF;
 after:=before;
 FOR k IN 1..cardinality(old) LOOP
   IF (length(after)-length(replace(after,old[k],'')))/length(old[k])<>expected[k] THEN
     RAISE EXCEPTION 'funded_population_anchor_refused: %/%',sig,k;
   END IF;
   after:=replace(after,old[k],new[k]);
 END LOOP;
 IF md5(after)<>post THEN RAISE EXCEPTION 'funded_population_derived_postimage_refused'; END IF;
 EXECUTE after;
 IF md5(pg_get_functiondef(sig))<>post OR
    (SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl)
       FROM pg_proc WHERE oid=sig) IS DISTINCT FROM security_before THEN
   RAISE EXCEPTION 'funded_population_postimage_or_security_refused';
 END IF;
END $body$;
SELECT pg_temp.funded_population_patch(
 'public.fn_cash_cluster_live_eligible(uuid,timestamp with time zone,integer)'::regprocedure,
 '40758904adab24fc2d37c6885d0b1cb6','fd042fee12ec1e87f8380de382d5203d',
 ARRAY[$a$              AND s.state NOT IN ('joining', 'eligibility_check', 'sit_out', 'disconnected', 'leaving', 'closed')$a$],ARRAY[$b$              AND s.state NOT IN ('joining', 'eligibility_check', 'sit_out', 'disconnected', 'leaving', 'closed')
              AND public.fn_lightning_anchor_is_live_eligible(s.anchor_seat_id, g.id, s.player_id)$b$],ARRAY[1]);
SELECT pg_temp.funded_population_patch(
 'public.fn_cash_cluster_population(uuid,timestamp with time zone,integer)'::regprocedure,
 '42d6a3fde2a0a075acdc1c557b433aa4','72b9f512aff4bb327d29ece2fd57dcf9',
 ARRAY[$a$     AND s.exited_at IS NULL AND s.state = 'active'$a$,$a$    JOIN public.lightning_hand h ON h.hand_id = hp.hand_id
   WHERE h.cluster_id$a$],
 ARRAY[$b$     AND s.exited_at IS NULL AND s.state = 'active'
     AND public.fn_lightning_anchor_is_live_eligible(s.anchor_seat_id, g.id, s.player_id)$b$,$b$    JOIN public.lightning_hand h ON h.hand_id = hp.hand_id
    JOIN public.lightning_instance i ON i.id = h.lightning_instance_id
      AND i.state IN ('forming', 'reserved', 'dealing', 'settling')
   WHERE h.cluster_id$b$],ARRAY[3,1]);
COMMIT;
