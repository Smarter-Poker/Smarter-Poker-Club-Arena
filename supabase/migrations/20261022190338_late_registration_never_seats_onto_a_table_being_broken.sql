SET LOCAL lock_timeout = '5s';

DO $m$
DECLARE
  v_bound text := E'AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_operations o\n'
               || E'                      WHERE o.source_table_id = tb.id\n'
               || E'                        AND o.state NOT IN (\'acknowledged\', \'withdrawn_before_manifest\'))';
  v_def text;
  v_old text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef('public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure);
  v_old := E'     AND COALESCE(tb.is_deleted,false)=false\n     AND (\n';
  v_new := E'     AND COALESCE(tb.is_deleted,false)=false\n     ' || v_bound || E'\n     AND (\n';
  IF position('smarter_private.f06_operations' IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'seat chooser: expected exactly one table filter to extend';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END IF;

  v_def := pg_get_functiondef('public.fn_ensure_late_registration_capacity(uuid,integer)'::regprocedure);
  v_old := E'       AND COALESCE(tb.is_deleted,false)=false\n  ), occupancy AS (';
  v_new := E'       AND COALESCE(tb.is_deleted,false)=false\n       ' || v_bound || E'\n  ), occupancy AS (';
  IF position('smarter_private.f06_operations' IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'capacity check: expected exactly one live_tables filter to extend';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END IF;
END
$m$;

DO $assert$
BEGIN
  IF position('smarter_private.f06_operations' IN
       pg_get_functiondef('public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'seat chooser was not updated';
  END IF;
  IF position('smarter_private.f06_operations' IN
       pg_get_functiondef('public.fn_ensure_late_registration_capacity(uuid,integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'capacity check was not updated';
  END IF;
END
$assert$;
