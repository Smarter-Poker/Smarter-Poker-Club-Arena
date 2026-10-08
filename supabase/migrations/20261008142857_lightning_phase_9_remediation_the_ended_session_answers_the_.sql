-- 20261008142857_lightning_phase_9_remediation_the_ended_session_answers_the_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASE 9 REMEDIATION (THE DATABASE SIDE): THE ENDED SESSION
-- ANSWERS, THE REAPER CLAMPS AND SKIPS THE FROZEN, AND PRESENCE SELF-HEALS.
--
-- The adversarial review of the Phase 9 disconnect/reconnect work
-- (20261008050805) found four database defects. The app-side half merged as
-- PR #6499; this file closes the database half, substituting into the bodies
-- production carries NOW (read with pg_get_functiondef on 2026-10-08, after
-- Phase 10's 20261008111425).
--
-- FINDING 1 (HIGH). fn_lightning_reconnect_state answered NULL for a player
-- whose session ENDED, so a returning client could not tell timed out from
-- stopped from merely gone: no exit_reason, no seat pointer, and the Phase 9
-- ending ("Your Lightning Session Timed Out") was unreachable. Now, with no
-- open session in the Cluster, the caller's MOST RECENT exited session
-- answers: {pool_session_id, state 'ended', in_hand false, hand_id null,
-- disconnected_at, stop_requested, seat_table_id, seat_number, stack
-- (the session's ending_stack), joinable, exit_reason} - exit_reason
-- verbatim from the row ('disconnect_expired', 'stop_playing',
-- 'anchor_seat_left', 'cluster_unfrozen', ...). The seat pointer answers
-- ONLY while the caller still owns the anchor seat (ts.user_id = caller,
-- left_at null): the reaper never stands the seat up, so VIEW GAME can point
-- at it; stood up or re-owned since, both seat keys are NULL, never another
-- player's chair. The open-session answer keeps its exact shape PLUS
-- exit_reason: null (the merged client's parse tolerates and reads the
-- extra key). Still auth.uid() scoped: the caller's own and nothing else,
-- no instance id, no cluster_mode, and a caller who never had a session in
-- the Cluster still reads NULL.
--
-- FINDING 4 (LOW). The open-session branch could leak a lightning_instance
-- id in the hand_id key: fn_lightning_player_live_hand's first branch
-- answers coalesce(i.hand_id, i.id) for a committed reservation on a
-- still-forming instance. That coalesce is LOAD-BEARING for its other
-- callers (fn_table_seats_lightning_anchor_guard and the engine's departure
-- gate lightningAnchor.ts both read null-vs-not-null as "engaged", and a
-- committed reservation on a forming instance must count), so the shared
-- body is NOT changed; the reconnect snapshot alone scopes the key: hand_id
-- answers only an id public.lightning_hand actually carries, so while the
-- instance is forming the snapshot says in_hand true, hand_id null.
--
-- FINDING 3 (LOW). fn_lightning_reap_expired_disconnects took any p_limit:
-- LIMIT GREATEST(1, coalesce(p_limit, 200)) had no upper clamp, so one call
-- could lock an unbounded worklist. Now LIMIT LEAST(GREATEST(1,
-- coalesce(p_limit, 200)), 2000).
--
-- FINDING 6 (LOW, decided doctrine). A Cluster frozen by the settlement
-- freeze (cash_games.cluster_mode = 'frozen', fn_lightning_settlement_freeze)
-- is under forensic investigation: its lightning_pool_session rows must not
-- be mutated. The disconnect/stop reaper now SKIPS sessions of a frozen
-- Cluster entirely - not a timed-out disconnect, and not a standing Stop
-- Playing request either (an idle stopper waits out the freeze; consistency
-- beats speed) - and the stop door defers its immediate exit the same way,
-- while still recording the stop mark (a responsible-gaming request is
-- never dropped). fn_cash_cluster_unfreeze owns the frozen Cluster's
-- recovery and exits its sessions itself ('cluster_unfrozen'); a thawed
-- Cluster's expired disconnects are reaped on the next pass. The formation
-- reaper's "recovery during the break" doctrine covers buried instances,
-- never session exits.
--
-- FINDING 2 (DB half). The app now retries lost reconnect reports (#6499);
-- the database adds its own self-heal at the doors a CONNECTED player's own
-- action reaches: fn_lightning_fast_fold (the player's fold, relayed by the
-- engine with the player's id) and fn_lightning_stop_playing (the player's
-- own tap) clear the CALLER'S OWN stale disconnected stamp
-- (disconnected_at := null, state 'disconnected' -> 'active') as a side
-- effect, because a player taking an action is definitionally connected.
-- Guarded (only when the stamp is set, never on a frozen Cluster, never an
-- exited row), event-light (one player_reconnected event in
-- fn_lightning_presence_report's own ledger shape). The engine-spoken doors
-- (presence_report, the reapers, auto_rebuy, settlement) are NOT touched:
-- the engine speaks for itself. The other authenticated Lightning doors are
-- STABLE reads and cannot write; fn_lightning_stop_playing is the only
-- authenticated per-action door.
--
-- LIGHTNING IS OFF EVERYWHERE (cash_games.lightning_enabled false across
-- the estate). Every change sits behind the Lightning doors: all four
-- bodies touch only lightning_pool_session rows and Lightning reads.
-- Non-Lightning cash behavior is unchanged; no Sentry anywhere.
--
-- HOUSE RULES OBSERVED. One BEGIN/COMMIT with SET LOCAL lock_timeout. NO
-- DDL on any table: no table is created, altered or locked. Every change is
-- an asserted substitution into the body production carries (each anchor
-- must appear exactly as often as stated or the file refuses), a body
-- already carrying the marker is left alone (re-appliable), and grants are
-- carried semantically: every signature is unchanged, CREATE OR REPLACE
-- keeps the installed ACL, and the read-back asserts who may execute with
-- has_function_privilege per role.
--
-- LAW 10.5. Nothing here reads is_horse or horse_id (the seat-ownership
-- check reads ts.user_id and ts.left_at). A horse's ended session answers,
-- heals and waits out a freeze exactly as a human's; the no-horse-reads
-- proof below pins every touched body.
--
-- @live-proof: (SELECT p.prosecdef AND p.provolatile = 's' AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND s ~ 'auth\.uid\(\)' AND s ~ '''ended''' AND s ~ '''exit_reason''' AND s ~ 's\.exited_at IS NOT NULL' AND s ~ 'ORDER BY s\.exited_at DESC, s\.id' FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid = 'public.fn_lightning_reconnect_state(uuid)'::regprocedure)
-- @live-proof: (SELECT s ~ 'ts\.id = ps\.anchor_seat_id AND ts\.user_id = v_uid AND ts\.left_at IS NULL' FROM (SELECT pg_get_functiondef('public.fn_lightning_reconnect_state(uuid)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ '''exit_reason'', NULL' AND s ~ '''stop_requested''' AND s !~ '''instance_id''' AND s !~ '''cluster_mode''' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_reconnect_state(uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ '''hand_id'', v_hand_id' AND s ~ 'lh\.hand_id = v_hand' AND s !~ '''hand_id'', v_hand,' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_reconnect_state(uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ 'coalesce\(i\.hand_id, i\.id\)' FROM (SELECT pg_get_functiondef('public.fn_lightning_player_live_hand(uuid,uuid)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ 'LIMIT LEAST\(GREATEST\(1, coalesce\(p_limit, 200\)\), 2000\)' AND s ~ 'FOR UPDATE OF ps SKIP LOCKED' FROM (SELECT pg_get_functiondef('public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ 'NOT EXISTS \(SELECT 1 FROM public\.cash_games fz' AND s ~ 'fz\.cluster_mode = ''frozen''' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT NOT p.prosecdef AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND s ~ '''player_reconnected''' AND s ~ 'disconnected_at = NULL' AND s ~ 'fz\.cluster_mode = ''frozen''' FROM pg_proc p, LATERAL (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s) q WHERE p.oid = 'public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)'::regprocedure)
-- @live-proof: (SELECT p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND s ~ '''player_reconnected''' AND s ~ 'NOT v_in_hand AND NOT v_frozen' AND s ~ 'fz\.cluster_mode = ''frozen''' FROM pg_proc p, LATERAL (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s) q WHERE p.oid = 'public.fn_lightning_stop_playing(uuid)'::regprocedure)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_lightning_reconnect_state', 'fn_lightning_reap_expired_disconnects', 'fn_lightning_fast_fold', 'fn_lightning_stop_playing', 'fn_lightning_player_live_hand') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id'))

BEGIN;

SET LOCAL lock_timeout = '2s';

-- ===========================================================================
-- 1. THE REWRITER, in the shape 20261008050805 and 20261008111425 cut it: an
--    asserted substitution into the body production carries. Every anchor
--    must appear exactly as often as stated or the file refuses. No
--    signature changes in this file, so the old-vs-new arms stay dormant; a
--    body already carrying the marker is left alone, so the file is
--    re-appliable.
-- ===========================================================================

CREATE OR REPLACE FUNCTION pg_temp.lp9r2_rewrite(p_old text, p_new text, p_marker text,
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
-- 2. FINDINGS 1 AND 4: fn_lightning_reconnect_state answers the ended
--    session and scopes hand_id to a dealt hand's id alone.
-- ===========================================================================

SELECT pg_temp.lp9r2_rewrite(
  'public.fn_lightning_reconnect_state(uuid)',
  'public.fn_lightning_reconnect_state(uuid)',
  '''exit_reason''',
  ARRAY[$a$  v_hand uuid;
BEGIN
$a$,
        $a$  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT ts.table_id, ts.seat_number INTO v_seat
    FROM public.table_seats ts WHERE ts.id = ps.anchor_seat_id;

  v_hand := public.fn_lightning_player_live_hand(v_uid, g.id);
$a$,
        $a$  -- EXACTLY TEN KEYS, the caller's own and nothing else: no instance id, no
$a$,
        $a$    'hand_id', v_hand,
$a$,
        $a$AND g.enabled IS TRUE));
$a$],
  ARRAY[$b$  v_hand uuid;
  v_hand_id uuid;
BEGIN
$b$,
        $b$  IF NOT FOUND THEN
    -- LIGHTNING PHASE 9 REMEDIATION (20261008142857): THE ENDED SESSION
    -- ANSWERS ITS ENDING. The old NULL told a returning client nothing, so
    -- timed out, stopped and merely gone were indistinguishable and the
    -- Phase 9 ending was unreachable. With no open session in the Cluster,
    -- the caller's MOST RECENT exited session answers, state 'ended',
    -- exit_reason verbatim from the row ('disconnect_expired',
    -- 'stop_playing', ...). Still the caller's own and nothing else.
    SELECT s.id, s.state, s.disconnected_at, s.stop_requested_at, s.anchor_seat_id,
           s.exit_reason, s.ending_stack INTO ps
      FROM public.lightning_pool_session s
     WHERE s.cluster_id = g.id AND s.player_id = v_uid AND s.exited_at IS NOT NULL
     ORDER BY s.exited_at DESC, s.id
     LIMIT 1;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    -- THE SEAT POINTER ANSWERS ONLY WHILE THE CALLER STILL OWNS THE SEAT:
    -- the disconnect reaper never stands the anchor seat up, so VIEW GAME
    -- can point at it; stood up or re-owned since, both seat keys are NULL,
    -- never another player's chair.
    SELECT ts.table_id, ts.seat_number INTO v_seat
      FROM public.table_seats ts
     WHERE ts.id = ps.anchor_seat_id AND ts.user_id = v_uid AND ts.left_at IS NULL;
    RETURN jsonb_build_object(
      'pool_session_id', ps.id,
      'state', 'ended',
      'in_hand', false,
      'hand_id', NULL::uuid,
      'disconnected_at', ps.disconnected_at,
      'stop_requested', ps.stop_requested_at IS NOT NULL,
      'seat_table_id', v_seat.table_id,
      'seat_number', v_seat.seat_number,
      'stack', ps.ending_stack,
      'joinable', (g.cluster_mode = 'lightning' AND coalesce(g.lightning_enabled, false) AND g.enabled IS TRUE),
      'exit_reason', ps.exit_reason);
  END IF;

  SELECT ts.table_id, ts.seat_number INTO v_seat
    FROM public.table_seats ts WHERE ts.id = ps.anchor_seat_id;

  v_hand := public.fn_lightning_player_live_hand(v_uid, g.id);
  -- FINDING 4 (20261008142857): THE SNAPSHOT'S hand_id IS A DEALT HAND'S ID
  -- ALONE. fn_lightning_player_live_hand answers coalesce(i.hand_id, i.id)
  -- and that coalesce is load-bearing for its other callers (the anchor
  -- guard and the engine's departure gate read null-vs-not-null as
  -- "engaged", a committed reservation on a forming instance included), so
  -- the shared body is untouched; this snapshot alone scopes the key to an
  -- id public.lightning_hand actually carries. While the instance is still
  -- forming: in_hand true, hand_id null.
  v_hand_id := (SELECT lh.hand_id FROM public.lightning_hand lh WHERE lh.hand_id = v_hand);
$b$,
        $b$  -- EXACTLY ELEVEN KEYS (20261008142857 adds exit_reason, NULL while the
  -- session is open), the caller's own and nothing else: no instance id, no
$b$,
        $b$    'hand_id', v_hand_id,
$b$,
        $b$AND g.enabled IS TRUE),
    'exit_reason', NULL::text);
$b$],
  ARRAY[1, 1, 1, 1, 1]);

-- ===========================================================================
-- 3. FINDINGS 3 AND 6: the reaper clamps its worklist above as well as
--    below, and never mutates a frozen Cluster's pool-session rows.
-- ===========================================================================

SELECT pg_temp.lp9r2_rewrite(
  'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)',
  'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)',
  'LIMIT LEAST(GREATEST(1, coalesce(p_limit, 200)), 2000)',
  ARRAY[$a$     WHERE ps.exited_at IS NULL
       AND (p_cluster_id IS NULL OR ps.cluster_id = p_cluster_id)
$a$,
        $a$     LIMIT GREATEST(1, coalesce(p_limit, 200))
$a$],
  ARRAY[$b$     WHERE ps.exited_at IS NULL
       AND (p_cluster_id IS NULL OR ps.cluster_id = p_cluster_id)
       -- LIGHTNING PHASE 9 REMEDIATION (20261008142857), FINDING 6: A FROZEN
       -- CLUSTER IS EVIDENCE. cluster_mode 'frozen'
       -- (fn_lightning_settlement_freeze) marks a Cluster under forensic
       -- investigation, and its pool-session rows are not mutated here: not
       -- a timed-out disconnect, and not a standing Stop Playing request
       -- either - an idle stopper waits out the freeze (consistency beats
       -- speed). fn_cash_cluster_unfreeze owns the frozen Cluster's recovery
       -- and exits its sessions itself ('cluster_unfrozen'); a Cluster
       -- thawed any other way is reaped on the next pass. The formation
       -- reaper's "recovery during the break" doctrine covers buried
       -- instances, never session exits.
       AND NOT EXISTS (SELECT 1 FROM public.cash_games fz
                        WHERE fz.id = ps.cluster_id AND fz.cluster_mode = 'frozen')
$b$,
        $b$     -- FINDING 3 (20261008142857): an upper clamp too - one pass can never
     -- lock more than 2000 sessions however large p_limit comes in.
     LIMIT LEAST(GREATEST(1, coalesce(p_limit, 200)), 2000)
$b$],
  ARRAY[1, 1]);

-- ===========================================================================
-- 4. FINDINGS 2 AND 6 AT THE STOP DOOR: pressing Stop is itself a heartbeat
--    (the caller's stale disconnect stamp clears when the session stays
--    open), and the immediate idle exit defers while the Cluster is frozen.
-- ===========================================================================

SELECT pg_temp.lp9r2_rewrite(
  'public.fn_lightning_stop_playing(uuid)',
  'public.fn_lightning_stop_playing(uuid)',
  'NOT v_in_hand AND NOT v_frozen',
  ARRAY[$a$  v_first   boolean := false;
$a$,
        $a$  v_in_hand := public.fn_lightning_player_in_hand(v_uid, p_cluster_id)
$a$,
        $a$  IF NOT v_in_hand THEN
$a$,
        $a$  RETURN jsonb_build_object('ok', true, 'pool_session_id', s.id, 'exited', false,
                            'in_hand', true, 'stop_requested_at', s.stop_requested_at);
END
$a$],
  ARRAY[$b$  v_first   boolean := false;
  v_frozen  boolean := false;
$b$,
        $b$  -- LIGHTNING PHASE 9 REMEDIATION (20261008142857), FINDING 6: A FROZEN
  -- CLUSTER IS EVIDENCE (the reaper's own doctrine). The stop mark above
  -- stands - a responsible-gaming request is never dropped, and the matcher
  -- must never deal this player again - but no pool-session row of a frozen
  -- Cluster is exited here: the exit waits for fn_cash_cluster_unfreeze or
  -- the first reaper pass after the thaw (consistency beats speed).
  v_frozen := EXISTS (SELECT 1 FROM public.cash_games fz
                       WHERE fz.id = s.cluster_id AND fz.cluster_mode = 'frozen');

  v_in_hand := public.fn_lightning_player_in_hand(v_uid, p_cluster_id)
$b$,
        $b$  IF NOT v_in_hand AND NOT v_frozen THEN
$b$,
        $b$  -- FINDING 2 (20261008142857): PRESSING STOP IS ITSELF A HEARTBEAT. A
  -- session that stays open past this door (a live hand, or a freeze) does
  -- so CONNECTED: the caller's own stale disconnect stamp - a lost presence
  -- report - is cleared, only when set and never on a frozen Cluster, with
  -- one player_reconnected event in the presence door's own ledger shape.
  IF NOT v_frozen THEN
    UPDATE public.lightning_pool_session ps
       SET disconnected_at = NULL,
           state = CASE WHEN ps.state = 'disconnected' THEN 'active' ELSE ps.state END,
           updated_at = v_now
     WHERE ps.id = s.id AND ps.exited_at IS NULL AND ps.disconnected_at IS NOT NULL;
    IF FOUND THEN
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
      VALUES (s.cluster_id, 'player_reconnected', jsonb_build_object(
        'cluster_id', s.cluster_id, 'cluster_epoch', s.cluster_epoch,
        'players', jsonb_build_array(jsonb_build_object('player_id', s.player_id, 'pool_session_id', s.id)),
        'at', v_now), s.cluster_epoch);
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'pool_session_id', s.id, 'exited', false,
                            'in_hand', v_in_hand, 'stop_requested_at', s.stop_requested_at);
END
$b$],
  ARRAY[1, 1, 1, 1]);

-- ===========================================================================
-- 5. FINDING 2 AT THE FOLD DOOR: the player's own fold (relayed by the
--    engine with the player's id) clears the player's stale disconnect
--    stamp, once, in the presence door's own ledger shape.
-- ===========================================================================

SELECT pg_temp.lp9r2_rewrite(
  'public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)',
  'public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)',
  '''player_reconnected''',
  ARRAY[$a$  v_kind     text;
$a$,
        $a$  v_kind := CASE p_fold_type$a$],
  ARRAY[$b$  v_kind     text;
  v_healed   jsonb;
$b$,
        $b$  -- LIGHTNING PHASE 9 REMEDIATION (20261008142857), FINDING 2: AN ACTION
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

  v_kind := CASE p_fold_type$b$],
  ARRAY[1, 1]);

-- ===========================================================================
-- 6. READ BACK. Grants are asserted semantically, per role, because the
--    rewriter's same-signature path relies on CREATE OR REPLACE keeping the
--    installed ACL and production's autorevoke environment is hostile.
-- ===========================================================================

DO $readback$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('the ended session answers through the browser door', (SELECT p.prosecdef AND p.provolatile = 's'
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
       AND s ~ 'auth\.uid\(\)' AND s ~ '''ended''' AND s ~ '''exit_reason'''
       AND s ~ 's\.exited_at IS NOT NULL' AND s ~ 'ORDER BY s\.exited_at DESC, s\.id'
       FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q2
      WHERE p.oid = 'public.fn_lightning_reconnect_state(uuid)'::regprocedure)),
    ('the seat pointer asks who owns the chair', (SELECT s ~ 'ts\.id = ps\.anchor_seat_id AND ts\.user_id = v_uid AND ts\.left_at IS NULL'
       FROM (SELECT pg_get_functiondef('public.fn_lightning_reconnect_state(uuid)'::regprocedure) AS s) q2)),
    ('the open answer carries exit_reason null and leaks nothing new', (SELECT s ~ '''exit_reason'', NULL' AND s ~ '''stop_requested'''
       AND s !~ '''instance_id''' AND s !~ '''cluster_mode'''
       FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_reconnect_state(uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q2)),
    ('hand_id is a dealt hand''s id alone', (SELECT s ~ '''hand_id'', v_hand_id' AND s ~ 'lh\.hand_id = v_hand' AND s !~ '''hand_id'', v_hand,'
       FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_reconnect_state(uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q2)),
    ('the shared live-hand reader keeps its coalesce for its other callers', (SELECT s ~ 'coalesce\(i\.hand_id, i\.id\)'
       FROM (SELECT pg_get_functiondef('public.fn_lightning_player_live_hand(uuid,uuid)'::regprocedure) AS s) q2)),
    ('the reaper clamps above as well as below and still skips locks', (SELECT s ~ 'LIMIT LEAST\(GREATEST\(1, coalesce\(p_limit, 200\)\), 2000\)'
       AND s ~ 'FOR UPDATE OF ps SKIP LOCKED'
       FROM (SELECT pg_get_functiondef('public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure) AS s) q2)),
    ('the reaper never mutates a frozen cluster''s rows', (SELECT s ~ 'NOT EXISTS \(SELECT 1 FROM public\.cash_games fz' AND s ~ 'fz\.cluster_mode = ''frozen'''
       AND s ~ '''stop_playing''' AND s ~ '''disconnect_expired'''
       FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q2)),
    ('the reaper stays the engine''s alone', (SELECT NOT p.prosecdef
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       FROM pg_proc p WHERE p.oid = 'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure)),
    ('the fold door heals the folder and stays the engine''s alone', (SELECT NOT p.prosecdef
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND s ~ '''player_reconnected''' AND s ~ 'disconnected_at = NULL' AND s ~ 'fz\.cluster_mode = ''frozen'''
       FROM pg_proc p, LATERAL (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s) q2
      WHERE p.oid = 'public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)'::regprocedure)),
    ('the stop door heals, defers for a freeze and keeps its grants', (SELECT p.prosecdef
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND s ~ '''player_reconnected''' AND s ~ 'NOT v_in_hand AND NOT v_frozen' AND s ~ 'fz\.cluster_mode = ''frozen'''
       FROM pg_proc p, LATERAL (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s) q2
      WHERE p.oid = 'public.fn_lightning_stop_playing(uuid)'::regprocedure)),
    ('no horse is singled out', (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f'
         AND p.proname IN ('fn_lightning_reconnect_state', 'fn_lightning_reap_expired_disconnects',
                           'fn_lightning_fast_fold', 'fn_lightning_stop_playing', 'fn_lightning_player_live_hand')
         AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id')))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_P9R_DB_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
