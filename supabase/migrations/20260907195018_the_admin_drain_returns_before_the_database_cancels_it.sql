-- THE ADMIN DRAIN RETURNS BEFORE THE DATABASE CANCELS IT
-- =============================================================================
-- PHASE 5 of 8, part 9 - a hazard I created, found in the caller audit.
--
-- fn_run_pending_rakeback_settlement is what the Settle Now button on the
-- settlement dashboard calls, and the dashboard passes p_max_clubs = 200. It
-- loops settle_club_rakeback over every club with pending work, in ONE
-- transaction, and it carries no statement_timeout of its own. The
-- `authenticated` role this reaches Postgres as is pinned at 8 seconds.
--
-- That was harmless while settle_club_rakeback returned almost immediately -
-- which it did, because it was being cancelled. Now that it WORKS, one busy
-- club costs up to ~4 seconds of honest work, so the second busy club exhausts
-- the 8s budget, the statement is cancelled, and BECAUSE IT IS ONE TRANSACTION
-- EVERY PERIOD IT JUST SETTLED IS ROLLED BACK. The admin sees "canceling
-- statement due to statement timeout", the players are not paid, and the money
-- that appeared to move did not.
--
-- I introduced that by making the inner function do real work. It is the exact
-- shape of the defect this phase started with - a drain cancelled by a timeout
-- nobody had budgeted for - one level further up.
--
-- THE FIX IS THE SAME ONE: a wall-clock budget, checked between clubs, so the
-- function RETURNS with what it did instead of being shot with what it did.
-- 6 seconds, so a club that overruns its own 4s budget still lands inside 8.
-- The response says how many clubs are left, and the dashboard already tells
-- the operator to run it again.
--
-- It also now reports the deferrals, so an admin who presses the button and
-- sees nothing move is told why - insufficient_club_treasury and
-- no_membership_at_earning_club are answers, where `clubs_processed: 3` is not.
--
-- The authorization is unchanged and was verified rather than assumed: this
-- function gates on profiles.role IN ('god','admin') and the worker underneath
-- gates on fn_is_platform_admin(), which accepts admin, superadmin and god -
-- a superset, so nothing that passes here is refused there. That was the whole
-- defect in part 2 and it is worth knowing it is actually closed.
--
-- The DEFAULT 100 on p_max_clubs is preserved deliberately: dropping it would
-- break every caller that omits the argument, and Postgres refuses the replace
-- outright rather than let that happen quietly.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_run_pending_rakeback_settlement(p_max_clubs integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_budget     numeric := 6.0;   -- inside the 8s the API roles carry
  v_is_admin   boolean;
  v_club       uuid;
  v_res        jsonb;
  v_clubs      integer := 0;
  v_periods    integer := 0;
  v_total      numeric := 0;
  v_deferred   integer := 0;
  v_errors     integer := 0;
  v_reasons    jsonb := '{}'::jsonb;
  v_k          text;
  v_remaining  integer;
  v_out_of_time boolean := false;
BEGIN
  SELECT EXISTS(SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('god','admin'))
    INTO v_is_admin;
  IF NOT v_is_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  IF p_max_clubs IS NULL OR p_max_clubs < 1 THEN p_max_clubs := 100; END IF;
  IF p_max_clubs > 500 THEN p_max_clubs := 500; END IF;

  FOR v_club IN
    SELECT DISTINCT club_id FROM rakeback_periods
     WHERE status='pending' AND period_end < CURRENT_DATE
     ORDER BY club_id
     LIMIT p_max_clubs
  LOOP
    -- Stop BEFORE starting a club we cannot finish. A cancelled statement
    -- would roll back every period settled in this transaction.
    IF extract(epoch FROM (clock_timestamp() - v_started)) > v_budget THEN
      v_out_of_time := true;
      EXIT;
    END IF;

    v_res := public.settle_club_rakeback(v_club);   -- bounded and idempotent

    IF COALESCE((v_res->>'success')::boolean, false) THEN
      v_clubs    := v_clubs + 1;
      v_periods  := v_periods  + COALESCE((v_res->>'periods_settled')::integer, 0);
      v_total    := v_total    + COALESCE((v_res->>'total_payout')::numeric, 0);
      v_deferred := v_deferred + COALESCE((v_res->>'deferred')::integer, 0);
      v_errors   := v_errors   + COALESCE((v_res->>'errors')::integer, 0);
      FOR v_k IN SELECT jsonb_object_keys(COALESCE(v_res->'deferred_reasons', '{}'::jsonb))
      LOOP
        v_reasons := jsonb_set(v_reasons, ARRAY[v_k],
          to_jsonb(COALESCE((v_reasons->>v_k)::int, 0)
                   + COALESCE((v_res->'deferred_reasons'->>v_k)::int, 0)), true);
      END LOOP;
    ELSE
      v_errors := v_errors + 1;
    END IF;
  END LOOP;

  SELECT count(DISTINCT club_id) INTO v_remaining FROM rakeback_periods
   WHERE status='pending' AND period_end < CURRENT_DATE;

  RETURN jsonb_build_object('success', true,
    'clubs_processed', v_clubs, 'periods_settled', v_periods,
    'total_payout', round(v_total, 2), 'clubs_remaining', v_remaining,
    'deferred', v_deferred, 'deferred_reasons', v_reasons, 'errors', v_errors,
    'periods_remaining', (SELECT count(*) FROM rakeback_periods
                           WHERE status='pending' AND period_end < CURRENT_DATE),
    'out_of_time', v_out_of_time,
    'elapsed_seconds', round(extract(epoch FROM (clock_timestamp() - v_started))::numeric, 3));
END;
$function$;

COMMENT ON FUNCTION public.fn_run_pending_rakeback_settlement(integer) IS
  'One bounded admin pass of rakeback settlement across every club with pending work. Stops at 6 seconds of wall clock so it RETURNS inside the 8s statement_timeout the API roles carry - being cancelled would roll back every period the same transaction had already paid. Reports clubs_remaining, periods_remaining, deferrals and out_of_time; press it again to continue.';

-- by_club was ordered by a TEXT comparison of a number, so 9.00 sorted above
-- 280142.41. Order it as a number.
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
    'by_club', (
      SELECT COALESCE(jsonb_agg(s.x ORDER BY s.owed DESC), '[]'::jsonb) FROM (
        SELECT o.owed,
               jsonb_build_object(
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

DO $assert$
DECLARE v_src text; v_status jsonb; v_args text;
BEGIN
  SELECT prosrc, pg_get_function_arguments(oid) INTO v_src, v_args FROM pg_proc
   WHERE proname='fn_run_pending_rakeback_settlement' AND pronamespace='public'::regnamespace;

  IF v_args <> 'p_max_clubs integer DEFAULT 100' THEN
    RAISE EXCEPTION 'the default on p_max_clubs was lost: %', v_args;
  END IF;
  IF v_src NOT LIKE '%v_budget%' THEN
    RAISE EXCEPTION 'the admin drain is still unbounded and will roll back what it paid';
  END IF;
  IF v_src NOT LIKE '%out_of_time%' THEN
    RAISE EXCEPTION 'the admin drain does not say it ran out of time';
  END IF;
  IF v_src NOT LIKE '%deferred_reasons%' THEN
    RAISE EXCEPTION 'the admin drain does not report why nothing moved';
  END IF;
  IF v_src NOT LIKE '%settle_club_rakeback%' THEN
    RAISE EXCEPTION 'the admin drain lost its worker';
  END IF;

  -- Every key the dashboard reads must still be produced.
  v_status := public.fn_rakeback_settlement_status();
  IF NOT (v_status ? 'pending_periods' AND v_status ? 'pending_clubs'
          AND v_status ? 'estimated_owed' AND v_status ? 'last_paid_at'
          AND v_status ? 'success' AND v_status ? 'by_club') THEN
    RAISE EXCEPTION 'the status report lost a key the settlement dashboard renders: %', v_status::text;
  END IF;
END
$assert$;

COMMIT;
