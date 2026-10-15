-- 20261015165657_the_conservation_report_reads_treasury_legs_from_covering_in.sql
--
-- THE CONSERVATION REPORT READS TREASURY LEGS FROM COVERING INDEXES (2026-10-15)
--
-- Cashier "Reconcile Now" (fn_cashier_conservation_report) returned 500 on
-- production: statement timeout (authenticated budget 8 s). Post-deploy run
-- 38763007185, job 116519227113, 15:50 UTC. Measured as the club owner:
-- Deep Stack Society 30.1 s; the bank leg alone took 2.7 s warm and 52.9 s
-- under the generic plan PL/pgSQL settles on.
--
-- Cause, read from the plans: the bank sums filter
--   club_id = p AND to_type/from_type = 'club_treasury' AND to/from_entity_id = p
--   AND created_at >= baseline
-- but idx_chip_ledger_treasury_in/_out are keyed (entity, created_at) and
-- carry only amount, so club_id forced a heap fetch for every leg since the
-- 2026-08-31 baseline (565,800 treasury credits for one club, growing with
-- every raked hand). The generic plan instead walked
-- idx_chip_ledger_club_to_created and fetched the same heap rows.
--
-- Fix: two partial covering indexes keyed (entity, club_id, created_at)
-- INCLUDE (amount). Both sums become index-only scans under the custom and the
-- generic plan (Heap Fetches 0-2, 2 ms). After the build, as the club owner:
-- Deep Stack Society 0.21 s, SHARK CLUB 1.7 s, Club JAQK 1.4 s. The report
-- function, its output, authorization and grants are unchanged; no row moves.
--
-- HOW IT WAS APPLIED. A concurrent build waits out every older transaction and
-- scans the 6.2 GB heap twice, which the postgres role's 2-minute
-- statement_timeout cancels (the same limit 20261003031000 records). As there,
-- each statement below ran in production OUTSIDE any transaction as the whole
-- command of its own one-shot pg_cron job (jobs 492-494, 16:54 UTC, all
-- succeeded and unscheduled), with `ALTER ROLE postgres IN DATABASE postgres
-- SET statement_timeout = '20min'` in force only from 16:51:44 until the jobs
-- had started, then RESET (no postgres/postgres row remains). An earlier
-- attempt's cancelled builds left invalid leftovers; they were dropped or
-- rebuilt concurrently by the same jobs. The IF NOT EXISTS forms below are the
-- replay for a database that has not run them; the transaction asserts the
-- end state either way.
--
-- @live-proof: (SELECT bool_and(indisvalid AND indisready AND indislive) AND count(*) = 2 FROM pg_index WHERE indexrelid IN (to_regclass('public.idx_chip_ledger_treasury_in_by_club'), to_regclass('public.idx_chip_ledger_treasury_out_by_club')))

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_treasury_in_by_club
  ON public.chip_ledger (to_entity_id, club_id, created_at)
  INCLUDE (amount)
  WHERE to_type = 'club_treasury' AND to_entity_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_treasury_out_by_club
  ON public.chip_ledger (from_entity_id, club_id, created_at)
  INCLUDE (amount)
  WHERE from_type = 'club_treasury' AND from_entity_id IS NOT NULL;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $assert$
BEGIN
  IF (SELECT count(*) FROM pg_index
       WHERE indexrelid IN (to_regclass('public.idx_chip_ledger_treasury_in_by_club'),
                            to_regclass('public.idx_chip_ledger_treasury_out_by_club'))
         AND indisvalid AND indisready AND indislive) <> 2
  OR to_regclass('public.idx_chip_ledger_treasury_in_by_club_ccnew') IS NOT NULL
  THEN
    RAISE EXCEPTION 'TREASURY_COVERING_INDEXES_NOT_VALID';
  END IF;
END $assert$;

COMMIT;
