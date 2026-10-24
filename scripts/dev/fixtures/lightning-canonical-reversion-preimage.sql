CREATE OR REPLACE FUNCTION public.fn_cash_cluster_commit_must_move(p_game_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g            record;
  v_conv       record;
  v_state      jsonb;
  v_live       integer;
  v_off        integer;
  v_inflight   integer;
  v_before     text;
  v_after      text;
  v_chips      numeric;
  v_epoch      integer;
  v_sessions   integer := 0;
  v_players    jsonb := '[]'::jsonb;
  v_slots      integer := 0;
  v_expired    integer := 0;
  v_released   integer := 0;
  v_tables     integer := 0;
  v_halted     integer := 0;
  v_stranded   integer := 0;
  v_open       integer := 0;
  v_locked_seats    uuid[];
  v_locked_sessions uuid[];
  v_drained         boolean := false;
BEGIN
  -- GATED, because this is the step that lets the physical tables deal again.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reverted', false, 'ready', false, 'reason', 'platform_frozen');
  END IF;

  -- LIGHTNING PHASE 7 REMEDIATION (20261007222717): THE DRAIN IS POLLED
  -- BEFORE THE LOCK. The tick asks this every pass while the drain empties,
  -- and the cheap not-ready answer does not need, and no longer takes, the
  -- Cluster row every formation, tick and conversion serialises on. The
  -- authoritative count below still runs under the lock.
  SELECT count(*)::integer INTO v_inflight
    FROM public.lightning_instance li
   WHERE li.cluster_id = p_game_id AND li.state IN ('forming', 'reserved', 'dealing', 'settling');
  IF v_inflight > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reverted', false, 'ready', false,
      'reason', 'instances_in_flight', 'instances_in_flight', v_inflight,
      'cluster_mode', (SELECT cluster_mode FROM public.cash_games WHERE id = p_game_id));
  END IF;

  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reverted', false, 'reason', 'not_found');
  END IF;

  SELECT * INTO v_conv FROM public.cash_cluster_conversion
   WHERE cluster_id = g.id AND conversion_request_id = p_request_id;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.cash_cluster_conversion
                WHERE conversion_request_id = p_request_id) THEN
      RETURN jsonb_build_object('ok', false, 'reverted', false,
        'reason', 'request_id_belongs_to_another_cluster');
    END IF;
    RETURN jsonb_build_object('ok', false, 'reverted', false, 'reason', 'no_such_conversion');
  END IF;
  IF v_conv.to_mode IS DISTINCT FROM 'must_move' THEN
    RETURN jsonb_build_object('ok', false, 'reverted', false,
      'reason', 'not_a_pending_off_conversion', 'to_mode', v_conv.to_mode);
  END IF;
  -- A RETRY OF A COMMITTED REVERSION is told what happened. reverted is read
  -- off the Cluster, as commit_lightning's converted is: the record says what
  -- this conversion did, the mode says what the Cluster is now.
  IF v_conv.status = 'committed' THEN
    RETURN jsonb_build_object('ok', true, 'reverted', g.cluster_mode = 'must_move',
      'reason', 'already_committed', 'conversion_id', v_conv.id,
      'epoch_after', v_conv.epoch_after, 'cluster_mode', g.cluster_mode);
  END IF;
  IF v_conv.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'reverted', false,
      'reason', 'conversion_already_closed', 'status', v_conv.status,
      'abort_reason', v_conv.abort_reason, 'cluster_mode', g.cluster_mode);
  END IF;
  IF g.cluster_mode IS DISTINCT FROM 'pending_off' THEN
    RETURN jsonb_build_object('ok', false, 'reverted', false, 'reason', 'wrong_state',
      'cluster_mode', g.cluster_mode);
  END IF;

  -- SPECIFICATION STEP 10. A population that rose back above OFF before the
  -- drain point cancels the reversion, while Lightning is still enabled.
  v_state := public.fn_cash_cluster_lightning_state(g.id);
  v_live  := coalesce((v_state -> 'verdict' ->> 'live_eligible')::integer, 0);
  v_off   := coalesce((v_state -> 'thresholds' ->> 'off')::integer, 0);
  IF coalesce(g.lightning_enabled, false) AND g.enabled IS NOT DISTINCT FROM true AND v_live > v_off THEN
    RETURN public.fn_cash_cluster_abort_pending_off(
      g.id, p_request_id, 'population_rose_above_off_threshold_before_the_drain_point')
      || jsonb_build_object('ok', false, 'reverted', false);
  END IF;

  -- THE DRAIN POINT. Not a raise: a structured not-ready answer the caller
  -- polls, exactly as commit_lightning answers hands_in_flight.
  SELECT count(*)::integer INTO v_inflight
    FROM public.lightning_instance li
   WHERE li.cluster_id = g.id AND li.state IN ('forming', 'reserved', 'dealing', 'settling');
  IF v_inflight > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reverted', false, 'ready', false,
      'reason', 'instances_in_flight', 'instances_in_flight', v_inflight,
      'cluster_mode', g.cluster_mode);
  END IF;

  -- THE MONEY, AS EVERY COLUMN OF EVERY ROW. A sum is satisfied by two stacks
  -- that swapped; this is not. Seats of every member table, the Cluster's
  -- cash sessions (baseline, stay clock, rejoin window, join time), and its
  -- blind ledger (what is owed). This transition writes none of them.
  -- THE MONEY, AS EVERY COLUMN OF EVERY LIVE ROW, UNDER ROW LOCKS
  -- (20261007222717). The two digests used to run unlocked at READ COMMITTED
  -- over every historical row, so ordinary concurrent seat or session traffic
  -- committing between them - an engine is_sitting_out update, a departure
  -- request, a session evaluation - could trip the assertion as a false
  -- alarm, and its cost grew with the Cluster's whole history. The live rows
  -- are taken FOR SHARE first, in the estate's order: the Cluster row is
  -- already held FOR UPDATE, then the seats in seat-id order (as formation
  -- takes its anchors), then the open cash sessions, then the blind ledger.
  -- Both digests cover exactly those live rows; a row already dead cannot
  -- change under this transaction's locks and proves nothing about what this
  -- transition wrote.
  -- THE REVERSION COMPARES THE ROWS IT LOCKED (2026-10-09, Phase 12 load
  -- and chaos): the same locks in the same order, and the ids they took are
  -- kept, so both digests below cover exactly those rows (and any row this
  -- transaction wrote). A row lock cannot stop an INSERT: a player arriving
  -- during the drain whose seat and cash session committed between the two
  -- digests tripped LIGHTNING_REVERSION_MOVED_MONEY although nothing here
  -- moved (measured in the conversion storm, a false financial alarm).
  SELECT coalesce(array_agg(x.id ORDER BY x.id), ARRAY[]::uuid[]) INTO v_locked_seats FROM (
    SELECT ts.id FROM public.table_seats ts
     WHERE ts.left_at IS NULL
       AND ts.table_id IN (SELECT tb.id FROM public.tables tb WHERE tb.cluster_id = g.id)
     ORDER BY ts.id
       FOR SHARE) x;
  SELECT coalesce(array_agg(x.id ORDER BY x.id), ARRAY[]::uuid[]) INTO v_locked_sessions FROM (
    SELECT s.id FROM public.cash_player_session s
     WHERE s.cluster_id = g.id AND s.closed_at IS NULL
     ORDER BY s.id
       FOR SHARE) x;
  PERFORM 1 FROM public.lightning_blind_ledger bl
   WHERE bl.cluster_id = g.id
   ORDER BY bl.player_id
   FOR SHARE;
  -- THE MODE CHANGES UNDER THE CLUSTER'S MODE LOCK (2026-10-15, Lightning
  -- Phase 12 load and chaos): EXCLUSIVE, after the row locks above and
  -- before the pool is closed. An arrival whose seat trigger read
  -- 'lightning' first (the drain opens PENDING_OFF and reverts in one
  -- transaction) has committed its pool session when this returns, and the
  -- close below sees it; one after waits for this commit and reads
  -- 'must_move'. No pool session at the old epoch outlives the reversion.
  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended('lightning_cluster_mode:' || g.id::text, 0));

  SELECT md5(coalesce(string_agg(x.r, '|' ORDER BY x.r), '')) INTO v_before FROM (
      SELECT 'ts:' || to_jsonb(ts)::text AS r
        FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
       WHERE tb.cluster_id = g.id AND ts.left_at IS NULL
         AND (ts.id = ANY (v_locked_seats) OR ts.xmin = pg_current_xact_id()::xid)
      UNION ALL
      SELECT 'cps:' || to_jsonb(s)::text FROM public.cash_player_session s
       WHERE s.cluster_id = g.id AND s.closed_at IS NULL
         AND (s.id = ANY (v_locked_sessions) OR s.xmin = pg_current_xact_id()::xid)
      UNION ALL
      SELECT 'bl:' || to_jsonb(bl)::text FROM public.lightning_blind_ledger bl WHERE bl.cluster_id = g.id
    ) x;
  SELECT coalesce(sum(ts.stack), 0) INTO v_chips
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id AND ts.left_at IS NULL;

  -- EVERY OPEN POOL SESSION EXITS, ONE pool_player_left EACH. The cash
  -- session it is subordinate to stays open: leaving Lightning does not end
  -- the player's cash session, and the anchor seat they never left is where
  -- they now play.
  -- LIGHTNING PHASE 13 (20261009235505): AN EMERGENCY DRAIN SAYS SO. The
  -- sessions a drain releases exit 'lightning_drained', the ones a falling
  -- population releases 'lightning_off'; the transition is the same.
  v_drained := EXISTS (SELECT 1 FROM public.lightning_cluster_drain d
                        WHERE d.cluster_id = g.id AND d.completed_at IS NULL);
  WITH exited AS (
    UPDATE public.lightning_pool_session ps
       SET exited_at = GREATEST(clock_timestamp(), ps.entered_at),
           exit_reason = CASE WHEN v_drained THEN 'lightning_drained' ELSE 'lightning_off' END,
           state = 'closed',
           ending_stack = public.fn_lightning_pool_stack(ps.id),
           updated_at = clock_timestamp()
     WHERE ps.cluster_id = g.id AND ps.exited_at IS NULL
    RETURNING ps.id, ps.cluster_epoch, ps.player_id, ps.anchor_seat_id, ps.ending_stack, ps.exited_at
  ), logged AS (
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload, cluster_epoch, request_id)
    SELECT g.id, ts.table_id, 'pool_player_left', jsonb_build_object(
             'cluster_id', g.id, 'cluster_epoch', e.cluster_epoch, 'player_id', e.player_id,
             'pool_session_id', e.id, 'anchor_seat_id', e.anchor_seat_id, 'reason', CASE WHEN v_drained THEN 'lightning_drained' ELSE 'lightning_off' END,
             'ending_stack', e.ending_stack, 'seat_table_id', ts.table_id, 'seat_number', ts.seat_number,
             'conversion_id', v_conv.id, 'at', e.exited_at),
           e.cluster_epoch, p_request_id
      FROM exited e LEFT JOIN public.table_seats ts ON ts.id = e.anchor_seat_id
    RETURNING 1
  )
  SELECT (SELECT count(*)::integer FROM exited),
         (SELECT coalesce(jsonb_agg(e.player_id ORDER BY e.player_id), '[]'::jsonb) FROM exited e),
         (SELECT count(*)::integer FROM exited e
           WHERE NOT EXISTS (SELECT 1 FROM public.table_seats ts
                              WHERE ts.id = e.anchor_seat_id AND ts.left_at IS NULL
                                AND ts.user_id = e.player_id)),
         (SELECT count(*)::integer FROM logged)
    INTO v_sessions, v_players, v_stranded, v_open;
  IF v_open IS DISTINCT FROM v_sessions THEN
    RAISE EXCEPTION 'LIGHTNING_REVERSION_LOST_AN_EVENT: cluster % exited % pool session(s) and logged % pool_player_left',
      g.id, v_sessions, v_open USING ERRCODE = 'check_violation';
  END IF;
  -- A PLAYER THE POOL LETS GO HAS A SEAT TO PLAY AT. The seat trigger exits a
  -- session the moment its anchor is left, so this cannot fire as written; it
  -- is here so that it fires the day something breaks that.
  IF v_stranded > 0 THEN
    RAISE EXCEPTION 'LIGHTNING_REVERSION_STRANDED_A_PLAYER: cluster % released % pool player(s) whose anchor seat is not theirs and live',
      g.id, v_stranded USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.lightning_pool_slot sl
     SET closed_at = GREATEST(clock_timestamp(), sl.opened_at), close_reason = 'lightning_off',
         updated_at = clock_timestamp()
   WHERE sl.cluster_id = g.id AND sl.closed_at IS NULL;
  GET DIAGNOSTICS v_slots = ROW_COUNT;

  -- Only Lightning-specific transient state is wiped. A pending reservation
  -- cannot outlive its instance in practice; one that did is expired, not
  -- deleted, so the row still says what happened to it.
  UPDATE public.lightning_reservation r
     SET state = 'expired', resolved_at = clock_timestamp(), reason = coalesce(r.reason, 'lightning_off')
   WHERE r.cluster_id = g.id AND r.state = 'pending';
  GET DIAGNOSTICS v_expired = ROW_COUNT;
  UPDATE public.lightning_reservation r
     SET state = 'released', resolved_at = clock_timestamp(), reason = coalesce(r.reason, 'lightning_off')
   WHERE r.cluster_id = g.id AND r.state = 'committed';
  GET DIAGNOSTICS v_released = ROW_COUNT;

  -- THE NEXT EPOCH, IN must_move. ca.epoch_reason is what the epoch writer
  -- records as started_by.
  PERFORM set_config('ca.epoch_reason', 'lightning_off', true);
  PERFORM set_config('ca.request_id', p_request_id::text, true);
  v_epoch := g.cluster_epoch + 1;
  UPDATE public.cash_games
     SET cluster_mode = 'must_move', cluster_epoch = v_epoch, updated_at = now()
   WHERE id = g.id;

  -- THE TABLES DEAL AGAIN. Only a halt Lightning placed is lifted; a halt
  -- somebody else put on a member table is theirs to lift. The engine polls
  -- the halt between hands, so this is what restarts the physical game.
  -- The engine's acknowledgement of that halt goes with it, so the next
  -- PENDING_ON waits for a fresh observation of its own halt.
  IF g.enabled IS NOT DISTINCT FROM true THEN
    UPDATE public.tables tb
       SET dealing_halted_at = NULL, dealing_halted_reason = NULL, dealing_halt_observed_at = NULL
     WHERE tb.cluster_id = g.id AND tb.dealing_halted_reason IN ('lightning', 'lightning_pending_on');
    GET DIAGNOSTICS v_tables = ROW_COUNT;
  ELSE
    -- 20261007222717: THE GAME ITSELF IS DISABLED. A reversion is a seating
    -- transition, not a licence to deal: the member tables stay halted for
    -- the game-close path that owns a disabled game, and the result and the
    -- event both say so (halts_kept_game_disabled).
    v_tables := 0;
  END IF;
  SELECT count(*)::integer INTO v_halted
    FROM public.tables tb
   WHERE tb.cluster_id = g.id AND tb.dealing_halted_at IS NOT NULL
     AND coalesce(tb.is_deleted, false) = false AND coalesce(tb.lifecycle, '') <> 'closed';

  SELECT md5(coalesce(string_agg(x.r, '|' ORDER BY x.r), '')) INTO v_after FROM (
      SELECT 'ts:' || to_jsonb(ts)::text AS r
        FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
       WHERE tb.cluster_id = g.id AND ts.left_at IS NULL
         AND (ts.id = ANY (v_locked_seats) OR ts.xmin = pg_current_xact_id()::xid)
      UNION ALL
      SELECT 'cps:' || to_jsonb(s)::text FROM public.cash_player_session s
       WHERE s.cluster_id = g.id AND s.closed_at IS NULL
         AND (s.id = ANY (v_locked_sessions) OR s.xmin = pg_current_xact_id()::xid)
      UNION ALL
      SELECT 'bl:' || to_jsonb(bl)::text FROM public.lightning_blind_ledger bl WHERE bl.cluster_id = g.id
    ) x;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'LIGHTNING_REVERSION_MOVED_MONEY: cluster % seats, cash sessions or blind ledger changed across the reversion (% -> %), and a mode change is a seating transition, not an economic transaction',
      g.id, v_before, v_after USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*)::integer INTO v_open
    FROM public.lightning_pool_session ps WHERE ps.cluster_id = g.id AND ps.exited_at IS NULL;
  IF v_open > 0 THEN
    RAISE EXCEPTION 'LIGHTNING_REVERSION_LEFT_A_POOL_SESSION_OPEN: cluster % still has % open pool session(s) in must_move',
      g.id, v_open USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.cash_cluster_conversion
     SET status = 'committed', epoch_after = v_epoch, closed_at = clock_timestamp(),
         chips_at_commit = v_chips
   WHERE id = v_conv.id;

  INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
  VALUES (g.id, 'lightning_off', jsonb_build_object(
    'conversion_id', v_conv.id, 'conversion_request_id', p_request_id,
    'from_mode', 'lightning', 'to_mode', 'must_move',
    'trigger_population', v_conv.trigger_population, 'population_at_commit', v_live,
    'on_threshold', v_conv.on_threshold, 'off_threshold', v_conv.off_threshold,
    'epoch_before', g.cluster_epoch, 'epoch_after', v_epoch,
    'pool_sessions_exited', v_sessions, 'players', v_players, 'slots_closed', v_slots,
    'reservations_expired', v_expired, 'reservations_released', v_released,
    'tables_released', v_tables, 'tables_still_halted', v_halted,
    'halts_kept_game_disabled', g.enabled IS DISTINCT FROM true,
    'chip_total', v_chips, 'money_md5', v_before, 'drained', v_drained), p_request_id);

  RETURN jsonb_build_object('ok', true, 'reverted', true, 'ready', true, 'reason', 'must_move',
    'conversion_id', v_conv.id, 'cluster_mode', 'must_move',
    'epoch_before', g.cluster_epoch, 'epoch_after', v_epoch,
    'pool_sessions_exited', v_sessions, 'slots_closed', v_slots,
    'reservations_expired', v_expired, 'reservations_released', v_released,
    'tables_released', v_tables, 'tables_still_halted', v_halted,
    'halts_kept_game_disabled', g.enabled IS DISTINCT FROM true,
    'chip_total', v_chips, 'population_at_commit', v_live, 'drained', v_drained);
END;
$function$
;

