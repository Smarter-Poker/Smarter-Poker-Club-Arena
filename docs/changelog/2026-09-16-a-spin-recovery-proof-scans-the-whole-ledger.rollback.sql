-- Rollback for 20260916193500_a_spin_recovery_proof_scans_the_whole_ledger.sql
--
-- Removing this index returns fn_prove_played_spin_launch_recovery to a
-- parallel sequential scan of 809,372 chip_ledger rows per worker: a 3,109 ms
-- mean over 254 calls with a 9,885 ms worst case against its own 10 s
-- statement timeout, measured on 2026-09-16. A proof that cannot be read is a
-- Spin that stands down with three paid seats instead of dealing, which is the
-- door behind the forty stranded Spins of 2026-09-12. There is no reason to
-- run this.

DROP INDEX CONCURRENTLY IF EXISTS public.idx_chip_ledger_tournament_category;
