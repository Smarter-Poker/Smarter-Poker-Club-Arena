-- Only after an inspected, terminal interrupted build of the exact maintained
-- index. Refuse wrong definition/owner or an active build; no blind retry.
-- Preserve native session admission, freeze checks and bounded runway.
REINDEX INDEX CONCURRENTLY public.idx_chip_ledger_cashier_totals_cover;
