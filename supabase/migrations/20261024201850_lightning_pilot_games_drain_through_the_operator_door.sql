-- 20261024201850_lightning_pilot_games_drain_through_the_operator_door.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- OWNER ORDER. Dan, 2026-10-24: "Two horses-only Lightning games are still
-- running in the old 'Lightning Internal Pilot' club, not Midway: NLH
-- 0.01/0.02 and NLH 0.02/0.04 ... FINISH THIS UP." Every game launches from
-- Midway Union only (20261024053530); these two pilot games stop and close.
--
-- WHY A DRAIN, AND WHY ONLY A DRAIN. Both games are live Lightning pools
-- (cluster_mode 'lightning', always_on, 11 and 8 horses on anchor seats, 2 and
-- 2 hands dealing when read). The platform's only door out of Lightning is the
-- operator drain, fn_lightning_operator_control(cluster, 'drain', ...): it stops
-- joins and formation in this statement, records lightning_cluster_drain, and
-- the existing drive (fn_cash_cluster_lightning_drive -> fn_lightning_drain_
-- advance) lets every dealing hand settle, closes every pool session onto the
-- anchor seat its player never left, reverts the game to must_move through the
-- original reversion (its money digest asserted), and completes the drain. It
-- stands nobody up, moves no seat and writes no wallet. These two games were
-- drained this way twice before (2026-10-18 14:06, 1.8 s; 21:05, 89 s).
--
-- The owner's switch, fn_cash_game_switch_off, refuses any Lightning state
-- ('lightning_state_requires_operator_drain') - measured in a rolled-back
-- probe both before and immediately after this drain, since the drain cannot
-- complete inside the transaction that opens it. So the stand-down is three
-- installs, each through its own maintained door:
--   1. THIS FILE: drain both games (seconds to ~2 minutes after install).
--   2. After both drains read complete and both games read must_move with
--      Lightning off: fn_cash_game_switch_off as the owner. The live engine's
--      HorseSessionRotator (horsesLeaveSwitchedOffGame, #7841) then stands each
--      horse up at the end of its hand through engine.leaveTable(), the
--      ordinary per-occupancy cash-out into its club wallet, exactly as a
--      person leaving; fn_cash_cluster_tick closes each table once it is empty.
--   3. Once nobody is seated: close the game (closed_at) as 20261015172330 did.
--
-- IDENTITY. The operator door reads auth.uid(); this transaction acts as the
-- club owner (2d1cd6c3, the platform service identity, role god), exactly as
-- 20261015172330 did, and clears the claim afterwards. The door records the
-- owner as requested_by. Each game has one stable request id, so a replay is
-- answered by the door instead of acting twice.
--
-- ASSERTED. Exactly these two games, in this club, enabled, live Lightning,
-- with no drain open; both answer ok with a new drain; both read draining with
-- Lightning off and still enabled; and - read by this transaction's own xid, so
-- concurrent play elsewhere can neither fail nor fake it - no other game and no
-- other drain was written, and no wallet, treasury, live seat, or table or seat
-- of these games. Proved in a rolled-back probe of this exact body at 2026-10-24 20:20 UTC.
-- @live-proof: (SELECT count(*) = 2 FROM public.lightning_operator_request r WHERE r.request_id IN ('9c321e6b-83a0-4548-8304-7f107c36a48c', '0492c919-d84a-404e-ab32-1f0d8f2190f2') AND r.action = 'drain' AND r.cluster_id IN ('56d5d6f0-23e9-41b0-b407-852aa1026c2a', '681eb9e8-e9fd-4026-8ec6-64075b911d33') AND (r.answer ->> 'ok') = 'true' AND (r.answer -> 'detail' ->> 'drain_id') IS NOT NULL) AND (SELECT count(*) = 2 FROM public.lightning_cluster_drain d WHERE d.request_id IN ('9c321e6b-83a0-4548-8304-7f107c36a48c', '0492c919-d84a-404e-ab32-1f0d8f2190f2') AND d.cluster_id IN ('56d5d6f0-23e9-41b0-b407-852aa1026c2a', '681eb9e8-e9fd-4026-8ec6-64075b911d33') AND d.requested_by = '2d1cd6c3-5700-4af9-a271-d4863fdab20d')

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $stand_down$
DECLARE
  c_club  constant uuid := 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
  c_owner constant uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  c_games constant uuid[] := ARRAY[
    '56d5d6f0-23e9-41b0-b407-852aa1026c2a', -- NLH 0.01/0.02 Lightning Games (action)
    '681eb9e8-e9fd-4026-8ec6-64075b911d33'  -- NLH 0.02/0.04 Lightning Games (madness)
  ]::uuid[];
  c_requests constant uuid[] := ARRAY[
    '9c321e6b-83a0-4548-8304-7f107c36a48c',
    '0492c919-d84a-404e-ab32-1f0d8f2190f2'
  ]::uuid[];
  c_reason constant text :=
    'Owner order 2026-10-24: every game launches from Midway Union only; the Lightning Internal Pilot games stop and close. Drain through the normal path: let every dealing hand settle, keep every anchor and stack, revert to must-move.';
  v_me xid := pg_current_xact_id()::xid;
  v_n integer;
  v_answer jsonb;
  v_answers jsonb := '[]'::jsonb;
  k integer;
BEGIN
  -- THE EXACT PREIMAGE: these two games, in this club, live in Lightning,
  -- enabled, never closed, and no drain already open on either.
  SELECT count(*) INTO v_n FROM public.cash_games g
   WHERE g.id = ANY (c_games) AND g.club_id = c_club AND g.union_id IS NULL
     AND g.enabled AND g.closed_at IS NULL AND g.variant = 'nlh'
     AND g.template_name IN ('action', 'madness') AND g.lightning_enabled
     AND g.cluster_mode = 'lightning'
     AND NOT EXISTS (SELECT 1 FROM public.lightning_cluster_drain d
                      WHERE d.cluster_id = g.id AND d.completed_at IS NULL);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'expected the two live Lightning pilot games, found %', v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = c_club AND c.owner_id = c_owner) THEN
    RAISE EXCEPTION 'the Lightning Internal Pilot is no longer owned by %', c_owner;
  END IF;

  -- The operator door reads auth.uid(); act as the club owner for this
  -- transaction only, exactly as 20261015172330 did.
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', c_owner::text, 'role', 'authenticated')::text, true);

  FOR k IN 1 .. 2 LOOP
    v_answer := public.fn_lightning_operator_control(
      c_games[k], 'drain', c_reason, jsonb_build_object('request_id', c_requests[k]::text));
    IF coalesce((v_answer ->> 'ok')::boolean, false) IS NOT TRUE
       OR coalesce((v_answer ->> 'already')::boolean, false)
       OR (v_answer -> 'detail' ->> 'drain_id') IS NULL THEN
      RAISE EXCEPTION 'the operator door did not open a drain for %: %', c_games[k], v_answer;
    END IF;
    v_answers := v_answers || jsonb_build_array(jsonb_build_object(
      'game', c_games[k], 'drain_id', v_answer -> 'detail' ->> 'drain_id',
      'phase', v_answer -> 'detail' ->> 'phase',
      'hands_in_flight', v_answer -> 'detail' -> 'hands_in_flight',
      'pool_sessions_open', v_answer -> 'detail' -> 'pool_sessions_open',
      'deadline_at', v_answer -> 'detail' -> 'deadline_at'));
  END LOOP;

  PERFORM set_config('request.jwt.claims', '', true);

  -- WHAT THE DOOR WROTE: joins and formation stopped, Lightning off, the
  -- drain open in 'finishing'; the game itself still enabled and unclosed.
  SELECT count(*) INTO v_n FROM public.cash_games g
   WHERE g.id = ANY (c_games) AND g.cluster_mode = 'draining' AND NOT g.lightning_enabled
     AND g.enabled AND g.closed_at IS NULL;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'the two pilot games are not both draining (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.lightning_cluster_drain d
   WHERE d.cluster_id = ANY (c_games) AND d.completed_at IS NULL AND d.phase = 'finishing'
     AND d.request_id = ANY (c_requests) AND d.requested_by = c_owner;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'expected two open drains, found %', v_n;
  END IF;

  -- ONLY THESE TWO GAMES, AND NO MONEY. Read by this transaction's own id,
  -- so concurrent play elsewhere cannot fail or fake the check.
  IF EXISTS (SELECT 1 FROM public.cash_games WHERE xmin = v_me AND NOT (id = ANY (c_games))) THEN
    RAISE EXCEPTION 'a game outside the two pilot games changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_cluster_drain WHERE xmin = v_me AND NOT (cluster_id = ANY (c_games))) THEN
    RAISE EXCEPTION 'a drain outside the two pilot games was opened';
  END IF;
  -- Every wallet and every treasury on the platform; every live seat on the
  -- platform; every table and seat of the two games.
  IF EXISTS (SELECT 1 FROM public.club_members WHERE xmin = v_me)
     OR EXISTS (SELECT 1 FROM public.clubs WHERE xmin = v_me)
     OR EXISTS (SELECT 1 FROM public.table_seats WHERE left_at IS NULL AND xmin = v_me)
     OR EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = ANY (c_games) AND t.xmin = v_me)
     OR EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id = s.table_id
                 WHERE t.cluster_id = ANY (c_games) AND s.xmin = v_me) THEN
    RAISE EXCEPTION 'the drain wrote a wallet, treasury, seat or table row';
  END IF;

  RAISE NOTICE 'lightning pilot drains opened: %', v_answers;
END $stand_down$;

COMMIT;
