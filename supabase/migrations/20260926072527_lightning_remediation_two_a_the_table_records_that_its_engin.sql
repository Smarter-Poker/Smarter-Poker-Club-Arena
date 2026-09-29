-- 20260926072527_lightning_remediation_two_a_the_table_records_that_its_engin.sql
--
-- LIGHTNING REMEDIATION TWO, FILE A OF FOUR: THE TABLE RECORDS THAT ITS ENGINE
-- SAW THE HALT.
--
-- One column on public.tables, alone in its own transaction. `tables` is read
-- by every engine loop and every table_seats trigger that looks up its parent,
-- and ADD COLUMN takes ACCESS EXCLUSIVE on it until COMMIT. So this file
-- touches nothing else - above all not table_seats, whose BEFORE triggers read
-- `tables`: a file holding `tables` while waiting on `table_seats` could
-- deadlock a live settlement or buy-in holding the other way round. The wait
-- is two seconds, then a clean refusal to be re-run once.
--
-- tables.dealing_halt_observed_at is stamped by
-- fn_cash_table_observe_dealing_halt (file C) when the engine, parked at its
-- halt gate between hands, reports that it has seen dealing_halted_at. The
-- conversion commits only when every member table with a live engine lease has
-- dealing_halt_observed_at >= dealing_halted_at. Nullable, no default: a
-- catalogue-only change, no rewrite.
--
-- Files B, C and D follow; each is its own transaction and each is re-appliable.
--
-- @live-proof: (SELECT a.atttypid = 'timestamptz'::regtype FROM pg_attribute a WHERE a.attrelid = 'public.tables'::regclass AND a.attname = 'dealing_halt_observed_at' AND NOT a.attisdropped)

BEGIN;

SET LOCAL lock_timeout = '2s';

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS dealing_halt_observed_at timestamptz;

COMMENT ON COLUMN public.tables.dealing_halt_observed_at IS
  'When the engine last reported, through fn_cash_table_observe_dealing_halt from its halt gate between hands, that it has seen this table''s dealing halt. A halt is a stop only once dealing_halt_observed_at >= dealing_halted_at; fn_cash_cluster_commit_lightning waits for that on every member table with a live engine lease.';

COMMIT;
