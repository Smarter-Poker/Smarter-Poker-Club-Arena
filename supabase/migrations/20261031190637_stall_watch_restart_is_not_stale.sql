DO $migration$
DECLARE
  v_def text := pg_get_functiondef('public.fn_ca_table_stall_watch_ingest(text,timestamptz,bigint)'::regprocedure);
  v_old text := 'AND v_uptime <= v_state.last_uptime_s THEN';
  v_new text := 'AND v_uptime = v_state.last_uptime_s THEN';
BEGIN
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one stale-uptime comparison in fn_ca_table_stall_watch_ingest';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$migration$;