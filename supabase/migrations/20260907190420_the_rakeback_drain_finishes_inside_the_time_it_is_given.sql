-- THE RAKEBACK DRAIN FINISHES INSIDE THE TIME IT IS GIVEN
-- =============================================================================
-- PHASE 5 of 8, part 2: the drain, the admin path, and the report.
--
-- Part 1 made one period cheap and correct. This makes the loop around it stop
-- before the database does.
--
-- THE NUMBER THAT MATTERS: service_role carries statement_timeout = 8s, and
-- every server-side caller - the Monday Open Claw cron, the engine's
-- RakebackSettlerService, the browser FinancialCronService - authenticates as
-- service_role. An unbounded loop over 1,769 periods was never going to
-- return; it was going to be cancelled, and it was, every Monday, as an
-- http_500 that nothing paged on.
--
-- So the worker takes a period cap AND a wall-clock budget, and reports what
-- it did not get to. A caller drains by calling it again, which is what a
-- backlog wants anyway: progress that survives being interrupted.
--
-- IT WARMS THE ROLLUP FIRST. 77 club-days in the current backlog have never
-- been rolled up (they pre-date the rollup, which began 2026-08-31), and a
-- period over an uncomputed day takes the slow path at ~2.6s. Computing the
-- day costs ~4.9s ONCE for every player in it - 463 players on the heaviest -
-- so the batch computes missing days first, inside its own share of the
-- budget, and every period after that is an indexed sum.
--
-- THE SIGNATURE DOES NOT CHANGE. settle_club_rakeback(uuid) keeps its exact
-- shape and becomes a thin call into the bounded worker, so all three existing
-- callers become bounded without being touched and no PostgREST overload is
-- created.
--
-- AND THE ADMIN BUTTON STARTS WORKING. fn_run_pending_rakeback_settlement
-- gates on an admin profile and then called a function that accepted only the
-- engine or the club OWNER. A platform admin owns no clubs, so Settle Now has
-- always returned success:true with clubs_processed:0. The worker accepts a
-- platform admin now, which is the authority the outer function already
-- demanded.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_settle_club_rakeback_batch(
  p_club_id uuid,
  p_max_periods integer DEFAULT 40,
  p_budget_seconds numeric DEFAULT 5.0,
  p_max_warm_days integer DEFAULT 2)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_period     record;
  v_day        record;
  v_res        jsonb;
  v_settled    int := 0;
  v_deferred   int := 0;
  v_warmed     int := 0;
  v_total      numeric := 0;
  v_reasons    jsonb := '{}'::jsonb;
  v_reason     text;
  v_remaining  int;
  v_budget     numeric;
  v_elapsed    numeric;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_club_id required');
  END IF;

  -- The engine and every server-side job, the club's own owner, or a platform
  -- admin. The admin arm is what fn_run_pending_rakeback_settlement always
  -- believed it had.
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL
          OR (NOT public.fn_is_platform_admin()
              AND NOT EXISTS (SELECT 1 FROM public.clubs c
                               WHERE c.id = p_club_id AND c.owner_id = auth.uid()))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorised');
  END IF;

  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
      'periods_settled', 0, 'total_payout', 0, 'deferred', 0,
      'note', 'platform_frozen', 'clock_ran_out', false);
  END IF;

  v_budget := GREATEST(COALESCE(p_budget_seconds, 5.0), 0.5);
  IF p_max_periods IS NULL OR p_max_periods < 1 THEN p_max_periods := 40; END IF;

  -- 1. WARM THE ROLLUP for days this club's pending periods cover and that
  --    have never been computed. One day serves every player in it.
  FOR v_day IN
    SELECT DISTINCT d::date AS day
      FROM public.rakeback_periods rp
      CROSS JOIN LATERAL generate_series(rp.period_start, rp.period_end, interval '1 day') d
     WHERE rp.club_id = p_club_id
       AND rp.status = 'pending'
       AND rp.period_end < CURRENT_DATE
       AND NOT EXISTS (SELECT 1 FROM public.rakeback_daily_state s
                        WHERE s.club_id = p_club_id AND s.day = d::date)
     ORDER BY 1
     LIMIT GREATEST(COALESCE(p_max_warm_days, 2), 0)
  LOOP
    EXIT WHEN extract(epoch FROM (clock_timestamp() - v_started)) > v_budget * 0.6;
    PERFORM public.fn_rakeback_recompute_day(p_club_id, v_day.day, false);
    v_warmed := v_warmed + 1;
  END LOOP;

  -- 2. CLOSE PERIODS, oldest first, until the cap or the clock.
  FOR v_period IN
    SELECT id FROM public.rakeback_periods
     WHERE club_id = p_club_id AND status = 'pending'
       AND period_end < CURRENT_DATE
     ORDER BY period_end, id
     LIMIT p_max_periods
  LOOP
    EXIT WHEN extract(epoch FROM (clock_timestamp() - v_started)) > v_budget;

    v_res := public.fn_close_settlement_period(v_period.id);

    IF COALESCE((v_res->>'success')::boolean, false) THEN
      v_settled := v_settled + 1;
      v_total   := v_total + COALESCE((v_res->>'payout')::numeric, 0);
    ELSE
      v_deferred := v_deferred + 1;
      v_reason   := COALESCE(v_res->>'deferred', v_res->>'error', 'unknown');
      v_reasons  := jsonb_set(v_reasons, ARRAY[v_reason],
                      to_jsonb(COALESCE((v_reasons->>v_reason)::int, 0) + 1), true);
    END IF;
  END LOOP;

  SELECT count(*) INTO v_remaining FROM public.rakeback_periods
   WHERE club_id = p_club_id AND status = 'pending' AND period_end < CURRENT_DATE;

  v_elapsed := round(extract(epoch FROM (clock_timestamp() - v_started))::numeric, 3);

  RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
    'periods_settled', v_settled, 'total_payout', round(v_total, 2),
    'deferred', v_deferred, 'deferred_reasons', v_reasons,
    'days_warmed', v_warmed, 'periods_remaining', v_remaining,
    'elapsed_seconds', v_elapsed,
    'clock_ran_out', v_elapsed > v_budget);
END;
$function$;

COMMENT ON FUNCTION public.fn_settle_club_rakeback_batch(uuid, integer, numeric, integer) IS
  'Settles at most p_max_periods rakeback periods for one club and stops at p_budget_seconds of wall clock, so it always returns inside the 8s statement_timeout every server-side role carries. Warms uncomputed rollup days first - one day serves every player in it. Reports what remains and why anything deferred. Call it again to continue.';

REVOKE ALL ON FUNCTION public.fn_settle_club_rakeback_batch(uuid, integer, numeric, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_club_rakeback_batch(uuid, integer, numeric, integer) TO service_role;

-- The three existing callers keep their exact call and become bounded.
CREATE OR REPLACE FUNCTION public.settle_club_rakeback(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.fn_settle_club_rakeback_batch(p_club_id, 40, 5.0, 2);
END;
$function$;

COMMENT ON FUNCTION public.settle_club_rakeback(uuid) IS
  'One bounded pass of rakeback settlement for a club - see fn_settle_club_rakeback_batch. Bounded since 2026-09-07: the unbounded version could not finish a 1,769-period backlog inside the 8s service_role timeout and had settled nothing since 2026-08-20. Callers drain by calling it until periods_remaining is 0.';

-- THE REPORT SAYS WHY, NOT JUST HOW MUCH ---------------------------------------

CREATE OR REPLACE FUNCTION public.fn_rakeback_settlement_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_ok boolean;
BEGIN
  v_ok := public.fn_caller_is_engine()
          OR (auth.uid() IS NOT NULL AND EXISTS (
                SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('god','admin')));
  IF NOT v_ok THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'pending_periods', (SELECT count(*) FROM rakeback_periods
                         WHERE status='pending' AND period_end < CURRENT_DATE),
    'pending_clubs', (SELECT count(DISTINCT club_id) FROM rakeback_periods
                       WHERE status='pending' AND period_end < CURRENT_DATE),
    'pending_players', (SELECT count(DISTINCT user_id) FROM rakeback_periods
                         WHERE status='pending' AND period_end < CURRENT_DATE),
    'estimated_owed', (SELECT COALESCE(round(sum(COALESCE(rakeback_amount, rakeback_earned, 0)),2),0)
                        FROM rakeback_periods WHERE status='pending' AND period_end < CURRENT_DATE),
    'oldest_period_end', (SELECT min(period_end) FROM rakeback_periods
                           WHERE status='pending' AND period_end < CURRENT_DATE),
    'last_paid_at', (SELECT max(paid_at) FROM rakeback_periods WHERE status='paid'),
    -- What is actually payable right now, and what is not, per club. An
    -- operator asking "why has nothing moved" gets the answer here instead of
    -- from a 500 in a cron log.
    'by_club', (
      SELECT COALESCE(jsonb_agg(x ORDER BY x->>'owed' DESC), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
                 'club_id', o.club_id, 'club_name', c.name,
                 'periods', o.periods, 'players', o.players, 'owed', o.owed,
                 'treasury', round(COALESCE(c.chip_treasury,0),2),
                 'fundable', COALESCE(c.chip_treasury,0) >= o.owed,
                 'shortfall', round(GREATEST(o.owed - COALESCE(c.chip_treasury,0), 0),2)) AS x
          FROM (SELECT club_id, count(*) periods, count(DISTINCT user_id) players,
                       round(sum(COALESCE(rakeback_amount, rakeback_earned,0)),2) owed
                  FROM rakeback_periods
                 WHERE status='pending' AND period_end < CURRENT_DATE
                 GROUP BY club_id) o
          JOIN clubs c ON c.id = o.club_id
      ) s),
    'deferrals', (
      SELECT COALESCE(jsonb_object_agg(deferred_reason, n), '{}'::jsonb)
        FROM (SELECT deferred_reason, count(*) n FROM rakeback_periods
               WHERE status='pending' AND deferred_reason IS NOT NULL
               GROUP BY deferred_reason) d),
    'rollup_days_missing', (
      SELECT count(*) FROM (
        SELECT DISTINCT rp.club_id, d::date AS day
          FROM rakeback_periods rp
          CROSS JOIN LATERAL generate_series(rp.period_start, rp.period_end, interval '1 day') d
         WHERE rp.status='pending' AND rp.period_end < CURRENT_DATE) n
       WHERE NOT EXISTS (SELECT 1 FROM rakeback_daily_state s
                          WHERE s.club_id=n.club_id AND s.day=n.day))
  );
END;
$function$;

-- ASSERTIONS -------------------------------------------------------------------

DO $assert$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='atomic_credit_wallet_and_log' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%app.ledger_club_id%' THEN
    RAISE EXCEPTION 'the credit path cannot be told which club a payment belongs to';
  END IF;
  IF v_src NOT LIKE '%club_members%' THEN
    RAISE EXCEPTION 'the credit path no longer writes the live chip pool';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_close_settlement_period' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%fn_player_rakeback_rate%' THEN
    RAISE EXCEPTION 'the payer still computes its own rate';
  END IF;
  IF v_src LIKE '%WHEN v_rake_total >= 10000 THEN 0.30%' THEN
    RAISE EXCEPTION 'the hardcoded ladder is still in the payer';
  END IF;
  IF v_src NOT LIKE '%rakeback_daily_user%' THEN
    RAISE EXCEPTION 'the payer does not read the rollup';
  END IF;
  IF v_src NOT LIKE '%fn_platform_frozen%' THEN
    RAISE EXCEPTION 'the payer moves money during a maintenance freeze';
  END IF;
  IF v_src NOT LIKE '%no_membership_at_earning_club%' THEN
    RAISE EXCEPTION 'the payer will still pay a player at a club they do not belong to';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='settle_club_rakeback' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%fn_settle_club_rakeback_batch%' THEN
    RAISE EXCEPTION 'the drain is still unbounded';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_settle_club_rakeback_batch' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%fn_is_platform_admin%' THEN
    RAISE EXCEPTION 'a platform admin still cannot settle a club they do not own';
  END IF;

  IF has_function_privilege('anon','public.fn_settle_club_rakeback_batch(uuid,integer,numeric,integer)'::regprocedure,'EXECUTE')
     OR has_function_privilege('authenticated','public.fn_settle_club_rakeback_batch(uuid,integer,numeric,integer)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'a browser can drive the rakeback drain';
  END IF;
END
$assert$;

COMMIT;
