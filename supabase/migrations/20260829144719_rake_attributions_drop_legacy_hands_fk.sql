-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829144719; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- rake_attributions.hand_id carried a legacy FK to the dead `hands` table
-- (live hands are written to hand_history, which is itself purged at 7 days).
-- The FK rejected every id the engine passed, aborting the whole
-- atomic_distribute_rake transaction: cash rake stopped banking the moment
-- the weighted-rake engine deployed (2026-08-29 ~14:41 UTC) and every fee
-- fell into pending_fee_distributions (safety net held; FeeReconciler
-- re-drives them once this lands). No FK is correct here — it mirrors
-- rake_records.hand_id, which is deliberately FK-free for the same reason.
ALTER TABLE public.rake_attributions DROP CONSTRAINT IF EXISTS rake_attributions_hand_id_fkey;
