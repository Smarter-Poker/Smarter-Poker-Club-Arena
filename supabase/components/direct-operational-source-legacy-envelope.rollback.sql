-- Exact compatibility repair for the original seven-day import envelope.
-- Source only until qualified and installed. No source rows, receipts, money,
-- routing configuration or history are rewritten. Owner serializes this DDL.
DO $repair$
DECLARE
  v_rollback boolean := true;
  v_old constant text := '7c12c50493f80f42f99654dab55ca475';
  v_new constant text := 'f632abdd64e5ba45a3d74298ef1e10a3';
  v_before jsonb; v_after jsonb; v_definition text; v_expected text;
  v_search_path text := current_setting('search_path');
  v_signature constant text := 'operational_source_intake.receipt_row(public.operational_alert_events,text)';
  v_needle constant text := $old_fragment$    IF jsonb_typeof(p_event.payload->'captured_at') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p_event.payload->'backfill_window_start') IS DISTINCT FROM 'string'$old_fragment$;
  v_replacement constant text := $new_fragment$    IF (jsonb_typeof(p_event.payload->'captured_at') IS DISTINCT FROM 'string'
        AND NOT (
          -- The original seven-day import used backfill_requested_at, before
          -- later finite readers introduced captured_at. Accept only its exact
          -- three-field original envelope; never relax a new capture or update.
          jsonb_typeof(p_event.payload->'backfill_requested_at') IS NOT DISTINCT FROM 'string'
          AND p_event.source = CASE p_kind WHEN 'engine' THEN 'engine-alerts-backfill'
            WHEN 'financial' THEN 'financial-alerts-backfill' WHEN 'drift' THEN 'drift-incidents-backfill' END
          AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_event.payload) k)
            IS NOT DISTINCT FROM ARRAY['backfill_requested_at','backfill_window_start',
              CASE WHEN p_kind='drift' THEN 'original_incident' ELSE 'original_event' END]
        ))
      OR jsonb_typeof(p_event.payload->'backfill_window_start') IS DISTINCT FROM 'string'$new_fragment$;
BEGIN
  -- Canonicalize type rendering in pg_get_functiondef without changing the function configuration.
  PERFORM pg_catalog.set_config('search_path','public,pg_catalog',true);
  IF current_user<>'postgres' OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='legacy operational envelope: owner and PG17 required';
  END IF;
  SELECT to_jsonb(p),pg_get_functiondef(p.oid) INTO v_before,v_definition
    FROM pg_proc p WHERE p.oid=to_regprocedure(v_signature);
  IF v_before IS NULL OR pg_get_userbyid((v_before->>'proowner')::oid)<>'postgres'
     OR v_before->'proacl' IS DISTINCT FROM '["postgres=X/postgres"]'::jsonb
     OR v_before->'proconfig' IS DISTINCT FROM '["search_path=pg_catalog"]'::jsonb
     OR v_before->'prosecdef' IS DISTINCT FROM 'false'::jsonb
     OR v_before->>'provolatile' IS DISTINCT FROM 's'
     OR md5(v_definition) NOT IN (v_old,v_new) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='legacy operational envelope: exact source or authority drift';
  END IF;
  v_expected:=CASE WHEN v_rollback THEN v_old ELSE v_new END;
  IF md5(v_definition)<>v_expected THEN
    IF v_rollback THEN
      IF (length(v_definition)-length(replace(v_definition,v_replacement,'')))/length(v_replacement)<>1 THEN
        RAISE EXCEPTION 'legacy operational envelope: rollback fragment is not unique';
      END IF;
      v_definition:=replace(v_definition,v_replacement,v_needle);
    ELSE
      IF (length(v_definition)-length(replace(v_definition,v_needle,'')))/length(v_needle)<>1 THEN
        RAISE EXCEPTION 'legacy operational envelope: source fragment is not unique';
      END IF;
      v_definition:=replace(v_definition,v_needle,v_replacement);
    END IF;
    IF md5(v_definition)<>v_expected THEN RAISE EXCEPTION 'legacy operational envelope: constructed source differs'; END IF;
    EXECUTE v_definition;
  END IF;
  SELECT to_jsonb(p),pg_get_functiondef(p.oid) INTO v_after,v_definition
    FROM pg_proc p WHERE p.oid=to_regprocedure(v_signature);
  IF md5(v_definition) IS DISTINCT FROM v_expected OR (v_before-'prosrc') IS DISTINCT FROM (v_after-'prosrc') THEN
    RAISE EXCEPTION 'legacy operational envelope: exact source and full authority readback differs';
  END IF;
  PERFORM pg_catalog.set_config('search_path',v_search_path,true);
END;
$repair$;
