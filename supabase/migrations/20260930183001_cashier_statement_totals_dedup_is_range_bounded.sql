-- 20260930183001_cashier_statement_totals_dedup_is_range_bounded.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- fn_cashier_statement_totals times out for real club admins. Measured on
-- production 2026-09-30 from pg_stat_statements: 21 calls, mean 3,482 ms, max
-- 7,968.7 ms against the authenticated role's 8s statement_timeout, and 12 of
-- 16 calls in 24h answered HTTP 500. The page prints "Unavailable For This
-- Range" and tests/e2e/production-cashier-statements.spec.ts fails at its
-- totals verdict.
--
-- THE PLAN, READ NOT ASSUMED. EXPLAIN (ANALYZE, BUFFERS) of the generated
-- totals SQL for club a41434bb-8d0c-400a-8f0d-e8b3d65afed4 over its default
-- last-7-day range (50,014 receipts + 27,031 movements = 77,045 entries):
--
--   HashAggregate                                          6,038 ms
--     CTE omitted_movements ............................... 2,756 ms
--       Index Scan using ux_chip_transactions_idempotency_key
--         rows=8  Rows Removed by Filter: 1146
--         Buffers: shared hit=165 read=828 ................ 2,709 ms
--     Index Only Scan idx_chip_tx_club_time_totals ........ 3,036 ms
--     Index Only Scan idx_chip_ledger_cashier_totals_cover .. 113 ms
--
-- The two branch scans are already optimal and are NOT what this migration
-- touches: both are index-only on purpose-built covering indexes, and a
-- hand-written two-column version of the receipt branch produces identical
-- Buffers and Heap Fetches, so the projection is already eliminated.
--
-- THE DEFECT IS THE DE-DUPLICATION CTE, AND IT IS O(ALL TIME).
--
-- The totals mode omitted_movements CTE excludes chip_ledger movements that a
-- chip_transactions receipt already mirrors, so neither is counted twice. Its
-- first arm filters represented.club_id and represented.created_at, but the
-- only index that can serve metadata ? 'idempotency_key' is
-- ux_chip_transactions_idempotency_key, which is keyed on the extracted key
-- alone and carries NEITHER column. So the planner scans that index in full -
-- every receipt ever written on the platform that carries an idempotency key,
-- for every club - and visits the heap once per entry to evaluate club and
-- range. Measured: 1,154 entries scanned and 1,146 discarded to find 8, at a
-- cost of 828 cold random heap reads and 2,709 ms - about 45% of the cold call.
--
-- A one-day range costs exactly as much as a ninety-two-day range, and the cost
-- grows with total platform history rather than with what the admin asked for:
-- 1,154 such receipts exist today and every idempotent receipt adds one.
--
-- THE FIX: give that arm an index it can range-scan. The new partial index
-- carries club_id and created_at as leading keys and the extracted key as its
-- third column, so the arm becomes an index-only scan over just this club's
-- in-range entries with no heap visit at all. It indexes 1,154 of 1,050,406
-- rows (~0.1%), so it is tens of kilobytes.
--
-- This is the whole of the change. No behaviour moves: the CTE's SQL, its
-- semantics and every row it omits are untouched, so the totals it produces are
-- identical - only the access path changes. Nothing is pre-aggregated, cached,
-- swept or back-filled (CLAUDE.md 10.11, 10.12), and no statement_timeout is
-- touched (CLAUDE.md section 2).
--
-- WHAT THIS DOES NOT FIX, STATED PLAINLY. The residual cost is the two branch
-- scans' heap fetches: 3,947 on chip_transactions and 1,484 on chip_ledger for
-- the default range. Those are visibility-map misses on recently written pages,
-- not query waste, and no index or rewrite removes them. The contrast is exact
-- and was measured on the same index: over an OLDER week the ledger scan
-- returns 75,796 rows with 7 heap fetches in 63 ms (968 cold reads, sequential,
-- 0.065 ms each), while over the CURRENT week it returns 27,103 rows with 1,484
-- heap fetches and cost up to 3,674 ms (random, ~2.5 ms each). Reducing that
-- needs the visibility map to be current for freshly written pages, which is a
-- VACUUM question and not a migration's to settle; it is recorded in
-- docs/changelog/2026-09-30-the-cashier-totals-dedup-reads-all-of-history.md
-- with its measurements so the next agent starts from data.
--
-- LOCK IMPLICATIONS. chip_transactions is written by the live money path, so a
-- plain CREATE INDEX is refused here: it holds SHARE for the whole build and
-- blocks every INSERT (CLAUDE.md section 2 rule 7). CONCURRENTLY takes only
-- SHARE UPDATE EXCLUSIVE, so readers and writers continue throughout; it costs
-- two table passes and cannot run inside a transaction block, which is why it
-- precedes BEGIN here - the one shape
-- scripts/ci/migration-concurrent-preamble.mjs accepts. A failed build leaves
-- an INVALID index; the transaction below refuses to commit in that case and
-- names the DROP INDEX CONCURRENTLY to run.

-- ROLLBACK (online):
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_chip_tx_club_time_idempotency_key;
-- Dropping it restores the previous plan and the previous timeout. It changes
-- no totals: the index is an access path, never a filter.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_tx_club_time_idempotency_key
  ON public.chip_transactions (club_id, created_at, ((metadata ->> 'idempotency_key')))
  WHERE metadata ? 'idempotency_key';

BEGIN;

-- The concurrent build above is the only reason this migration exists, so the
-- transaction refuses to record itself unless that index is present AND VALID.
-- An INVALID leftover from an interrupted build would still be ignored by the
-- planner, which would leave the timeout in place while the history row claimed
-- the fix had landed (CLAUDE.md 10.86 rule 1: a signal must not answer when it
-- does not know).
DO $checks$
DECLARE
  v_oid oid;
  v_valid boolean;
BEGIN
  SELECT c.oid INTO v_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'idx_chip_tx_club_time_idempotency_key';

  IF v_oid IS NULL THEN
    RAISE EXCEPTION
      'idx_chip_tx_club_time_idempotency_key was not built; the CONCURRENTLY preamble did not run';
  END IF;

  SELECT i.indisvalid AND i.indisready INTO v_valid FROM pg_index i WHERE i.indexrelid = v_oid;

  IF NOT v_valid THEN
    RAISE EXCEPTION
      'idx_chip_tx_club_time_idempotency_key exists but is INVALID. Run: DROP INDEX CONCURRENTLY IF EXISTS public.idx_chip_tx_club_time_idempotency_key; then dispatch this migration again.';
  END IF;
END;
$checks$;

COMMENT ON INDEX public.idx_chip_tx_club_time_idempotency_key IS
  'Bounds the cashier statement totals de-duplication to the range asked for. Without it fn_cashier_statement_rows scans ux_chip_transactions_idempotency_key in full - every idempotent receipt on the platform, for every club - and heap-visits each to filter club and range: 1,154 entries and 828 cold reads to find 8, 2,709 ms of a 6,038 ms call measured 2026-09-30. Leading keys are club_id and created_at so the arm range-scans, and the extracted idempotency key is carried so it stays index-only.';

COMMIT;
