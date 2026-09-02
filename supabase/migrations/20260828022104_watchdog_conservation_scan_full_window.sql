-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828022104; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
-- watchdog_conservation_scan_full_window
-- ============================================================================
-- WHAT WAS WRONG
--
-- fn_tournament_money_conservation(p_since_days, p_tolerance, p_limit) is the
-- top-level money-integrity watchdog for tournaments. It reported
-- {"ok": true, "flagged": 0} and had done so for as long as anyone had looked.
--
-- The reason is the scan loop. It read:
--
--     FROM public.tournaments t
--    WHERE ... AND t.ended_at > now() - make_interval(days => GREATEST(p_since_days,1))
--    ORDER BY t.ended_at DESC
--    LIMIT GREATEST(p_limit, 1)
--
-- The p_since_days predicate is real -- that part of the audit note was slightly
-- off -- but it is irrelevant, because LIMIT is applied to the SCAN, and the
-- scan is ordered newest-first. p_limit defaults to 500. This platform ends
-- roughly 11,000 qualifying tournaments per WEEK. So:
--
--   caller asks for      qualifying events    events actually examined
--   p_since_days = 7          11,113                     500
--   p_since_days = 30         13,655                     500
--   p_since_days = 365        14,491                     500
--
-- Measured on 2026-08-28, calling with p_since_days => 30 examined events from
-- 2026-08-26 23:14 UTC onward. A 30-day request bought 26 hours of coverage.
-- Asking for a wider window did not widen anything; it just re-read the same
-- newest 500 rows. And because p_limit was the scan cap, the one knob that
-- looked like it should help -- raise the limit -- was also the only way to
-- make the scan slower rather than deeper, so nobody touched it.
--
-- The reported 'flagged' count was therefore not a measurement of the platform.
-- It was a measurement of the last day. Emulating the old function's exact
-- behaviour set-based over p_since_days => 30 returns flagged = 1 against a real
-- population of 1,241 offenders in that window. That is the fake green light.
--
-- WHAT THIS MIGRATION DOES
--
-- 1. The scan now covers the ENTIRE p_since_days window. No LIMIT on the scan.
--    'scanned' in the return value is now the true count of events examined, so
--    coverage is visible instead of inferred.
--
-- 2. p_limit now caps REPORTED offenders -- specifically, how many NEW rows one
--    run may insert into financial_alerts. It no longer influences detection at
--    all. Offenders are visited worst-first (ORDER BY abs(delta) DESC) so that a
--    truncated report is the top of the problem rather than an arbitrary slice
--    of it. An offender that already has an open alert does not consume budget,
--    because it has already been reported; this lets successive runs converge on
--    full coverage instead of re-spending the budget on the same events.
--
-- 3. New fields make the truth legible, and 'ok' now means what a reader assumes
--    it means. BREAKING-ISH, FLAGGED FOR THE LEAD: 'ok' was previously hardcoded
--    true and meant "the procedure ran". It is now (flagged = 0) and means "the
--    tournament ledger conserves". A caller that treats ok=false as a hard error
--    WILL now error. That is deliberate -- a conservation check whose green light
--    is independent of the result is not a check -- but it is a real behaviour
--    change. 'check_ran' is added as the field that carries the old meaning, so
--    a caller that only wanted "did it execute" has somewhere to move to.
--    The 'ok' and 'flagged' keys are both still present, same types.
--
--    Full return shape (superset of the old one):
--      ok, check_ran, scanned, flagged, reported, report_truncated,
--      window_days, tolerance, report_limit, auto_resolved,
--      retained_chips, unfunded_chips, worst_abs_delta, duration_ms
--
-- 4. The auto-resolve pass at the top is unchanged in logic. It still walks up
--    to 1000 open alerts and clears any whose delta has come back inside
--    tolerance. Note that with the amnesty removed (migration
--    watchdog_remove_conservation_delta_amnesty) it will clear far fewer, which
--    is correct: those alerts were being resolved by fake arithmetic.
--
-- COST
--
-- Not free, and the cadence chosen in watchdog_schedule_tournament_money_jobs
-- reflects it. One delta evaluation is 5 correlated subqueries against
-- wallet_transactions (2.38M rows) and rake_records (1.45M rows). Measured
-- 2026-08-28: a full 30-day scan is 13,655 delta evaluations in ~8.4s of
-- server time. A 365-day scan is 14,491 evaluations, similar. This is an
-- index-driven read-only workload -- idx_wallet_tx_entity_cat_created and
-- idx_rake_records_tournament both apply -- but it is seconds, not
-- milliseconds, and it grows with tournament volume. It must not be scheduled
-- at minute granularity, and the wide-window variant must not run hot.
--
-- DETECTION ONLY. This migration writes no money row. It writes financial_alerts
-- rows, which is the function's existing and intended side effect.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_tournament_money_conservation(
  p_since_days integer DEFAULT 7,
  p_tolerance  numeric DEFAULT 1.0,
  p_limit      integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row       record;
  v_flagged   integer := 0;
  v_scanned   integer := 0;
  v_reported  integer := 0;
  v_resolved  integer := 0;
  v_retained  numeric := 0;
  v_unfunded  numeric := 0;
  v_worst     numeric := 0;
  v_delta     numeric;
  v_ins       integer;
  v_tol       numeric := GREATEST(p_tolerance, 0);
  v_days      integer := GREATEST(p_since_days, 1);
  v_cap       integer := GREATEST(p_limit, 1);
  v_started   timestamptz := clock_timestamp();
BEGIN
  ---------------------------------------------------------------------------
  -- Pass 1: auto-resolve open alerts that have come back inside tolerance.
  -- Unchanged from the original.
  ---------------------------------------------------------------------------
  FOR v_row IN
    SELECT fa.id, (fa.context->>'tournament_id')::uuid AS tid
      FROM public.financial_alerts fa
     WHERE fa.source = 'fn_tournament_money_conservation'
       AND fa.resolved IS NOT TRUE
       AND fa.context->>'tournament_id' IS NOT NULL
     ORDER BY fa.created_at ASC
     LIMIT 1000
  LOOP
    v_delta := public.fn_tournament_conservation_delta(v_row.tid);
    IF v_delta IS NOT NULL AND abs(v_delta) <= v_tol THEN
      UPDATE public.financial_alerts
         SET resolved = true, resolved_at = now()
       WHERE id = v_row.id;
      v_resolved := v_resolved + 1;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- Pass 2: scan the FULL p_since_days window. No LIMIT here -- that was the
  -- defect. Deltas are computed once in the CTE and the offenders are visited
  -- worst-first so that a report truncated by p_limit is still the top of the
  -- problem.
  ---------------------------------------------------------------------------
  FOR v_row IN
    WITH scan AS (
      SELECT t.id, t.name, t.variant, t.ended_at,
             public.fn_tournament_conservation_delta(t.id) AS delta
        FROM public.tournaments t
       WHERE t.status IN ('COMPLETED','CANCELLED')
         AND t.ended_at > now() - make_interval(days => v_days)
         AND t.ended_at < now() - interval '30 minutes'
         AND COALESCE(t.variant, '') NOT IN ('spin', 'satellite')
         AND COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) > 0
    )
    SELECT s.id, s.name, s.variant, s.delta
      FROM scan s
     ORDER BY abs(s.delta) DESC NULLS LAST, s.ended_at DESC
  LOOP
    v_scanned := v_scanned + 1;
    v_delta := v_row.delta;

    IF v_delta IS NULL OR abs(v_delta) <= v_tol THEN CONTINUE; END IF;

    IF v_delta > 0 THEN v_retained := v_retained + v_delta;
    ELSE                v_unfunded := v_unfunded - v_delta; END IF;
    v_flagged := v_flagged + 1;
    v_worst := GREATEST(v_worst, abs(v_delta));

    -- p_limit caps how many NEW alerts one run may raise. Detection above is
    -- already complete and unconditional; this only throttles the write side.
    IF v_reported < v_cap THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'warning', 'fn_tournament_money_conservation',
             CASE WHEN v_delta > 0
                  THEN 'Tournament retained money it never paid out: '
                  ELSE 'Tournament paid out money it never collected: ' END
               || COALESCE(v_row.name, v_row.id::text),
             jsonb_build_object('tournament_id', v_row.id, 'variant', v_row.variant,
                                'delta', v_delta)
       WHERE NOT EXISTS (
         SELECT 1 FROM public.financial_alerts
          WHERE source = 'fn_tournament_money_conservation'
            AND resolved IS NOT TRUE
            AND context->>'tournament_id' = v_row.id::text);
      GET DIAGNOSTICS v_ins = ROW_COUNT;
      v_reported := v_reported + v_ins;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok',               (v_flagged = 0),
    'check_ran',        true,
    'scanned',          v_scanned,
    'flagged',          v_flagged,
    'reported',         v_reported,
    'report_truncated', (v_reported >= v_cap AND v_flagged > v_reported),
    'window_days',      v_days,
    'tolerance',        v_tol,
    'report_limit',     v_cap,
    'auto_resolved',    v_resolved,
    'retained_chips',   round(v_retained, 2),
    'unfunded_chips',   round(v_unfunded, 2),
    'worst_abs_delta',  round(v_worst, 2),
    'duration_ms',      round(extract(epoch FROM clock_timestamp() - v_started) * 1000)
  );
END;
$fn$;

COMMENT ON FUNCTION public.fn_tournament_money_conservation(integer, numeric, integer) IS
'Tournament money-conservation watchdog. Scans EVERY qualifying event in the p_since_days window (previously the scan was silently capped at p_limit rows ordered newest-first, so a 30-day request only ever examined the newest 500 events - roughly 26 hours of coverage). p_limit now caps only how many NEW financial_alerts rows a single run may raise; offenders are visited worst-first. ''ok'' now means (flagged = 0), not "the procedure ran" - use ''check_ran'' for the latter. Expensive: one full 30-day scan is ~13.6k delta evaluations, ~8s. Schedule it, do not poll it.';

