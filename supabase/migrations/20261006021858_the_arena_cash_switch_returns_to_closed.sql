-- ===========================================================================
--  THE ARENA CASH SWITCH RETURNS TO CLOSED
-- ===========================================================================
--
-- Poker Arena Diamond build programme, the release switch, corrective.
--
-- THE DECISION THIS RESTORES. Asked directly on 2026-10-05 how to open the
-- Diamond Arena, Dan chose "Tournaments only, now": tournaments open, cash
-- games closed. 20261005105457_the_arena_opens_its_tournaments.sql carried
-- that out, and asserted inside its own committed transaction that
-- cash_games_enabled was false both before and after it ran, so the column
-- was false at 19:14 UTC on 2026-10-05. It was read false repeatedly through
-- that evening, last at 00:40 UTC on 2026-10-06.
--
-- WHAT WAS FOUND. At 02:12 UTC on 2026-10-06 the column read true, and it
-- still read true when re-measured at 02:14 UTC before this file was written.
-- Nothing accounts for that. No authorisation was given. No migration did it:
-- no migration after 20261006004756 touches either switch by name, and of the
-- twelve live functions that mention public.ca_arena_settings, every one only
-- reads it - none contains a write of the table in its body.
--
-- THE ROUTE IS UNKNOWN. This is stated plainly rather than guessed, because
-- the estate has no way to answer it: the table carries no DML trigger, no
-- row-level policy, and no audit or history table anywhere records a change
-- to it. Its updated_at has read 2026-09-08 11:28:12 all day and did not move
-- when tournaments opened, so that column is not maintained and cannot date
-- the write either. Whoever or whatever set it true left no trace that this
-- estate can read. Closing the switch does not close that gap, and this
-- migration does not pretend to: the gap is reported separately, and what to
-- do about it is Dan's call, not this file's.
--
-- WHY AN OPEN CASH SWITCH IS WRONG EVEN ON ITS OWN TERMS. 20261005183028 is
-- applied, so the cash rake switch is on, and by that migration's deliberate
-- design a Diamond cash hand arriving without contributed, dealt_in and
-- hand_saw_flop in its stacks payload refuses by name. The engine does not
-- send those keys yet. Open cash therefore would not have dealt hands; it
-- would have refused them at the table.
--
-- WHAT WAS MEASURED BEFORE THIS RAN, read-only against production at 02:14 to
-- 02:16 UTC on 2026-10-06. Exposure on the 17 Diamond cash tables was zero:
-- no occupied seat, no hand dealt, no row in poker_diamond_hand_receipts, no
-- row in ca_diamond_rake_accrual. One seat had been taken and given up again
-- in the minute before the switch was first noticed - seat 1, a 400 stack,
-- joined 02:12:05 and left 02:13:05 - and it settled whole: the 400 was
-- reserved out of the player's wallet at 02:12:05 and released back to it at
-- 02:13:05, its custody row reads released with a zero balance, and no hand
-- was dealt, so no rake was owed and nothing is taken back from anyone. The
-- board was otherwise clean: no open critical Diamond incident, suspense
-- zero, the register and the supply equal.
--
-- WHAT THIS DOES. One UPDATE of one column of one row, closing cash and
-- leaving tournaments alone - they are legitimately open on Dan's decision
-- and players may be using them, so the pre-image requires them true and the
-- post-image requires them still true. If cash is already false when this
-- runs, because another hand closed it first, this says so and does nothing.
--
-- It defines no function, no trigger and no cron, and adds no watcher,
-- reconciler or repair loop: CLAUDE.md 10.11 and 10.12, and
-- tests/only-a-person-moves-the-arena-switches.law.test.ts, which admits
-- exactly this - a migration's own statement, run once when a person applies
-- it.
--
-- To open cash games, a forward migration sets the column true, once B4 to
-- B10 are answered and the engine sends the three stack keys. Do not edit
-- this file.
--
-- @live-proof: (SELECT cash_games_enabled FROM public.ca_arena_settings WHERE id = 1) = false
-- @live-proof: (SELECT tournaments_enabled FROM public.ca_arena_settings WHERE id = 1) = true
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $mig$
DECLARE
  v_cash_before  boolean;
  v_tourn_before boolean;
  v_cash_after   boolean;
  v_tourn_after  boolean;
  v_rows         integer;
BEGIN
  -- 1. PRE-IMAGE. The row is taken for update first, so nothing moves it
  --    between the read and the write.
  SELECT cash_games_enabled, tournaments_enabled
    INTO v_cash_before, v_tourn_before
    FROM public.ca_arena_settings WHERE id = 1 FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'the arena does not close: no settings row with id = 1';
  END IF;

  -- Already closed, by another hand or an earlier run of this file. Nothing
  -- to do, and that is not a failure.
  IF v_cash_before IS FALSE THEN
    RAISE NOTICE 'cash games are already closed; nothing to do';
    RETURN;
  END IF;

  -- Tournaments were opened by the decision of 2026-10-05 and this file must
  -- not disturb them. If they are not open, the board has moved in some
  -- further way that nobody expected, and closing cash alone would be a
  -- half-measure on an unknown state. Refuse and let a person look.
  IF v_tourn_before IS NOT TRUE THEN
    RAISE EXCEPTION 'the arena does not close: tournaments read % before the update and the decision of 2026-10-05 is tournaments open, cash closed; refusing to act on a board nobody has looked at', v_tourn_before;
  END IF;

  -- 2. THE SWITCH. One row, one column.
  UPDATE public.ca_arena_settings
     SET cash_games_enabled = false
   WHERE id = 1 AND cash_games_enabled IS NOT FALSE;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'the arena does not close: expected to move exactly 1 settings row, moved %', v_rows;
  END IF;

  -- 3. POST-IMAGE. Cash shut, tournaments untouched, and still one row.
  SELECT cash_games_enabled, tournaments_enabled
    INTO v_cash_after, v_tourn_after
    FROM public.ca_arena_settings WHERE id = 1;

  IF v_cash_after IS NOT FALSE THEN
    RAISE EXCEPTION 'the arena does not close: cash reads % after the update and must be false', v_cash_after;
  END IF;
  IF v_tourn_after IS NOT TRUE THEN
    RAISE EXCEPTION 'the arena does not close: tournaments read % after the update and must still be true', v_tourn_after;
  END IF;
  IF (SELECT count(*) FROM public.ca_arena_settings) <> 1 THEN
    RAISE EXCEPTION 'the arena does not close: the settings table holds other than one row';
  END IF;

  RAISE NOTICE 'Diamond Arena cash games are closed again, on the decision of 2026-10-05. Tournaments stay open. The route by which the switch opened is unknown and is reported, not guessed.';
END
$mig$;

COMMIT;
