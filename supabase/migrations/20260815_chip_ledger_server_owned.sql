-- ═══════════════════════════════════════════════════════════════════════════
-- AUDIT chip_ledger server-ownership (2026-08-15) — APPLIED TO PROD via
-- Supabase MCP the same day (probe-verified in a rolled-back transaction:
-- authenticated INSERT on both tables -> permission denied; SELECT intact).
--
-- chip_ledger is the LEGACY audit ledger: 88,479 rows, newest 2026-05-03 —
-- no writer in 3.5 months. The live authoritative ledger is
-- wallet_transactions (server-only via SECURITY DEFINER RPCs; RLS denies
-- client writes). But chip_ledger still carried an INSERT policy whose only
-- check was "auth.uid() IS NOT NULL": ANY signed-in user could forge audit
-- rows with arbitrary amounts, categories, and other users' ids in
-- from/to/performed_by. Zero legitimate writers remain; this closes the
-- forge hole and keeps the table as readable history for the UI.
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Authenticated users can log transactions" ON public.chip_ledger;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON public.chip_ledger FROM anon, authenticated, PUBLIC;

-- The SELECT policy ("Users can view their own transactions") is kept: the
-- UI still shows historical rows.

-- wallet_transactions: RLS already denies client writes (only a SELECT-own
-- policy exists); strip the redundant grants so a future policy mistake
-- cannot silently re-open writes.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON public.wallet_transactions FROM anon, authenticated, PUBLIC;
