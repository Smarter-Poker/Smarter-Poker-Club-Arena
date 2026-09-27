-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260909235709 "a_registrant_the_launch_cannot_seat_is_released_with_an_exac"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 735171d5b6371b6d99a79f6f8303291d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

DO $reader$
DECLARE
  v_oid oid := to_regprocedure(
    'public.fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid)');
  v_def text;
  v_old1 text := $t$     OR (v_r.start_authority IN (
           'spin_actual_start','heads_up_sng_actual_start')
       AND EXISTS ($t$;
  v_new1 text := $t$     OR (v_r.start_authority IN (
           'spin_actual_start','heads_up_sng_actual_start','launch_release')
       AND EXISTS ($t$;
  v_old2 text := $t$     OR v_r.start_authority NOT IN (
          'scheduled_clock','spin_actual_start','heads_up_sng_actual_start')$t$;
  v_new2 text := $t$     OR v_r.start_authority NOT IN (
          'scheduled_clock','spin_actual_start','heads_up_sng_actual_start',
          'launch_release')$t$;
  v_changed boolean := false;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid) is not installed';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF position(v_new1 IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1 THEN
      RAISE EXCEPTION 'the seat-first authority clause of fn_ca_tournament_unregistration_receipt was expected exactly once';
    END IF;
    v_def := replace(v_def, v_old1, v_new1); v_changed := true;
  END IF;
  IF position(v_new2 IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1 THEN
      RAISE EXCEPTION 'the authority whitelist of fn_ca_tournament_unregistration_receipt was expected exactly once';
    END IF;
    v_def := replace(v_def, v_old2, v_new2); v_changed := true;
  END IF;
  IF v_changed THEN EXECUTE v_def; END IF;
END
$reader$;
