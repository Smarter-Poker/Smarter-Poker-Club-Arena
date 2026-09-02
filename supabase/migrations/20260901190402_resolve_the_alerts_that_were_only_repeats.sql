-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901190402; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DO $resolve$
DECLARE
  v_settlement integer;
  v_disbursement integer;
BEGIN
  WITH keep AS (
    SELECT id FROM public.financial_alerts
     WHERE source = 'fn_close_settlement_period' AND resolved IS NOT TRUE
     ORDER BY created_at DESC LIMIT 1
  )
  UPDATE public.financial_alerts fa
     SET resolved = true, resolved_at = now()
   WHERE fa.source = 'fn_close_settlement_period'
     AND fa.resolved IS NOT TRUE
     AND fa.id NOT IN (SELECT id FROM keep);
  GET DIAGNOSTICS v_settlement = ROW_COUNT;

  WITH ranked AS (
    SELECT fa.id,
           row_number() OVER (
             PARTITION BY COALESCE(fa.context->>'tournament_id', fa.message)
             ORDER BY fa.created_at DESC) AS rn
      FROM public.financial_alerts fa
     WHERE fa.source = 'FeeReconciler.prize_disbursement'
       AND fa.resolved IS NOT TRUE
  )
  UPDATE public.financial_alerts fa
     SET resolved = true, resolved_at = now()
    FROM ranked r
   WHERE fa.id = r.id AND r.rn > 1;
  GET DIAGNOSTICS v_disbursement = ROW_COUNT;

  RAISE NOTICE 'resolved % settlement repeat(s) and % disbursement repeat(s)',
    v_settlement, v_disbursement;
END
$resolve$;
