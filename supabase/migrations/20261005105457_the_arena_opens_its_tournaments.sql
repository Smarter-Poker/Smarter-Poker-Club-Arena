-- ===========================================================================
--  THE ARENA OPENS ITS TOURNAMENTS
-- ===========================================================================
--
-- Poker Arena Diamond build programme, the release switch. Dan's decision,
-- taken 2026-10-04: open tournaments now, leave cash games closed.
--
-- WHY ONLY ONE OF THE TWO SWITCHES. The two paths are not equally ready, and
-- the difference is money, not code quality.
--
--   Tournaments have a working fee. The Diamond entry fee runs today: 10
--   percent of the total entry, 5 percent when the field is capped at two
--   players, floored to whole Diamonds, and it reaches the house at settlement
--   through fn_poker_diamond_tournament_settle_fee, which returns early on an
--   existing poker-tournament-fee:<id> ledger key so a replay banks nothing
--   twice. Question B1 of docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md asks
--   only whether that inherited rate is the approved one. Opening tournaments
--   therefore loses nothing while the answer is outstanding.
--
--   Cash games have no rake at all. None is taken today and six layers refuse
--   it (that design, section 2.4). Questions B4 to B10 - whether rake is taken,
--   the percentage per stake, the cap, the short-handed rules, whether a
--   pre-flop hand is raked, the smallest raked pot and the rounding direction -
--   are unanswered, so every Diamond cash hand played now would be raked at
--   zero. A settled hand cannot be raked afterwards and ruling 10.9 forbids
--   taking anything back from a player, so that revenue would be unrecoverable.
--   cash_games_enabled therefore stays false and this migration asserts it.
--
-- WHAT OPENING ADMITS, read from production 2026-10-05. No Diamond tournament
-- has ever existed (0 rows), so nothing starts by itself: this lets staff
-- create the first one deliberately. A guarantee, a promised satellite seat,
-- a freeroll and a promotional entry stay refused by name pending A1 to A20,
-- and horses are not refused - the "diamond horse funding not open" message is
-- gone from every function body, so CLAUDE.md 10.5 holds on this path.
--
-- WHAT THIS REFUSES. The release gate is re-read here rather than trusted, so
-- the switch cannot open on a board that moved since the decision: no open
-- critical Diamond incident, suspense zero, the register and the supply equal,
-- and cash still closed. Any one of those aborts the whole transaction.
--
-- This is one UPDATE of one row. It defines no function, no trigger and no
-- cron, so tests/only-a-person-moves-the-arena-switches.law.test.ts is
-- satisfied: that law refuses automatic switching and admits exactly this, a
-- migration statement that runs once when a person applies it.
--
-- To close tournaments again, a forward migration sets the column false. Do
-- not edit this file.
--
-- @live-proof: (SELECT tournaments_enabled FROM public.ca_arena_settings WHERE id = 1) = true
-- @live-proof: (SELECT cash_games_enabled FROM public.ca_arena_settings WHERE id = 1) = false
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $mig$
DECLARE
  v_open_critical integer;
  v_suspense      numeric;
  v_register_diff numeric;
  v_cash          boolean;
  v_tourn_before  boolean;
  v_tourn_after   boolean;
  v_rows          integer;
BEGIN
  -- 0. THE GATE, RE-READ. Not trusted from the decision; read here.
  SELECT count(*) INTO v_open_critical
    FROM public.ca_diamond_incidents
   WHERE severity = 'critical' AND resolved_at IS NULL;
  IF v_open_critical <> 0 THEN
    RAISE EXCEPTION 'the arena does not open: % open critical Diamond incident(s)', v_open_critical;
  END IF;

  SELECT balance_now INTO v_suspense
    FROM public.fn_ca_diamond_trial_balance() WHERE account = 'suspense';
  IF COALESCE(v_suspense, -1) <> 0 THEN
    RAISE EXCEPTION 'the arena does not open: suspense reads %, not zero', v_suspense;
  END IF;

  SELECT difference INTO v_register_diff FROM public.fn_ca_diamond_register_vs_supply();
  IF COALESCE(v_register_diff, -1) <> 0 THEN
    RAISE EXCEPTION 'the arena does not open: the register and the supply differ by %', v_register_diff;
  END IF;

  SELECT cash_games_enabled, tournaments_enabled
    INTO v_cash, v_tourn_before
    FROM public.ca_arena_settings WHERE id = 1 FOR UPDATE;
  IF v_cash IS NOT FALSE THEN
    RAISE EXCEPTION 'the arena does not open: cash_games_enabled is already %, and this migration opens tournaments only', v_cash;
  END IF;
  IF v_tourn_before IS TRUE THEN
    RAISE NOTICE 'tournaments_enabled is already true; nothing to do';
    RETURN;
  END IF;

  -- 1. THE SWITCH. One row, one column.
  UPDATE public.ca_arena_settings
     SET tournaments_enabled = true
   WHERE id = 1 AND tournaments_enabled IS NOT TRUE;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'the arena does not open: expected to move exactly 1 settings row, moved %', v_rows;
  END IF;

  -- 2. POST-IMAGE. Tournaments open, cash still shut, and nothing else moved.
  SELECT cash_games_enabled, tournaments_enabled
    INTO v_cash, v_tourn_after
    FROM public.ca_arena_settings WHERE id = 1;
  IF v_tourn_after IS NOT TRUE THEN
    RAISE EXCEPTION 'the arena does not open: tournaments_enabled reads % after the update', v_tourn_after;
  END IF;
  IF v_cash IS NOT FALSE THEN
    RAISE EXCEPTION 'the arena does not open: cash_games_enabled reads % after the update and must stay false', v_cash;
  END IF;
  IF (SELECT count(*) FROM public.ca_arena_settings) <> 1 THEN
    RAISE EXCEPTION 'the arena does not open: ca_arena_settings holds other than one row';
  END IF;

  RAISE NOTICE 'Diamond Arena tournaments are open. cash_games_enabled stays false pending B4 to B10.';
END
$mig$;

COMMIT;
