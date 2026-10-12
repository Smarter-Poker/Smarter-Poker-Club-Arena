-- tests/fixtures/ledger-invariant/suspense-bootstrap.sql
--
-- The state production is in when *_no_balance_moves_against_settlement_suspense
-- applies: every chip store refuses (20261002042417). stores-regression.sql
-- leaves the promo store in observe for its per-store mode case; this puts it
-- back, so the migration's preimage and read-back see production's shape.
UPDATE public.ca_ledger_invariant_store_mode SET mode = 'refuse', reason = 'fixture: every chip store refuses (20261002042417)';
