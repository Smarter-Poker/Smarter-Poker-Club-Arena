-- Version reserved by scripts/new-migration.mjs; only the reserved slug renamed.
-- The locked-batch cache cast and linearly searched all requested UUIDs inside
-- every tuple iteration. Build the bounded requested-hand key set once after
-- original input validation. All qualification, caps and authority stay intact.
-- @live-proof: COALESCE((SELECT md5(pg_get_functiondef(p.oid)) = 'a616a19fcae4cd91485d2a66d781b3fa' AND p.proowner = 'postgres'::regrole AND p.prosecdef AND p.proacl::text = '{postgres=X/postgres}' AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private','lock_timeout=2s'] FROM pg_proc p WHERE p.oid = to_regprocedure('smarter_private.purge_legacy_horse_learning(uuid[])')), false)
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $patch$
DECLARE p pg_proc; src text; original text; replacement text;
BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid='smarter_private.purge_legacy_horse_learning(uuid[])'::regprocedure;
 IF md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM '71e06db3bd454096fbd7bd605b9c0631'
 OR p.proowner<>'postgres'::regrole OR NOT p.prosecdef
 OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, smarter_private','lock_timeout=2s']
 THEN RAISE EXCEPTION 'LEGACY_REQUESTED_SET_PREIMAGE_CHANGED'; END IF;
 src:=pg_get_functiondef(p.oid);
 original:=' cache_bad boolean;';
 replacement:=' cache_bad boolean; requested_hands jsonb;';
 IF (length(src)-length(replace(src,original,'')))/length(original)<>1
 THEN RAISE EXCEPTION 'LEGACY_REQUESTED_SET_DECLARATION_CHANGED'; END IF;
 src:=replace(src,original,replacement);
 original:=$old$ THEN RAISE EXCEPTION 'LEGACY_LEARNING_INVALID_IDS'; END IF;
$old$;
 replacement:=$new$ THEN RAISE EXCEPTION 'LEGACY_LEARNING_INVALID_IDS'; END IF;
 SELECT COALESCE(jsonb_object_agg(h::text,true),'{}'::jsonb) INTO requested_hands FROM unnest(p_hand_ids) h;
$new$;
 IF (length(src)-length(replace(src,original,'')))/length(original)<>1
 THEN RAISE EXCEPTION 'LEGACY_REQUESTED_SET_VALIDATION_CHANGED'; END IF;
 src:=replace(src,original,replacement);
 original:='IF cache_hand=ANY(p_hand_ids::text[]) THEN';
 replacement:='IF requested_hands ? cache_hand THEN';
 IF (length(src)-length(replace(src,original,'')))/length(original)<>1
 THEN RAISE EXCEPTION 'LEGACY_REQUESTED_SET_MEMBERSHIP_CHANGED'; END IF;
 EXECUTE replace(src,original,replacement);
END $patch$;
COMMIT;
