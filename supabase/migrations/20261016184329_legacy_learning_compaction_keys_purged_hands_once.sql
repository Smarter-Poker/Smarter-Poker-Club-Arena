-- Reserved by scripts/new-migration.mjs against current main and remote heads.
-- The final batch filter still cast and linearly searched the purged UUID array
-- for each tuple. Build that bounded set once after accepted IDs are finalized.
-- Preserve the original NOT COALESCE(...,false): NULL and empty-set tuples stay.
-- @live-proof: COALESCE((SELECT md5(pg_get_functiondef(p.oid)) = 'fd6116d9a8765321a31883cdbf531bed' AND p.proowner = 'postgres'::regrole AND p.prosecdef AND p.proacl::text = '{postgres=X/postgres}' AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private','lock_timeout=2s'] FROM pg_proc p WHERE p.oid = to_regprocedure('smarter_private.purge_legacy_horse_learning(uuid[])')), false)
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $patch$
DECLARE p pg_proc; src text; original text; replacement text;
BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid='smarter_private.purge_legacy_horse_learning(uuid[])'::regprocedure;
 IF md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM 'a616a19fcae4cd91485d2a66d781b3fa'
 OR p.proowner<>'postgres'::regrole OR NOT p.prosecdef
 OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, smarter_private','lock_timeout=2s']
 THEN RAISE EXCEPTION 'LEGACY_COMPACTION_SET_PREIMAGE_CHANGED'; END IF;
 src:=pg_get_functiondef(p.oid);
 original:=$before$ requested_hands jsonb;$before$;
 replacement:=$after$ requested_hands jsonb; purged_hand_set jsonb;$after$;
 IF (length(src)-length(replace(src,original,'')))/length(original)<>1
 THEN RAISE EXCEPTION 'LEGACY_COMPACTION_SET_ANCHOR_1_CHANGED'; END IF;
 src:=replace(src,original,replacement);
 original:=$before$ -- Exactly one rewrite of each touched batch in this transaction. Original$before$;
 replacement:=$after$ SELECT COALESCE(jsonb_object_agg(h::text,true),'{}'::jsonb) INTO purged_hand_set FROM unnest(purged) h;
 -- Exactly one rewrite of each touched batch in this transaction. Original$after$;
 IF (length(src)-length(replace(src,original,'')))/length(original)<>1
 THEN RAISE EXCEPTION 'LEGACY_COMPACTION_SET_ANCHOR_2_CHANGED'; END IF;
 src:=replace(src,original,replacement);
 original:=$before$WHERE NOT COALESCE((value#>>'{}')::jsonb->>2=ANY(purged::text[]),false)$before$;
 replacement:=$after$WHERE NOT COALESCE(purged_hand_set ? ((value#>>'{}')::jsonb->>2),false)$after$;
 IF (length(src)-length(replace(src,original,'')))/length(original)<>1
 THEN RAISE EXCEPTION 'LEGACY_COMPACTION_SET_ANCHOR_3_CHANGED'; END IF;
 src:=replace(src,original,replacement);
 EXECUTE src;
END $patch$;
COMMIT;
