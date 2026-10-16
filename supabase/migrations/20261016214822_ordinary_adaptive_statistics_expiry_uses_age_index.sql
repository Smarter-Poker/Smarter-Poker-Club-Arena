-- Expiry must use the existing age index even when no old statistics exist.
-- Compute one conservative cutoff at the expiry stage, after hand retirement.
-- @live-proof: COALESCE((SELECT md5(pg_get_functiondef(p.oid)) = 'c0631cff4a00f33fce8ab06aacac0a7e' AND p.proowner = 'postgres'::regrole AND p.prosecdef AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private','lock_timeout=2s'] FROM pg_proc p WHERE p.oid = to_regprocedure('public.fn_prune_horse_adaptive_journal()')), false)
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $patch$
DECLARE p pg_proc; src text; original text; replacement text;
BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid='public.fn_prune_horse_adaptive_journal()'::regprocedure;
 IF md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM '70231d2cc066971c13a269b5cc374be8'
 OR p.proowner<>'postgres'::regrole OR NOT p.prosecdef
 OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, smarter_private','lock_timeout=2s']
 THEN RAISE EXCEPTION 'ADAPTIVE_EXPIRY_INDEX_PREIMAGE_CHANGED'; END IF;
 src:=pg_get_functiondef(p.oid);
 original:=$before$ retired_hands text[]:='{}'; kept jsonb;$before$;
 replacement:=$after$ retired_hands text[]:='{}'; kept jsonb; statistics_cutoff_ms bigint;$after$;
 IF (length(src)-length(replace(src,original,'')))/length(original)<>1
 THEN RAISE EXCEPTION 'ADAPTIVE_EXPIRY_INDEX_ANCHOR_1_CHANGED'; END IF;
 src:=replace(src,original,replacement);
 original:=$before$ IF clock_timestamp()<deadline THEN
  WITH expired AS$before$;
 replacement:=$after$ statistics_cutoff_ms:=floor(extract(epoch FROM (clock_timestamp()-interval '30 days'))*1000)::bigint;
 IF clock_timestamp()<deadline THEN
  WITH expired AS$after$;
 IF (length(src)-length(replace(src,original,'')))/length(original)<>1
 THEN RAISE EXCEPTION 'ADAPTIVE_EXPIRY_INDEX_ANCHOR_2_CHANGED'; END IF;
 src:=replace(src,original,replacement);
 original:=$before$WHERE observed_at_ms<floor(extract(epoch FROM (clock_timestamp()-interval '30 days'))*1000)::bigint LIMIT 1000)$before$;
 replacement:=$after$WHERE observed_at_ms<statistics_cutoff_ms LIMIT 1000)$after$;
 IF (length(src)-length(replace(src,original,'')))/length(original)<>1
 THEN RAISE EXCEPTION 'ADAPTIVE_EXPIRY_INDEX_ANCHOR_3_CHANGED'; END IF;
 src:=replace(src,original,replacement);
 original:=$before$IF EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_statistics
   WHERE observed_at_ms<floor(extract(epoch FROM (clock_timestamp()-interval '30 days'))*1000)::bigint LIMIT 1)$before$;
 replacement:=$after$IF (SELECT min(observed_at_ms) FROM smarter_private.horse_adaptive_statistics)<statistics_cutoff_ms$after$;
 IF (length(src)-length(replace(src,original,'')))/length(original)<>1
 THEN RAISE EXCEPTION 'ADAPTIVE_EXPIRY_INDEX_ANCHOR_4_CHANGED'; END IF;
 src:=replace(src,original,replacement);
 EXECUTE src;
END $patch$;
COMMIT;
