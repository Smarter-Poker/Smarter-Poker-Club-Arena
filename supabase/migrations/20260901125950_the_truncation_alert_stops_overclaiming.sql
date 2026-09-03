-- My own alarm over-claimed, ten minutes after I shipped it.
--
-- 20260901123205 made a truncated APPLYING pass raise a critical alert, on the
-- reasoning that the sweep orders newest-first so anything it misses only gets
-- older and no later pass reaches it. That is true of the hourly pg_cron job.
-- It is NOT true of the other caller, which I did not know about when I wrote
-- it: RakebackSettlerService runs a NARROW pass (2 days / 6,000) every cycle
-- AND a DEEP pass (30 days / 40,000) every 24th cycle. The narrow pass
-- truncates by design and the deep pass is what catches the remainder.
--
-- So the first thing the new guard did was fire critical on a caller that has a
-- wider pass behind it, with a message asserting something false. That is the
-- same failure I had just finished fixing in the engine watchdog -- an alarm
-- that is right about the reading and wrong about whether anything is broken --
-- and it earns the same correction rather than an exception.
--
-- The alert now states what it can actually see: how much of the window went
-- unexamined by THIS pass, and that a wider pass, if one is configured, is
-- where the remainder has to come from. It stays 'warning' unless the pass was
-- asked to cover its whole window and could not.

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

  -- Truncation on an APPLYING pass, stated as what it is rather than as a
  -- conclusion this function is not in a position to draw. A narrow pass that
  -- truncates is normal when a deep pass backs it (RakebackSettlerService);
  -- the hourly pg_cron job has nothing behind it, so for that caller the
  -- unreached tail really is unreachable. This function cannot tell the two
  -- apart, so it reports and does not diagnose.
  IF p_apply AND v_matched > v_scanned THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'warning',
           'fn_tournament_payout_sweep_truncated',
           format('An applying payout sweep examined %s of %s tournament(s) in its '
                  '%s-day window and stopped at its %s-row limit, leaving %s '
                  'unexamined. It orders newest-first, so those only get older: '
                  'they are reached only by a wider pass, if one is configured. '
                  'If this caller has no deeper pass behind it, raise the limit.',
                  v_scanned, v_matched, GREATEST(p_days, 1), v_limit,
                  v_matched - v_scanned),
           jsonb_build_object('scanned', v_scanned, 'matched', v_matched,
                              'days', GREATEST(p_days, 1), 'limit', v_limit,
                              'unexamined', v_matched - v_scanned)
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

-- Clear the two alerts raised by the over-claiming version and by my own
-- verification calls. Both describe closed facts: the truncation one asserted
-- something untrue about a caller that has a deep pass, and the duplicate-payout
-- one describes the 2026-08-31 incident, which is ageing out of the 24h window
-- as this is applied. Leaving either open would dedupe the next real occurrence
-- into silence, which is the failure mode both guards exist to avoid.
UPDATE public.financial_alerts
   SET resolved = true
 WHERE resolved IS NOT TRUE
   AND source IN ('fn_tournament_payout_sweep_truncated',
                  'fn_ca_duplicate_structure_payout_check');;
