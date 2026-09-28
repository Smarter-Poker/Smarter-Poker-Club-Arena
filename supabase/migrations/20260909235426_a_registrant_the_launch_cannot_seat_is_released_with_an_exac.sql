-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260909235426 "a_registrant_the_launch_cannot_seat_is_released_with_an_exac"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9dfecec2900507936cfa12ad461faf19 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

DO $gate$
DECLARE
  v_oid oid := to_regprocedure(
    'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)');
  v_def text;
  v_release_clause text := $clause$
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_launch_receipts r
          WHERE r.tournament_id=p_tournament_id
            AND r.completed_at IS NULL
            AND r.launch_id::text=NULLIF(
              current_setting('app.ca_launch_release_launch_id',true),''))$clause$;
  -- Gate one: the pre-flight refusal at the top of the function.
  v_old1 text := $old$
    IF clock_timestamp()>=v_t.start_time THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  ELSE$old$;
  v_new1 text;
  -- Gate two: the re-proof after all money and seat work.
  v_old2 text := $old$
    IF v_unregistered_at>=v_t.start_time THEN
      RAISE EXCEPTION 'tournament started before unregistration could commit'
        USING ERRCODE='55000';
    END IF;
  ELSE$old$;
  v_new2 text;
  v_n1 integer; v_n2 integer; v_m1 integer; v_m2 integer;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid) is not installed';
  END IF;
  v_new1 := $new$
    /* A release performed by the launch that holds this event's INCOMPLETE
       launch receipt is pre-start: the clock has passed start_time, but no
       hand has been dealt (checked above, fails closed) and the receipt has
       not been completed. The launch names its receipt through the
       transaction-local app.ca_launch_release_launch_id, set only by
       fn_ca_release_unseatable_registrant_at_launch. */
    IF clock_timestamp()>=v_t.start_time$new$ || v_release_clause || $new$ THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  ELSE$new$;
  v_new2 := $new$
    IF v_unregistered_at>=v_t.start_time$new$ || v_release_clause || $new$ THEN
      RAISE EXCEPTION 'tournament started before unregistration could commit'
        USING ERRCODE='55000';
    END IF;
  ELSE$new$;
  v_def := pg_get_functiondef(v_oid);
  v_n1 := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  v_m1 := (length(v_def) - length(replace(v_def, v_new1, ''))) / length(v_new1);
  v_n2 := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  v_m2 := (length(v_def) - length(replace(v_def, v_new2, ''))) / length(v_new2);
  IF NOT ((v_n1 = 1 AND v_m1 = 0) OR (v_n1 = 0 AND v_m1 = 1)) THEN
    RAISE EXCEPTION 'gate one of fn_ca_unregister_tournament_player_exact: expected the old text once or the new text once, found old=% new=%', v_n1, v_m1;
  END IF;
  IF NOT ((v_n2 = 1 AND v_m2 = 0) OR (v_n2 = 0 AND v_m2 = 1)) THEN
    RAISE EXCEPTION 'gate two of fn_ca_unregister_tournament_player_exact: expected the old text once or the new text once, found old=% new=%', v_n2, v_m2;
  END IF;
  IF v_n1 = 1 THEN v_def := replace(v_def, v_old1, v_new1); END IF;
  IF v_n2 = 1 THEN v_def := replace(v_def, v_old2, v_new2); END IF;
  IF v_n1 = 1 OR v_n2 = 1 THEN EXECUTE v_def; END IF;
END
$gate$;
