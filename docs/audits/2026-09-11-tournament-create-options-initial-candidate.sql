-- Preserve the two explicit Free Buy creation choices in their existing columns.
-- The existing helper decides eligibility; this correction does not derive flags
-- from price, change an entry/purchase price, or rewrite historical events.
-- Insertions are pinned to the complete verified function source hash. Positions
-- are PostgreSQL character positions immediately before the INSERT list closers.
BEGIN;
DO $persist_free_buy_creation_options$
DECLARE
 v_oid oid:='public.fn_create_tournament_governed_legacy(uuid,jsonb)'::regprocedure;
 v_source text; v_next text; v_definition text; v_metadata jsonb;
BEGIN
 SELECT p.prosrc,to_jsonb(p)-'prosrc' INTO STRICT v_source,v_metadata FROM pg_proc p WHERE p.oid=v_oid;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_create_tournament(uuid,jsonb)'::regprocedure)<>'16305fb3739f13e64af6a1e8eb3bf165' THEN
  RAISE EXCEPTION 'The authorized creation wrapper changed; review before installing option persistence';
 END IF;
 IF md5(v_source)='19497dda6c39de94cda7d175f2cdcaeb' THEN RETURN; END IF;
 IF md5(v_source)<>'855086582b43d915ed6bc4c124a34696' THEN
  RAISE EXCEPTION 'The governed creator changed; refusing an unreviewed insertion';
 END IF;
 v_next:=overlay(v_source PLACING $new_option_values$,
    COALESCE((p_config->>'freeBuy')::boolean, false),
    COALESCE((p_config->>'addOnFromStart')::boolean, false)
  $new_option_values$ FROM 10823 FOR 0);
 v_next:=overlay(v_next PLACING $new_option_columns$,
    free_buy, addon_from_start
  $new_option_columns$ FROM 8324 FOR 0);
 IF md5(v_next)<>'19497dda6c39de94cda7d175f2cdcaeb' THEN RAISE EXCEPTION 'Unexpected option persistence postimage'; END IF;
 v_definition:=pg_get_functiondef(v_oid);
 IF (length(v_definition)-length(replace(v_definition,v_source,'')))<>length(v_source) THEN
  RAISE EXCEPTION 'The function body must occur exactly once in its definition';
 END IF;
 EXECUTE replace(v_definition,v_source,v_next);
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid)<>'19497dda6c39de94cda7d175f2cdcaeb' THEN RAISE EXCEPTION 'Creator source verification failed'; END IF;
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=v_oid) IS DISTINCT FROM v_metadata THEN
  RAISE EXCEPTION 'Creation option correction changed function metadata';
 END IF;
END;
$persist_free_buy_creation_options$;
COMMIT;
