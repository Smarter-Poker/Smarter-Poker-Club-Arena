-- ═══════════════════════════════════════════════════════════════════════════
--  A CASH POT REACHES A PLAYER OR IT IS A BUG (2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The tournament side of this audit ends with fn_payout_guarantee_check asking
-- every hour whether an MTT, Spin or Heads-Up paid everyone who earned. The
-- cash side had one half of that question answered and one half unasked.
--
-- ANSWERED. Chips leaving the felt: the 2026-08-25 trigger writes every exit of
-- a non-zero stack to ca_seat_stack_exits and fn_unaccounted_seat_exits() lists
-- the ones with no matching wallet credit. Measured 2026-09-01: ZERO.
--
-- UNASKED, until now. Chips leaving a POT. Nothing checked that what came out
-- of a pot equals what went into it. Measured over the three days to
-- 2026-09-01, 159,695 cash hands: 0 mismatches, and 2 hands totalling 0.40 in
-- pots with 0.04 of rake taken and no winner recorded at all, both on
-- 2026-08-30, none since. So the surface is healthy - and it was healthy
-- unobserved, which is the same position the vacant finishing places were in
-- for ten weeks.
--
-- THE INVARIANT. For a completed cash hand:
--
--     pot_size = rake_amount + bbj_amount + sum(winners[].amount)
--
-- Anything else means chips entered a pot and did not come out to a player, or
-- came out twice. It reports; it moves no money.
--
-- WHY A SEPARATE FUNCTION. Cash hands arrive at ~53,000 a day against ~1,500
-- tournaments, so this wants its own window and its own cadence, and mixing it
-- into the tournament check would make one slow query out of two fast ones.
--
-- APPLIED AS THREE MIGRATIONS, and this file is the union of them. Both later
-- ones were corrections the check earned by being run:
--   20260901190656  a_cash_pot_reaches_a_player_or_it_is_a_bug
--   20260901190917  a_no_winner_hand_that_owes_nobody_is_not_an_alert
--   20260901192531  the_cash_pot_check_is_bounded_at_forty_eight_hours
-- The function body here was then checked against production rather than
-- assumed - md5 of pg_proc.prosrc against md5 of the body in this file,
-- 2026-09-01: 0e3898647e1fb5b4bcac56077d06b3a5, 5111 bytes.
--
-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.fn_cash_pot_conservation_check(integer);

CREATE OR REPLACE FUNCTION public.fn_cash_pot_conservation_check(
  p_since_hours integer DEFAULT 24
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  /* BOUNDED AT 48 HOURS, MEASURED (2026-09-01, and the ceiling was 720 for
     about an hour before this).

     Cash hands arrive at roughly 59,000 a day and the per-row cost is a
     jsonb_array_elements sum over `winners`. A 24-hour window reads 58,932
     rows and returns comfortably. A 168-hour window read 463,506 rows and
     returned once, then hit the statement timeout on the very next call an
     hour later when the database was busier - which is the shape of every
     check on this platform that quietly stopped working. fn_spin_unpaid_check
     learned the same lesson the same way ("it read the unbounded view three
     times and timed out every call before 2026-08-31").

     48 hours is double what the engine asks for and still half of what has
     been seen to fail. An operator who wants a week walks it two days at a
     time; a check that cannot finish tells nobody anything. */
  v_hours   integer := LEAST(GREATEST(COALESCE(p_since_hours, 24), 1), 48);
  v_since   timestamptz;
  v_hands   bigint := 0;
  v_bad     bigint := 0;
  v_chips   numeric := 0;
  v_nowin   bigint := 0;
  v_nowin_chips numeric := 0;
  v_alerts  integer := 0;
BEGIN
  v_since := now() - make_interval(hours => v_hours);

  WITH h AS (
    SELECT hh.id, hh.table_id, hh.created_at,
           COALESCE(hh.pot_size, 0)    AS pot,
           COALESCE(hh.rake_amount, 0) AS rake,
           COALESCE(hh.bbj_amount, 0)  AS bbj,
           COALESCE((SELECT sum((e->>'amount')::numeric)
                       FROM jsonb_array_elements(
                         CASE WHEN jsonb_typeof(hh.winners) = 'array'
                              THEN hh.winners ELSE '[]'::jsonb END) e
                      WHERE e ? 'amount'), 0) AS awarded,
           COALESCE(jsonb_array_length(
             CASE WHEN jsonb_typeof(hh.winners) = 'array'
                  THEN hh.winners ELSE '[]'::jsonb END), 0) AS winner_count
      FROM public.hand_history hh
     WHERE hh.tournament_id IS NULL
       AND hh.created_at >= v_since
       AND COALESCE(hh.pot_size, 0) > 0
  )
  SELECT count(*),
         count(*) FILTER (WHERE winner_count > 0 AND abs(pot - rake - bbj - awarded) > 0.01),
         COALESCE(round(sum(abs(pot - rake - bbj - awarded))
                        FILTER (WHERE winner_count > 0
                                  AND abs(pot - rake - bbj - awarded) > 0.01), 2), 0),
         /* A HAND WITH NO WINNER IS NOT AUTOMATICALLY A HAND WITH A PROBLEM
            (2026-09-01, corrected on the first live run). Both hands this
            found - 86ff9441 and 139babb2, 2026-08-30 - had their whole pot
            after rake go to the Bad Beat Jackpot: pot 0.30, rake 0.03, bbj
            0.27, undistributed 0.00. Nobody was owed anything and there was
            nothing wrong. Only a no-winner hand that still HOLDS chips is
            worth an alert. */
         count(*) FILTER (WHERE winner_count = 0 AND pot - rake - bbj > 0.01),
         COALESCE(round(sum(pot - rake - bbj)
                        FILTER (WHERE winner_count = 0 AND pot - rake - bbj > 0.01), 2), 0)
    INTO v_hands, v_bad, v_chips, v_nowin, v_nowin_chips
    FROM h;

  /* One OPEN alert per condition, refreshed by resolving it. A per-hand alert
     would file thousands of rows on a bad day and bury itself, which is the
     failure 20260901170000 exists to stop. */
  IF v_bad > 0 THEN
    PERFORM public.fn_raise_server_financial_alert(
      'critical', 'fn_cash_pot_conservation_check',
      format('%s cash hand(s) in the last %sh did not distribute their pot: %s chips entered pots and did not come out to a player or the rake',
             v_bad, v_hours, v_chips),
      jsonb_build_object('kind','pot_not_distributed','hands',v_bad,
        'chips',v_chips,'since_hours',v_hours,'hands_checked',v_hands,
        'detail','no money was moved by this check'),
      'pot_not_distributed');
    v_alerts := v_alerts + 1;
  END IF;

  IF v_nowin > 0 THEN
    PERFORM public.fn_raise_server_financial_alert(
      'warning', 'fn_cash_pot_conservation_check',
      format('%s cash hand(s) in the last %sh recorded no winner at all while still holding %s chips after rake and jackpot',
             v_nowin, v_hours, v_nowin_chips),
      jsonb_build_object('kind','no_winner_recorded','hands',v_nowin,
        'chips',v_nowin_chips,'since_hours',v_hours,
        'detail','a hand whose whole pot goes to the jackpot has no winner and owes nobody; this counts only the ones still holding chips'),
      'no_winner_recorded');
    v_alerts := v_alerts + 1;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'since_hours', v_hours,
    'hands_checked', v_hands,
    'pot_not_distributed', v_bad,
    'pot_not_distributed_chips', v_chips,
    'no_winner_recorded', v_nowin,
    'no_winner_recorded_chips', v_nowin_chips,
    -- NOT "alerts_raised": the dedupe path returns an existing row's id, so a
    -- standing condition reports itself on every pass without a new row being
    -- written. This counts CONDITIONS that are open, which is what it means.
    'conditions_alerted', v_alerts);
END;
$function$;

COMMENT ON FUNCTION public.fn_cash_pot_conservation_check(integer) IS
  'Asks of every completed cash hand whether pot_size equals rake + bbj + what the winners were awarded. The one money surface on the platform that nothing was watching. Reports through the deduped alert path and moves no money.';

REVOKE ALL ON FUNCTION public.fn_cash_pot_conservation_check(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_pot_conservation_check(integer) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_cash_pot_conservation_check') THEN
    RAISE EXCEPTION 'fn_cash_pot_conservation_check was not created';
  END IF;
END $$;
