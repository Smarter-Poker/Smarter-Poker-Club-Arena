-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901055308; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_tournament_payout_sweep(
  p_days integer DEFAULT 2,
  p_apply boolean DEFAULT false,
  p_limit integer DEFAULT 50
)
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

DO $$
BEGIN
  IF has_function_privilege('anon',
       'public.fn_tournament_payout_sweep(integer, boolean, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute the payout sweep';
  END IF;
  IF has_function_privilege('authenticated',
       'public.fn_tournament_payout_sweep(integer, boolean, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute the payout sweep';
  END IF;
END $$;
