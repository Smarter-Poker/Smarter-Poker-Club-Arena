-- ============================================================================
-- 20260824020100_a_zero_chip_field_is_never_a_result.sql
-- TIER: 2 | AFFECTS: new fn_refuse_zero_chip_field_elimination + a BEFORE
--                    UPDATE trigger on tournament_players.
--
-- SOURCE-CONTROL NOTE: applied directly to production 2026-08-24 to stop an
-- active money-integrity bug. This file is the missing source of truth for
-- what is already running; applying it is a no-op.
--
-- WHAT HAPPENED
--
-- A Spin seats its field as reservations at stack 0 and credits the real
-- stacks after the wheel. The elimination sweep runs every 5 seconds and did
-- not wait: it synced table_seats.stack (still 0) into
-- tournament_players.chips, selected every 'playing' row with chips <= 0 - the
-- ENTIRE field - spared an arbitrary "top" stack of zero, eliminated the rest
-- and paid that player first prize. Buy-ins collected, prize paid, not one
-- card dealt. Measured 2026-08-23: 276 of the last 278 completed Spins had
-- ZERO rows in hand_history.
--
-- THE INVARIANT
--
-- Chips are conserved. Every chip one player loses another gains, so the sum
-- of live stacks is constant and cannot be zero while anybody is still
-- playing. "Every remaining player is at <= 0" is not a state poker can
-- produce - it means the stacks were never written.
--
-- HOW IT REFUSES, AND WHY THAT SHAPE
--
-- By CANCELLING the row update (RETURN NULL), not by raising.
-- TournamentManagerEliminations.eliminatePlayer updates the row FIRST and
-- returns early when the update matches nothing:
--
--     if (updateErr || (updateCount !== null && updateCount === 0)) return;
--
-- and the prize credit sits BELOW that line. So a cancelled elimination costs
-- nothing, pays nothing, logs no error, and is retried on the next sweep - by
-- which time fn_credit_stalled_seat_first_stacks has funded the table.
--
-- Deliberately NOT restricted to spins: an uncredited field is wrong in every
-- format, and this is the last line before money moves.
--
-- PROVEN, both directions, in a rolled-back probe against production:
--   all-zero field          -> rows eliminated = 0  (refused)
--   one funded rival        -> rows eliminated = 1  (normal bust allowed)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_refuse_zero_chip_field_elimination()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_live int;
  v_zero int;
BEGIN
  -- Only a transition INTO elimination, from a live seat, at zero chips.
  IF NEW.status <> 'eliminated' OR OLD.status <> 'playing' THEN
    RETURN NEW;
  END IF;
  IF COALESCE(OLD.chips, 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE COALESCE(chips, 0) <= 0)
    INTO v_live, v_zero
    FROM public.tournament_players
   WHERE tournament_id = NEW.tournament_id
     AND status = 'playing';

  -- More than one player left and NONE has a chip: the table is uncredited.
  -- At exactly one remaining player this is the legitimate "everybody busted
  -- in the same hand" tail, which the engine resolves by naming the last one
  -- out the winner - leave that alone.
  IF v_live > 1 AND v_zero = v_live THEN
    RAISE WARNING
      'refused elimination in %: all % live player(s) read 0 chips - uncredited stacks, not a bust',
      NEW.tournament_id, v_live;
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_refuse_zero_chip_field_elimination ON public.tournament_players;
CREATE TRIGGER trg_refuse_zero_chip_field_elimination
  BEFORE UPDATE ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_zero_chip_field_elimination();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournament_players'::regclass
       AND tgname = 'trg_refuse_zero_chip_field_elimination' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_refuse_zero_chip_field_elimination was not created';
  END IF;
END $$;
