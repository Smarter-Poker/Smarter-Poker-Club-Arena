-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260824031735 "credit_stalled_seat_first_stacks"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8f66b21576a145becee228f9151e40de of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- THE CHIPS MUST ARRIVE, EVEN IF THE TIMER DOES NOT (2026-08-24)
--
-- WHAT WAS MEASURED
--
-- Spins stopped dealing at 2026-08-23 04:00-05:00 UTC and never resumed.
-- 04:00 UTC: 64 of 106 spins dealt. 05:00 UTC onward: 0. In the six hours
-- before this migration, 433 spins started and 0 dealt a single hand.
--
-- A controlled comparison names the cause. Heads-up SNGs take the IDENTICAL
-- seat-first path (fn_take_seat_and_buy_in, a pre-created open-seat table,
-- reservations at stack 0) and dealt 234 of 251 in the same window. The only
-- branch that separates them is in TournamentManagerBase.start():
--
--     if (!(await this.deferStacksForSpinReveal(tournament))) {
--       await this.creditSeatStacks(tournament);
--     }
--
-- A heads-up game is credited synchronously and deals. A Spin defers the
-- credit to a setTimeout ~16.6s out (the wheel must land before stacks appear)
-- guarded by `stillLive() = isRunning() && tableEngines.size > 0`. When that
-- timer does not deliver, NOTHING retries: seats stay at stack 0,
-- ServerTableEngineDealing's `activePlayers` filter requires `p.stack > 0`, so
-- the table can never find two funded players and idles forever at
-- 'idle_not_enough_players'. The engine is alive - it just has nothing to deal.
--
-- WHAT THIS DOES
--
-- The safety net the deferral always needed. Any RUNNING tournament that is
-- past the reveal window, has never dealt a hand, and whose every live seat
-- still reads zero, gets the stack it was always going to get.
--
-- WHY IT CANNOT TAKE MONEY FROM ANYBODY
--
--   * `no hands` - it never touches a game that has played.
--   * `every live seat <= 0` - there is no stack to disturb; it cannot lower
--     one, only raise it to the tournament's own starting_chips.
--   * 60s floor - comfortably past spinRevealToDealMs() (~16.6s), so it can
--     never front-run the wheel and put chips on the felt mid-reveal.
--   * starting_chips > 0 and at least one live seat - a misconfigured or empty
--     tournament is left alone.
--
-- It is idempotent by construction: once credited, `stack <= 0` is false and
-- the next pass skips the tournament entirely.
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
       -- Never touch a game that has actually played.
       AND NOT EXISTS (
         SELECT 1 FROM public.tables tb
          JOIN public.hand_history hh ON hh.table_id = tb.id
          WHERE tb.tournament_id = t.id
       )
       -- At least one live seat ...
       AND EXISTS (
         SELECT 1 FROM public.table_seats s
          JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = t.id AND s.left_at IS NULL
       )
       -- ... and every one of them is still a zero-chip reservation.
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
