-- 20261001152917_conservation_sweep_reads_use_covering_partial_indexes.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE HOURLY CONSERVATION SWEEP TIMES OUT BECAUSE FOUR OF ITS READS GROW WITH
-- ALL OF HISTORY (2026-09-27). Recording-only: no function, predicate, grant,
-- row or accounting outcome changes here.
--
-- fn_ca_conservation_sweep runs 30 checks inside ONE cron statement under the
-- postgres role's 120 s statement_timeout. A cancel (SQLSTATE 57014) is not
-- caught by the per-check EXCEPTION WHEN OTHERS, so one slow read rolls back
-- the whole sweep and records nothing for any class. Completed runs took
-- 50-110 s; on 2026-09-26 8 of 24 completed and on 2026-09-27 1 of 16. The
-- cancel lands wherever the clock runs out (fn_chip_integrity_report,
-- fn_settlement_conservation_check, fn_satellite_conservation_audit,
-- fn_ca_payout_rows_without_money, fn_ca_stranded_tournament_players,
-- fn_bbj_conservation_check ...), so no single message names the cause.
--
-- Measured read-only on production 2026-09-27 16:05-16:30 UTC, each sub-check
-- alone (the settlement and satellite reads were already indexed by #5392):
--   fn_chip_drift_since_baseline (inside fn_chip_integrity_report, the FIRST
--     check): 4.7 s hot and serial; an index scan on idx_chip_ledger_created_at
--     touches 3,275,432 buffers to aggregate 1,032,144 player_wallet legs out
--     of 6.2M rows since the 2026-08-26 baseline; 6.9 s to 31.8 s measured
--     through the function depending on cache and load. A cancel at 00:52 UTC
--     landed inside it, i.e. it alone exceeded 120 s at the :52 slot.
--   fn_bbj_conservation_check epoch identity: 3.5 s hot and serial; 2,395,022
--     buffers for 2,524,067 bbj_pool legs out of 4.86M rows; 3.7 s to 29.4 s
--     through the function.
--   fn_ca_payout_rows_without_money: 4.3-5.8 s; a sequential scan of all
--     tournament_payouts (106 MB) for a 3-day window, plus min(created_at) of
--     wallet_credit_idempotency by a sequential scan of 486k rows (125 MB).
-- Each is O(all history) by construction and cold at the :52 slot, when the
-- hand-history prune/compact/vacuum jobs run beside it.
--
-- RE-MEASURED 2026-10-01. 3b6033cd7 (#5462) gave the job a 600 s budget and
-- every run has completed since 2026-09-28 14:52 UTC, but the cost keeps
-- growing with history: daily mean duration 56 s (09-25), 98 s (09-27),
-- 178 s (09-28), 194 s (09-29), 230 s (09-30), 260 s (10-01, max 321 s).
-- Read-only, each alone, ~15:00 UTC: fn_ca_payout_rows_without_money(3)
-- 74.1 s (312,465 buffers, 0 rows); fn_chip_integrity_report() cancelled at
-- 120 s inside fn_chip_drift_since_baseline; fn_bbj_conservation_check()
-- cancelled at 120 s inside its epoch sum. chip_ledger ~7.6M rows, 3.5 GB.
--
-- THE FIX: four online indexes built by
-- scripts/ops/build-conservation-sweep-read-indexes-concurrently.sql (one
-- CREATE INDEX CONCURRENTLY each, outside any transaction). The two chip_ledger
-- indexes are partial and covering, so each read becomes an index-only scan of
-- exactly the legs it sums, instead of a heap visit per ledger row since the
-- baseline. This transaction builds nothing: it refuses to record unless all
-- four exist with the exact shape, are valid/ready/live, and the three reading
-- functions are byte-identical to the bodies the plans were qualified against.
--
-- Qualified by scripts/ci/test-conservation-sweep-read-indexes-postgres.py on a
-- native PostgreSQL cluster: identical results before and after, every read
-- switches to its index, and chip_ledger buffer reads fall by more than 4x.
-- That is local evidence; the production sweep duration after install is
-- separate evidence, recorded against incident ca-conservation-sweep-hourly.
--
-- @live-proof: select c.relname, i.indisvalid, i.indisready, i.indislive from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname in ('idx_chip_ledger_player_wallet_drift','idx_chip_ledger_bbj_pool_epoch','idx_tournament_payouts_paid_at','idx_wallet_credit_idempotency_created_at');

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = public, pg_temp;

DO $verify$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('idx_chip_ledger_player_wallet_drift', 'public.chip_ledger',
       'CREATE INDEX idx_chip_ledger_player_wallet_drift ON public.chip_ledger USING btree (created_at) INCLUDE (club_id, to_type, to_entity_id, from_type, from_entity_id, amount) WHERE ((club_id IS NOT NULL) AND ((to_type = ''player_wallet''::text) OR (from_type = ''player_wallet''::text)))'),
      ('idx_chip_ledger_bbj_pool_epoch', 'public.chip_ledger',
       'CREATE INDEX idx_chip_ledger_bbj_pool_epoch ON public.chip_ledger USING btree (created_at) INCLUDE (to_type, from_type, amount) WHERE ((to_type = ''bbj_pool''::text) OR (from_type = ''bbj_pool''::text))'),
      ('idx_tournament_payouts_paid_at', 'public.tournament_payouts',
       'CREATE INDEX idx_tournament_payouts_paid_at ON public.tournament_payouts USING btree (paid_at)'),
      ('idx_wallet_credit_idempotency_created_at', 'public.wallet_credit_idempotency',
       'CREATE INDEX idx_wallet_credit_idempotency_created_at ON public.wallet_credit_idempotency USING btree (created_at)')
    ) v(name, rel, def)
  LOOP
    IF to_regclass('public.' || r.name) IS NULL THEN
      RAISE EXCEPTION 'SWEEP_READ_INDEX_MISSING_BUILD_ONLINE: %', r.name USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
        JOIN pg_class ix ON ix.oid = i.indexrelid
        JOIN pg_class tab ON tab.oid = i.indrelid
       WHERE i.indexrelid = ('public.' || r.name)::regclass
         AND i.indrelid = r.rel::regclass
         AND i.indisvalid AND i.indisready AND i.indislive
         AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
         AND pg_get_userbyid(ix.relowner) = 'postgres'
         AND pg_get_userbyid(tab.relowner) = 'postgres'
         AND pg_get_indexdef(i.indexrelid) = r.def
    ) THEN
      RAISE EXCEPTION 'SWEEP_READ_INDEX_CONTRACT_CHANGED: %', r.name USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- The plans were qualified against these exact installed bodies.
  IF md5(pg_get_functiondef('public.fn_chip_drift_since_baseline()'::regprocedure))
       IS DISTINCT FROM 'd0f1d4f355477669a4bc0427de757581'
     OR md5(pg_get_functiondef('public.fn_bbj_conservation_check()'::regprocedure))
       IS DISTINCT FROM 'cd515fb20589a20ba6b930a6831610b8'
     OR md5(pg_get_functiondef('public.fn_ca_payout_rows_without_money(integer)'::regprocedure))
       IS DISTINCT FROM 'f5cf519b32f61707d283d634c39190f2' THEN
    RAISE EXCEPTION 'SWEEP_READ_SOURCE_CHANGED' USING ERRCODE = '55000';
  END IF;
END
$verify$;

COMMIT;
