-- 20261008050805_lightning_phase_9_disconnect_reconnect_and_the_forensic_ledg.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASE 9 (SPECIFICATION PHASES 14 AND 15, THE DATABASE SIDE):
-- DISCONNECT / RECONNECT AND THE EVENT LEDGER / AUDIT / FORENSICS.
--
-- Presence is engine-side (the DisconnectEngine owns the sockets); the
-- database is where a disconnect must become DURABLE, because the matcher,
-- the population and the forensic record all read the database, not a
-- worker's memory. This file gives the engine one door to report presence
-- transitions through, one reaper that expires a disconnect nobody came back
-- from, one door a reconnecting client rebuilds from, and the two audit
-- readers the specification's Phase 15 asks of persisted state.
--
-- 1. DURABLE DISCONNECT STATE. lightning_pool_session gains disconnected_at.
--    fn_lightning_presence_report(cluster, disconnected[], reconnected[],
--    now) (service_role) stamps and clears it on the Cluster's open pool
--    sessions, flips state between 'active' and 'disconnected' (and only
--    between those two: a sit_out or leaving session keeps its state and only
--    carries the stamp), and emits ONE player_disconnected and ONE
--    player_reconnected event per call, carrying the lists - the engine calls
--    this on presence transitions, not every pass, and a second identical
--    call writes nothing. P0 already refuses a 'disconnected' session as
--    DISCONNECTED and the matcher already diagnoses it WAITING_FOR_RECONNECT;
--    this file makes that state reachable.
--
-- 2. EXPIRY. fn_lightning_reap_expired_disconnects (service_role, wired into
--    fn_cash_clusters_tick_all beside the formation reaper, isolated the same
--    way): an open pool session disconnected longer than the Cluster's
--    disconnect_timeout_ms (new fn_lightning_config key, default 180000,
--    clamped 30000..1800000) whose player is NOT in a live hand and holds no
--    live reservation exits the pool - exit_reason 'disconnect_expired',
--    state 'closed', slot closed, one pool_player_left and one player_expired
--    event - and releases nothing in-hand: a player in a live hand is never
--    expired here, the hand's own clock and fold rules own them until it
--    settles. Expired disconnects then no longer count in
--    fn_cash_cluster_live_eligible's pool half (the session is exited), and
--    the seated half is answered by the p_disconnected subtraction the engine
--    already passes until it stands the seat up, exactly as the population
--    comment records.
--
-- 3. RECONNECT SNAPSHOT. fn_lightning_reconnect_state(cluster)
--    (authenticated, SECURITY DEFINER, auth.uid() scoped): everything the
--    caller's client needs to rebuild after a reconnect - {pool_session_id,
--    state, in_hand, hand_id, disconnected_at, seat_table_id, seat_number,
--    stack, joinable} - joinable computed exactly as fn_lightning_pool_status
--    computes it, never the raw cluster_mode, never an instance id, never
--    another player's anything.
--
-- 4. THE LEDGER IS COMPLETE AND READABLE. Every pool-session exit path now
--    emits pool_player_left: the anchor-seat trigger and the Phase 7
--    reversion already did, the new reaper does, and fn_cash_cluster_unfreeze
--    (the one writer that exited sessions silently) is substituted to emit
--    one per session it exits. fn_lightning_cluster_forensics(cluster, from,
--    to, limit) (service_role, read-only, bounded) answers the window's
--    events, conversions, matcher passes, instances and hands in order.
--    fn_lightning_hand_replay_check(hand) (service_role, read-only) is the
--    deterministic audit the specification's REPLAY ENGINE asks of persisted
--    state: stack_before + net = stack_after per player, conservation of the
--    deltas against the recorded rake and BBJ, the six versions present, and
--    the hand's events present in order (hand_created, hand_settled or
--    instance_destroyed) - {ok, defects} with a named defect for every
--    violated clause.
--
-- 5. VERSIONING ON CONVERSIONS is verified, not rebuilt: cash_cluster_conversion
--    already records from_mode, to_mode, trigger_population, both thresholds,
--    both epochs, the request id and completion status (Phase 5); a live
--    proof below pins that and no column is added.
--
-- HOUSE RULES OBSERVED. One BEGIN/COMMIT with SET LOCAL lock_timeout. The
-- only table altered is lightning_pool_session; neither tables nor
-- table_seats is locked by DDL. Every change to an existing body
-- (fn_lightning_config, fn_cash_clusters_tick_all, fn_cash_cluster_unfreeze)
-- is an asserted substitution into the body production carries (read with
-- pg_get_functiondef on 2026-10-08, after 20261008043021): each anchor must
-- appear exactly as often as stated or the file refuses, and a body already
-- carrying the marker is left alone, so the file is re-appliable. The tick
-- substitution adds a fifth isolated sub-block, so exactly one predecessor
-- proof (20260926023047's reading of the tick at four EXCEPTION blocks) is
-- restated here against five, with the reap order extended by one step.
--
-- LAW 10.5. Nothing here reads is_horse or horse_id. A horse disconnects,
-- reconnects, expires and is audited exactly as a human is.
--
-- @live-proof: (SELECT a.atttypid = 'timestamptz'::regtype AND NOT a.attnotnull FROM pg_attribute a WHERE a.attrelid = 'public.lightning_pool_session'::regclass AND a.attname = 'disconnected_at' AND NOT a.attisdropped)
-- @live-proof: (SELECT pg_get_constraintdef(c.oid) ~ 'disconnected_at IS NOT NULL' FROM pg_constraint c WHERE c.conrelid = 'public.lightning_pool_session'::regclass AND c.conname = 'lightning_pool_session_disconnect_is_dated')
-- @live-proof: (SELECT NOT p.prosecdef AND p.provolatile = 'v' AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND s ~ '''player_disconnected''' AND s ~ '''player_reconnected''' AND s ~ 'coalesce\(s\.disconnected_at, v_now\)' FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid = 'public.fn_lightning_presence_report(uuid,uuid[],uuid[],timestamp with time zone)'::regprocedure)
-- @live-proof: (SELECT NOT p.prosecdef AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND s ~ '''disconnect_expired''' AND s ~ '''player_expired''' AND s ~ '''pool_player_left''' AND s ~ 'LEAST\(coalesce\(p_now, clock_timestamp\(\)\), clock_timestamp\(\)\)' AND s ~ 'FOR UPDATE OF ps SKIP LOCKED' AND s ~ 'fn_lightning_player_in_hand' FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid = 'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure)
-- @live-proof: (SELECT (public.fn_lightning_config(NULL) ->> 'disconnect_timeout_ms')::integer = 180000)
-- @live-proof: (SELECT s ~ 'fn_lightning_reap_expired_disconnects\(\)' AND s ~ '''disconnects_reaped'', v_disconnects_reaped' FROM (SELECT pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ 'public\.fn_lightning_reap_formations\(\)' AND s ~ 'public\.fn_lightning_reap_expired_disconnects\(\)' AND s ~ 'public\.fn_lightning_pool_slots_sync\(lc\.id\)' AND position('fn_platform_frozen' in s) < position('fn_cash_cluster_reap_stuck_conversions' in s) AND position('fn_cash_cluster_reap_stuck_conversions' in s) < position('fn_lightning_reap_formations' in s) AND position('fn_lightning_reap_formations' in s) < position('fn_lightning_reap_expired_disconnects' in s) AND position('fn_lightning_reap_expired_disconnects' in s) < position('fn_lightning_pool_slots_sync' in s) AND position('fn_lightning_pool_slots_sync' in s) < position('FOR w IN' in s) AND (SELECT count(*) FROM regexp_matches(s, 'EXCEPTION WHEN OTHERS THEN', 'g')) = 5 AND s !~ 'is_horse' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT p.prosecdef AND p.provolatile = 's' AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND s ~ 'auth\.uid\(\)' AND s ~ '''joinable''' AND s !~ '''instance_id''' AND s !~ '''cluster_mode''' FROM pg_proc p, LATERAL (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s) q WHERE p.oid = 'public.fn_lightning_reconnect_state(uuid)'::regprocedure)
-- @live-proof: (SELECT NOT p.prosecdef AND p.provolatile = 's' AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND s ~ 'LEAST\(GREATEST\(coalesce\(p_limit, 500\), 1\), 2000\)' AND s !~ '\mINSERT\M' AND s !~ '\mUPDATE public\M' FROM pg_proc p, LATERAL (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s) q WHERE p.oid = 'public.fn_lightning_cluster_forensics(uuid,timestamp with time zone,timestamp with time zone,integer)'::regprocedure)
-- @live-proof: (SELECT NOT p.prosecdef AND p.provolatile = 's' AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND s ~ '''stack_arithmetic''' AND s ~ '''conservation''' AND s ~ '''version_missing''' AND s ~ '''event_missing''' AND s ~ '''event_order''' FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid = 'public.fn_lightning_hand_replay_check(uuid)'::regprocedure)
-- @live-proof: (SELECT pg_get_functiondef('public.fn_cash_cluster_unfreeze(uuid,uuid,text)'::regprocedure) ~ '''pool_player_left''')
-- @live-proof: (SELECT count(*) = 8 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cash_cluster_conversion' AND column_name IN ('from_mode', 'to_mode', 'trigger_population', 'on_threshold', 'off_threshold', 'epoch_before', 'epoch_after', 'conversion_request_id'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_lightning_presence_report', 'fn_lightning_reap_expired_disconnects', 'fn_lightning_reconnect_state', 'fn_lightning_cluster_forensics', 'fn_lightning_hand_replay_check', 'fn_lightning_config', 'fn_cash_clusters_tick_all', 'fn_cash_cluster_unfreeze') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id'))

BEGIN;

SET LOCAL lock_timeout = '2s';

-- ===========================================================================
-- 1. DURABLE DISCONNECT STATE: the stamp and its constraint. One ALTER on
--    lightning_pool_session alone; neither tables nor table_seats is locked.
-- ===========================================================================

ALTER TABLE public.lightning_pool_session
  ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;

COMMENT ON COLUMN public.lightning_pool_session.disconnected_at IS
  'When the engine last reported this player''s logical gaming presence lost (fn_lightning_presence_report), NULL while connected. Survives on an exited row for forensics. A session disconnected longer than the Cluster''s disconnect_timeout_ms whose player is not in a live hand is exited by fn_lightning_reap_expired_disconnects (exit_reason disconnect_expired).';

DO $ddl$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.lightning_pool_session'::regclass
                    AND conname = 'lightning_pool_session_disconnect_is_dated') THEN
    -- The participation state machine cannot say 'disconnected' without
    -- saying since when: the reaper's whole judgement is that timestamp.
    ALTER TABLE public.lightning_pool_session
      ADD CONSTRAINT lightning_pool_session_disconnect_is_dated
      CHECK (state <> 'disconnected' OR disconnected_at IS NOT NULL);
  END IF;
END
$ddl$;

-- The reaper's worklist: open, stamped sessions only. Partial, so the index
-- stays empty while everyone is connected.
CREATE INDEX IF NOT EXISTS lightning_pool_session_expiring_disconnects
  ON public.lightning_pool_session (disconnected_at)
  WHERE exited_at IS NULL AND disconnected_at IS NOT NULL;

-- ===========================================================================
-- 2. THE PRESENCE DOOR. The engine's DisconnectEngine calls this on presence
--    TRANSITIONS (not every pass). Idempotent: a session already stamped
--    keeps its original stamp, a session already clear stays clear, and a
--    call that changes nothing writes no event. One event per call per
--    direction, carrying the lists. A player named in both lists ends
--    connected: the reconnect is applied after the disconnect.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_presence_report(
  p_cluster_id   uuid,
  p_disconnected uuid[],
  p_reconnected  uuid[],
  p_now          timestamp with time zone DEFAULT clock_timestamp())
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g        record;
  v_now    timestamp with time zone;
  v_down   jsonb;
  v_up     jsonb;
BEGIN
  -- NEVER STAMP BY A CLOCK THAT HAS NOT ARRIVED: a future p_now would age the
  -- disconnect toward expiry before it happened (the reapers' rule).
  v_now := LEAST(coalesce(p_now, clock_timestamp()), clock_timestamp());

  SELECT cg.id, cg.cluster_epoch INTO g FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'cluster_id', p_cluster_id);
  END IF;

  -- THE DISCONNECTS. Only an unstamped open session changes, so the original
  -- stamp stands however often the engine repeats itself. Only 'active'
  -- becomes 'disconnected': sit_out, joining, eligibility_check and leaving
  -- keep their own state (P0 refuses each with its own reason already) and
  -- carry the stamp for the reaper and the record.
  WITH stamped AS (
    UPDATE public.lightning_pool_session s
       SET disconnected_at = coalesce(s.disconnected_at, v_now),
           state = CASE WHEN s.state = 'active' THEN 'disconnected' ELSE s.state END,
           updated_at = v_now
     WHERE s.cluster_id = g.id AND s.exited_at IS NULL
       AND s.disconnected_at IS NULL
       AND s.player_id = ANY (coalesce(p_disconnected, ARRAY[]::uuid[]))
       AND NOT (s.player_id = ANY (coalesce(p_reconnected, ARRAY[]::uuid[])))
    RETURNING s.id, s.player_id
  )
  SELECT jsonb_agg(jsonb_build_object('player_id', st.player_id, 'pool_session_id', st.id)
                   ORDER BY st.player_id)
    INTO v_down FROM stamped st;

  IF v_down IS NOT NULL THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
    VALUES (g.id, 'player_disconnected', jsonb_build_object(
      'cluster_id', g.id, 'cluster_epoch', g.cluster_epoch,
      'players', v_down, 'at', v_now), g.cluster_epoch);
  END IF;

  -- THE RECONNECTS. Only a stamped open session changes; 'disconnected'
  -- returns to 'active', any other state keeps itself and just loses the
  -- stamp. An expired session is exited already and is NOT revived here: the
  -- player rejoins through the seat door like anybody else.
  WITH cleared AS (
    UPDATE public.lightning_pool_session s
       SET disconnected_at = NULL,
           state = CASE WHEN s.state = 'disconnected' THEN 'active' ELSE s.state END,
           updated_at = v_now
     WHERE s.cluster_id = g.id AND s.exited_at IS NULL
       AND s.disconnected_at IS NOT NULL
       AND s.player_id = ANY (coalesce(p_reconnected, ARRAY[]::uuid[]))
    RETURNING s.id, s.player_id
  )
  SELECT jsonb_agg(jsonb_build_object('player_id', cl.player_id, 'pool_session_id', cl.id)
                   ORDER BY cl.player_id)
    INTO v_up FROM cleared cl;

  IF v_up IS NOT NULL THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
    VALUES (g.id, 'player_reconnected', jsonb_build_object(
      'cluster_id', g.id, 'cluster_epoch', g.cluster_epoch,
      'players', v_up, 'at', v_now), g.cluster_epoch);
  END IF;

  RETURN jsonb_build_object('ok', true, 'cluster_id', g.id, 'cluster_epoch', g.cluster_epoch,
    'disconnected', coalesce(v_down, '[]'::jsonb), 'reconnected', coalesce(v_up, '[]'::jsonb));
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_presence_report(uuid, uuid[], uuid[], timestamp with time zone) IS
  'Lightning Phase 9 (spec Phase 14). The engine''s presence door: stamps disconnected_at (keeping the original stamp) and flips active -> disconnected on the Cluster''s open pool sessions for p_disconnected, clears the stamp and flips disconnected -> active for p_reconnected, and emits at most one player_disconnected and one player_reconnected event per call, carrying the lists. Idempotent and event-light: a call that changes nothing writes nothing. Called by the engine on presence transitions, service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_presence_report(uuid, uuid[], uuid[], timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_presence_report(uuid, uuid[], uuid[], timestamp with time zone) TO service_role;

-- ===========================================================================
-- 3. THE EXPIRY REAPER. Beside fn_lightning_reap_formations in the tick: an
--    open session disconnected longer than the Cluster's configured timeout,
--    whose player is NOT in a live hand and holds NO live reservation, exits
--    the pool. Per-item isolation: one session's failure costs that session.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_reap_expired_disconnects(
  p_cluster_id uuid DEFAULT NULL::uuid,
  p_now        timestamp with time zone DEFAULT clock_timestamp(),
  p_limit      integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  s          record;
  v_exited   integer := 0;
  v_rows     jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_errors   jsonb := '[]'::jsonb;
  v_expired  jsonb;
  v_seat     record;
  v_stack    numeric;
  v_sqlstate text;
  v_message  text;
  c          record;
BEGIN
  -- NEVER REAP BY A CLOCK THAT HAS NOT ARRIVED (the formation reaper's rule):
  -- a future p_now would expire a disconnect that has not yet stood its time.
  p_now := LEAST(coalesce(p_now, clock_timestamp()), clock_timestamp());

  FOR s IN
    SELECT ps.id, ps.cluster_id, ps.cluster_epoch, ps.player_id, ps.anchor_seat_id,
           ps.disconnected_at, cfg.timeout_ms
      FROM public.lightning_pool_session ps
      JOIN LATERAL (SELECT (public.fn_lightning_config(ps.cluster_id) ->> 'disconnect_timeout_ms')::integer
                      AS timeout_ms) cfg ON true
     WHERE ps.exited_at IS NULL
       AND ps.disconnected_at IS NOT NULL
       AND (p_cluster_id IS NULL OR ps.cluster_id = p_cluster_id)
       AND ps.disconnected_at + make_interval(secs => cfg.timeout_ms / 1000.0) <= p_now
     ORDER BY ps.disconnected_at, ps.id
     LIMIT GREATEST(1, coalesce(p_limit, 200))
       FOR UPDATE OF ps SKIP LOCKED
  LOOP
    BEGIN
      -- RELEASE NOTHING IN-HAND. A player in a live hand - or holding any
      -- live reservation on the way into one - is never expired here: the
      -- hand's own clock, fold rules and settlement own them, and the
      -- formation reaper owns a reservation nothing vouches for. The next
      -- pass expires them once the hand lets go.
      IF public.fn_lightning_player_in_hand(s.player_id, s.cluster_id)
         OR EXISTS (SELECT 1 FROM public.lightning_reservation r
                     WHERE r.cluster_id = s.cluster_id AND r.player_id = s.player_id
                       AND r.state IN ('pending', 'committed')) THEN
        v_skipped := v_skipped || jsonb_build_object(
          'pool_session_id', s.id, 'cluster_id', s.cluster_id, 'player_id', s.player_id,
          'reason', 'in_hand_or_reserved');
        CONTINUE;
      END IF;

      UPDATE public.lightning_pool_session ps
         SET exited_at = GREATEST(p_now, ps.entered_at),
             exit_reason = 'disconnect_expired',
             state = 'closed',
             ending_stack = public.fn_lightning_pool_stack(ps.id),
             updated_at = p_now
       WHERE ps.id = s.id AND ps.exited_at IS NULL
      RETURNING ps.ending_stack INTO v_stack;
      IF NOT FOUND THEN
        CONTINUE;
      END IF;

      UPDATE public.lightning_pool_slot sl
         SET closed_at = GREATEST(p_now, sl.opened_at),
             close_reason = 'pool_session_exited',
             updated_at = p_now
       WHERE sl.pool_session_id = s.id AND sl.closed_at IS NULL;

      SELECT ts.table_id INTO v_seat FROM public.table_seats ts WHERE ts.id = s.anchor_seat_id;

      -- EVERY EXIT PATH SAYS pool_player_left, this one included, in the
      -- anchor-seat trigger's own payload shape.
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload, cluster_epoch)
      VALUES (s.cluster_id, v_seat.table_id, 'pool_player_left', jsonb_build_object(
        'cluster_id', s.cluster_id, 'cluster_epoch', s.cluster_epoch, 'player_id', s.player_id,
        'pool_session_id', s.id, 'anchor_seat_id', s.anchor_seat_id, 'reason', 'disconnect_expired',
        'ending_stack', v_stack, 'at', p_now), s.cluster_epoch);

      v_exited := v_exited + 1;
      v_rows := v_rows || jsonb_build_object(
        'pool_session_id', s.id, 'cluster_id', s.cluster_id, 'cluster_epoch', s.cluster_epoch,
        'player_id', s.player_id, 'disconnected_at', s.disconnected_at,
        'timeout_ms', s.timeout_ms);
    EXCEPTION WHEN OTHERS THEN
      -- PER-ITEM ISOLATION: one session's failure is a row, not the reap's.
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
      v_errors := v_errors || jsonb_build_object(
        'pool_session_id', s.id, 'cluster_id', s.cluster_id, 'player_id', s.player_id,
        'sqlstate', v_sqlstate, 'message', v_message);
    END;
  END LOOP;

  -- ONE player_expired EVENT PER CLUSTER PER CALL, carrying that Cluster's
  -- expired players, after the loop so an isolated failure cannot double it.
  FOR c IN
    SELECT (x ->> 'cluster_id')::uuid AS cluster_id,
           max((x ->> 'cluster_epoch')::integer) AS cluster_epoch,
           jsonb_agg(x - 'cluster_id' - 'cluster_epoch' ORDER BY x ->> 'player_id') AS players
      FROM jsonb_array_elements(v_rows) x
     GROUP BY 1
  LOOP
    v_expired := c.players;
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
    VALUES (c.cluster_id, 'player_expired', jsonb_build_object(
      'cluster_id', c.cluster_id, 'cluster_epoch', c.cluster_epoch,
      'players', v_expired, 'at', p_now), c.cluster_epoch);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'expired', v_exited,
    'rows', v_rows, 'skipped', v_skipped, 'errors', v_errors);
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_reap_expired_disconnects(uuid, timestamp with time zone, integer) IS
  'Lightning Phase 9 (spec Phase 14). Exits every open pool session disconnected longer than its Cluster''s disconnect_timeout_ms whose player is not in a live hand and holds no live reservation: exit_reason disconnect_expired, state closed, slot closed, one pool_player_left per session and one player_expired event per Cluster per call. Releases nothing in-hand. Clock-guarded, bounded, SKIP LOCKED, each session isolated in its own sub-block. Run by fn_cash_clusters_tick_all beside the formation reaper; service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_reap_expired_disconnects(uuid, timestamp with time zone, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_reap_expired_disconnects(uuid, timestamp with time zone, integer) TO service_role;

-- ===========================================================================
-- 4. THE RECONNECT SNAPSHOT. The one door a reconnecting client rebuilds
--    from: the caller's own open pool session in the Cluster, or NULL.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_reconnect_state(p_cluster_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid  uuid;
  g      record;
  ps     record;
  v_seat record;
  v_hand uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL OR p_cluster_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT cg.id, cg.cluster_mode, cg.enabled, cg.lightning_enabled INTO g
    FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT s.id, s.state, s.disconnected_at, s.anchor_seat_id INTO ps
    FROM public.lightning_pool_session s
   WHERE s.cluster_id = g.id AND s.player_id = v_uid AND s.exited_at IS NULL
   ORDER BY s.entered_at DESC, s.id
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT ts.table_id, ts.seat_number INTO v_seat
    FROM public.table_seats ts WHERE ts.id = ps.anchor_seat_id;

  v_hand := public.fn_lightning_player_live_hand(v_uid, g.id);

  -- EXACTLY NINE KEYS, the caller's own and nothing else: no instance id, no
  -- other player's anything, and joinable computed exactly as
  -- fn_lightning_pool_status computes it rather than leaking cluster_mode.
  RETURN jsonb_build_object(
    'pool_session_id', ps.id,
    'state', ps.state,
    'in_hand', v_hand IS NOT NULL,
    'hand_id', v_hand,
    'disconnected_at', ps.disconnected_at,
    'seat_table_id', v_seat.table_id,
    'seat_number', v_seat.seat_number,
    'stack', public.fn_lightning_pool_stack(ps.id),
    'joinable', (g.cluster_mode = 'lightning' AND coalesce(g.lightning_enabled, false) AND g.enabled IS TRUE));
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_reconnect_state(uuid) IS
  'Lightning Phase 9 (spec Phase 14). The reconnect snapshot: the caller''s own open pool session in the Cluster as {pool_session_id, state, in_hand, hand_id, disconnected_at, seat_table_id, seat_number, stack, joinable}, NULL for anyone else, any other Cluster, or no caller. hand_id is the caller''s own live hand or null; joinable is fn_lightning_pool_status''s own formula; no instance id and no raw cluster_mode. SECURITY DEFINER, auth.uid() scoped; authenticated and service_role.';

REVOKE ALL ON FUNCTION public.fn_lightning_reconnect_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_reconnect_state(uuid) TO authenticated, service_role;

-- ===========================================================================
-- 5. THE FORENSIC READER (spec Phase 15). Operators replay a window of one
--    Cluster's life from the persisted record: events, conversions, matcher
--    passes, instances and hands, each in order, each bounded by the same
--    clamped limit. Read-only and service_role only.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_cluster_forensics(
  p_cluster_id uuid,
  p_from       timestamp with time zone,
  p_to         timestamp with time zone,
  p_limit      integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 500), 1), 2000);
  v_from  timestamp with time zone := coalesce(p_from, '-infinity');
  v_to    timestamp with time zone := coalesce(p_to, 'infinity');
  g       record;
  v_events jsonb;
  v_convs  jsonb;
  v_passes jsonb;
  v_insts  jsonb;
  v_hands  jsonb;
BEGIN
  SELECT cg.id, cg.cluster_mode, cg.cluster_epoch INTO g
    FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'cluster_id', p_cluster_id);
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'id', e.id, 'kind', e.kind, 'at', e.at, 'cluster_epoch', e.cluster_epoch,
           'event_version', e.event_version, 'request_id', e.request_id,
           'table_id', e.table_id, 'payload', e.payload) ORDER BY e.at, e.id)
    INTO v_events
    FROM (SELECT * FROM public.cash_cluster_events e
           WHERE e.game_id = g.id AND e.at >= v_from AND e.at < v_to
           ORDER BY e.at, e.id LIMIT v_limit) e;

  SELECT jsonb_agg(jsonb_build_object(
           'id', c.id, 'conversion_request_id', c.conversion_request_id,
           'from_mode', c.from_mode, 'to_mode', c.to_mode,
           'trigger_population', c.trigger_population,
           'on_threshold', c.on_threshold, 'off_threshold', c.off_threshold,
           'epoch_before', c.epoch_before, 'epoch_after', c.epoch_after,
           'status', c.status, 'abort_reason', c.abort_reason,
           'opened_at', c.opened_at, 'closed_at', c.closed_at,
           'chips_at_begin', c.chips_at_begin, 'chips_at_commit', c.chips_at_commit)
           ORDER BY c.opened_at, c.id)
    INTO v_convs
    FROM (SELECT * FROM public.cash_cluster_conversion c
           WHERE c.cluster_id = g.id AND c.opened_at >= v_from AND c.opened_at < v_to
           ORDER BY c.opened_at, c.id LIMIT v_limit) c;

  SELECT jsonb_agg(jsonb_build_object(
           'request_id', mp.request_id, 'cluster_epoch', mp.cluster_epoch,
           'matcher_version', mp.matcher_version, 'started_at', mp.started_at,
           'finished_at', mp.finished_at, 'hands_formed', mp.hands_formed)
           ORDER BY mp.started_at, mp.request_id)
    INTO v_passes
    FROM (SELECT * FROM public.cash_cluster_matcher_pass mp
           WHERE mp.cluster_id = g.id AND mp.started_at >= v_from AND mp.started_at < v_to
           ORDER BY mp.started_at, mp.request_id LIMIT v_limit) mp;

  SELECT jsonb_agg(jsonb_build_object(
           'id', li.id, 'state', li.state, 'hand_id', li.hand_id,
           'cluster_epoch', li.cluster_epoch, 'target_size', li.target_size,
           'max_size', li.max_size, 'created_at', li.created_at,
           'started_at', li.started_at, 'completed_at', li.completed_at,
           'deadline_at', li.deadline_at, 'abandon_reason', li.abandon_reason)
           ORDER BY li.created_at, li.id)
    INTO v_insts
    FROM (SELECT * FROM public.lightning_instance li
           WHERE li.cluster_id = g.id AND li.created_at >= v_from AND li.created_at < v_to
           ORDER BY li.created_at, li.id LIMIT v_limit) li;

  SELECT jsonb_agg(jsonb_build_object(
           'hand_id', lh.hand_id, 'hand_number', lh.hand_number,
           'cluster_epoch', lh.cluster_epoch, 'lightning_instance_id', lh.lightning_instance_id,
           'formed_at', lh.formed_at, 'settled_at', lh.settled_at,
           'player_count', lh.player_count, 'hand_history_id', lh.hand_history_id,
           'matcher_version', lh.matcher_version, 'rules_version', lh.rules_version,
           'rake', lh.settle_receipt -> 'rake', 'deltas', lh.settle_receipt -> 'deltas')
           ORDER BY lh.formed_at, lh.hand_id)
    INTO v_hands
    FROM (SELECT * FROM public.lightning_hand lh
           WHERE lh.cluster_id = g.id AND lh.formed_at >= v_from AND lh.formed_at < v_to
           ORDER BY lh.formed_at, lh.hand_id LIMIT v_limit) lh;

  RETURN jsonb_build_object('ok', true, 'cluster_id', g.id,
    'cluster_mode', g.cluster_mode, 'cluster_epoch', g.cluster_epoch,
    'from', v_from, 'to', v_to, 'limit', v_limit,
    'events', coalesce(v_events, '[]'::jsonb),
    'conversions', coalesce(v_convs, '[]'::jsonb),
    'matcher_passes', coalesce(v_passes, '[]'::jsonb),
    'instances', coalesce(v_insts, '[]'::jsonb),
    'hands', coalesce(v_hands, '[]'::jsonb));
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_cluster_forensics(uuid, timestamp with time zone, timestamp with time zone, integer) IS
  'Lightning Phase 9 (spec Phase 15). The operator''s window into one Cluster: events, conversions, matcher passes (without their result blobs), instances and hands of [from, to), each in time order and each bounded by the same limit clamped to 1..2000 (default 500). Read-only; service_role (operators) only - it names instance ids and other players, which no player door may.';

REVOKE ALL ON FUNCTION public.fn_lightning_cluster_forensics(uuid, timestamp with time zone, timestamp with time zone, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_cluster_forensics(uuid, timestamp with time zone, timestamp with time zone, integer) TO service_role;

-- ===========================================================================
-- 6. THE REPLAY CHECK (spec REPLAY ENGINE, the database's share). The same
--    persisted inputs must always produce the same verdict: per-player stack
--    arithmetic, conservation against the recorded rake and BBJ, the six
--    versions, and the hand's events present and in order. {ok, defects},
--    one named defect per violated clause, never a repair.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_hand_replay_check(p_hand_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  h          record;
  li         record;
  v_defects  jsonb := '[]'::jsonb;
  v_n        integer;
  v_sum      numeric;
  v_rake     numeric;
  v_bbj      numeric;
  v_formed_e timestamp with time zone;
  v_settle_e timestamp with time zone;
  v_bad      jsonb;
BEGIN
  SELECT * INTO h FROM public.lightning_hand WHERE hand_id = p_hand_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'hand_id', p_hand_id,
      'defects', jsonb_build_array(jsonb_build_object('code', 'hand_not_found')));
  END IF;
  SELECT * INTO li FROM public.lightning_instance WHERE id = h.lightning_instance_id;

  -- A LIVE HAND IS NOT AUDITABLE YET: nothing is repaired and nothing is
  -- guessed; the caller comes back when it is terminal.
  IF h.settled_at IS NULL AND (li.state IS DISTINCT FROM 'abandoned') THEN
    RETURN jsonb_build_object('ok', false, 'hand_id', p_hand_id, 'settled', false,
      'defects', jsonb_build_array(jsonb_build_object('code', 'hand_not_terminal',
        'instance_state', li.state)));
  END IF;

  -- THE PARTICIPANT SET matches the locked count.
  SELECT count(*) INTO v_n FROM public.lightning_hand_player hp WHERE hp.hand_id = p_hand_id;
  IF v_n IS DISTINCT FROM h.player_count THEN
    v_defects := v_defects || jsonb_build_object('code', 'participant_count',
      'locked', h.player_count, 'found', v_n);
  END IF;

  -- THE SIX VERSIONS are present (spec VERSIONING).
  SELECT jsonb_agg(jsonb_build_object('code', 'version_missing', 'field', f.name))
    INTO v_bad
    FROM (VALUES ('rules_version', h.rules_version), ('matcher_version', h.matcher_version),
                 ('blind_algorithm_version', h.blind_algorithm_version),
                 ('lightning_version', h.lightning_version), ('rake_version', h.rake_version)) f(name, v)
   WHERE coalesce(btrim(f.v), '') = '';
  v_defects := v_defects || coalesce(v_bad, '[]'::jsonb);
  IF h.cluster_epoch IS NULL OR h.cluster_epoch < 0 THEN
    v_defects := v_defects || jsonb_build_object('code', 'version_missing', 'field', 'cluster_epoch');
  END IF;

  IF h.settled_at IS NOT NULL THEN
    -- STACK ARITHMETIC, per player: stack_before + net = stack_after.
    SELECT jsonb_agg(jsonb_build_object('code', 'stack_arithmetic', 'player_id', hp.player_id,
             'stack_before', hp.stack_before, 'net', hp.net_result, 'stack_after', hp.stack_after)
             ORDER BY hp.player_id)
      INTO v_bad
      FROM public.lightning_hand_player hp
     WHERE hp.hand_id = p_hand_id
       AND (hp.stack_after IS NULL OR hp.stack_before IS NULL
            OR round(hp.stack_before + hp.net_result, 2) IS DISTINCT FROM round(hp.stack_after, 2));
    v_defects := v_defects || coalesce(v_bad, '[]'::jsonb);

    -- CONSERVATION: the deltas sum to exactly minus the recorded rake and
    -- BBJ. Chips neither appear nor vanish unexplained.
    v_rake := coalesce((h.settle_receipt ->> 'rake')::numeric, 0);
    v_bbj  := coalesce((h.settle_receipt ->> 'bbj')::numeric, 0);
    SELECT round(coalesce(sum(hp.net_result), 0), 2) INTO v_sum
      FROM public.lightning_hand_player hp WHERE hp.hand_id = p_hand_id;
    IF v_sum + v_rake + v_bbj <> 0 THEN
      v_defects := v_defects || jsonb_build_object('code', 'conservation',
        'net_sum', v_sum, 'rake', v_rake, 'bbj', v_bbj);
    END IF;

    -- THE RECEIPT AGREES with the participant rows it was cut from.
    SELECT jsonb_agg(jsonb_build_object('code', 'receipt_disagrees', 'player_id', hp.player_id,
             'receipt_delta', h.settle_receipt -> 'deltas' -> hp.player_id::text,
             'net', hp.net_result) ORDER BY hp.player_id)
      INTO v_bad
      FROM public.lightning_hand_player hp
     WHERE hp.hand_id = p_hand_id
       AND (h.settle_receipt -> 'deltas' -> hp.player_id::text) IS DISTINCT FROM
           to_jsonb(round(hp.net_result, 2));
    v_defects := v_defects || coalesce(v_bad, '[]'::jsonb);
  END IF;

  -- THE EVENTS EXIST, IN ORDER: hand_created <= dealing <= hand_settled (or
  -- the instance_destroyed of an abandonment), in the timestamps and in the
  -- ledger.
  SELECT min(e.at) INTO v_formed_e FROM public.cash_cluster_events e
   WHERE e.game_id = h.cluster_id AND e.kind = 'hand_created'
     AND e.payload ->> 'hand_id' = p_hand_id::text;
  IF v_formed_e IS NULL THEN
    v_defects := v_defects || jsonb_build_object('code', 'event_missing', 'kind', 'hand_created');
  END IF;
  IF h.settled_at IS NOT NULL THEN
    SELECT min(e.at) INTO v_settle_e FROM public.cash_cluster_events e
     WHERE e.game_id = h.cluster_id AND e.kind = 'hand_settled'
       AND e.payload ->> 'hand_id' = p_hand_id::text;
    IF v_settle_e IS NULL THEN
      v_defects := v_defects || jsonb_build_object('code', 'event_missing', 'kind', 'hand_settled');
    END IF;
    IF h.formed_at > coalesce(li.started_at, h.formed_at)
       OR coalesce(li.started_at, h.formed_at) > h.settled_at
       OR coalesce(v_formed_e, h.formed_at) > coalesce(v_settle_e, h.settled_at) THEN
      v_defects := v_defects || jsonb_build_object('code', 'event_order',
        'formed_at', h.formed_at, 'dealing_at', li.started_at, 'settled_at', h.settled_at,
        'formed_event_at', v_formed_e, 'settled_event_at', v_settle_e);
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.cash_cluster_events e
                    WHERE e.game_id = h.cluster_id AND e.kind = 'instance_destroyed'
                      AND e.payload ->> 'instance_id' = h.lightning_instance_id::text) THEN
      v_defects := v_defects || jsonb_build_object('code', 'event_missing', 'kind', 'instance_destroyed');
    END IF;
    IF h.formed_at > coalesce(li.completed_at, h.formed_at) THEN
      v_defects := v_defects || jsonb_build_object('code', 'event_order',
        'formed_at', h.formed_at, 'abandoned_at', li.completed_at);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', v_defects = '[]'::jsonb, 'hand_id', p_hand_id,
    'cluster_id', h.cluster_id, 'cluster_epoch', h.cluster_epoch,
    'settled', h.settled_at IS NOT NULL, 'defects', v_defects);
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_hand_replay_check(uuid) IS
  'Lightning Phase 9 (spec Phase 15 / REPLAY ENGINE). The deterministic audit of one terminal hand from persisted state alone: participant count equals the locked count, stack_before + net = stack_after per player, the deltas conserve against the receipt''s rake and BBJ, the receipt agrees with the rows, the six versions are present, and the hand_created, dealing and hand_settled (or instance_destroyed) records exist in order. Returns {ok, defects}, one named defect per violated clause (hand_not_found, hand_not_terminal, participant_count, version_missing, stack_arithmetic, conservation, receipt_disagrees, event_missing, event_order). Read-only, never a repair; service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_hand_replay_check(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_hand_replay_check(uuid) TO service_role;

-- ===========================================================================
-- 7. THE REWRITER, in the shape 20261008043021 cut it: an asserted
--    substitution into the body production carries. Every anchor must appear
--    exactly as often as stated or the file refuses. No signature changes in
--    this file, so the old-vs-new arms stay dormant; a body already carrying
--    the marker is left alone, so the file is re-appliable.
-- ===========================================================================

CREATE OR REPLACE FUNCTION pg_temp.lp9_rewrite(p_old text, p_new text, p_marker text,
                                    p_from text[], p_to text[], p_counts integer[])
RETURNS void LANGUAGE plpgsql AS $rw$
DECLARE
  v_same    boolean := p_old = p_new;
  v_src     text;
  v_new     text;
  v_n       integer;
  k         integer;
  v_roles   constant text[] := ARRAY['anon', 'authenticated', 'service_role'];
  v_had     boolean[];
  v_bad     text;
  v_comment text;
BEGIN
  IF NOT v_same AND to_regprocedure(p_new) IS NOT NULL THEN
    IF to_regprocedure(p_old) IS NOT NULL THEN
      RAISE EXCEPTION '% and % both exist; refusing to guess which one callers reach', p_old, p_new;
    END IF;
    IF position(p_marker in pg_get_functiondef(p_new::regprocedure)) = 0 THEN
      RAISE EXCEPTION '% exists without %', p_new, p_marker;
    END IF;
    RETURN;
  END IF;
  v_src := pg_get_functiondef(p_old::regprocedure);
  IF v_same AND position(p_marker in v_src) > 0 THEN
    RETURN;
  END IF;
  v_new := v_src;
  FOR k IN 1 .. array_length(p_from, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_from[k], ''))) / length(p_from[k]);
    IF v_n IS DISTINCT FROM p_counts[k] THEN
      RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', p_old, k, v_n, p_counts[k];
    END IF;
    v_new := replace(v_new, p_from[k], p_to[k]);
  END LOOP;
  SELECT array_agg(has_function_privilege(t.r, p_old::regprocedure, 'EXECUTE') ORDER BY t.ord)
    INTO v_had FROM unnest(v_roles) WITH ORDINALITY t(r, ord);
  v_comment := obj_description(p_old::regprocedure, 'pg_proc');
  IF NOT v_same THEN
    EXECUTE format('DROP FUNCTION %s', p_old);
  END IF;
  EXECUTE v_new;
  IF NOT v_same THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', p_new);
    FOR k IN 1 .. array_length(v_roles, 1) LOOP
      IF v_had[k] THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', p_new, v_roles[k]);
      END IF;
    END LOOP;
    IF v_comment IS NOT NULL THEN
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', p_new, v_comment);
    END IF;
    SELECT string_agg(t.r || ': had ' || v_had[t.ord] || ', has '
                      || has_function_privilege(t.r, p_new::regprocedure, 'EXECUTE'), '; ')
      INTO v_bad
      FROM unnest(v_roles) WITH ORDINALITY t(r, ord)
     WHERE has_function_privilege(t.r, p_new::regprocedure, 'EXECUTE') IS DISTINCT FROM v_had[t.ord];
    IF v_bad IS NOT NULL
       OR obj_description(p_new::regprocedure, 'pg_proc') IS DISTINCT FROM v_comment THEN
      RAISE EXCEPTION '% did not keep who may execute (%) and the comment of %', p_new, coalesce(v_bad, 'comment'), p_old;
    END IF;
  END IF;
  IF position(p_marker in pg_get_functiondef(p_new::regprocedure)) = 0 THEN
    RAISE EXCEPTION '% does not read back carrying %', p_new, p_marker;
  END IF;
END
$rw$;

-- ===========================================================================
-- 8. fn_lightning_config answers disconnect_timeout_ms: default 180000,
--    clamped 30000..1800000 (30 seconds to 30 minutes), read, clamped and
--    reported exactly as every other number key.
-- ===========================================================================

SELECT pg_temp.lp9_rewrite(
  'public.fn_lightning_config(uuid)',
  'public.fn_lightning_config(uuid)',
  '''disconnect_timeout_ms''',
  ARRAY[$a$  v_dwell    integer;
$a$,
        $a$  r := public.fn_lightning_config_number(v_cfg, 'pass_record_prune_batch', 100, 1, 10000, true);
  v_prune := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
$a$,
        $a$    'pass_record_prune_batch', v_prune,
$a$],
  ARRAY[$b$  v_dwell    integer;
  v_disc     integer;
$b$,
        $b$  r := public.fn_lightning_config_number(v_cfg, 'pass_record_prune_batch', 100, 1, 10000, true);
  v_prune := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  -- LIGHTNING PHASE 9 (20261008050805): how long a reported disconnect may
  -- stand before fn_lightning_reap_expired_disconnects exits the pool
  -- session (never a player in a live hand). 30 seconds to 30 minutes.
  r := public.fn_lightning_config_number(v_cfg, 'disconnect_timeout_ms', 180000, 30000, 1800000, true);
  v_disc := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
$b$,
        $b$    'pass_record_prune_batch', v_prune,
    'disconnect_timeout_ms', v_disc,
$b$],
  ARRAY[1, 1, 1]);

-- ===========================================================================
-- 9. fn_cash_clusters_tick_all runs the disconnect reaper beside the
--    formation reaper, isolated the same way: a lock wait or failure inside
--    it costs the reap, never the pass.
-- ===========================================================================

SELECT pg_temp.lp9_rewrite(
  'public.fn_cash_clusters_tick_all(jsonb)',
  'public.fn_cash_clusters_tick_all(jsonb)',
  'fn_lightning_reap_expired_disconnects()',
  ARRAY[$a$  v_lightning_reaped jsonb := '{}'::jsonb;
$a$,
        $a$  BEGIN
    v_lightning_reaped := public.fn_lightning_reap_formations();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    v_lightning_reaped := jsonb_build_object('ok', false, 'sqlstate', v_sqlstate, 'message', v_message);
  END;
$a$,
        $a$    'lightning_reaped', v_lightning_reaped,
$a$],
  ARRAY[$b$  v_lightning_reaped jsonb := '{}'::jsonb;
  v_disconnects_reaped jsonb := '{}'::jsonb;
$b$,
        $b$  BEGIN
    v_lightning_reaped := public.fn_lightning_reap_formations();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    v_lightning_reaped := jsonb_build_object('ok', false, 'sqlstate', v_sqlstate, 'message', v_message);
  END;

  -- LIGHTNING PHASE 9 (20261008050805): THE DISCONNECT EXPIRY, beside the
  -- formation reap for the same reason - the per-Cluster drive stands down
  -- for players the engine withholds, so nothing else in the estate would
  -- ever exit a pool session nobody is coming back to. In its own sub-block,
  -- because lock_timeout is 2000ms and a lock wait must cost this reap
  -- rather than the pass; inside, each session is isolated again.
  BEGIN
    v_disconnects_reaped := public.fn_lightning_reap_expired_disconnects();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    v_disconnects_reaped := jsonb_build_object('ok', false, 'sqlstate', v_sqlstate, 'message', v_message);
  END;
$b$,
        $b$    'lightning_reaped', v_lightning_reaped,
    'disconnects_reaped', v_disconnects_reaped,
$b$],
  ARRAY[1, 1, 1]);

-- ===========================================================================
-- 10. fn_cash_cluster_unfreeze says pool_player_left for every session it
--     exits - the one exit writer that was silent. Same payload shape as the
--     anchor-seat trigger and the Phase 7 reversion, so the ledger reads one
--     way everywhere.
-- ===========================================================================

SELECT pg_temp.lp9_rewrite(
  'public.fn_cash_cluster_unfreeze(uuid,uuid,text)',
  'public.fn_cash_cluster_unfreeze(uuid,uuid,text)',
  '''pool_player_left''',
  ARRAY[$a$  i            record;
$a$,
        $a$  UPDATE public.lightning_pool_session ps
     SET exited_at = GREATEST(clock_timestamp(), ps.entered_at), exit_reason = 'cluster_unfrozen',
         state = 'closed', ending_stack = public.fn_lightning_pool_stack(ps.id), updated_at = clock_timestamp()
   WHERE ps.cluster_id = g.id AND ps.exited_at IS NULL;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;
$a$],
  ARRAY[$b$  i            record;
  r_exit       record;
$b$,
        $b$  -- LIGHTNING PHASE 9 (20261008050805): EVERY EXIT PATH SAYS
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
$b$],
  ARRAY[1, 1]);

-- ===========================================================================
-- 11. READ BACK.
-- ===========================================================================

DO $readback$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('the stamp column exists', (SELECT a.atttypid = 'timestamptz'::regtype FROM pg_attribute a
       WHERE a.attrelid = 'public.lightning_pool_session'::regclass AND a.attname = 'disconnected_at' AND NOT a.attisdropped)),
    ('a disconnected session is dated', (SELECT pg_get_constraintdef(c.oid) ~ 'disconnected_at IS NOT NULL'
       FROM pg_constraint c WHERE c.conrelid = 'public.lightning_pool_session'::regclass
        AND c.conname = 'lightning_pool_session_disconnect_is_dated')),
    ('the presence door stands, service_role only', (SELECT NOT p.prosecdef
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       FROM pg_proc p WHERE p.oid = 'public.fn_lightning_presence_report(uuid,uuid[],uuid[],timestamp with time zone)'::regprocedure)),
    ('the reaper stands, service_role only', (SELECT has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND pg_get_functiondef(p.oid) ~ '''disconnect_expired''' AND pg_get_functiondef(p.oid) ~ '''player_expired'''
       FROM pg_proc p WHERE p.oid = 'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure)),
    ('the configuration answers the timeout', (SELECT (public.fn_lightning_config(NULL) ->> 'disconnect_timeout_ms')::integer = 180000)),
    ('the tick runs the reaper', (SELECT s ~ 'fn_lightning_reap_expired_disconnects\(\)' AND s ~ '''disconnects_reaped'', v_disconnects_reaped'
       FROM (SELECT pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure) AS s) q2)),
    ('the reconnect door asks who is calling', (SELECT p.prosecdef AND p.provolatile = 's'
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND pg_get_functiondef(p.oid) ~ 'auth\.uid\(\)'
       FROM pg_proc p WHERE p.oid = 'public.fn_lightning_reconnect_state(uuid)'::regprocedure)),
    ('the forensics are bounded, read-only and service_role only', (SELECT p.provolatile = 's'
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       FROM pg_proc p WHERE p.oid = 'public.fn_lightning_cluster_forensics(uuid,timestamp with time zone,timestamp with time zone,integer)'::regprocedure)),
    ('the replay check stands, service_role only', (SELECT p.provolatile = 's'
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       FROM pg_proc p WHERE p.oid = 'public.fn_lightning_hand_replay_check(uuid)'::regprocedure)),
    ('the unfreeze says pool_player_left', (SELECT pg_get_functiondef('public.fn_cash_cluster_unfreeze(uuid,uuid,text)'::regprocedure)
       ~ '''pool_player_left''')),
    ('the conversion record carries its versions', (SELECT count(*) = 8 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'cash_cluster_conversion'
         AND column_name IN ('from_mode', 'to_mode', 'trigger_population', 'on_threshold', 'off_threshold',
                             'epoch_before', 'epoch_after', 'conversion_request_id'))),
    ('no horse is singled out', (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f'
         AND p.proname IN ('fn_lightning_presence_report', 'fn_lightning_reap_expired_disconnects',
                           'fn_lightning_reconnect_state', 'fn_lightning_cluster_forensics',
                           'fn_lightning_hand_replay_check', 'fn_lightning_config',
                           'fn_cash_clusters_tick_all', 'fn_cash_cluster_unfreeze')
         AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id')))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_P9_RECONNECT_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
