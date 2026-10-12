-- 20261001222856_lightning_phase_7_the_pool_reverts_to_must_move_and_the_tick.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASE 7 OF 14 (SPECIFICATION PHASE 10): THE POOL REVERTS TO
-- MUST-MOVE, AND THE CLUSTER TICK DRIVES BOTH CONVERSIONS.
--
-- Until this file a Lightning Cluster had exactly one way back to the
-- physical tables, the operator's fn_cash_cluster_unfreeze, and nothing in the
-- estate ever converted a Cluster at all: fn_cash_cluster_begin_pending_on and
-- fn_cash_cluster_commit_lightning had no caller outside the harnesses. This
-- file adds the mandatory reversion and wires both directions into the tick.
--
-- 1. fn_cash_cluster_begin_pending_off(game, request, reason) moves a Cluster
--    from 'lightning' to 'pending_off' when the live eligible population is at
--    or below the OFF threshold, or Lightning or the game has been disabled
--    (a disabled Cluster always drains; it is never stranded by a flag). It
--    opens a cash_cluster_conversion row (lightning -> must_move, trigger
--    population, both thresholds, epoch_before, chips_at_begin) and emits
--    lightning_pending_off. Formation already refuses every mode but
--    'lightning', so no new hand forms; a formation that has not dealt yet
--    (forming or reserved) is void and is abandoned through the existing
--    fn_lightning_instance_abandon, which moves no chip; a hand already
--    dealing or settling finishes and settles (settlement refuses only a
--    frozen Cluster). The member tables stay halted.
--
-- 2. fn_cash_cluster_commit_must_move(game, request) refuses with a
--    structured not-ready answer (instances_in_flight) while any instance of
--    the Cluster is not terminal, self-aborts if the population has risen
--    back above OFF while Lightning is still enabled, and otherwise, in one
--    transaction: exits every open pool session (exit_reason 'lightning_off',
--    one pool_player_left each), closes every open slot, expires every pending
--    reservation, opens the next epoch in must_move, lifts the Lightning halt
--    and its engine acknowledgement (dealing_halted_at, dealing_halted_reason,
--    dealing_halt_observed_at) on every member table (only a halt Lightning
--    placed), records the
--    conversion committed and emits lightning_off. It writes no row of
--    table_seats, cash_player_session or lightning_blind_ledger, and asserts
--    it: an md5 over every column of every such row of the Cluster, before
--    and after, or LIGHTNING_REVERSION_MOVED_MONEY. Stack, baseline, stay
--    clock, rejoin window, join time and the blind ledger are therefore
--    exactly what they were. The must-move tick, which stands down in every
--    other mode, takes the Cluster on its next pass.
--
-- 3. fn_cash_cluster_abort_pending_off(game, request, reason) returns a
--    pending_off Cluster to 'lightning' (refused while Lightning or the game
--    is disabled), aborts the conversion, puts into the pool every eligible
--    seated player who sat down during the drain, and emits
--    lightning_pending_off_aborted. Formation resumes.
--
-- 4. fn_cash_cluster_lightning_drive(game) is the state machine one tick
--    pass runs per Cluster, with hysteresis from the one population reader:
--    MUST_MOVE at or above ON begins PENDING_ON; PENDING_ON aborts below ON
--    (or when disabled) and otherwise asks commit_lightning, which waits for
--    the engines' halt acknowledgements and the hand boundary; LIGHTNING at
--    or below OFF, or disabled, begins PENDING_OFF; PENDING_OFF aborts above
--    OFF while enabled and otherwise asks commit_must_move, which waits for
--    the drain. Request ids are derived from the Cluster, its epoch, the
--    direction and the number of conversions it has had, so two passes racing
--    on one Cluster open one conversion. fn_cash_clusters_tick_all calls it
--    for every Cluster with lightning_enabled (and must_move) or in a
--    Lightning mode, after the stuck-conversion and formation reaps and
--    before the slot sync, each in its own sub-block. No new cron. Production
--    has lightning_enabled false on every game, so this ships dark.
--
-- 5. fn_cash_cluster_reap_stuck_conversions also reaps a PENDING_OFF past
--    its age: every instance still not terminal is abandoned through
--    fn_lightning_instance_abandon (a void hand, no chip moved), then the
--    conversion is committed through fn_cash_cluster_commit_must_move, whose
--    own money assertion holds. The PENDING_ON branch is unchanged.
--
-- 6. fn_lightning_my_session(cluster) also answers a caller with no open pool
--    session who holds a live seat in the Cluster:
--    {pool_session_id: null, cluster_mode, seat_table_id, seat_number}. With
--    an open session every existing key is kept and seat_table_id (the
--    anchor table) is added.
--
-- LAW 10.5. Nothing here reads is_horse or horse_id. A horse leaves the pool,
-- keeps its stack and is reseated exactly as a human is.
--
-- HOUSE RULES OBSERVED. One BEGIN/COMMIT with SET LOCAL lock_timeout. No
-- table is created or altered, so neither tables nor table_seats is locked by
-- this file. Every change to an existing body is an asserted substitution into
-- the body production carries (read with pg_get_functiondef): each anchor must
-- appear exactly as often as stated or the file refuses, and a body already
-- carrying the change is left alone, so the file is re-appliable. The four new
-- functions are SECURITY DEFINER with a pinned search_path and are executable
-- by service_role alone.
--
-- @live-proof: (SELECT count(*) = 4 AND bool_and(p.prosecdef AND p.proconfig::text ~ 'search_path' AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')) FROM pg_proc p WHERE p.oid IN ('public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)'::regprocedure, 'public.fn_cash_cluster_commit_must_move(uuid,uuid)'::regprocedure, 'public.fn_cash_cluster_abort_pending_off(uuid,uuid,text)'::regprocedure, 'public.fn_cash_cluster_lightning_drive(uuid)'::regprocedure))
-- @live-proof: (SELECT s ~ 'LIGHTNING_REVERSION_MOVED_MONEY' AND s ~ '''instances_in_flight''' AND s ~ '''lightning_off''' AND s ~ '''pool_player_left''' AND s ~ 'dealing_halted_reason IN \(''lightning'', ''lightning_pending_on''\)' AND s ~ 'ca\.epoch_reason' AND s ~ 'dealing_halt_observed_at = NULL' FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_commit_must_move(uuid,uuid)'::regprocedure) AS s) q)
-- @live-proof: (SELECT position('fn_cash_cluster_lightning_drive' in s) > 0 AND position('''lightning_driven''' in s) > 0 AND position('fn_cash_cluster_lightning_drive' in s) < position('fn_lightning_pool_slots_sync' in s) AND position('fn_lightning_reap_formations' in s) < position('fn_cash_cluster_lightning_drive' in s) FROM (SELECT pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ '''lightning_pending_off_reaped''' AND s ~ 'fn_cash_cluster_commit_must_move' AND s ~ '''not_a_pending_on_lightning_conversion''' AND s ~ 'fn_cash_cluster_abort_pending_on' FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)'::regprocedure) AS s) q)
-- @live-proof: (SELECT p.prosecdef AND s ~ '''seat_table_id'', v_seat\.table_id' AND s ~ '''seat_table_id'', s\.anchor_table_id' AND s ~ '''anchor_table_id'', s\.anchor_table_id' AND s ~ 'auth\.uid\(\)' AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid = 'public.fn_lightning_my_session(uuid)'::regprocedure)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_cash_cluster_begin_pending_off', 'fn_cash_cluster_commit_must_move', 'fn_cash_cluster_abort_pending_off', 'fn_cash_cluster_lightning_drive') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id'))
--
BEGIN;

SET LOCAL lock_timeout = '2s';

-- ===========================================================================
-- 1. LIGHTNING -> PENDING_OFF.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_cash_cluster_begin_pending_off(p_game_id uuid,
                                                                    p_request_id uuid DEFAULT gen_random_uuid(),
                                                                    p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g          record;
  v_prior    record;
  v_state    jsonb;
  v_why      text;
  v_voided   integer := 0;
  v_inflight integer := 0;
  v_chips    numeric;
  i          record;
BEGIN
  -- IDEMPOTENCY FIRST, as begin_pending_on asks it: a worker retrying a
  -- request that already succeeded is told so, and an id that names a
  -- conversion in the other direction is named as the caller's bug.
  SELECT * INTO v_prior FROM public.cash_cluster_conversion
   WHERE conversion_request_id = p_request_id AND cluster_id = p_game_id;
  IF FOUND THEN
    IF v_prior.to_mode IS DISTINCT FROM 'must_move' THEN
      RETURN jsonb_build_object('ok', false, 'pending', false,
        'reason', 'request_id_belongs_to_another_conversion',
        'conversion_id', v_prior.id, 'to_mode', v_prior.to_mode);
    END IF;
    RETURN jsonb_build_object(
      'ok', v_prior.status <> 'aborted',
      'pending', v_prior.status = 'pending',
      'reason', CASE v_prior.status
                  WHEN 'pending'   THEN 'already_known'
                  WHEN 'committed' THEN 'already_committed'
                  ELSE 'conversion_already_aborted' END,
      'conversion_id', v_prior.id, 'status', v_prior.status,
      'abort_reason', v_prior.abort_reason,
      'cluster_mode', (SELECT cluster_mode FROM public.cash_games WHERE id = p_game_id));
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_cluster_conversion
              WHERE conversion_request_id = p_request_id) THEN
    RETURN jsonb_build_object('ok', false, 'pending', false, 'reason', 'request_id_belongs_to_another_cluster');
  END IF;

  -- NOT GATED ON fn_platform_frozen(). Leaving Lightning must always be
  -- possible (the verdict's own asymmetry: entering is gated, leaving never
  -- is), and this call deals nothing and moves no chip. The commit, which
  -- lets the physical tables deal again, is gated.

  -- THE CLUSTER ROW FIRST, in the order the ON path and formation take it.
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'pending', false, 'reason', 'not_found');
  END IF;

  -- ASKED AGAIN UNDER THE LOCK, for two callers sharing one request id.
  SELECT * INTO v_prior FROM public.cash_cluster_conversion
   WHERE conversion_request_id = p_request_id AND cluster_id = p_game_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', v_prior.status <> 'aborted' AND v_prior.to_mode = 'must_move',
      'pending', v_prior.status = 'pending',
      'reason', CASE WHEN v_prior.to_mode IS DISTINCT FROM 'must_move' THEN 'request_id_belongs_to_another_conversion'
                     WHEN v_prior.status = 'pending' THEN 'already_known'
                     WHEN v_prior.status = 'committed' THEN 'already_committed'
                     ELSE 'conversion_already_aborted' END,
      'conversion_id', v_prior.id, 'status', v_prior.status,
      'abort_reason', v_prior.abort_reason, 'cluster_mode', g.cluster_mode);
  END IF;

  IF g.cluster_mode IS DISTINCT FROM 'lightning' THEN
    RETURN jsonb_build_object('ok', false,
      'pending', g.cluster_mode IN ('pending_on', 'pending_off'),
      'reason', 'wrong_state', 'cluster_mode', g.cluster_mode);
  END IF;

  -- THE TRIGGER. The verdict is the one population reader the lobby and the
  -- ON path embed; a disabled Cluster drains whatever its population.
  v_state := public.fn_cash_cluster_lightning_state(g.id);
  v_why := CASE
    WHEN coalesce(g.lightning_enabled, false) = false THEN 'lightning_disabled'
    WHEN g.enabled IS DISTINCT FROM true THEN 'game_disabled'
    WHEN coalesce((v_state -> 'verdict' ->> 'would_turn_off')::boolean, false) THEN 'population_at_or_below_off_threshold'
    ELSE NULL END;
  IF v_why IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'pending', false, 'reason', 'threshold_not_reached',
      'verdict', v_state -> 'verdict', 'thresholds', v_state -> 'thresholds');
  END IF;

  UPDATE public.cash_games SET cluster_mode = 'pending_off', updated_at = now()
   WHERE id = g.id;

  -- THE DRAIN POLICY. Nothing new forms: fn_lightning_form_hand refuses every
  -- mode but 'lightning'. A formation that has not been dealt is void now,
  -- rather than when begin_dealing or the reaper finds it; nothing was dealt,
  -- so nothing is owed, and the AFTER trigger on lightning_instance hands its
  -- players back. A hand already dealing or settling is left to finish.
  FOR i IN
    SELECT li.id FROM public.lightning_instance li
     WHERE li.cluster_id = g.id AND li.state IN ('forming', 'reserved')
     ORDER BY li.id
     FOR UPDATE
  LOOP
    PERFORM public.fn_lightning_instance_abandon(i.id,
      'lightning pending_off: a hand not yet dealt is void; nothing was dealt and no chip moved',
      clock_timestamp());
    v_voided := v_voided + 1;
  END LOOP;

  SELECT count(*)::integer INTO v_inflight
    FROM public.lightning_instance li
   WHERE li.cluster_id = g.id AND li.state IN ('dealing', 'settling');

  SELECT coalesce(sum(ts.stack), 0) INTO v_chips
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id AND ts.left_at IS NULL;

  INSERT INTO public.cash_cluster_conversion (
    cluster_id, conversion_request_id, from_mode, to_mode, trigger_population,
    on_threshold, off_threshold, epoch_before, chips_at_begin)
  VALUES (
    g.id, p_request_id, 'lightning', 'must_move',
    coalesce((v_state -> 'verdict' ->> 'live_eligible')::integer, 0),
    coalesce((v_state -> 'thresholds' ->> 'on')::integer, 0),
    coalesce((v_state -> 'thresholds' ->> 'off')::integer, 0),
    g.cluster_epoch, v_chips)
  RETURNING * INTO v_prior;

  INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
  VALUES (g.id, 'lightning_pending_off', jsonb_build_object(
    'conversion_id', v_prior.id, 'conversion_request_id', p_request_id,
    'reason', v_why, 'note', nullif(btrim(coalesce(p_reason, '')), ''),
    'trigger_population', v_prior.trigger_population,
    'on_threshold', v_prior.on_threshold, 'off_threshold', v_prior.off_threshold,
    'epoch_before', g.cluster_epoch, 'lightning_enabled', g.lightning_enabled,
    'instances_voided', v_voided, 'hands_in_flight', v_inflight,
    'chips_at_begin', v_chips), p_request_id);

  RETURN jsonb_build_object('ok', true, 'pending', true, 'reason', 'pending_off',
    'why', v_why, 'conversion_id', v_prior.id, 'conversion_request_id', p_request_id,
    'cluster_mode', 'pending_off', 'trigger_population', v_prior.trigger_population,
    'instances_voided', v_voided, 'hands_in_flight', v_inflight,
    'thresholds', v_state -> 'thresholds');
END;
$function$;

-- ===========================================================================
-- 2. PENDING_OFF -> LIGHTNING.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_cash_cluster_abort_pending_off(p_game_id uuid, p_request_id uuid,
                                                                    p_reason text DEFAULT 'population_rose_above_off_threshold')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g        record;
  v_conv   record;
  v_reason text := coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'unstated');
  v_entered integer := 0;
  s        record;
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'aborted', false, 'reason', 'not_found');
  END IF;

  SELECT * INTO v_conv FROM public.cash_cluster_conversion
   WHERE cluster_id = g.id AND conversion_request_id = p_request_id;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.cash_cluster_conversion
                WHERE conversion_request_id = p_request_id) THEN
      RETURN jsonb_build_object('ok', false, 'aborted', false,
        'reason', 'request_id_belongs_to_another_cluster');
    END IF;
    RETURN jsonb_build_object('ok', false, 'aborted', false, 'reason', 'no_such_conversion');
  END IF;
  IF v_conv.to_mode IS DISTINCT FROM 'must_move' THEN
    RETURN jsonb_build_object('ok', false, 'aborted', false,
      'reason', 'not_a_pending_off_conversion', 'to_mode', v_conv.to_mode);
  END IF;
  IF v_conv.status = 'aborted' THEN
    RETURN jsonb_build_object('ok', true, 'aborted', true, 'reason', 'already_aborted',
      'conversion_id', v_conv.id, 'status', v_conv.status,
      'abort_reason', v_conv.abort_reason, 'cluster_mode', g.cluster_mode);
  END IF;
  IF v_conv.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'aborted', false,
      'reason', 'conversion_already_closed',
      'status', v_conv.status, 'epoch_after', v_conv.epoch_after,
      'cluster_mode', g.cluster_mode);
  END IF;
  IF g.cluster_mode IS DISTINCT FROM 'pending_off' THEN
    RETURN jsonb_build_object('ok', false, 'aborted', false, 'reason', 'wrong_state',
      'cluster_mode', g.cluster_mode);
  END IF;
  -- NEVER BACK INTO A POOL THAT HAS BEEN SWITCHED OFF. A drain begun because
  -- Lightning or the game was disabled finishes; it is not undone by a
  -- population that happens to be high.
  IF coalesce(g.lightning_enabled, false) = false OR g.enabled IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('ok', false, 'aborted', false, 'reason', 'lightning_disabled',
      'cluster_mode', g.cluster_mode);
  END IF;

  UPDATE public.cash_games SET cluster_mode = 'lightning', updated_at = now()
   WHERE id = g.id;

  -- WHOEVER SAT DOWN DURING THE DRAIN IS IN THE POOL NOW. The seat trigger
  -- enters a player only while the Cluster is 'lightning', so a player seated
  -- in pending_off would otherwise sit at a halted table in a Cluster that is
  -- a pool again. Same door, same predicate as the trigger.
  FOR s IN
    SELECT DISTINCT ON (ts.user_id) ts.id, ts.user_id
      FROM public.table_seats ts
      JOIN public.tables tb ON tb.id = ts.table_id
     WHERE tb.cluster_id = g.id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
       AND public.fn_lightning_anchor_is_live_eligible(ts.id, g.id, ts.user_id)
       AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session ps
                        WHERE ps.cluster_id = g.id AND ps.player_id = ts.user_id
                          AND ps.exited_at IS NULL)
     ORDER BY ts.user_id, ts.joined_at, ts.id
  LOOP
    IF public.fn_lightning_pool_enter(s.id, clock_timestamp()) IS NOT NULL THEN
      v_entered := v_entered + 1;
    END IF;
  END LOOP;

  UPDATE public.cash_cluster_conversion
     SET status = 'aborted', abort_reason = v_reason, closed_at = clock_timestamp()
   WHERE id = v_conv.id;

  INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
  VALUES (g.id, 'lightning_pending_off_aborted', jsonb_build_object(
    'conversion_id', v_conv.id, 'conversion_request_id', p_request_id,
    'abort_reason', v_reason, 'pool_sessions_entered', v_entered,
    'live_eligible', public.fn_cash_cluster_live_eligible(g.id)), p_request_id);

  RETURN jsonb_build_object('ok', true, 'aborted', true, 'reason', 'aborted',
    'conversion_id', v_conv.id, 'cluster_mode', 'lightning',
    'abort_reason', v_reason, 'pool_sessions_entered', v_entered);
END;
$function$;

-- ===========================================================================
-- 3. PENDING_OFF -> MUST_MOVE.
-- ===========================================================================
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
BEGIN
  -- GATED, because this is the step that lets the physical tables deal again.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reverted', false, 'ready', false, 'reason', 'platform_frozen');
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
  SELECT md5(coalesce(string_agg(x.r, '|' ORDER BY x.r), '')) INTO v_before FROM (
      SELECT 'ts:' || to_jsonb(ts)::text AS r
        FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
       WHERE tb.cluster_id = g.id
      UNION ALL
      SELECT 'cps:' || to_jsonb(s)::text FROM public.cash_player_session s WHERE s.cluster_id = g.id
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
  WITH exited AS (
    UPDATE public.lightning_pool_session ps
       SET exited_at = GREATEST(clock_timestamp(), ps.entered_at),
           exit_reason = 'lightning_off',
           state = 'closed',
           ending_stack = public.fn_lightning_pool_stack(ps.id),
           updated_at = clock_timestamp()
     WHERE ps.cluster_id = g.id AND ps.exited_at IS NULL
    RETURNING ps.id, ps.cluster_epoch, ps.player_id, ps.anchor_seat_id, ps.ending_stack, ps.exited_at
  ), logged AS (
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload, cluster_epoch, request_id)
    SELECT g.id, ts.table_id, 'pool_player_left', jsonb_build_object(
             'cluster_id', g.id, 'cluster_epoch', e.cluster_epoch, 'player_id', e.player_id,
             'pool_session_id', e.id, 'anchor_seat_id', e.anchor_seat_id, 'reason', 'lightning_off',
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
  UPDATE public.tables tb
     SET dealing_halted_at = NULL, dealing_halted_reason = NULL, dealing_halt_observed_at = NULL
   WHERE tb.cluster_id = g.id AND tb.dealing_halted_reason IN ('lightning', 'lightning_pending_on');
  GET DIAGNOSTICS v_tables = ROW_COUNT;
  SELECT count(*)::integer INTO v_halted
    FROM public.tables tb
   WHERE tb.cluster_id = g.id AND tb.dealing_halted_at IS NOT NULL
     AND coalesce(tb.is_deleted, false) = false AND coalesce(tb.lifecycle, '') <> 'closed';

  SELECT md5(coalesce(string_agg(x.r, '|' ORDER BY x.r), '')) INTO v_after FROM (
      SELECT 'ts:' || to_jsonb(ts)::text AS r
        FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
       WHERE tb.cluster_id = g.id
      UNION ALL
      SELECT 'cps:' || to_jsonb(s)::text FROM public.cash_player_session s WHERE s.cluster_id = g.id
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
    'chip_total', v_chips, 'money_md5', v_before), p_request_id);

  RETURN jsonb_build_object('ok', true, 'reverted', true, 'ready', true, 'reason', 'must_move',
    'conversion_id', v_conv.id, 'cluster_mode', 'must_move',
    'epoch_before', g.cluster_epoch, 'epoch_after', v_epoch,
    'pool_sessions_exited', v_sessions, 'slots_closed', v_slots,
    'reservations_expired', v_expired, 'reservations_released', v_released,
    'tables_released', v_tables, 'tables_still_halted', v_halted,
    'chip_total', v_chips, 'population_at_commit', v_live);
END;
$function$;

-- ===========================================================================
-- 4. THE STATE MACHINE ONE TICK PASS RUNS FOR ONE CLUSTER.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_drive(p_game_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g        record;
  v_state  jsonb;
  v_conv   record;
  v_n      integer;
  v_live   integer;
  v_off    integer;
  v_on_ok  boolean;
  v_off_ok boolean;
  v_live_ok boolean;
  v_action text;
  v_res    jsonb;
  v_mode   text;
  v_sqlstate text;
  v_message  text;
BEGIN
  SELECT cg.id, cg.cluster_mode, cg.cluster_epoch, cg.lightning_enabled, cg.enabled, cg.must_move
    INTO g FROM public.cash_games cg WHERE cg.id = p_game_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- ONE CLUSTER'S FAILURE IS ITS OWN. Everything below runs in this block's
  -- sub-transaction: a lock wait past the pass's lock_timeout, or any error,
  -- rolls back only this Cluster's step and is answered as a row and an
  -- event, and the tick pass goes on to the next Cluster.
  BEGIN

  -- ONE READER. The verdict is fn_cash_cluster_live_eligible against the
  -- configured thresholds; the hysteresis is the gap between ON and OFF, and
  -- nothing here re-derives either number.
  v_state  := public.fn_cash_cluster_lightning_state(g.id);
  v_on_ok  := coalesce((v_state -> 'verdict' ->> 'would_turn_on')::boolean, false);
  v_off_ok := coalesce((v_state -> 'verdict' ->> 'would_turn_off')::boolean, false);
  v_live   := coalesce((v_state -> 'verdict' ->> 'live_eligible')::integer, 0);
  v_off    := coalesce((v_state -> 'thresholds' ->> 'off')::integer, 0);
  v_live_ok := coalesce(g.lightning_enabled, false) AND g.enabled IS NOT DISTINCT FROM true;

  SELECT * INTO v_conv FROM public.cash_cluster_conversion cc
   WHERE cc.cluster_id = g.id AND cc.status = 'pending';
  SELECT count(*)::integer INTO v_n FROM public.cash_cluster_conversion cc WHERE cc.cluster_id = g.id;

  IF g.cluster_mode = 'must_move' THEN
    IF v_on_ok AND coalesce(g.must_move, false) THEN
      v_action := 'begin_pending_on';
      -- THE REQUEST ID IS THE CLUSTER, ITS EPOCH, THE DIRECTION AND HOW MANY
      -- CONVERSIONS IT HAS HAD, so two passes racing here ask for the same
      -- conversion and the second is told already_known. An abort adds a row,
      -- so the next attempt gets a new id.
      v_res := public.fn_cash_cluster_begin_pending_on(g.id,
        md5(format('lightning-drive:%s:%s:lightning:%s', g.id, g.cluster_epoch, v_n))::uuid);
    ELSE
      v_action := 'hold';
    END IF;
  ELSIF g.cluster_mode = 'pending_on' THEN
    IF v_conv.id IS NULL THEN
      v_action := 'no_open_conversion';
    ELSIF NOT v_on_ok THEN
      v_action := 'abort_pending_on';
      v_res := public.fn_cash_cluster_abort_pending_on(g.id, v_conv.conversion_request_id,
        CASE WHEN coalesce(g.lightning_enabled, false) = false THEN 'lightning_disabled'
             WHEN g.enabled IS DISTINCT FROM true THEN 'game_disabled'
             ELSE 'population_fell_below_on_threshold' END);
    ELSE
      v_action := 'commit_lightning';
      v_res := public.fn_cash_cluster_commit_lightning(g.id, v_conv.conversion_request_id);
    END IF;
  ELSIF g.cluster_mode = 'lightning' THEN
    IF v_off_ok OR NOT v_live_ok THEN
      v_action := 'begin_pending_off';
      v_res := public.fn_cash_cluster_begin_pending_off(g.id,
        md5(format('lightning-drive:%s:%s:must_move:%s', g.id, g.cluster_epoch, v_n))::uuid,
        'fn_cash_cluster_lightning_drive');
    ELSE
      v_action := 'hold';
    END IF;
  ELSIF g.cluster_mode = 'pending_off' THEN
    IF v_conv.id IS NULL THEN
      v_action := 'no_open_conversion';
    ELSIF v_live_ok AND v_live > v_off THEN
      v_action := 'abort_pending_off';
      v_res := public.fn_cash_cluster_abort_pending_off(g.id, v_conv.conversion_request_id,
        'population_rose_above_off_threshold');
    ELSE
      v_action := 'commit_must_move';
      v_res := public.fn_cash_cluster_commit_must_move(g.id, v_conv.conversion_request_id);
    END IF;
  ELSE
    v_action := 'mode_not_driven';
  END IF;

  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (g.id, 'lightning_drive_error', jsonb_build_object(
      'cluster_id', g.id, 'mode', g.cluster_mode, 'action', v_action,
      'sqlstate', v_sqlstate, 'message', v_message, 'at', clock_timestamp()));
    RETURN jsonb_build_object('ok', false, 'cluster_id', g.id, 'action', v_action,
      'mode_before', g.cluster_mode,
      'error', jsonb_build_object('sqlstate', v_sqlstate, 'message', v_message));
  END;

  SELECT cg.cluster_mode INTO v_mode FROM public.cash_games cg WHERE cg.id = g.id;
  RETURN jsonb_build_object('ok', true, 'cluster_id', g.id, 'action', v_action,
    'mode_before', g.cluster_mode, 'cluster_mode', v_mode,
    'live_eligible', v_live, 'thresholds', v_state -> 'thresholds',
    'lightning_enabled', g.lightning_enabled)
    || CASE WHEN v_res IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('result', v_res) END;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_begin_pending_off(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_begin_pending_off(uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_cluster_abort_pending_off(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_abort_pending_off(uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_cluster_commit_must_move(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_commit_must_move(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_cluster_lightning_drive(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_lightning_drive(uuid) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_begin_pending_off(uuid, uuid, text) IS
  'Lightning Phase 7 (spec Phase 10): LIGHTNING -> PENDING_OFF when the live eligible population is at or below OFF, or Lightning or the game is disabled. Opens a lightning -> must_move cash_cluster_conversion, voids formations not yet dealt, emits lightning_pending_off. Idempotent on p_request_id. Moves no chip.';
COMMENT ON FUNCTION public.fn_cash_cluster_abort_pending_off(uuid, uuid, text) IS
  'Lightning Phase 7: PENDING_OFF -> LIGHTNING (refused while disabled). Aborts the conversion, enters players seated during the drain into the pool, emits lightning_pending_off_aborted.';
COMMENT ON FUNCTION public.fn_cash_cluster_commit_must_move(uuid, uuid) IS
  'Lightning Phase 7: PENDING_OFF -> MUST_MOVE once no instance is live (else {ready:false, reason:instances_in_flight}). Exits every pool session (lightning_off), closes slots, expires reservations, opens the next epoch, lifts the Lightning halt, emits lightning_off and one pool_player_left per player. Writes no seat, cash session or blind ledger row, asserted by md5.';
COMMENT ON FUNCTION public.fn_cash_cluster_lightning_drive(uuid) IS
  'Lightning Phase 7: the conversion state machine one fn_cash_clusters_tick_all pass runs per Cluster, with ON/OFF hysteresis from fn_cash_cluster_lightning_state and request ids derived from the Cluster, epoch, direction and conversion count.';

-- ===========================================================================
-- 5. fn_cash_cluster_reap_stuck_conversions: a stuck PENDING_OFF is reaped.
-- ===========================================================================
DO $sub_reap$
DECLARE
  v_sig constant text := 'public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$    v_seen := v_seen + 1;

    IF c.to_mode IS DISTINCT FROM 'lightning' OR c.cluster_mode IS DISTINCT FROM 'pending_on' THEN
$a$];
  b text[] := ARRAY[
$b$    v_seen := v_seen + 1;

    -- LIGHTNING PHASE 7 (20261001222856): A STUCK PENDING_OFF. Its drain is a
    -- set of hands that never finished. Past the age every instance still not
    -- terminal is abandoned through the existing door (a void hand: nothing
    -- writes money before settlement, so no chip moves), and the reversion is
    -- committed through fn_cash_cluster_commit_must_move, whose own md5
    -- assertion is the proof. One Cluster's failure is a row and an event,
    -- and the queue behind it is still reaped.
    IF c.to_mode = 'must_move' AND c.cluster_mode = 'pending_off' THEN
      DECLARE
        v_inst     record;
        v_void     integer := 0;
        v_commit   jsonb;
        v_reverted boolean := false;
      BEGIN
        BEGIN
          FOR v_inst IN
            SELECT li.id FROM public.lightning_instance li
             WHERE li.cluster_id = c.cluster_id
               AND li.state IN ('forming', 'reserved', 'dealing', 'settling')
             ORDER BY li.id
          LOOP
            PERFORM public.fn_lightning_instance_abandon(v_inst.id,
              format('reaped: PENDING_OFF for %s, past the %s this estate allows a reversion to wait on a hand; the hand is void and no chip moved',
                     justify_interval(p_now - c.opened_at), v_age),
              clock_timestamp());
            v_void := v_void + 1;
          END LOOP;
          v_commit := public.fn_cash_cluster_commit_must_move(c.cluster_id, c.conversion_request_id);
          v_reverted := coalesce((v_commit ->> 'reverted')::boolean, false);
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
          v_reverted := false;
          v_void := 0;
          v_failed := v_failed + 1;
          v_commit := jsonb_build_object('ok', false, 'reverted', false, 'reason', 'revert_failed',
                                         'sqlstate', v_sqlstate, 'message', v_msg);
          INSERT INTO public.cash_cluster_events (game_id, kind, payload)
          VALUES (c.cluster_id, 'lightning_pending_off_reap_failed', jsonb_build_object(
            'cluster_id', c.cluster_id, 'conversion_id', c.id,
            'conversion_request_id', c.conversion_request_id, 'opened_at', c.opened_at,
            'sqlstate', v_sqlstate, 'message', v_msg, 'at', clock_timestamp()));
        END;
        IF v_reverted THEN
          v_reaped := v_reaped + 1;
          INSERT INTO public.cash_cluster_events (game_id, kind, payload)
          VALUES (c.cluster_id, 'lightning_pending_off_reaped', jsonb_build_object(
            'conversion_id', c.id, 'conversion_request_id', c.conversion_request_id,
            'opened_at', c.opened_at,
            'stuck_for', justify_interval(p_now - c.opened_at)::text,
            'max_age', v_age::text,
            'instances_abandoned', v_void,
            'commit', v_commit,
            'pool_health', public.fn_cash_cluster_pool_health(c.cluster_id, p_now)));
        ELSE
          v_skipped := v_skipped + 1;
        END IF;
        v_rows := v_rows || jsonb_build_object(
          'conversion_id', c.id, 'cluster_id', c.cluster_id, 'direction', 'off',
          'reaped', v_reverted, 'instances_abandoned', v_void, 'answer', v_commit);
      END;
      CONTINUE;
    END IF;

    IF c.to_mode IS DISTINCT FROM 'lightning' OR c.cluster_mode IS DISTINCT FROM 'pending_on' THEN
$b$];
  c integer[] := ARRAY[1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('''lightning_pending_off_reaped''' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position(b[1] in v_src) = 0
     OR position('fn_cash_cluster_abort_pending_on' in v_src) = 0
     OR position('''not_a_pending_on_lightning_conversion''' in v_src) = 0 THEN
    RAISE EXCEPTION '% does not read back reaping a stuck PENDING_OFF', v_sig;
  END IF;
END
$sub_reap$;

-- ===========================================================================
-- 6. fn_cash_clusters_tick_all: every pass drives every Lightning Cluster.
-- ===========================================================================
DO $sub_tick$
DECLARE
  v_sig constant text := 'public.fn_cash_clusters_tick_all(jsonb)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$  v_lightning_synced jsonb := '[]'::jsonb;
$a$,
$a$  FOR lc IN
    SELECT cg.id FROM public.cash_games cg
     WHERE cg.cluster_mode = 'lightning'
$a$,
$a$    'lightning_synced', v_lightning_synced,
$a$];
  b text[] := ARRAY[
$b$  v_lightning_synced jsonb := '[]'::jsonb;
  v_lightning_driven jsonb := '[]'::jsonb;
$b$,
$b$  -- LIGHTNING PHASE 7 (20261001222856): THE CONVERSIONS ARE DRIVEN HERE.
  -- Every Cluster that may convert (lightning_enabled and a must-move game)
  -- or is in a Lightning mode, after both reaps so a buried instance is not
  -- waited on, and before the slot sync so a Cluster converted now is given
  -- its slots now. One step per Cluster per pass; each in its own sub-block
  -- inside the drive, so one Cluster's lock wait or failure costs that
  -- Cluster, not the pass.
  -- Production has lightning_enabled false on every game: this loop finds
  -- nothing there until a game is switched on.
  FOR lc IN
    SELECT cg.id FROM public.cash_games cg
     WHERE (coalesce(cg.lightning_enabled, false) AND coalesce(cg.must_move, false))
        OR cg.cluster_mode IN ('pending_on', 'lightning', 'pending_off')
     ORDER BY cg.id
  LOOP
    IF clock_timestamp() - v_now > v_budget THEN
      v_lightning_driven := v_lightning_driven || jsonb_build_object(
        'cluster_id', lc.id, 'deferred', true);
      CONTINUE;
    END IF;
    -- The drive isolates itself: a lock wait or a failure inside it is rolled
    -- back to its own sub-block and answered {ok: false, error}, so this loop
    -- needs no handler of its own.
    v_lightning_driven := v_lightning_driven || public.fn_cash_cluster_lightning_drive(lc.id);
  END LOOP;

  FOR lc IN
    SELECT cg.id FROM public.cash_games cg
     WHERE cg.cluster_mode = 'lightning'
$b$,
$b$    'lightning_synced', v_lightning_synced,
    'lightning_driven', v_lightning_driven,
$b$];
  c integer[] := ARRAY[1, 1, 1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('fn_cash_cluster_lightning_drive' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position(b[1] in v_src) = 0 OR position(b[2] in v_src) = 0 OR position(b[3] in v_src) = 0
     OR position('fn_lightning_reap_formations' in v_src) > position('fn_cash_cluster_lightning_drive' in v_src)
     OR position('fn_cash_cluster_lightning_drive' in v_src) > position('fn_lightning_pool_slots_sync' in v_src) THEN
    RAISE EXCEPTION '% does not read back driving the conversions between the reaps and the slot sync', v_sig;
  END IF;
END
$sub_tick$;

-- ===========================================================================
-- 7. fn_lightning_my_session: a seated caller with no pool session is told
--    where they sit.
-- ===========================================================================
DO $sub_session$
DECLARE
  v_sig constant text := 'public.fn_lightning_my_session(uuid)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$  v_hand uuid;
BEGIN
$a$,
$a$  IF NOT FOUND THEN
    RETURN jsonb_build_object('pool_session_id', NULL);
  END IF;
$a$,
$a$'anchor_table_id', s.anchor_table_id, 'seat_number', s.seat_number,$a$];
  b text[] := ARRAY[
$b$  v_hand uuid;
  v_seat record;
BEGIN
$b$,
$b$  IF NOT FOUND THEN
    -- LIGHTNING PHASE 7 (20261001222856): NO OPEN POOL SESSION, BUT A LIVE
    -- SEAT IN THE CLUSTER - a must-move player, or one whose pool session the
    -- reversion has just closed. The client is told where they sit, so it
    -- moves them back to the physical table without guessing.
    SELECT ts.table_id, ts.seat_number, cg.cluster_mode
      INTO v_seat
      FROM public.table_seats ts
      JOIN public.tables tb ON tb.id = ts.table_id
      JOIN public.cash_games cg ON cg.id = tb.cluster_id
     WHERE tb.cluster_id = p_cluster_id AND ts.user_id = v_uid AND ts.left_at IS NULL
       AND coalesce(tb.is_deleted, false) = false AND coalesce(tb.lifecycle, '') <> 'closed'
     ORDER BY ts.joined_at, ts.id
     LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('pool_session_id', NULL);
    END IF;
    RETURN jsonb_build_object('pool_session_id', NULL, 'cluster_mode', v_seat.cluster_mode,
                              'seat_table_id', v_seat.table_id, 'seat_number', v_seat.seat_number);
  END IF;
$b$,
$b$'anchor_table_id', s.anchor_table_id, 'seat_table_id', s.anchor_table_id, 'seat_number', s.seat_number,$b$];
  c integer[] := ARRAY[1, 1, 1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('''seat_table_id''' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position(b[1] in v_src) = 0 OR position(b[2] in v_src) = 0 OR position(b[3] in v_src) = 0
     OR position('auth.uid()' in v_src) = 0
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_sig::regprocedure) THEN
    RAISE EXCEPTION '% does not read back naming the seat of a caller with no pool session', v_sig;
  END IF;
END
$sub_session$;

-- ===========================================================================
-- THE READBACK.
-- ===========================================================================
DO $readback$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('service_role doors', (SELECT bool_and(has_function_privilege('service_role', f::regprocedure, 'EXECUTE')
       AND NOT has_function_privilege('anon', f::regprocedure, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', f::regprocedure, 'EXECUTE'))
       FROM unnest(ARRAY['public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)',
                         'public.fn_cash_cluster_abort_pending_off(uuid,uuid,text)',
                         'public.fn_cash_cluster_commit_must_move(uuid,uuid)',
                         'public.fn_cash_cluster_lightning_drive(uuid)',
                         'public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)',
                         'public.fn_cash_clusters_tick_all(jsonb)']) f)),
    ('the browser door', (SELECT p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.oid = 'public.fn_lightning_my_session(uuid)'::regprocedure)),
    ('definers with pinned search paths', (SELECT bool_and(p.prosecdef AND p.proconfig IS NOT NULL AND p.proconfig::text ~ 'search_path')
       FROM pg_proc p WHERE p.oid IN (
         'public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)'::regprocedure,
         'public.fn_cash_cluster_abort_pending_off(uuid,uuid,text)'::regprocedure,
         'public.fn_cash_cluster_commit_must_move(uuid,uuid)'::regprocedure,
         'public.fn_cash_cluster_lightning_drive(uuid)'::regprocedure,
         'public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)'::regprocedure,
         'public.fn_cash_clusters_tick_all(jsonb)'::regprocedure,
         'public.fn_lightning_my_session(uuid)'::regprocedure))),
    ('formation still refuses every mode but lightning', (SELECT pg_get_functiondef(
       'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid)'::regprocedure)
       ~ 'g\.cluster_mode IS DISTINCT FROM ''lightning''')),
    ('settlement still refuses only a frozen Cluster', (SELECT s ~ 'v_mode IS NOT DISTINCT FROM ''frozen''' AND s !~ 'v_mode IS DISTINCT FROM ''lightning'''
       FROM (SELECT pg_get_functiondef('public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure) AS s) q))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_PHASE_7_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
