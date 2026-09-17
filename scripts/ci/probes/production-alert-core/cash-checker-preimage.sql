-- Fixture-only missing source leaf. Exact captured checker; no rewritten business body.
-- The caller has admitted the existing owned full notification/core fixture.
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()!~'^qual_owner_notify_[0-9a-f]{32}$'
   OR current_setting('cash_connected.execution_uuid',true) IS NULL
   OR to_regprocedure('public.fn_cash_pot_conservation_check(integer)') IS NOT NULL
 THEN RAISE EXCEPTION 'cash connected checker leaf requires exact fresh owned fixture'; END IF;
END $$;
-- The full schema capture omitted this existing production index. Restore its
-- exact catalog definition inside the admitted disposable fixture only.
CREATE INDEX idx_hand_history_created ON public.hand_history USING btree (created_at DESC);
CREATE OR REPLACE FUNCTION public.fn_cash_pot_conservation_check(p_since_hours integer DEFAULT 24)
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
$function$
;
ALTER FUNCTION public.fn_cash_pot_conservation_check(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_cash_pot_conservation_check(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cash_pot_conservation_check(integer) TO service_role;
