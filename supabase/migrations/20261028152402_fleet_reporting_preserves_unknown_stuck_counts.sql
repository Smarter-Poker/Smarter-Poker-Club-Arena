-- @live-proof: md5(pg_get_functiondef('public.fn_sp_daily_metrics_compute(date)'::regprocedure))='84156c6c99e30404658633d6fa53d064' AND md5(pg_get_functiondef('public.fn_sp_digest_attention(date,jsonb)'::regprocedure))='9ec3954ba017fcee7ff7d8a6f530b2aa'
-- Preserve unknown stuck-horse counts in the producer and attention consumer.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
DO $change$
DECLARE d text; m jsonb;
BEGIN
 d:=pg_get_functiondef('public.fn_sp_daily_metrics_compute(date)'::regprocedure);
 IF md5(d) IS DISTINCT FROM 'b3e73a2b6a93d2bde0d18b4aea540a7e' THEN RAISE EXCEPTION 'October27 reporting source changed: fn_sp_daily_metrics_compute'; END IF;
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'secdef',prosecdef,'volatility',provolatile) INTO m FROM pg_proc WHERE oid='public.fn_sp_daily_metrics_compute(date)'::regprocedure;
 IF (length(d)-length(replace(d,$old$'max_stuck', COALESCE(max(horses_stuck),0)$old$,'')))/length($old$'max_stuck', COALESCE(max(horses_stuck),0)$old$)<>1 THEN RAISE EXCEPTION 'reporting anchor changed'; END IF;
 EXECUTE replace(d,$old$'max_stuck', COALESCE(max(horses_stuck),0)$old$,$new$'max_stuck', max(horses_stuck), 'unknown_stuck_beats', count(*) FILTER (WHERE horses_stuck IS NULL), 'stuck_samples', count(horses_stuck)$new$);
 IF m IS DISTINCT FROM (SELECT jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'secdef',prosecdef,'volatility',provolatile) FROM pg_proc WHERE oid='public.fn_sp_daily_metrics_compute(date)'::regprocedure) THEN RAISE EXCEPTION 'reporting metadata changed'; END IF;
END $change$;
DO $change$
DECLARE d text; m jsonb;
BEGIN
 d:=pg_get_functiondef('public.fn_sp_digest_attention(date,jsonb)'::regprocedure);
 IF md5(d) IS DISTINCT FROM 'aa8ff7ce72f217fef3c73cbe2292d68a' THEN RAISE EXCEPTION 'October27 reporting source changed: fn_sp_digest_attention'; END IF;
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'secdef',prosecdef,'volatility',provolatile) INTO m FROM pg_proc WHERE oid='public.fn_sp_digest_attention(date,jsonb)'::regprocedure;
 IF (length(d)-length(replace(d,$old$format('Horse fleet degraded on %s heartbeats, up to %s horses stuck', COALESCE(v,0), COALESCE(v2,0))$old$,'')))/length($old$format('Horse fleet degraded on %s heartbeats, up to %s horses stuck', COALESCE(v,0), COALESCE(v2,0))$old$)<>1 THEN RAISE EXCEPTION 'reporting anchor changed'; END IF;
 EXECUTE replace(d,$old$format('Horse fleet degraded on %s heartbeats, up to %s horses stuck', COALESCE(v,0), COALESCE(v2,0))$old$,$new$CASE WHEN COALESCE((p_metrics#>>'{play,horse_fleet,unknown_stuck_beats}')::numeric,-1)<>0 OR v2 IS NULL THEN format('Horse fleet degraded on %s heartbeats; stuck-horse count unavailable', COALESCE(v,0)) ELSE format('Horse fleet degraded on %s heartbeats, up to %s horses stuck', COALESCE(v,0), v2) END$new$);
 IF m IS DISTINCT FROM (SELECT jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'secdef',prosecdef,'volatility',provolatile) FROM pg_proc WHERE oid='public.fn_sp_digest_attention(date,jsonb)'::regprocedure) THEN RAISE EXCEPTION 'reporting metadata changed'; END IF;
END $change$;
COMMIT;
