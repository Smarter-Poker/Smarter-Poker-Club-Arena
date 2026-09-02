-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831101800; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- Two fn_tournament_payout_reconcile alerts re-fired for events whose excess
-- is already recorded in tournament_conservation_baseline:
--   dfae9288  453.60  — the Sunday $200 double payment, acknowledged with its
--                       full cause and Dan named as the decision owner;
--   3b0e5707    0.01  — a rounding epsilon the function reports and, by its
--                       own design, never claws back.
-- Both are the reconciler restating a known, filed fact. Resolved gated on the
-- acknowledgment actually existing, so an event with a NEW excess still speaks.
UPDATE public.financial_alerts fa
   SET resolved = true, resolved_at = now()
 WHERE fa.source = 'fn_tournament_payout_reconcile'
   AND fa.resolved IS NOT TRUE
   AND (EXISTS (SELECT 1 FROM public.tournament_conservation_baseline b
                 WHERE b.tournament_id::text = fa.context->>'tournament_id')
        OR (fa.context->'issues'->0->>'excess')::numeric <= 0.01);

-- The rake/BBJ audit alerts from the window while the fee queue was draining:
-- resolved only if the live audit is clean right now.
UPDATE public.financial_alerts
   SET resolved = true, resolved_at = now()
 WHERE source = 'fn_rake_bbj_audit' AND resolved IS NOT TRUE
   AND (SELECT (fn_rake_bbj_audit()->>'violations')::int) = 0;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.financial_alerts
   WHERE source = 'fn_tournament_payout_reconcile' AND resolved IS NOT TRUE;
  IF n > 0 THEN RAISE EXCEPTION '% payout-reconcile alerts left unacknowledged', n; END IF;
END $$;

