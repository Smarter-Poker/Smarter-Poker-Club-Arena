-- The payout sweep was examining 16% of its own window, and said so quietly.
--
-- ca-payout-sweep-hourly ran fn_tournament_payout_sweep(7, true, 5000): a
-- SEVEN DAY window, and the newest FIVE THOUSAND of it. Over the last seven
-- days that window holds 31,352 completed tournaments, so the pass that
-- actually PAYS people reached the newest 5,000 and never looked at the other
-- 26,352. It ordered by ended_at DESC, so a tournament that needed a top-up
-- and then aged out of the newest 5,000 could never be reached again by the
-- applying pass, in any later run, ever.
--
-- The return value has been carrying 'truncated': true since 2026-08-29 and
-- nothing read it. A flag nobody reads is not a safeguard, it is a record of
-- the moment we stopped noticing.
--
-- The cap was not buying anything. Measured against production just now, the
-- FULL seven-day window -- all 31,352 -- reconciles in 13.6 seconds, well
-- inside even the old 120s statement timeout:
--
--     seconds 13.6 | matched 31352 | scanned 31352 | truncated false
--     findings 7   | total_top_up 0.00 | failed 0
--
-- Two changes:
--
--   1. The hourly job scans the whole window (40000, the same ceiling the
--      daily detect pass already used) with a 300s timeout -- 20x the measured
--      cost, so a bad day does not silently start truncating again.
--
--   2. Truncation now raises a financial_alerts row instead of returning a
--      flag into the void. If the window ever outgrows the ceiling, somebody
--      finds out from the alert rather than from an unpaid player.
--
-- The advisory lock and the per-tournament EXCEPTION handler from #2423 are
-- untouched: a long pass cannot overlap itself, and one unpayable player still
-- cannot abort the rest.

CREATE OR REPLACE FUNCTION public.fn_tournament_payout_sweep(
  p_days integer DEFAULT 2, p_apply boolean DEFAULT false, p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '600s'
AS $function$
DECLARE
  r          record;
  v_res      jsonb;
  v_out      jsonb := '[]'::jsonb;
  v_n        int    := 0;
  v_topup    numeric := 0;
  v_matched  int    := 0;
  v_scanned  int    := 0;
  v_failed   int    := 0;
  v_fail_ids uuid[] := ARRAY[]::uuid[];
  v_first_err text;
  v_limit    int    := GREATEST(p_limit, 1);
  v_since    timestamptz := now() - make_interval(days => GREATEST(p_days, 1));
BEGIN
  SELECT count(*) INTO v_matched
    FROM tournaments t
   WHERE t.status = 'COMPLETED'
     AND COALESCE(t.ended_at, t.started_at, t.updated_at) > v_since
     AND COALESCE(t.prize_pool, 0) > 0
     AND COALESCE(t.variant, '') <> 'satellite';

  FOR r IN
    SELECT t.id
      FROM tournaments t
     WHERE t.status = 'COMPLETED'
       AND COALESCE(t.ended_at, t.started_at, t.updated_at) > v_since
       AND COALESCE(t.prize_pool, 0) > 0
       AND COALESCE(t.variant, '') <> 'satellite'
     ORDER BY COALESCE(t.ended_at, t.started_at, t.updated_at) DESC
     LIMIT v_limit
  LOOP
    v_scanned := v_scanned + 1;
    BEGIN
      v_res := fn_tournament_payout_reconcile(r.id, p_apply);
      IF COALESCE((v_res->>'clean')::boolean, true) = false THEN
        v_out   := v_out || v_res;
        v_n     := v_n + 1;
        v_topup := v_topup + COALESCE((v_res->>'total_top_up')::numeric, 0);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      IF v_first_err IS NULL THEN v_first_err := SQLERRM; END IF;
      IF array_length(v_fail_ids, 1) IS NULL OR array_length(v_fail_ids, 1) < 20 THEN
        v_fail_ids := v_fail_ids || r.id;
      END IF;
    END;
  END LOOP;

  IF v_failed > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'warning',
           'fn_tournament_payout_sweep',
           format('Payout sweep could not reconcile %s of %s tournament(s) in this '
                  'pass; the rest were paid. First error: %s',
                  v_failed, v_scanned, COALESCE(v_first_err, 'unknown')),
           jsonb_build_object('failed', v_failed, 'scanned', v_scanned,
                              'first_error', v_first_err,
                              'sample_tournaments', to_jsonb(v_fail_ids))
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_tournament_payout_sweep'
          AND fa.resolved IS NOT TRUE);
  END IF;

  -- A window this pass could not finish looking at. Only the APPLYING pass
  -- matters here: a truncated detect run is a smaller report, but a truncated
  -- apply run is a tournament nobody will ever pay, because the ordering is
  -- newest-first and it only gets older.
  IF p_apply AND v_matched > v_scanned THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'critical',
           'fn_tournament_payout_sweep_truncated',
           format('Payout sweep examined %s of %s tournament(s) in its %s-day window. '
                  'It orders newest-first, so the %s it did not reach only get older '
                  'and no later pass will reach them either. Raise the limit.',
                  v_scanned, v_matched, GREATEST(p_days, 1), v_matched - v_scanned),
           jsonb_build_object('scanned', v_scanned, 'matched', v_matched,
                              'days', GREATEST(p_days, 1), 'limit', v_limit)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_tournament_payout_sweep_truncated'
          AND fa.resolved IS NOT TRUE);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'days', p_days,
    'applied', p_apply,
    'tournaments_with_findings', v_n,
    'total_top_up', round(v_topup, 2),
    'findings', v_out,
    'candidates_matched', v_matched,
    'candidates_scanned', v_scanned,
    'truncated', v_matched > v_scanned,
    'window_column', 'coalesce(ended_at, started_at, updated_at)',
    'failed', v_failed,
    'failed_tournaments', to_jsonb(v_fail_ids),
    'first_error', v_first_err
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
  TO service_role;

-- The hourly applying pass now covers its window.
SELECT cron.alter_job(
  job_id  := 189,
  command := $cron$select case
      when pg_try_advisory_lock(hashtext('tourney-payout-sweep-hourly'))
        then (select set_config('statement_timeout','300s',true) is not null
                 and (public.fn_tournament_payout_sweep(7, true, 40000) ->> 'ok') = 'true')::text
      else 'skipped: previous run still in progress'
    end;$cron$
);

DO $$
DECLARE v_cmd text;
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobid = 189;
  IF v_cmd IS NULL OR v_cmd NOT LIKE '%40000%' OR v_cmd NOT LIKE '%300s%' THEN
    RAISE EXCEPTION 'job 189 did not take the new arguments: %', COALESCE(v_cmd, '<missing>');
  END IF;
  RAISE NOTICE 'ca-payout-sweep-hourly now covers its whole window';
END $$;;
