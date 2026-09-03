-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902052811; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- fn_ca_money_rpc_drift caught tonight's new balance writers again, which is
-- the registry doing its job twice in one session.
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_ca_backpay_guarantee_shortfalls', 'approved',
   'Funds an unmet guarantee from the union bank (club treasury fallback) under FOR UPDATE, all-or-nothing, raises prize_pool to the guarantee, writes one descriptive chip_ledger row naming the tournament and shortfall, then hands distribution to fn_tournament_payout_reconcile. It distributes nothing itself: payout_structure is the authority and the reconciler owns it.'),
  ('sp_ca_reconcile_backpaid_events', 'approved',
   'Procedure. Calls fn_tournament_payout_reconcile over the back-paid events, committing per event so a deadlock against the live engine cannot lose the batch. Tops up to the structure entitlement; never claws back.')
ON CONFLICT (proname) DO UPDATE
  SET status = EXCLUDED.status, notes = EXCLUDED.notes;

