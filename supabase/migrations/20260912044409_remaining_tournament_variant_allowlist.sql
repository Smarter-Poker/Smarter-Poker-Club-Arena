-- Enforce the existing eight-game tournament catalogue at the governed creator.
-- No historical rows or financial formulas change. Keep all function metadata.
BEGIN;
DO $remaining_variant_guard$
DECLARE
  v_oid oid := 'public.fn_create_tournament_governed_legacy(uuid,jsonb)'::regprocedure;
  v_source text; v_next text; v_definition text; v_metadata jsonb;
BEGIN
  SELECT p.prosrc, to_jsonb(p)-'prosrc' INTO STRICT v_source, v_metadata FROM pg_proc p WHERE p.oid=v_oid;
  IF md5(v_source)='d00caa094f988ca352b6f7038f660c19' THEN RETURN; END IF;
  IF md5(v_source)<>'ef2671b3cb67a8c710a7fbe3f0431ef6' THEN
    RAISE EXCEPTION 'Governed creator source changed; review before installing variant allowlist';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_create_tournament(uuid,jsonb)'::regprocedure)<>'16305fb3739f13e64af6a1e8eb3bf165' THEN
    RAISE EXCEPTION 'Authorized creation wrapper changed; review before installing variant allowlist';
  END IF;
  v_next := replace(v_source, $anchor$  v_total := COALESCE((p_config->>'buyIn')::numeric, 0);$anchor$, $guard$  -- Keep the database launch boundary aligned with the tournament catalogue.
  -- Authentication and club authority above remain the existing first gates.
  IF p_config IS NOT NULL AND jsonb_typeof(p_config) <> 'object' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_configuration');
  END IF;
  p_config := jsonb_set(COALESCE(p_config, '{}'::jsonb), '{gameVariant}',
    to_jsonb(upper(btrim(COALESCE(p_config->>'gameVariant', 'NLH')))), true);
  IF p_config->>'gameVariant' NOT IN ('NLH','PLO4','PLO5','PLO6','PLO8','SHORT_DECK','FLH','FLO8') THEN
    RETURN jsonb_build_object('success', false, 'error', 'unsupported_tournament_variant');
  END IF;

  IF lower(COALESCE(p_config->>'type','mtt'))='spin'
     AND p_config->>'gameVariant' NOT IN ('NLH','PLO4','PLO5','PLO6') THEN
    RETURN jsonb_build_object('success', false, 'error', 'unsupported_spin_variant');
  END IF;

  v_total := COALESCE((p_config->>'buyIn')::numeric, 0);$guard$);
  IF md5(v_next)<>'d00caa094f988ca352b6f7038f660c19' THEN RAISE EXCEPTION 'Unexpected variant guard postimage'; END IF;
  v_definition := pg_get_functiondef(v_oid);
  IF (length(v_definition)-length(replace(v_definition,v_source,'')))<>length(v_source) THEN
    RAISE EXCEPTION 'Function body must occur exactly once in its definition';
  END IF;
  EXECUTE replace(v_definition,v_source,v_next);
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid)<>'d00caa094f988ca352b6f7038f660c19' THEN RAISE EXCEPTION 'Variant guard source verification failed'; END IF;
  IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=v_oid) IS DISTINCT FROM v_metadata THEN
    RAISE EXCEPTION 'Variant guard changed creator metadata';
  END IF;
END;
$remaining_variant_guard$;
COMMIT;
