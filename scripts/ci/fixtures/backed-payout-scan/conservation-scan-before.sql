CREATE OR REPLACE FUNCTION public.fn_tournament_money_conservation(p_since_days integer DEFAULT 7, p_tolerance numeric DEFAULT 0.05, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  --
  -- SATELLITES ARE IN THE SCAN NOW (2026-09-02, Phase 4). They were excluded
  -- because they could never balance, which is circular: they could never
  -- balance only because the seat a satellite pays was invisible to the delta.
  -- 'spin' stays out - its pool is funded by the Reserve Pool rather than by
  -- its own collections, and it has its own check.
  ---------------------------------------------------------------------------
  FOR v_row IN
    WITH scan AS (
      SELECT t.id, t.name, t.variant, t.ended_at,
             public.fn_tournament_conservation_delta(t.id) AS delta
        FROM public.tournaments t
       WHERE t.status IN ('COMPLETED','CANCELLED')
         AND t.ended_at > now() - make_interval(days => v_days)
         AND t.ended_at < now() - interval '30 minutes'
         AND COALESCE(t.variant, '') NOT IN ('spin')
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
$function$
