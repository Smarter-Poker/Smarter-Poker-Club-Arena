-- 20261008111425_lightning_phase_10_responsible_gaming_stop_playing_auto_rebu.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASE 10 (SPECIFICATION PHASES 16 AND 17, THE DATABASE SIDE):
-- RESPONSIBLE GAMING / AUTO-REBUY INTEGRATION, AND THE RNG / HIDDEN
-- INFORMATION REVIEW.
--
-- RESPONSIBLE GAMING REUSES WHAT EXISTS. The platform already carries
-- responsible_gaming_limits (deposit/loss caps, session time, self-exclusion,
-- cooling-off; 20260420010549), its gate fn_rg_require_not_excluded, and the
-- operator restriction policy (ca_operator_policy.restrictions_enforced with
-- fn_ca_player_restricted), and fn_lightning_player_legality ALREADY refuses
-- a restricted player as RESTRICTED and an excluded or cooling-off player as
-- RG_EXCLUDED on every matcher pass, so a player whose exclusion begins
-- mid-session is never matched into another hand. Nothing parallel is built
-- here. What was missing, and lands here:
--
-- 1. THE POOL DOOR. fn_lightning_pool_enter now defers to the same
--    fn_rg_require_not_excluded gate before opening a pool session, so a
--    self-excluded or cooling-off player never ENTERS the pool at all
--    (the matcher-side refusal alone would have let them sit in the pool
--    idle). An asserted substitution; the refusal is the door's own NULL.
--
-- 2. STOP PLAYING. lightning_pool_session gains stop_requested_at.
--    fn_lightning_stop_playing(p_cluster_id) (authenticated, SECURITY
--    DEFINER, auth.uid() scoped, idempotent) marks the caller's open pool
--    session; fn_lightning_player_legality gains the STOP_REQUESTED refusal
--    so the matcher skips a stopping player from the next formation on;
--    current hand and action rules are untouched (a player in a live hand
--    keeps every in-hand obligation). Not in a live hand and holding no live
--    reservation, the door exits the session at once (exit_reason
--    'stop_playing', state 'closed', slot closed, one pool_player_left, in
--    the anchor-seat trigger's own payload shape) exactly as the disconnect
--    reaper exits. In a live hand, the mark stands and the EXISTING post-hand
--    exit machinery finishes the job: fn_lightning_reap_expired_disconnects
--    (already wired into fn_cash_clusters_tick_all) is widened by asserted
--    substitution to also exit a stop-requested session the moment it holds
--    no live hand and no live reservation - same skip rules, same event
--    shape, exit_reason 'stop_playing', and a stopped session is never
--    counted into the player_expired record. One stop_playing_requested
--    event on the first mark. fn_lightning_reconnect_state carries the new
--    'stop_requested' key so a reconnecting client sees the standing stop.
--
-- 3. SESSION METRICS are verified, not rebuilt: fn_lightning_session_stats
--    (Phase 8, authenticated, caller-scoped) already answers hands,
--    duration_s, hands_per_hour, net, bb_per_100 and the wait percentiles,
--    and fn_lightning_session_summary already carries ended/exit_reason - a
--    session ended by the stop control answers exit_reason 'stop_playing'.
--    A live proof pins the keys; no reader is added.
--
-- AUTO-REBUY (disabled by default, config-gated per Cluster):
--
-- 4. fn_lightning_config gains auto_rebuy_enabled (false), auto_rebuy_trigger
--    ('zero' | 'below_bb' | 'below_pct'), auto_rebuy_threshold_bb (1,
--    0..100), auto_rebuy_threshold_pct (25, 1..99), auto_rebuy_target
--    ('initial' | 'max'), auto_rebuy_max_count (3, 0..100) and
--    auto_rebuy_session_cap (0 = uncapped, 0..1000000), read, clamped and
--    reported in `invalid` exactly as every other key.
--
-- 5. fn_lightning_auto_rebuy(p_cluster_id, p_player_id, p_now) (service_role
--    only) is the one door the engine calls BETWEEN hands. It verifies the
--    session is open and active (never stop-requested, never disconnected),
--    the player holds no live hand and no live reservation, no unresolved
--    pending addon is already in flight, responsible gaming clears the
--    player, the count is under auto_rebuy_max_count, and the trigger
--    condition holds against the CURRENT seated stack
--    (fn_lightning_pool_stack). Then it executes the top-up THROUGH THE
--    EXISTING reload door public.atomic_table_rebuy (the same SECURITY
--    DEFINER wallet path a manual reload takes: entry-purchase receipt,
--    maintenance freeze, club-wallet debit with its own sufficient-funds
--    refusal, table_pending_addons row that the engine's existing addon
--    delivery resolves into the seat between hands), with a DETERMINISTIC
--    purchase key per (session, count) so a retry can never debit twice.
--    No chips are moved by this file: a wallet refusal comes back as
--    RELOAD_REFUSED and nothing changed. The count and total land on the
--    session (auto_rebuys, auto_rebuy_total), one auto_rebuy event carries
--    before/after. An auto-rebuy is NOT a leave: session_baseline rules,
--    starting_stack and net_result accounting are untouched.
--
-- RNG / HIDDEN INFORMATION REVIEW (SPEC PHASE 17) - what the database can
-- prove, inspected against PokerIQ-Production on 2026-10-08 and pinned below:
--
--   a. No new RNG is built and none is touched. Shuffling and dealing live in
--      the engine; the database never stores a deck order for Lightning.
--   b. HIDDEN CARDS NEVER ENTER THE LIGHTNING TABLES: lightning_hand,
--      lightning_hand_player, lightning_instance, lightning_reservation,
--      lightning_pool_session and lightning_pool_slot carry no card, deck,
--      seed or hole column (pinned). Hand storage separates hidden
--      information from public actions: hole cards live only in
--      table_hole_cards and hand_private_state, both RLS-enabled with every
--      player-facing read policy auth.uid() scoped to the owner (pinned);
--      hand_history rows are readable only by the hand's own participants
--      (players @> the caller) and its hole_cards column is NULL in practice
--      (engine does not persist it; sampled newest rows NULL).
--   c. NO authenticated- or anon-executable fn_lightning_* function
--      references hole-card storage at all (pinned as a standing invariant,
--      so a future door that reaches for it fails the proof). The
--      authenticated doors (my_session, my_sessions, pool_status,
--      recent_hands, reconnect_state, session_stats, session_summary) answer
--      only the caller's own rows; fn_lightning_recent_hands exposes
--      results, pots and winners - never cards.
--   d. The only cross-player windows are the Phase 9 operator doors
--      fn_lightning_cluster_forensics and fn_lightning_hand_replay_check and
--      the engine's fn_lightning_settlement_seats, all service_role only
--      (pinned). NO LEAK WAS FOUND, so nothing is fixed; the proofs pin the
--      reviewed state against drift.
--
-- LIGHTNING IS OFF EVERYWHERE (cash_games.lightning_enabled false across the
-- estate). Every behavior change in this file sits behind the Lightning
-- doors: the pool-enter gate runs only for cluster_mode 'lightning', the
-- stop door only against a Lightning pool session, auto-rebuy only behind
-- auto_rebuy_enabled (default false), and the reaper widening only ever
-- touches lightning_pool_session rows. Non-Lightning cash play is unchanged.
--
-- HOUSE RULES OBSERVED. One BEGIN/COMMIT with SET LOCAL lock_timeout. The
-- only table altered is lightning_pool_session; neither tables nor
-- table_seats nor any wallet table is locked by DDL. Every change to an
-- existing body (fn_lightning_config, fn_lightning_player_legality,
-- fn_lightning_pool_enter, fn_lightning_reap_expired_disconnects,
-- fn_lightning_reconnect_state) is an asserted substitution into the body
-- production carries (read with pg_get_functiondef on 2026-10-08, after
-- 20261008050805): each anchor must appear exactly as often as stated or the
-- file refuses, and a body already carrying the marker is left alone, so the
-- file is re-appliable. No predecessor live proof is falsified.
--
-- LAW 10.5. Nothing here reads is_horse or horse_id. A horse is refused at
-- the doors, stops playing, auto-rebuys and is audited exactly as a human.
--
-- @live-proof: (SELECT a.atttypid = 'timestamptz'::regtype AND NOT a.attnotnull FROM pg_attribute a WHERE a.attrelid = 'public.lightning_pool_session'::regclass AND a.attname = 'stop_requested_at' AND NOT a.attisdropped)
-- @live-proof: (SELECT count(*) = 2 FROM pg_attribute a WHERE a.attrelid = 'public.lightning_pool_session'::regclass AND a.attname IN ('auto_rebuys', 'auto_rebuy_total') AND NOT a.attisdropped AND a.attnotnull)
-- @live-proof: (SELECT pg_get_constraintdef(c.oid) ~ 'auto_rebuys >= 0' AND pg_get_constraintdef(c.oid) ~ 'auto_rebuy_total >= \(?0\)?' FROM pg_constraint c WHERE c.conrelid = 'public.lightning_pool_session'::regclass AND c.conname = 'lightning_pool_session_auto_rebuy_counters_are_sane')
-- @live-proof: (SELECT p.prosecdef AND p.provolatile = 'v' AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND s ~ 'auth\.uid\(\)' AND s ~ '''stop_playing''' AND s ~ '''stop_playing_requested''' AND s ~ '''pool_player_left''' AND s ~ 'fn_lightning_player_in_hand' FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid = 'public.fn_lightning_stop_playing(uuid)'::regprocedure)
-- @live-proof: (SELECT NOT p.prosecdef AND p.provolatile = 'v' AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND s ~ 'public\.atomic_table_rebuy\(' AND s ~ 'fn_rg_require_not_excluded' AND s ~ '''auto_rebuy''' AND s !~ 'UPDATE public\.table_seats' AND s !~ 'club_members' AND s !~ 'wallet_transactions' FROM pg_proc p, LATERAL (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s) q WHERE p.oid = 'public.fn_lightning_auto_rebuy(uuid,uuid,timestamp with time zone)'::regprocedure)
-- @live-proof: (SELECT (c ->> 'auto_rebuy_enabled')::boolean = false AND c ->> 'auto_rebuy_trigger' = 'zero' AND c ->> 'auto_rebuy_target' = 'initial' AND (c ->> 'auto_rebuy_threshold_bb')::numeric = 1 AND (c ->> 'auto_rebuy_threshold_pct')::integer = 25 AND (c ->> 'auto_rebuy_max_count')::integer = 3 AND (c ->> 'auto_rebuy_session_cap')::numeric = 0 FROM (SELECT public.fn_lightning_config(NULL) AS c) q)
-- @live-proof: (SELECT s ~ '''STOP_REQUESTED''' AND s ~ 'f\.stop_requested_at IS NOT NULL' FROM (SELECT pg_get_functiondef('public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ 'fn_rg_require_not_excluded\(s\.user_id\)' FROM (SELECT pg_get_functiondef('public.fn_lightning_pool_enter(uuid,timestamp with time zone)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ '''stop_playing''' AND s ~ 'ps\.stop_requested_at IS NOT NULL' AND s ~ '''disconnect_expired''' AND s ~ 'FOR UPDATE OF ps SKIP LOCKED' FROM (SELECT pg_get_functiondef('public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ '\(x ->> ''stopped''\)::boolean IS NOT TRUE' FROM (SELECT pg_get_functiondef('public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ '''stop_requested''' FROM (SELECT pg_get_functiondef('public.fn_lightning_reconnect_state(uuid)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ '''hands_per_hour''' AND s ~ '''duration_s''' AND s ~ '''net''' AND s ~ '''hands''' FROM (SELECT pg_get_functiondef('public.fn_lightning_session_stats(uuid)'::regprocedure) AS s) q)
-- @live-proof: (SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_cluster_forensics(uuid,timestamp with time zone,timestamp with time zone,integer)'::regprocedure, 'public.fn_lightning_hand_replay_check(uuid)'::regprocedure, 'public.fn_lightning_settlement_seats(uuid,bigint)'::regprocedure))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname LIKE 'fn\_lightning\_%' AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')) AND pg_get_functiondef(p.oid) ~* 'hole_cards|hand_private_state|table_hole_cards'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('lightning_hand', 'lightning_hand_player', 'lightning_instance', 'lightning_reservation', 'lightning_pool_session', 'lightning_pool_slot') AND column_name ~* 'card|deck|seed|hole'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN ('table_hole_cards', 'hand_private_state') AND c.relkind = 'r' AND NOT c.relrowsecurity))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_policy pol JOIN pg_class pc ON pc.oid = pol.polrelid JOIN pg_namespace pn ON pn.oid = pc.relnamespace WHERE pn.nspname = 'public' AND pc.relname IN ('table_hole_cards', 'hand_private_state') AND pol.polcmd::text IN ('r', '*') AND coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') !~ 'auth\.uid' AND pol.polroles <> ARRAY[(SELECT r.oid FROM pg_roles r WHERE r.rolname = 'service_role')]::oid[]))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_lightning_stop_playing', 'fn_lightning_auto_rebuy', 'fn_lightning_player_legality', 'fn_lightning_pool_enter', 'fn_lightning_reap_expired_disconnects', 'fn_lightning_reconnect_state', 'fn_lightning_config') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id'))

BEGIN;

SET LOCAL lock_timeout = '2s';

-- ===========================================================================
-- 1. THE STOP MARK AND THE REBUY COUNTERS. One ALTER on
--    lightning_pool_session alone; neither tables nor table_seats is locked.
-- ===========================================================================

ALTER TABLE public.lightning_pool_session
  ADD COLUMN IF NOT EXISTS stop_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_rebuys integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_rebuy_total numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.lightning_pool_session.stop_requested_at IS
  'When the player pressed Stop Playing (fn_lightning_stop_playing), NULL otherwise. A marked open session is refused by fn_lightning_player_legality as STOP_REQUESTED (never matched again) and exited by fn_lightning_stop_playing at once when idle, or by fn_lightning_reap_expired_disconnects the moment it holds no live hand and no live reservation (exit_reason stop_playing). Survives on the exited row for the record.';
COMMENT ON COLUMN public.lightning_pool_session.auto_rebuys IS
  'How many auto-rebuys fn_lightning_auto_rebuy has executed for this session, capped by the Cluster''s auto_rebuy_max_count.';
COMMENT ON COLUMN public.lightning_pool_session.auto_rebuy_total IS
  'The chips auto-rebought into this session in all, capped by the Cluster''s auto_rebuy_session_cap when that cap is set.';

DO $ddl$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.lightning_pool_session'::regclass
                    AND conname = 'lightning_pool_session_auto_rebuy_counters_are_sane') THEN
    ALTER TABLE public.lightning_pool_session
      ADD CONSTRAINT lightning_pool_session_auto_rebuy_counters_are_sane
      CHECK (auto_rebuys >= 0 AND auto_rebuy_total >= 0);
  END IF;
END
$ddl$;

-- The stop reaper's worklist: open, marked sessions only.
CREATE INDEX IF NOT EXISTS lightning_pool_session_stop_requests
  ON public.lightning_pool_session (cluster_id, stop_requested_at)
  WHERE exited_at IS NULL AND stop_requested_at IS NOT NULL;

-- ===========================================================================
-- 2. STOP PLAYING: the player's own door. Idempotent; marks always, exits at
--    once only when the caller holds no live hand and no live reservation,
--    in the disconnect reaper's own exit shape; in a live hand the mark
--    stands, every in-hand rule is untouched, and the widened reaper
--    (section 7) finishes the exit after the hand lets go.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_stop_playing(p_cluster_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_now     timestamptz := clock_timestamp();
  s         record;
  v_table   uuid;
  v_in_hand boolean;
  v_first   boolean := false;
  v_stack   numeric;
BEGIN
  IF v_uid IS NULL OR p_cluster_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- The caller's newest session in the Cluster, locked so the matcher, the
  -- reaper and a doubled tap serialize against this mark.
  SELECT ps.id, ps.cluster_id, ps.cluster_epoch, ps.player_id, ps.anchor_seat_id,
         ps.state, ps.exited_at, ps.exit_reason, ps.stop_requested_at
    INTO s
    FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = p_cluster_id AND ps.player_id = v_uid
   ORDER BY ps.entered_at DESC, ps.id
   LIMIT 1
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'NO_SESSION');
  END IF;

  -- Already exited: stopping is a no-op that answers what stands.
  IF s.exited_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'pool_session_id', s.id, 'exited', true,
                              'in_hand', false, 'exit_reason', s.exit_reason,
                              'stop_requested_at', s.stop_requested_at);
  END IF;

  IF s.stop_requested_at IS NULL THEN
    UPDATE public.lightning_pool_session ps
       SET stop_requested_at = v_now, updated_at = v_now
     WHERE ps.id = s.id;
    s.stop_requested_at := v_now;
    v_first := true;
  END IF;

  -- CURRENT HAND AND ACTION RULES ARE RESPECTED: a live hand, or any live
  -- reservation on the way into one, is never cut short by a stop.
  v_in_hand := public.fn_lightning_player_in_hand(v_uid, p_cluster_id)
            OR EXISTS (SELECT 1 FROM public.lightning_reservation r
                        WHERE r.cluster_id = p_cluster_id AND r.player_id = v_uid
                          AND r.state IN ('pending', 'committed'));

  SELECT ts.table_id INTO v_table FROM public.table_seats ts WHERE ts.id = s.anchor_seat_id;

  IF v_first THEN
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload, cluster_epoch)
    VALUES (s.cluster_id, v_table, 'stop_playing_requested', jsonb_build_object(
      'cluster_id', s.cluster_id, 'cluster_epoch', s.cluster_epoch, 'player_id', s.player_id,
      'pool_session_id', s.id, 'anchor_seat_id', s.anchor_seat_id, 'in_hand', v_in_hand,
      'at', v_now), s.cluster_epoch);
  END IF;

  IF NOT v_in_hand THEN
    UPDATE public.lightning_pool_session ps
       SET exited_at = GREATEST(v_now, ps.entered_at),
           exit_reason = 'stop_playing',
           state = 'closed',
           ending_stack = public.fn_lightning_pool_stack(ps.id),
           updated_at = v_now
     WHERE ps.id = s.id AND ps.exited_at IS NULL
    RETURNING ps.ending_stack INTO v_stack;
    IF FOUND THEN
      UPDATE public.lightning_pool_slot sl
         SET closed_at = GREATEST(v_now, sl.opened_at),
             close_reason = 'pool_session_exited',
             updated_at = v_now
       WHERE sl.pool_session_id = s.id AND sl.closed_at IS NULL;

      -- EVERY EXIT PATH SAYS pool_player_left, this one included, in the
      -- anchor-seat trigger's own payload shape.
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload, cluster_epoch)
      VALUES (s.cluster_id, v_table, 'pool_player_left', jsonb_build_object(
        'cluster_id', s.cluster_id, 'cluster_epoch', s.cluster_epoch, 'player_id', s.player_id,
        'pool_session_id', s.id, 'anchor_seat_id', s.anchor_seat_id, 'reason', 'stop_playing',
        'ending_stack', v_stack, 'at', v_now), s.cluster_epoch);
    END IF;
    RETURN jsonb_build_object('ok', true, 'pool_session_id', s.id, 'exited', true,
                              'in_hand', false, 'stop_requested_at', s.stop_requested_at);
  END IF;

  RETURN jsonb_build_object('ok', true, 'pool_session_id', s.id, 'exited', false,
                            'in_hand', true, 'stop_requested_at', s.stop_requested_at);
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_stop_playing(uuid) IS
  'Lightning Phase 10 (20261008111425): the Stop Playing control. auth.uid() scoped and idempotent: marks the caller''s open pool session (stop_requested_at) so fn_lightning_player_legality refuses STOP_REQUESTED from the next formation on; exits the session at once (exit_reason stop_playing) when the caller holds no live hand and no live reservation, and otherwise leaves the exit to fn_lightning_reap_expired_disconnects after the hand settles. Current hand and action rules are never cut short.';

REVOKE ALL ON FUNCTION public.fn_lightning_stop_playing(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_stop_playing(uuid) TO authenticated, service_role;

-- ===========================================================================
-- 3. AUTO-REBUY: one service door the engine calls between hands. The top-up
--    itself goes THROUGH public.atomic_table_rebuy - the existing reload
--    wallet path with its receipt, freeze, sufficient-funds and pending-addon
--    delivery discipline - never a direct chip move.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_auto_rebuy(p_cluster_id uuid, p_player_id uuid,
                                                          p_now timestamptz DEFAULT clock_timestamp())
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_now      timestamptz := LEAST(coalesce(p_now, clock_timestamp()), clock_timestamp());
  v_cfg      jsonb;
  s          record;
  v_seat     record;
  v_tbl      record;
  v_bb       numeric;
  v_max_buy  numeric;
  v_stack    numeric;
  v_target   numeric;
  v_amount   numeric;
  v_cap      numeric;
  v_key      uuid;
  v_balance  numeric;
  v_sqlstate text;
  v_message  text;
BEGIN
  IF p_cluster_id IS NULL OR p_player_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'BAD_REQUEST');
  END IF;

  v_cfg := public.fn_lightning_config(p_cluster_id);
  IF coalesce((v_cfg ->> 'auto_rebuy_enabled')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'DISABLED');
  END IF;

  SELECT ps.id, ps.cluster_id, ps.cluster_epoch, ps.player_id, ps.anchor_seat_id, ps.state,
         ps.starting_stack, ps.stop_requested_at, ps.disconnected_at,
         ps.auto_rebuys, ps.auto_rebuy_total
    INTO s
    FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = p_cluster_id AND ps.player_id = p_player_id AND ps.exited_at IS NULL
   ORDER BY ps.entered_at DESC, ps.id
   LIMIT 1
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'NO_SESSION');
  END IF;
  IF s.state IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'SESSION_NOT_ACTIVE', 'state', s.state);
  END IF;
  IF s.stop_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'STOP_REQUESTED');
  END IF;
  IF s.disconnected_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'DISCONNECTED');
  END IF;

  -- BETWEEN HANDS ONLY: a live hand, or any live reservation on the way into
  -- one, refuses the top-up; the engine asks again after the settle.
  IF public.fn_lightning_player_in_hand(p_player_id, p_cluster_id)
     OR EXISTS (SELECT 1 FROM public.lightning_reservation r
                 WHERE r.cluster_id = p_cluster_id AND r.player_id = p_player_id
                   AND r.state IN ('pending', 'committed')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'IN_HAND');
  END IF;

  -- RESPONSIBLE GAMING HAS THE SAME LAST WORD HERE AS AT EVERY DOOR.
  IF (public.fn_rg_require_not_excluded(p_player_id) ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'RG_EXCLUDED',
                              'responsible_gaming', public.fn_rg_require_not_excluded(p_player_id));
  END IF;

  SELECT ts.id, ts.table_id, ts.stack INTO v_seat
    FROM public.table_seats ts
   WHERE ts.id = s.anchor_seat_id AND ts.left_at IS NULL AND ts.user_id = p_player_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ANCHOR_LEFT');
  END IF;

  -- One top-up in flight at a time: an unresolved pending addon means the
  -- previous purchase has not yet landed on the seat.
  IF EXISTS (SELECT 1 FROM public.table_pending_addons a
              WHERE a.table_id = v_seat.table_id AND a.user_id = p_player_id
                AND a.resolved_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'PENDING_ADDON');
  END IF;

  IF coalesce(s.auto_rebuys, 0) >= (v_cfg ->> 'auto_rebuy_max_count')::integer THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'MAX_COUNT',
                              'auto_rebuys', coalesce(s.auto_rebuys, 0),
                              'auto_rebuy_max_count', (v_cfg ->> 'auto_rebuy_max_count')::integer);
  END IF;

  SELECT t.max_buy_in, t.big_blind INTO v_tbl FROM public.tables t WHERE t.id = v_seat.table_id;
  v_bb := coalesce(nullif(v_tbl.big_blind, 0),
                   (SELECT cg.bb FROM public.cash_games cg WHERE cg.id = p_cluster_id), 0);
  -- The effective-buyin reader's own fallback: an unset table maximum is
  -- two hundred big blinds.
  v_max_buy := CASE WHEN coalesce(v_tbl.max_buy_in, 0) > 0 THEN v_tbl.max_buy_in ELSE v_bb * 200 END;

  v_stack := coalesce(public.fn_lightning_pool_stack(s.id), 0);
  v_target := CASE v_cfg ->> 'auto_rebuy_target'
                WHEN 'max' THEN v_max_buy
                ELSE LEAST(coalesce(s.starting_stack, 0), v_max_buy)
              END;

  IF NOT (CASE v_cfg ->> 'auto_rebuy_trigger'
            WHEN 'zero'      THEN v_stack <= 0
            WHEN 'below_bb'  THEN v_stack < (v_cfg ->> 'auto_rebuy_threshold_bb')::numeric * v_bb
            WHEN 'below_pct' THEN v_stack < v_target * (v_cfg ->> 'auto_rebuy_threshold_pct')::numeric / 100.0
            ELSE false
          END) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'NOT_TRIGGERED',
                              'stack', v_stack, 'target', v_target,
                              'trigger', v_cfg ->> 'auto_rebuy_trigger');
  END IF;

  v_amount := round(v_target - v_stack, 2);
  v_cap := (v_cfg ->> 'auto_rebuy_session_cap')::numeric;
  IF v_cap > 0 THEN
    v_amount := LEAST(v_amount, round(v_cap - coalesce(s.auto_rebuy_total, 0), 2));
    IF v_amount <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'SESSION_CAP',
                                'auto_rebuy_total', coalesce(s.auto_rebuy_total, 0),
                                'auto_rebuy_session_cap', v_cap);
    END IF;
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_AT_TARGET',
                              'stack', v_stack, 'target', v_target);
  END IF;

  -- THE DETERMINISTIC PURCHASE KEY: one per (session, count), so however the
  -- engine retries, the reload door's receipt makes the debit happen once.
  v_key := md5('lightning_auto_rebuy:' || s.id::text || ':' || (coalesce(s.auto_rebuys, 0) + 1)::text)::uuid;

  BEGIN
    v_balance := public.atomic_table_rebuy(p_player_id, v_seat.table_id, v_amount, v_key);
  EXCEPTION WHEN OTHERS THEN
    -- The reload door refused (insufficient club chips, a freeze, a seat
    -- vacated under us): its sub-transaction rolled back and nothing moved.
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    RETURN jsonb_build_object('ok', false, 'reason', 'RELOAD_REFUSED',
                              'sqlstate', v_sqlstate, 'message', v_message,
                              'amount', v_amount, 'purchase_key', v_key);
  END;

  UPDATE public.lightning_pool_session ps
     SET auto_rebuys = coalesce(ps.auto_rebuys, 0) + 1,
         auto_rebuy_total = coalesce(ps.auto_rebuy_total, 0) + v_amount,
         updated_at = v_now
   WHERE ps.id = s.id;

  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload, cluster_epoch)
  VALUES (s.cluster_id, v_seat.table_id, 'auto_rebuy', jsonb_build_object(
    'cluster_id', s.cluster_id, 'cluster_epoch', s.cluster_epoch, 'player_id', s.player_id,
    'pool_session_id', s.id, 'anchor_seat_id', s.anchor_seat_id,
    'amount', v_amount, 'stack_before', v_stack,
    'stack_after_delivery', round(v_stack + v_amount, 2),
    'trigger', v_cfg ->> 'auto_rebuy_trigger', 'target', v_cfg ->> 'auto_rebuy_target',
    'count', coalesce(s.auto_rebuys, 0) + 1, 'purchase_key', v_key, 'at', v_now), s.cluster_epoch);

  RETURN jsonb_build_object('ok', true, 'pool_session_id', s.id, 'amount', v_amount,
                            'stack_before', v_stack,
                            'stack_after_delivery', round(v_stack + v_amount, 2),
                            'count', coalesce(s.auto_rebuys, 0) + 1,
                            'balance', v_balance, 'purchase_key', v_key);
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_auto_rebuy(uuid, uuid, timestamptz) IS
  'Lightning Phase 10 (20261008111425): the engine''s between-hands auto-rebuy door, config-gated by auto_rebuy_enabled (default false). Verifies the open active session, no live hand or reservation, no unresolved pending addon, responsible gaming, the count under auto_rebuy_max_count and the trigger against the current pool stack, then tops up THROUGH public.atomic_table_rebuy (the manual reload''s own wallet path) with a deterministic purchase key per (session, count). Never moves chips itself; a wallet refusal answers RELOAD_REFUSED.';

REVOKE ALL ON FUNCTION public.fn_lightning_auto_rebuy(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_auto_rebuy(uuid, uuid, timestamptz) TO service_role;

-- ===========================================================================
-- 4. THE REWRITER, in the shape 20261008050805 cut it: an asserted
--    substitution into the body production carries. Every anchor must appear
--    exactly as often as stated or the file refuses. No signature changes in
--    this file, so the old-vs-new arms stay dormant; a body already carrying
--    the marker is left alone, so the file is re-appliable.
-- ===========================================================================

CREATE OR REPLACE FUNCTION pg_temp.lp10_rewrite(p_old text, p_new text, p_marker text,
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
-- 5. fn_lightning_config answers the seven auto-rebuy keys, read, clamped
--    and reported exactly as every other key. Disabled by default.
-- ===========================================================================

SELECT pg_temp.lp10_rewrite(
  'public.fn_lightning_config(uuid)',
  'public.fn_lightning_config(uuid)',
  '''auto_rebuy_enabled''',
  ARRAY[$a$  v_disc     integer;
$a$,
        $a$  r := public.fn_lightning_config_number(v_cfg, 'disconnect_timeout_ms', 180000, 30000, 1800000, true);
  v_disc := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
$a$,
        $a$    'disconnect_timeout_ms', v_disc,
$a$],
  ARRAY[$b$  v_disc     integer;
  v_ar_on    boolean;
  v_ar_trig  text;
  v_ar_bb    numeric;
  v_ar_pct   integer;
  v_ar_tgt   text;
  v_ar_max   integer;
  v_ar_cap   numeric;
$b$,
        $b$  r := public.fn_lightning_config_number(v_cfg, 'disconnect_timeout_ms', 180000, 30000, 1800000, true);
  v_disc := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  -- LIGHTNING PHASE 10 (20261008111425): AUTO-REBUY, off unless the Cluster
  -- turns it on. The trigger names when fn_lightning_auto_rebuy fires (at
  -- zero, under a big-blind count, under a percentage of the target), the
  -- target names where the top-up aims (the session's starting stack or the
  -- table maximum), and the caps bound how many times and how much.
  v_ar_on := false;
  IF v_cfg ? 'auto_rebuy_enabled' AND jsonb_typeof(v_cfg -> 'auto_rebuy_enabled') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'auto_rebuy_enabled') = 'boolean' THEN
      v_ar_on := (v_cfg ->> 'auto_rebuy_enabled')::boolean;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'auto_rebuy_enabled', 'given', v_cfg -> 'auto_rebuy_enabled',
                                           'reason', 'wrong_type', 'used', v_ar_on);
    END IF;
  END IF;
  v_ar_trig := 'zero';
  IF v_cfg ? 'auto_rebuy_trigger' AND jsonb_typeof(v_cfg -> 'auto_rebuy_trigger') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'auto_rebuy_trigger') = 'string'
       AND (v_cfg ->> 'auto_rebuy_trigger') IN ('zero', 'below_bb', 'below_pct') THEN
      v_ar_trig := v_cfg ->> 'auto_rebuy_trigger';
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'auto_rebuy_trigger', 'given', v_cfg -> 'auto_rebuy_trigger',
                                           'reason', 'not_zero_below_bb_or_below_pct', 'used', v_ar_trig);
    END IF;
  END IF;
  v_ar_tgt := 'initial';
  IF v_cfg ? 'auto_rebuy_target' AND jsonb_typeof(v_cfg -> 'auto_rebuy_target') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'auto_rebuy_target') = 'string'
       AND (v_cfg ->> 'auto_rebuy_target') IN ('initial', 'max') THEN
      v_ar_tgt := v_cfg ->> 'auto_rebuy_target';
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'auto_rebuy_target', 'given', v_cfg -> 'auto_rebuy_target',
                                           'reason', 'not_initial_or_max', 'used', v_ar_tgt);
    END IF;
  END IF;
  r := public.fn_lightning_config_number(v_cfg, 'auto_rebuy_threshold_bb', 1, 0, 100, false);
  v_ar_bb := (r ->> 'value')::numeric; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'auto_rebuy_threshold_pct', 25, 1, 99, true);
  v_ar_pct := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'auto_rebuy_max_count', 3, 0, 100, true);
  v_ar_max := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'auto_rebuy_session_cap', 0, 0, 1000000, false);
  v_ar_cap := (r ->> 'value')::numeric; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
$b$,
        $b$    'disconnect_timeout_ms', v_disc,
    'auto_rebuy_enabled', v_ar_on,
    'auto_rebuy_trigger', v_ar_trig,
    'auto_rebuy_threshold_bb', v_ar_bb,
    'auto_rebuy_threshold_pct', v_ar_pct,
    'auto_rebuy_target', v_ar_tgt,
    'auto_rebuy_max_count', v_ar_max,
    'auto_rebuy_session_cap', v_ar_cap,
$b$],
  ARRAY[1, 1, 1]);

-- ===========================================================================
-- 6. fn_lightning_player_legality refuses a stopping player: STOP_REQUESTED,
--    after responsible gaming and before the disconnect arm, so the matcher
--    skips them from the next formation on while every in-hand rule stands.
-- ===========================================================================

SELECT pg_temp.lp10_rewrite(
  'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)',
  'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)',
  '''STOP_REQUESTED''',
  ARRAY[$a$           ps.anchor_seat_id,
$a$,
        $a$        WHEN public.fn_lightning_player_in_hand(f.player_id, f.cluster_id) THEN 'IN_HAND'
$a$,
        $a$              WHEN 'DISCONNECTED' THEN jsonb_build_object('reported_disconnected',
$a$],
  ARRAY[$b$           ps.anchor_seat_id,
           ps.stop_requested_at,
$b$,
        $b$        WHEN public.fn_lightning_player_in_hand(f.player_id, f.cluster_id) THEN 'IN_HAND'
        -- LIGHTNING PHASE 10 (20261008111425): a player who pressed Stop
        -- Playing is never matched into another hand. After the hand arms,
        -- so a stopper still playing reads IN_HAND until the hand lets go.
        WHEN f.stop_requested_at IS NOT NULL THEN 'STOP_REQUESTED'
$b$,
        $b$              WHEN 'STOP_REQUESTED' THEN jsonb_build_object('stop_requested_at', c.stop_requested_at)
              WHEN 'DISCONNECTED' THEN jsonb_build_object('reported_disconnected',
$b$],
  ARRAY[1, 1, 1]);

-- ===========================================================================
-- 7. fn_lightning_pool_enter defers to the responsible-gaming gate the cash
--    sit-down path already answers to: a self-excluded or cooling-off player
--    never opens a pool session.
-- ===========================================================================

SELECT pg_temp.lp10_rewrite(
  'public.fn_lightning_pool_enter(uuid,timestamp with time zone)',
  'public.fn_lightning_pool_enter(uuid,timestamp with time zone)',
  'fn_rg_require_not_excluded',
  ARRAY[$a$  IF NOT public.fn_lightning_anchor_is_live_eligible(s.id, g.id, s.user_id) THEN
    RETURN NULL;
  END IF;
$a$],
  ARRAY[$b$  IF NOT public.fn_lightning_anchor_is_live_eligible(s.id, g.id, s.user_id) THEN
    RETURN NULL;
  END IF;

  -- LIGHTNING PHASE 10 (20261008111425): THE POOL DOOR HONORS RESPONSIBLE
  -- GAMING. The same gate the matcher consults (fn_rg_require_not_excluded:
  -- self-exclusion and cooling-off) refuses entry outright, so an excluded
  -- player never sits in the pool at all. The door's refusal is its NULL,
  -- as for every other ineligible seat.
  IF (public.fn_rg_require_not_excluded(s.user_id) ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RETURN NULL;
  END IF;
$b$],
  ARRAY[1]);

-- ===========================================================================
-- 8. fn_lightning_reap_expired_disconnects also finishes a Stop Playing
--    request: a marked session is exited the moment it holds no live hand
--    and no live reservation (exit_reason stop_playing), under the same
--    skip rules, locks, per-item isolation and pool_player_left discipline;
--    a stopped session is never counted into the player_expired record.
-- ===========================================================================

SELECT pg_temp.lp10_rewrite(
  'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)',
  'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)',
  '''stop_playing''',
  ARRAY[$a$           ps.disconnected_at, cfg.timeout_ms
$a$,
        $a$     WHERE ps.exited_at IS NULL
       AND ps.disconnected_at IS NOT NULL
       AND (p_cluster_id IS NULL OR ps.cluster_id = p_cluster_id)
       AND ps.disconnected_at + make_interval(secs => cfg.timeout_ms / 1000.0) <= p_now
     ORDER BY ps.disconnected_at, ps.id
$a$,
        $a$             exit_reason = 'disconnect_expired',
$a$,
        $a$        'pool_session_id', s.id, 'anchor_seat_id', s.anchor_seat_id, 'reason', 'disconnect_expired',
$a$,
        $a$        'player_id', s.player_id, 'disconnected_at', s.disconnected_at,
        'timeout_ms', s.timeout_ms);
$a$,
        $a$           jsonb_agg(x - 'cluster_id' - 'cluster_epoch' ORDER BY x ->> 'player_id') AS players
      FROM jsonb_array_elements(v_rows) x
     GROUP BY 1
$a$],
  ARRAY[$b$           ps.disconnected_at, ps.stop_requested_at, cfg.timeout_ms
$b$,
        $b$     WHERE ps.exited_at IS NULL
       AND (p_cluster_id IS NULL OR ps.cluster_id = p_cluster_id)
       -- LIGHTNING PHASE 10 (20261008111425): the worklist is a disconnect
       -- past its timeout OR a standing Stop Playing request, which owes
       -- nobody a timeout - it exits the moment the hand lets go.
       AND ((ps.disconnected_at IS NOT NULL
             AND ps.disconnected_at + make_interval(secs => cfg.timeout_ms / 1000.0) <= p_now)
            OR ps.stop_requested_at IS NOT NULL)
     ORDER BY LEAST(coalesce(ps.disconnected_at, ps.stop_requested_at),
                    coalesce(ps.stop_requested_at, ps.disconnected_at)), ps.id
$b$,
        $b$             exit_reason = CASE WHEN s.stop_requested_at IS NOT NULL
                                THEN 'stop_playing' ELSE 'disconnect_expired' END,
$b$,
        $b$        'pool_session_id', s.id, 'anchor_seat_id', s.anchor_seat_id,
        'reason', CASE WHEN s.stop_requested_at IS NOT NULL
                       THEN 'stop_playing' ELSE 'disconnect_expired' END,
$b$,
        $b$        'player_id', s.player_id, 'disconnected_at', s.disconnected_at,
        'stopped', s.stop_requested_at IS NOT NULL,
        'timeout_ms', s.timeout_ms);
$b$,
        $b$           jsonb_agg(x - 'cluster_id' - 'cluster_epoch' - 'stopped' ORDER BY x ->> 'player_id') AS players
      FROM jsonb_array_elements(v_rows) x
     -- A stopped session left of its own will is not an expired disconnect.
     WHERE (x ->> 'stopped')::boolean IS NOT TRUE
     GROUP BY 1
$b$],
  ARRAY[1, 1, 1, 1, 1, 1]);

-- ===========================================================================
-- 9. fn_lightning_reconnect_state tells a reconnecting client that its stop
--    stands: one more key, the caller's own and nothing else.
-- ===========================================================================

SELECT pg_temp.lp10_rewrite(
  'public.fn_lightning_reconnect_state(uuid)',
  'public.fn_lightning_reconnect_state(uuid)',
  '''stop_requested''',
  ARRAY[$a$  SELECT s.id, s.state, s.disconnected_at, s.anchor_seat_id INTO ps
$a$,
        $a$  -- EXACTLY NINE KEYS, the caller's own and nothing else: no instance id, no
$a$,
        $a$    'disconnected_at', ps.disconnected_at,
$a$],
  ARRAY[$b$  SELECT s.id, s.state, s.disconnected_at, s.stop_requested_at, s.anchor_seat_id INTO ps
$b$,
        $b$  -- EXACTLY TEN KEYS, the caller's own and nothing else: no instance id, no
$b$,
        $b$    'disconnected_at', ps.disconnected_at,
    'stop_requested', ps.stop_requested_at IS NOT NULL,
$b$],
  ARRAY[1, 1, 1]);

-- ===========================================================================
-- 10. READ BACK.
-- ===========================================================================

DO $readback$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('the stop mark exists', (SELECT a.atttypid = 'timestamptz'::regtype AND NOT a.attnotnull FROM pg_attribute a
       WHERE a.attrelid = 'public.lightning_pool_session'::regclass AND a.attname = 'stop_requested_at' AND NOT a.attisdropped)),
    ('the rebuy counters exist and refuse the negative', (SELECT count(*) = 2 FROM pg_attribute a
       WHERE a.attrelid = 'public.lightning_pool_session'::regclass
         AND a.attname IN ('auto_rebuys', 'auto_rebuy_total') AND NOT a.attisdropped AND a.attnotnull)
       AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.lightning_pool_session'::regclass
                     AND c.conname = 'lightning_pool_session_auto_rebuy_counters_are_sane')),
    ('the stop door asks who is calling', (SELECT p.prosecdef AND p.provolatile = 'v'
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND pg_get_functiondef(p.oid) ~ 'auth\.uid\(\)'
       FROM pg_proc p WHERE p.oid = 'public.fn_lightning_stop_playing(uuid)'::regprocedure)),
    ('the auto-rebuy door is the engine''s alone and reloads through the wallet door', (SELECT NOT p.prosecdef
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND pg_get_functiondef(p.oid) ~ 'public\.atomic_table_rebuy\('
       FROM pg_proc p WHERE p.oid = 'public.fn_lightning_auto_rebuy(uuid,uuid,timestamp with time zone)'::regprocedure)),
    ('the configuration answers auto-rebuy, off', (SELECT (public.fn_lightning_config(NULL) ->> 'auto_rebuy_enabled')::boolean = false
       AND (public.fn_lightning_config(NULL) ->> 'auto_rebuy_max_count')::integer = 3)),
    ('the matcher refuses a stopping player', (SELECT pg_get_functiondef('public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure) ~ '''STOP_REQUESTED''')),
    ('the pool door honors responsible gaming', (SELECT pg_get_functiondef('public.fn_lightning_pool_enter(uuid,timestamp with time zone)'::regprocedure) ~ 'fn_rg_require_not_excluded\(s\.user_id\)')),
    ('the reaper finishes a stop', (SELECT s ~ '''stop_playing''' AND s ~ '\(x ->> ''stopped''\)::boolean IS NOT TRUE'
       FROM (SELECT pg_get_functiondef('public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure) AS s) q2)),
    ('the reconnect snapshot names the stop', (SELECT pg_get_functiondef('public.fn_lightning_reconnect_state(uuid)'::regprocedure) ~ '''stop_requested''')),
    ('no horse is singled out', (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f'
         AND p.proname IN ('fn_lightning_stop_playing', 'fn_lightning_auto_rebuy',
                           'fn_lightning_player_legality', 'fn_lightning_pool_enter',
                           'fn_lightning_reap_expired_disconnects', 'fn_lightning_reconnect_state',
                           'fn_lightning_config')
         AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id')))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_P10_RG_REBUY_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
