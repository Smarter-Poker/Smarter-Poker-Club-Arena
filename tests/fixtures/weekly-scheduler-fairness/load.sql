\set ON_ERROR_STOP on
-- UNRUN. Fixture input for the protected owner; never a production migration.
-- Use a fresh, isolated database. Production coordinator, routing, statement,
-- delivery and conservation bodies are loaded from their guarded components.
\ir ../routed-accounting/bootstrap.sql
\ir ../routed-accounting/preimage.sql
\ir ../../../supabase/accounting/weekly-v3/components/20260914132449_rakeback_follows_recorded_hierarchy_in_one_funded_transaction.sql
\ir ../../../supabase/accounting/weekly-v3/components/20260914135008_standalone_clubs_use_the_same_atomic_routed_stages.sql
\ir ../routed-accounting/seed.sql
\ir ../routed-accounting/central-delivery-schema.sql
\ir ../routed-accounting/central-delivery-preimage.sql
\ir ../../../supabase/accounting/weekly-v3/components/20260914133404_routed_invoice_roles_follow_the_recorded_payment.sql
\ir ../routed-accounting/central-delivery-triggers.sql
\ir ../unified-weekly-accounting/schema.sql
\ir ../mixed-rake-period/schema.sql
ALTER TABLE accounting_tournament_fee_recognitions ADD COLUMN union_wallet_transaction_id uuid,ADD COLUMN bank_journal_id uuid;
\ir ../mixed-rake-period/tournament-authority.sql
DROP VIEW accounting_payable_earning_sources;
\ir ../../../supabase/accounting/weekly-v3/components/20260914140015_recognized_cash_and_tournament_sources_share_one_payment_route.sql
\ir ../unified-weekly-accounting/preimages.sql
\ir ../../../supabase/accounting/weekly-v3/components/20260914142256_weekly_statements_follow_recorded_union_and_standalone_books.sql
INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES(u(999),'2026-08-31 07:00Z','2026-09-07 07:00Z','2026-09-07 09:00Z','failed',7,'{"success":false,"original":true}');
\ir ../../../supabase/accounting/weekly-v3/components/20260914142600_unions_and_standalone_clubs_share_one_weekly_run_journal.sql
\ir ../union-earned-close/conservation-preimage.sql
\ir ../../../supabase/accounting/weekly-v3/components/20260914143500_weekly_conservation_requires_recorded_scope_and_payment_receipts.sql
\ir ../automatic-accounting-doors/preimage.sql
\ir ../../../supabase/accounting/weekly-v3/components/20260914145000_legacy_claims_enter_only_automatic_weekly_accounting.sql
\ir pnl-predecessor.sql
\ir ../../../supabase/accounting/weekly-v3/components/20260914154500_weekly_scheduler_visits_every_accounting_scope_fairly.sql
-- Only after the exact preimage guard has consumed the real predecessor do
-- we replace the clock dependency, as in the original coordinator fixture.
\ir ../unified-weekly-accounting/controls.sql
\ir seed.sql
