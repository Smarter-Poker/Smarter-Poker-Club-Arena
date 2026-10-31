CREATE OR REPLACE FUNCTION public.fn_cash_cluster_unfreeze(p_game_id uuid, p_operator uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g            record;
  v_reason     text := btrim(coalesce(p_reason, ''));
  v_before     numeric;
  v_after      numeric;
  v_instances  integer := 0;
  v_sessions   integer := 0;
  v_slots      integer := 0;
  v_tables     integer := 0;
  v_convs      integer := 0;
  v_epoch      integer;
  i            record;
  r_exit       record;
BEGIN
  IF v_reason = '' THEN
    RETURN jsonb_build_object('ok', false, 'unfrozen', false, 'reason', 'reason_required');
  END IF;
  IF p_operator IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'unfrozen', false, 'reason', 'operator_required');
  END IF;

  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'unfrozen', false, 'reason', 'not_found');
  END IF;
  IF g.cluster_mode IS DISTINCT FROM 'frozen' THEN
    RETURN jsonb_build_object('ok', false, 'unfrozen', false, 'reason', 'not_frozen',
                              'cluster_mode', g.cluster_mode);
  END IF;

  SELECT coalesce(sum(ts.stack), 0) INTO v_before
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id AND ts.left_at IS NULL;

  FOR i IN
    SELECT li.id FROM public.lightning_instance li
     WHERE li.cluster_id = g.id AND li.state IN ('forming', 'reserved', 'dealing', 'settling')
     ORDER BY li.id
     FOR UPDATE
  LOOP
    UPDATE public.lightning_instance li
       SET state = 'abandoned',
           abandon_reason = 'cluster unfrozen by operator ' || p_operator || ': ' || v_reason,
           completed_at = CASE WHEN li.started_at IS NOT NULL
                               THEN GREATEST(clock_timestamp(), li.started_at) ELSE li.completed_at END
     WHERE li.id = i.id;
    v_instances := v_instances + 1;
  END LOOP;

  UPDATE public.lightning_pool_slot sl
     SET closed_at = GREATEST(clock_timestamp(), sl.opened_at), close_reason = 'cluster_unfrozen',
         updated_at = clock_timestamp()
   WHERE sl.cluster_id = g.id AND sl.closed_at IS NULL;
  GET DIAGNOSTICS v_slots = ROW_COUNT;

  -- LIGHTNING PHASE 9 (20261008050805): EVERY EXIT PATH SAYS
  -- pool_player_left. The unfreeze exited its sessions silently; it now
  -- records one per session, in the anchor-seat trigger's own payload shape.
  FOR r_exit IN
    UPDATE public.lightning_pool_session ps
       SET exited_at = GREATEST(clock_timestamp(), ps.entered_at), exit_reason = 'cluster_unfrozen',
           state = 'closed', ending_stack = public.fn_lightning_pool_stack(ps.id), updated_at = clock_timestamp()
     WHERE ps.cluster_id = g.id AND ps.exited_at IS NULL
    RETURNING ps.id, ps.cluster_id, ps.cluster_epoch, ps.player_id, ps.anchor_seat_id, ps.ending_stack
  LOOP
    v_sessions := v_sessions + 1;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload, cluster_epoch)
    VALUES (r_exit.cluster_id,
            (SELECT ts.table_id FROM public.table_seats ts WHERE ts.id = r_exit.anchor_seat_id),
            'pool_player_left', jsonb_build_object(
      'cluster_id', r_exit.cluster_id, 'cluster_epoch', r_exit.cluster_epoch,
      'player_id', r_exit.player_id, 'pool_session_id', r_exit.id,
      'anchor_seat_id', r_exit.anchor_seat_id, 'reason', 'cluster_unfrozen',
      'ending_stack', r_exit.ending_stack, 'at', clock_timestamp()), r_exit.cluster_epoch);
  END LOOP;

  -- LIGHTNING PHASE 7 REMEDIATION (20261007222717): AN UNFREEZE CLOSES THE
  -- CONVERSION IT WOULD OTHERWISE ORPHAN. A Cluster frozen out of pending_off
  -- or pending_on still holds its open cash_cluster_conversion row; left
  -- pending, the one-open-per-cluster index refuses every later begin for
  -- ever (the drive recorded that as lightning_drive_error on every pass) and
  -- the reaper answers not_a_pending_on_lightning_conversion. It is closed
  -- here as an abort, so the record says what happened to it.
  UPDATE public.cash_cluster_conversion
     SET status = 'aborted', abort_reason = 'cluster_unfrozen', closed_at = clock_timestamp()
   WHERE cluster_id = g.id AND status = 'pending';
  GET DIAGNOSTICS v_convs = ROW_COUNT;

  -- A NEW EPOCH IN must_move, so nothing formed at the frozen epoch can ever be
  -- mistaken for the Cluster's present.
  PERFORM set_config('ca.epoch_reason', 'unfrozen', true);
  v_epoch := g.cluster_epoch + 1;
  -- 20261008043021: A STALE DWELL SIGHTING DOES NOT SURVIVE AN UNFREEZE.
  -- Cleared beside the halt clearing above, in the same UPDATE that moves the
  -- mode, so the next Lightning epoch cannot open PENDING_OFF on a single
  -- observation against a sighting recorded before the freeze.
  UPDATE public.cash_games SET cluster_mode = 'must_move', cluster_epoch = v_epoch, lightning_off_condition_since = NULL, updated_at = now()
   WHERE id = g.id;

  UPDATE public.tables tb
     -- 20261007222717: the engine acknowledgement goes with the halt, exactly
     -- as fn_cash_cluster_commit_must_move lifts it, so the next PENDING_ON
     -- waits for a fresh observation of its own halt instead of reading a
     -- stale one.
     SET dealing_halted_at = NULL, dealing_halted_reason = NULL, dealing_halt_observed_at = NULL
   WHERE tb.cluster_id = g.id AND tb.dealing_halted_reason IN ('lightning', 'lightning_pending_on');
  GET DIAGNOSTICS v_tables = ROW_COUNT;

  SELECT coalesce(sum(ts.stack), 0) INTO v_after
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id AND ts.left_at IS NULL;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'LIGHTNING_UNFREEZE_MOVED_MONEY: cluster % chip total went from % to %', g.id, v_before, v_after
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
  VALUES (g.id, 'cluster_unfrozen', jsonb_build_object(
    'cluster_id', g.id, 'cluster_epoch', v_epoch, 'epoch_before', g.cluster_epoch,
    'from_mode', 'frozen', 'to_mode', 'must_move', 'operator', p_operator, 'reason', v_reason,
    'instances_abandoned', v_instances, 'pool_sessions_exited', v_sessions, 'slots_closed', v_slots,
    'conversions_aborted', v_convs,
    'tables_released', v_tables, 'chip_total', v_before, 'at', clock_timestamp()), v_epoch);

  RETURN jsonb_build_object('ok', true, 'unfrozen', true, 'cluster_id', g.id, 'cluster_mode', 'must_move',
                            'epoch_before', g.cluster_epoch, 'epoch_after', v_epoch,
                            'instances_abandoned', v_instances, 'pool_sessions_exited', v_sessions,
                            'slots_closed', v_slots, 'tables_released', v_tables,
                            'conversions_aborted', v_convs, 'chip_total', v_before);
END
$function$

