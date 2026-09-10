/* A RE-POINT IS NOT ALLOWED TO COLLIDE (2026-09-10)

   A cash seat move carries the player's open session across to the destination
   by re-pointing it:

     UPDATE public.cash_player_session SET scope_id = dst.id, table_id = dst.id
      WHERE player_id = ... AND scope_id = m.from_table_id AND closed_at IS NULL;

   cash_player_session_one_open is UNIQUE (player_id, scope_type, scope_id)
   WHERE closed_at IS NULL. So if the player ALREADY holds an open session on
   the destination - a leftover from an earlier stay there that was never
   closed - that UPDATE produces two rows with (player_id, 'table', dst) both
   open, and the statement throws:

     [postHandTasks.step_failed.leave_pending]
     duplicate key value violates unique constraint "cash_player_session_one_open"

   The throw takes out the whole post-hand leave_pending step, so THE PLAYER
   DOES NOT LEAVE. Measured on production 2026-09-10 00:44 UTC:
     - 1,091 of 4,751 completed seat moves in six hours had the destination
       already carrying an open session for that player (23% of all moves)
     - 34 hands across 6 tables failed this way in 83 minutes, still firing
     - 51 sessions have been open for over 12 hours and 5 are open for a player
       who holds no live seat at all - that is where the leftovers come from

   fn_cash_session_open is NOT the culprit and needs no change: it already
   carries ON CONFLICT ... DO NOTHING and falls back to reading the existing
   row. The collision is created by an UPDATE, which no ON CONFLICT covers.

   THE FIX. The SOURCE session is the live one - it carries the stay clock for
   the seat actually being moved - so the leftover on the destination is closed
   with a stated reason immediately before the re-point. Both the move path and
   BOTH re-points in the swap path (one per player) get the same guard.

   This is not a repair job and nothing is scheduled (10.12): the statement that
   produced the wrong outcome is the statement that changed. */
DO $mig$
DECLARE
  v_src text; v_new text; v_n int;
  v_a text; v_b text; v_c text; v_d text; v_e text; v_f text; v_check text;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  ---------------------------------------------------------------------------
  -- 1. THE MOVE PATH
  ---------------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_cash_seat_move_execute_before_maintenance_gate';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_cash_seat_move_execute_before_maintenance_gate not found';
  END IF;

  IF position('A RE-POINT IS NOT ALLOWED TO COLLIDE' in v_src) > 0 THEN
    RAISE NOTICE 'move path already guarded; skipping';
  ELSE
    v_a := '  UPDATE public.cash_player_session' || E'\n' ||
           '     SET scope_id = dst.id, table_id = dst.id' || E'\n' ||
           '   WHERE player_id = m.player_id AND scope_type = ''table'' AND scope_id = m.from_table_id AND closed_at IS NULL;';
    v_n := (length(v_src)-length(replace(v_src,v_a,'')))/length(v_a);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the move re-point appears % times, expected exactly 1 - the function has changed and this edit must be re-read against it', v_n;
    END IF;

    v_b := '  /* A RE-POINT IS NOT ALLOWED TO COLLIDE (2026-09-10). This UPDATE moves' || E'\n' ||
           '     the open session from the source table to the destination. If the' || E'\n' ||
           '     player already holds an OPEN session on the destination - a leftover' || E'\n' ||
           '     from an earlier stay there that was never closed - the re-point makes' || E'\n' ||
           '     two rows with (player_id, ''table'', dst) both closed_at IS NULL and' || E'\n' ||
           '     violates cash_player_session_one_open. The whole post-hand leave_pending' || E'\n' ||
           '     step then throws and the player does not leave. Measured 2026-09-10:' || E'\n' ||
           '     1,091 of 4,751 seat moves in six hours had the destination already' || E'\n' ||
           '     carrying an open session, and 34 hands in 83 minutes failed this way.' || E'\n' ||
           '     The SOURCE session is the live one - it carries the stay clock for the' || E'\n' ||
           '     seat being moved - so the leftover is closed and the live one re-points. */' || E'\n' ||
           '  UPDATE public.cash_player_session' || E'\n' ||
           '     SET closed_at = clock_timestamp(), closed_reason = ''superseded_by_move''' || E'\n' ||
           '   WHERE player_id = m.player_id AND scope_type = ''table'' AND scope_id = dst.id AND closed_at IS NULL;' || E'\n' ||
           '' || E'\n' ||
           '  UPDATE public.cash_player_session' || E'\n' ||
           '     SET scope_id = dst.id, table_id = dst.id' || E'\n' ||
           '   WHERE player_id = m.player_id AND scope_type = ''table'' AND scope_id = m.from_table_id AND closed_at IS NULL;';

    v_new := replace(v_src, v_a, v_b);
    IF v_new = v_src THEN RAISE EXCEPTION 'move substitution produced no change'; END IF;
    EXECUTE v_new;
  END IF;

  ---------------------------------------------------------------------------
  -- 2. THE SWAP PATH - two re-points, one per player
  ---------------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_cash_seat_swap_execute_before_maintenance_gate';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_cash_seat_swap_execute_before_maintenance_gate not found';
  END IF;

  IF position('A RE-POINT IS NOT ALLOWED TO COLLIDE' in v_src) > 0 THEN
    RAISE NOTICE 'swap path already guarded; skipping';
  ELSE
    v_c := '  UPDATE public.cash_player_session SET scope_id = m.to_table_id, table_id = m.to_table_id' || E'\n' ||
           '   WHERE player_id = m.player_id AND scope_type = ''table'' AND scope_id = m.from_table_id AND closed_at IS NULL;';
    v_e := '  UPDATE public.cash_player_session SET scope_id = pm.to_table_id, table_id = pm.to_table_id' || E'\n' ||
           '   WHERE player_id = pm.player_id AND scope_type = ''table'' AND scope_id = pm.from_table_id AND closed_at IS NULL;';

    v_n := (length(v_src)-length(replace(v_src,v_c,'')))/length(v_c);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'swap re-point A appears % times, expected exactly 1', v_n;
    END IF;
    v_n := (length(v_src)-length(replace(v_src,v_e,'')))/length(v_e);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'swap re-point B appears % times, expected exactly 1', v_n;
    END IF;

    v_d := '  /* A RE-POINT IS NOT ALLOWED TO COLLIDE (2026-09-10) - see the move path' || E'\n' ||
           '     for the measurement. A swap re-points BOTH players, so both need it. */' || E'\n' ||
           '  UPDATE public.cash_player_session' || E'\n' ||
           '     SET closed_at = clock_timestamp(), closed_reason = ''superseded_by_swap''' || E'\n' ||
           '   WHERE player_id = m.player_id AND scope_type = ''table'' AND scope_id = m.to_table_id AND closed_at IS NULL;' || E'\n' ||
           v_c;
    v_f := '  UPDATE public.cash_player_session' || E'\n' ||
           '     SET closed_at = clock_timestamp(), closed_reason = ''superseded_by_swap''' || E'\n' ||
           '   WHERE player_id = pm.player_id AND scope_type = ''table'' AND scope_id = pm.to_table_id AND closed_at IS NULL;' || E'\n' ||
           v_e;

    v_new := replace(replace(v_src, v_c, v_d), v_e, v_f);
    IF v_new = v_src THEN RAISE EXCEPTION 'swap substitution produced no change'; END IF;
    EXECUTE v_new;
  END IF;

  ---------------------------------------------------------------------------
  -- POST-CONDITION: every re-point is now preceded by its guard
  ---------------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_check
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_cash_seat_move_execute_before_maintenance_gate';
  IF v_check IS NULL OR position('superseded_by_move' in v_check) = 0 THEN
    RAISE EXCEPTION 'post-condition failed: the move re-point is unguarded. Nothing written.';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_check
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_cash_seat_swap_execute_before_maintenance_gate';
  IF v_check IS NULL
     OR (length(v_check)-length(replace(v_check,'superseded_by_swap','')))/length('superseded_by_swap') <> 2 THEN
    RAISE EXCEPTION 'post-condition failed: the swap path must guard BOTH re-points. Nothing written.';
  END IF;

  RAISE NOTICE 'every session re-point now closes a colliding leftover first';
END $mig$;
