-- Ordinary transient maintenance-lane writers must not discard private original continuations.
-- Bounded one-second wait on the SAME first shared lane; freeze and every financial/lease guard unchanged.
-- @live-proof: (SELECT count(*)=3 FROM pg_proc p WHERE ((p.oid='public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)'::regprocedure AND md5(pg_get_functiondef(p.oid))='90ddd69be6ba6378789f2e4ab0aa6fea' AND md5(p.prosrc)='42dc66013ad08ec677bf1bd0c2fd6fe6') OR (p.oid='public.fn_f06_claim_legacy_river_continuation(uuid,uuid,uuid,bigint,timestamp with time zone,text,text)'::regprocedure AND md5(pg_get_functiondef(p.oid))='7b3426f016bbb3d9146d4763bae68b4c' AND md5(p.prosrc)='a11893306c2e8d594fde5c9d2382c8a5') OR (p.oid='public.fn_f06_retain_hand_continuation(uuid,uuid,uuid,bigint,bigint,text,text)'::regprocedure AND md5(pg_get_functiondef(p.oid))='e5001407fe6ae37667f73a292812985d' AND md5(p.prosrc)='e53111a8d13236f9a107df003177496f')) AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.lock_hand_continuation_maintenance_lane()') AND p.proowner='postgres'::regrole AND NOT p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog','lock_timeout=1s'] AND position('pg_advisory_xact_lock_shared(530090,1)' IN p.prosrc)>0)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $pre$ BEGIN IF to_regprocedure('smarter_private.lock_hand_continuation_maintenance_lane()') IS NOT NULL THEN RAISE EXCEPTION 'HAND_CONTINUATION_WAIT_HELPER_EXISTS'; END IF; END $pre$;
CREATE FUNCTION smarter_private.lock_hand_continuation_maintenance_lane() RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog SET lock_timeout='1s' AS $wait$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(530090,1);
END $wait$;
REVOKE ALL ON FUNCTION smarter_private.lock_hand_continuation_maintenance_lane() FROM PUBLIC,anon,authenticated,service_role;
DO $replace$ DECLARE f regprocedure;d text;BEGIN
 f:='public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)'::regprocedure;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f AND md5(pg_get_functiondef(p.oid))='a633c51983e18c18de73be2caf75bc9c' AND md5(p.prosrc)='e561f72118832e3d513903983acd42a1' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'HAND_CONTINUATION_WAIT_PREIMAGE_CHANGED' USING ERRCODE='55000'; END IF;
 d:=pg_get_functiondef(f);
 IF (length(d)-length(replace(d,'IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
    RAISE EXCEPTION ''HAND_CONTINUATION_MAINTENANCE_BUSY'' USING ERRCODE=''55P03''; END IF;','')))<>length('IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
    RAISE EXCEPTION ''HAND_CONTINUATION_MAINTENANCE_BUSY'' USING ERRCODE=''55P03''; END IF;') THEN RAISE EXCEPTION 'HAND_CONTINUATION_WAIT_SHAPE_CHANGED';END IF;
 EXECUTE replace(d,'IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
    RAISE EXCEPTION ''HAND_CONTINUATION_MAINTENANCE_BUSY'' USING ERRCODE=''55P03''; END IF;','PERFORM smarter_private.lock_hand_continuation_maintenance_lane();');
 f:='public.fn_f06_claim_legacy_river_continuation(uuid,uuid,uuid,bigint,timestamp with time zone,text,text)'::regprocedure;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f AND md5(pg_get_functiondef(p.oid))='49b9c2f115e09bc16059b24ad7f2bdd4' AND md5(p.prosrc)='86b19a549c49eddc14722a841a5a3183' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'HAND_CONTINUATION_WAIT_PREIMAGE_CHANGED' USING ERRCODE='55000'; END IF;
 d:=pg_get_functiondef(f);
 IF (length(d)-length(replace(d,'IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
  RAISE EXCEPTION ''HAND_CONTINUATION_MAINTENANCE_BUSY'' USING ERRCODE=''55P03''; END IF;','')))<>length('IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
  RAISE EXCEPTION ''HAND_CONTINUATION_MAINTENANCE_BUSY'' USING ERRCODE=''55P03''; END IF;') THEN RAISE EXCEPTION 'HAND_CONTINUATION_WAIT_SHAPE_CHANGED';END IF;
 EXECUTE replace(d,'IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
  RAISE EXCEPTION ''HAND_CONTINUATION_MAINTENANCE_BUSY'' USING ERRCODE=''55P03''; END IF;','PERFORM smarter_private.lock_hand_continuation_maintenance_lane();');
 f:='public.fn_f06_retain_hand_continuation(uuid,uuid,uuid,bigint,bigint,text,text)'::regprocedure;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f AND md5(pg_get_functiondef(p.oid))='a3c4bb0187c9433e4e93712d0a6f3ae6' AND md5(p.prosrc)='47f09d17c6466d5c47855778e403244e' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'HAND_CONTINUATION_WAIT_PREIMAGE_CHANGED' USING ERRCODE='55000'; END IF;
 d:=pg_get_functiondef(f);
 IF (length(d)-length(replace(d,'IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
    RAISE EXCEPTION ''HAND_CONTINUATION_MAINTENANCE_BUSY'' USING ERRCODE=''55P03''; END IF;','')))<>length('IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
    RAISE EXCEPTION ''HAND_CONTINUATION_MAINTENANCE_BUSY'' USING ERRCODE=''55P03''; END IF;') THEN RAISE EXCEPTION 'HAND_CONTINUATION_WAIT_SHAPE_CHANGED';END IF;
 EXECUTE replace(d,'IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
    RAISE EXCEPTION ''HAND_CONTINUATION_MAINTENANCE_BUSY'' USING ERRCODE=''55P03''; END IF;','PERFORM smarter_private.lock_hand_continuation_maintenance_lane();');
 IF NOT ((SELECT count(*)=3 FROM pg_proc p WHERE ((p.oid='public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)'::regprocedure AND md5(pg_get_functiondef(p.oid))='90ddd69be6ba6378789f2e4ab0aa6fea' AND md5(p.prosrc)='42dc66013ad08ec677bf1bd0c2fd6fe6') OR (p.oid='public.fn_f06_claim_legacy_river_continuation(uuid,uuid,uuid,bigint,timestamp with time zone,text,text)'::regprocedure AND md5(pg_get_functiondef(p.oid))='7b3426f016bbb3d9146d4763bae68b4c' AND md5(p.prosrc)='a11893306c2e8d594fde5c9d2382c8a5') OR (p.oid='public.fn_f06_retain_hand_continuation(uuid,uuid,uuid,bigint,bigint,text,text)'::regprocedure AND md5(pg_get_functiondef(p.oid))='e5001407fe6ae37667f73a292812985d' AND md5(p.prosrc)='e53111a8d13236f9a107df003177496f')) AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.lock_hand_continuation_maintenance_lane()') AND p.proowner='postgres'::regrole AND NOT p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog','lock_timeout=1s'] AND position('pg_advisory_xact_lock_shared(530090,1)' IN p.prosrc)>0)) THEN RAISE EXCEPTION 'HAND_CONTINUATION_WAIT_POSTIMAGE_CHANGED'; END IF;
END $replace$;
COMMIT;
