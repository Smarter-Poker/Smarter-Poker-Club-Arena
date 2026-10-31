ALTER TABLE smarter_private.ca_table_stall_watch_state ADD COLUMN IF NOT EXISTS maint_since timestamptz;

DO $migration$
DECLARE
  v_def text := pg_get_functiondef('public.fn_ca_table_stall_watch_ingest(text,timestamptz,bigint)'::regprocedure);
  a1 text := 'v_summary text; v_stop record;';
  b1 text := 'v_summary text; v_stop record; v_maint_since timestamptz;';
  a2 text := E'  v_maint := COALESCE((regexp_match(p_body, E''\\npoker_maintenance_break_active (\\\\d)''))[1] = ''1'', false);\n';
  b2 text := E'  v_maint := COALESCE((regexp_match(p_body, E''\\npoker_maintenance_break_active (\\\\d)''))[1] = ''1'', false);\n'
          || E'  -- 2026-10-31: a maintenance or recovery break is by design only inside its\n'
          || E'  -- bound (5-minute break plus last-hand lead and resume spread). Measured\n'
          || E'  -- that afternoon: 19:54-20:20 UTC, 26 minutes of no dealing anywhere, all\n'
          || E'  -- of it read as "maintenance" and reported to no one.\n'
          || E'  IF v_maint THEN\n'
          || E'    UPDATE smarter_private.ca_table_stall_watch_state SET maint_since = COALESCE(maint_since, p_now)\n'
          || E'     WHERE singleton RETURNING maint_since INTO v_maint_since;\n'
          || E'    v_maint := p_now - v_maint_since < interval ''12 minutes'';\n'
          || E'  ELSE\n'
          || E'    UPDATE smarter_private.ca_table_stall_watch_state SET maint_since = NULL WHERE singleton AND maint_since IS NOT NULL;\n'
          || E'  END IF;\n';
BEGIN
  IF position('v_maint_since' IN v_def) > 0 THEN RAISE NOTICE 'already applied'; RETURN; END IF;
  IF (length(v_def) - length(replace(v_def, a1, ''))) / length(a1) <> 1 THEN RAISE EXCEPTION 'declare anchor not found once'; END IF;
  IF (length(v_def) - length(replace(v_def, a2, ''))) / length(a2) <> 1 THEN RAISE EXCEPTION 'maintenance anchor not found once'; END IF;
  EXECUTE replace(replace(v_def, a1, b1), a2, b2);
END
$migration$;