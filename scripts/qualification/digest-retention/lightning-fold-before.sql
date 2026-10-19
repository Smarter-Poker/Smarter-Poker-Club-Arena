CREATE OR REPLACE FUNCTION public.fn_lightning_fast_fold(p_hand_id uuid, p_player_id uuid, p_request_id uuid, p_fold_type text, p_committed numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  h          record;
  i          record;
  hp         record;
  v_now      timestamptz := clock_timestamp();
  v_released integer := 0;
  v_kind     text;
  v_healed   jsonb;
BEGIN
  IF p_hand_id IS NULL OR p_player_id IS NULL OR p_request_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_arguments');
  END IF;
  IF p_fold_type IS NULL OR p_fold_type NOT IN ('fast', 'normal', 'fold_watch') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_fold_type');
  END IF;
  IF p_committed IS NOT NULL AND (p_committed < 0 OR p_committed <> round(p_committed, 2)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_committed');
  END IF;

  SELECT lh.hand_id, lh.lightning_instance_id, lh.cluster_id, lh.cluster_epoch
    INTO h FROM public.lightning_hand lh WHERE lh.hand_id = p_hand_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'hand_not_found');
  END IF;
  -- The instance first, as every door that changes a live hand takes it.
  SELECT li.id, li.state INTO i FROM public.lightning_instance li
   WHERE li.id = h.lightning_instance_id FOR UPDATE;
  SELECT x.player_id, x.fold_type, x.folded_at, x.stack_before, x.pool_slot_id
    INTO hp FROM public.lightning_hand_player x
   WHERE x.hand_id = p_hand_id AND x.player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_participant');
  END IF;

  -- IDEMPOTENT ON (hand, player): a fold is recorded once.
  IF hp.folded_at IS NOT NULL THEN
    IF hp.fold_type = p_fold_type THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'hand_id', p_hand_id, 'player_id', p_player_id,
                                'fold_type', hp.fold_type, 'released', hp.fold_type IN ('fast', 'normal'));
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'already_folded', 'fold_type', hp.fold_type);
  END IF;
  IF i.state IS DISTINCT FROM 'dealing' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'instance_not_dealing', 'state', i.state);
  END IF;
  IF p_committed IS NOT NULL AND p_committed > coalesce(hp.stack_before, 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'committed_exceeds_stack_before',
                              'stack_before', hp.stack_before);
  END IF;

  UPDATE public.lightning_hand_player
     SET fold_type = p_fold_type, folded_at = v_now, committed_at_fold = p_committed
   WHERE hand_id = p_hand_id AND player_id = p_player_id;

  -- 'fast' and 'normal' free the player now: their committed reservation,
  -- and only theirs, is released, and the reservation-end trigger stamps
  -- idle_since because this instance was dealt. 'fold_watch' keeps it until
  -- the hand ends.
  IF p_fold_type IN ('fast', 'normal') THEN
    UPDATE public.lightning_reservation r
       SET state = 'released', resolved_at = v_now, reason = p_fold_type || '_fold'
     WHERE r.lightning_instance_id = i.id AND r.player_id = p_player_id AND r.state = 'committed';
    GET DIAGNOSTICS v_released = ROW_COUNT;
  END IF;

  -- LIGHTNING PHASE 9 REMEDIATION (20261008142857), FINDING 2: AN ACTION
  -- IS A HEARTBEAT. The fold just recorded was taken by a CONNECTED player
  -- (the engine relays the player's own tap with the player's id), so the
  -- caller's stale disconnect stamp - a lost presence report the app may
  -- never repeat - is cleared as a side effect: only when the stamp is set,
  -- never an exited row, never on a frozen Cluster (forensic rows are not
  -- mutated), with one player_reconnected event in the presence door's own
  -- ledger shape. The engine-spoken doors (presence_report, the reapers,
  -- auto_rebuy, settlement) still speak for the engine alone.
  WITH healed AS (
    UPDATE public.lightning_pool_session s
       SET disconnected_at = NULL,
           state = CASE WHEN s.state = 'disconnected' THEN 'active' ELSE s.state END,
           updated_at = v_now
     WHERE s.cluster_id = h.cluster_id AND s.player_id = p_player_id
       AND s.exited_at IS NULL AND s.disconnected_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.cash_games fz
                        WHERE fz.id = s.cluster_id AND fz.cluster_mode = 'frozen')
    RETURNING s.id, s.player_id
  )
  SELECT jsonb_agg(jsonb_build_object('player_id', hd.player_id, 'pool_session_id', hd.id)
                   ORDER BY hd.id)
    INTO v_healed FROM healed hd;
  IF v_healed IS NOT NULL THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
    VALUES (h.cluster_id, 'player_reconnected', jsonb_build_object(
      'cluster_id', h.cluster_id, 'cluster_epoch', h.cluster_epoch,
      'players', v_healed, 'at', v_now), h.cluster_epoch);
  END IF;

  v_kind := CASE p_fold_type WHEN 'fast' THEN 'fast_fold' WHEN 'normal' THEN 'normal_fold' ELSE 'fold_and_watch' END;
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
  VALUES (h.cluster_id, v_kind, jsonb_build_object(
    'cluster_id', h.cluster_id, 'cluster_epoch', h.cluster_epoch, 'hand_id', p_hand_id,
    'player_id', p_player_id, 'fold_type', p_fold_type, 'released', v_released > 0,
    'committed', p_committed, 'at', v_now), h.cluster_epoch, p_request_id);

  RETURN jsonb_build_object('ok', true, 'hand_id', p_hand_id, 'player_id', p_player_id,
                            'fold_type', p_fold_type, 'released', v_released > 0);
END
$function$;
