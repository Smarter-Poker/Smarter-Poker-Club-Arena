-- 20260917195207_accounting_club_foreign_keys_stay_indexed.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Post-deploy run35266814559 refused production browser certification because
-- these four accounting foreign keys require full child-table scans on club
-- deletion. The same live catalogue guard passed at16:58:57UTC before these
-- references appeared. Keep each referencing column first in a valid, plain
-- index; partial or non-leading indexes cannot satisfy the FK lookup.
-- Read-only production measurement at19:51UTC: cash-bank receipts6453 rows,
-- 1.03MiB; union runs2 rows/8KiB; calculations and correction documents empty.
-- The bounded single transaction follows the existing tournament-refund FK
-- index migration. No account, wallet, receipt, FK or accounting rule changes.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_accounting_cash_bank_receipts_club_id_fk
  ON public.accounting_cash_bank_receipts (club_id);
CREATE INDEX IF NOT EXISTS idx_union_accounting_runs_standalone_club_id_fk
  ON public.union_accounting_runs (standalone_club_id);
CREATE INDEX IF NOT EXISTS idx_accounting_rakeback_period_calculations_club_id_fk
  ON public.accounting_rakeback_period_calculations (club_id);
CREATE INDEX IF NOT EXISTS idx_accounting_correction_documents_club_id_fk
  ON public.accounting_correction_documents (club_id);

COMMIT;
