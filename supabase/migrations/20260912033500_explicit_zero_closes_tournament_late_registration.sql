-- Explicit zero closes late registration, matching its authoritative reader.
-- An unused rebuy_levels default must not keep a no-rebuy HU prize pool open.
-- No row, prize, fee, seat or standing is changed by this migration.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $migration$
DECLARE
 v_oid oid:='public.trg_tournament_pool_finalization_window_guard()'::regprocedure;
 v_body text;v_definition text;v_metadata jsonb;
 v_old text:=$old$COALESCE(NULLIF(NEW.late_reg_levels, 0),
                                       NULLIF(NEW.rebuy_levels, 0), 0)$old$;
 v_new text:=$new$COALESCE(NEW.late_reg_levels, NEW.rebuy_levels, 0)$new$;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc'
 INTO v_body,v_definition,v_metadata FROM pg_proc p WHERE oid=v_oid;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid
   AND proowner='postgres'::regrole AND prosecdef
   AND proconfig=ARRAY['search_path=public']
   AND proacl::text='{postgres=X/postgres,service_role=X/postgres}')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE
   tgrelid='public.tournaments'::regclass AND tgfoid=v_oid
   AND tgname='zzzz_tournament_pool_finalization_window_guard' AND tgenabled='O') THEN
  RAISE EXCEPTION 'Prize-window guard authority or trigger differs from reviewed source';
 END IF;
 IF md5(v_body)='efb60ed981bc13386d5bdedc37a011e6' THEN RETURN; END IF;
 IF md5(v_body)<>'60b8d3004e7db4e0e89a783d77cc0f71'
 OR (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 THEN
  RAISE EXCEPTION 'Prize-window guard source differs from reviewed preimage';
 END IF;
 EXECUTE replace(v_definition,v_old,v_new);
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid)<>'efb60ed981bc13386d5bdedc37a011e6'
 OR (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=v_oid) IS DISTINCT FROM v_metadata THEN
  RAISE EXCEPTION 'Prize-window guard postimage or metadata mismatch';
 END IF;
END;
$migration$;
COMMIT;
