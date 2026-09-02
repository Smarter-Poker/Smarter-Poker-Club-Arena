-- ============================================================================
-- 20260824020000_spins_deal_again.sql
-- TIER: 2 | AFFECTS: new fn_credit_stalled_seat_first_stacks + a per-minute
--                    cron job. No schema change.
--
-- SOURCE-CONTROL NOTE: this function and its job were applied directly to
-- production on 2026-08-24 to stop an active outage. This file is the missing
-- source of truth for what is already running; applying it is a no-op.
--
-- WHAT WAS MEASURED
--
-- Spins stopped dealing at 2026-08-23 04:00-05:00 UTC and did not resume.
-- 04:00 UTC: 64 of 106 dealt. 05:00 onward: 0. In the six hours before this
-- landed, 433 spins started and ZERO dealt a hand - buy-ins collected, prizes
-- paid, no poker played.
--
-- THE CAUSE, BY CONTROLLED COMPARISON
--
-- Heads-up SNGs take the IDENTICAL seat-first path (fn_take_seat_and_buy_in, a
-- pre-created open-seat table, reservations at stack 0) and dealt 234 of 251
-- in the same window. The only branch separating them is in
-- TournamentManagerBase.start():
--
--     if (!(await this.deferStacksForSpinReveal(tournament))) {
--       await this.creditSeatStacks(tournament);
--     }
--
-- A heads-up game is credited synchronously and deals. A Spin defers the
-- credit to a setTimeout ~16.6s out (the wheel must land before stacks
-- appear), guarded by `stillLive() = isRunning() && tableEngines.size > 0`.
-- When that timer does not deliver, NOTHING retries. Seats stay at stack 0,
-- ServerTableEngineDealing's `activePlayers` filter requires `p.stack > 0`, so
-- the table can never find two funded players and idles forever at
-- 'idle_not_enough_players'. The engine is alive; it has nothing to deal.
--
-- WHY IT CANNOT TAKE MONEY FROM ANYBODY
--
--   * no hands       - it never touches a game that has played.
--   * all seats <= 0 - there is no stack to disturb; it only ever RAISES to
--                      the tournament's own starting_chips.
--   * 60s floor      - comfortably past spinRevealToDealMs() (~16.6s), so it
--                      can never front-run the wheel.
--   * needs >=1 live seat and starting_chips > 0.
--
-- Idempotent: once credited, `stack <= 0` is false and the next pass skips.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_credit_stalled_seat_first_stacks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_t record;
  v_fixed int := 0;
BEGIN
  FOR v_t IN
    SELECT t.id, t.starting_chips
      FROM public.tournaments t
     WHERE t.status = 'RUNNING'
       AND COALESCE(t.starting_chips, 0) > 0
       AND t.started_at IS NOT NULL
       AND t.started_at < now() - interval '60 seconds'
       AND NOT EXISTS (
         SELECT 1 FROM public.tables tb
          JOIN public.hand_history hh ON hh.table_id = tb.id
          WHERE tb.tournament_id = t.id
       )
       AND EXISTS (
         SELECT 1 FROM public.table_seats s
          JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = t.id AND s.left_at IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.table_seats s
          JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = t.id AND s.left_at IS NULL
            AND COALESCE(s.stack, 0) > 0
       )
     FOR UPDATE OF t SKIP LOCKED
  LOOP
    UPDATE public.table_seats s
       SET stack = v_t.starting_chips
      FROM public.tables tb
     WHERE tb.id = s.table_id
       AND tb.tournament_id = v_t.id
       AND s.left_at IS NULL
       AND COALESCE(s.stack, 0) < v_t.starting_chips;

    UPDATE public.tournament_players tp
       SET chips = v_t.starting_chips
     WHERE tp.tournament_id = v_t.id
       AND tp.status IN ('playing', 'registered')
       AND COALESCE(tp.chips, 0) < v_t.starting_chips;

    v_fixed := v_fixed + 1;
    RAISE WARNING 'credited stalled seat-first tournament % to % chips', v_t.id, v_t.starting_chips;
  END LOOP;

  RETURN v_fixed;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_credit_stalled_seat_first_stacks() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_credit_stalled_seat_first_stacks() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_credit_stalled_seat_first_stacks() TO service_role;

-- Per-minute safety net, advisory-locked like every other job in this database.
DO $$
BEGIN
  PERFORM cron.unschedule('credit-stalled-seat-first-stacks');
EXCEPTION WHEN OTHERS THEN
  NULL; -- not scheduled yet
END $$;

SELECT cron.schedule(
  'credit-stalled-seat-first-stacks',
  '* * * * *',
  $job$
  select case
           when pg_try_advisory_lock(hashtext('credit-stalled-seat-first-stacks'))
           then (select public.fn_credit_stalled_seat_first_stacks())
           else -1
         end;
  $job$
);
