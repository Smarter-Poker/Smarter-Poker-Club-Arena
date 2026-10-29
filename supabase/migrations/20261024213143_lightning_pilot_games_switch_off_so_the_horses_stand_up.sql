-- SUPERSEDED BY 20261025025922: never installed; refused twice after ~8.1 s when fn_cash_game_switch_off's replay lookup read 1.2 M cluster events.
-- @live-proof: (SELECT count(*) = 2 FROM public.cash_games g WHERE g.id IN ('56d5d6f0-23e9-41b0-b407-852aa1026c2a', '681eb9e8-e9fd-4026-8ec6-64075b911d33') AND NOT g.enabled AND NOT g.lightning_enabled) AND (SELECT count(*) = 2 FROM public.cash_cluster_events e WHERE e.kind = 'game_switched_off_by_owner' AND e.request_id IN ('5b0f8f3e-6a7c-4a9e-9d51-2c4b7e1f0a11', 'c3e2d7a9-1f84-4b6d-8a2e-9b7c5d0e4f22'))
-- 20261024213143_lightning_pilot_games_switch_off_so_the_horses_stand_up.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- OWNER ORDER. Dan, 2026-10-24: "Two horses-only Lightning games are still
-- running in the old 'Lightning Internal Pilot' club, not Midway: NLH
-- 0.01/0.02 and NLH 0.02/0.04 ... FINISH THIS UP." Every game launches from
-- Midway Union only (20261024053530).
--
-- STEP 2 OF 3. 20261024201850 drained both games through the operator door;
-- the drive reverted each to must_move with every horse still on its anchor
-- seat and stack. This switches each game off through the owner's own door,
-- fn_cash_game_switch_off, as the club owner. That door writes enabled=false
-- and its audit event; it moves no chip and no seat. The live engine's horse
-- rotator then stands each horse up at the end of its hand through the
-- ordinary per-seat cash-out into its own club wallet, exactly as a person
-- leaving a switched-off game (#7841), and fn_cash_cluster_tick closes each
-- table once it is empty. Measured on 2026-10-24 05:04 UTC for game e48072d8:
-- 19 horses left within 30 s, every one with a credited cash-out receipt equal
-- to its stack.
--
-- IDENTITY. fn_cash_game_switch_off checks auth.uid() and a live session.
-- Claims carry only sub (no role), which fn_caller_session_is_live treats as
-- the trusted migration context; an 'authenticated' role claim is refused with
-- SESSION_REVOKED (measured in a rolled-back probe). Each game has one stable
-- request id, so a replay is answered by the door instead of acting twice.
--
-- REFUSES WHOLE unless both drains are complete and both games read must_move
-- with Lightning off and still enabled. Asserted after: both games off, and -
-- by this transaction's own xid - no other game, no wallet, no treasury, no
-- seat and no table was written.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $switch_off$
DECLARE
  c_club  constant uuid := 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
  c_owner constant uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  c_games constant uuid[] := ARRAY[
    '56d5d6f0-23e9-41b0-b407-852aa1026c2a', -- NLH 0.01/0.02 Lightning Games
    '681eb9e8-e9fd-4026-8ec6-64075b911d33'  -- NLH 0.02/0.04 Lightning Games
  ]::uuid[];
  c_requests constant uuid[] := ARRAY[
    '5b0f8f3e-6a7c-4a9e-9d51-2c4b7e1f0a11',
    'c3e2d7a9-1f84-4b6d-8a2e-9b7c5d0e4f22'
  ]::uuid[];
  c_reason constant text :=
    'Owner order 2026-10-24: every game launches from Midway Union only; the Lightning Internal Pilot games stop and close. Switched off after the operator drain; players leave through the normal cash-out.';
  v_me xid := pg_current_xact_id()::xid;
  v_n integer;
  v_answer jsonb;
  k integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.cash_games g
   WHERE g.id = ANY (c_games) AND g.club_id = c_club AND g.enabled AND g.closed_at IS NULL
     AND NOT coalesce(g.lightning_enabled, false) AND g.cluster_mode = 'must_move'
     AND EXISTS (SELECT 1 FROM public.lightning_cluster_drain d
                  WHERE d.cluster_id = g.id
                    AND d.request_id IN ('9c321e6b-83a0-4548-8304-7f107c36a48c', '0492c919-d84a-404e-ab32-1f0d8f2190f2')
                    AND d.completed_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM public.lightning_cluster_drain d
                      WHERE d.cluster_id = g.id AND d.completed_at IS NULL);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'expected both pilot games drained to must_move and still enabled, found %', v_n;
  END IF;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', c_owner::text)::text, true);
  FOR k IN 1 .. 2 LOOP
    v_answer := public.fn_cash_game_switch_off(c_games[k], c_requests[k], c_reason);
    IF coalesce((v_answer ->> 'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'the owner door refused to switch off %: %', c_games[k], v_answer;
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', '', true);

  SELECT count(*) INTO v_n FROM public.cash_games g
   WHERE g.id = ANY (c_games) AND NOT g.enabled AND g.closed_at IS NULL;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'the two pilot games are not both switched off (%)', v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_games WHERE xmin = v_me AND NOT (id = ANY (c_games))) THEN
    RAISE EXCEPTION 'a game outside the two pilot games changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.club_members WHERE xmin = v_me)
     OR EXISTS (SELECT 1 FROM public.clubs WHERE xmin = v_me)
     OR EXISTS (SELECT 1 FROM public.table_seats WHERE left_at IS NULL AND xmin = v_me)
     OR EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = ANY (c_games) AND t.xmin = v_me) THEN
    RAISE EXCEPTION 'the switch-off wrote a wallet, treasury, seat or table row';
  END IF;
END $switch_off$;

COMMIT;
