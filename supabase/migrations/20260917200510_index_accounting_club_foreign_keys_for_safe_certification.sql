-- Four installed accounting tables introduced club foreign keys without a
-- valid full leading-column index. Post-deploy run 35266814559 correctly
-- refused production fixtures before cleanup could strand their balances.
-- At 2026-09-17 20:03 UTC the largest child occupied 1,073,152 heap bytes
-- (~6,633 estimated rows); the others were empty or two rows. Keep the DDL
-- transaction short and fail on lock contention. No records, balances,
-- constraints, privileges or financial behavior are changed.
-- Depends on installed accounting migrations 20260914110557/20260917181100.
-- Existing fn_ca_fk_index_gaps and post-deploy checks retain regression coverage.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

CREATE INDEX IF NOT EXISTS idx_accounting_cash_bank_receipts_club_id_fk
  ON public.accounting_cash_bank_receipts (club_id);
CREATE INDEX IF NOT EXISTS idx_union_accounting_runs_standalone_club_id_fk
  ON public.union_accounting_runs (standalone_club_id);
CREATE INDEX IF NOT EXISTS idx_accounting_rakeback_period_calculations_club_id_fk
  ON public.accounting_rakeback_period_calculations (club_id);
CREATE INDEX IF NOT EXISTS idx_accounting_correction_documents_club_id_fk
  ON public.accounting_correction_documents (club_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.fn_ca_fk_index_gaps('public.clubs')->'gaps') AS gap
    WHERE gap->>'child_table' IN (
      'accounting_cash_bank_receipts', 'union_accounting_runs',
      'accounting_rakeback_period_calculations', 'accounting_correction_documents'
    )
  ) THEN
    RAISE EXCEPTION 'Accounting club foreign key index qualification failed';
  END IF;
END;
$$;
COMMIT;
