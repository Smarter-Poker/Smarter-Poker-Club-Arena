-- THE SUPPLY CHECK READS AN INDEX, NOT THE WHOLE LEDGER (2026-09-29)
--
-- DEFECT
-- public.fn_ca_mint_register_vs_supply runs four aggregates over
-- public.ca_mint_ledger on every call. Three of them read the whole heap:
--
--   r  : SUM(...) WHERE asset = 'chips'
--   ra : SUM(...) WHERE asset = 'chips' AND created_at <= snapshot.taken_at
--   c  : SUM(...) WHERE asset = 'chips'
--                   AND op_id LIKE 'register-opening-baseline-correction:%'
--                   AND created_at <= snapshot.taken_at
--
-- asset = 'chips' is 69.99% of the table (pg_stats most_common_freqs), so no
-- index can beat a heap scan on selectivity and the planner correctly chooses
-- a parallel sequential scan for r. ca_mint_ledger_asset_idx covers
-- (asset, action, created_at DESC) but omits amount, so it cannot answer the
-- sums from the index either; ra and c fall back to walking
-- ca_mint_ledger_created_idx and heap-fetching every row in range. c reads
-- 34,826 buffers to return 11 rows.
--
-- The only available win is an INDEX-ONLY scan: read a narrow index instead of
-- a 271 MB heap. That is what this migration adds.
--
-- PRODUCTION EVIDENCE (kuklfnapbkmacvwxktbh, 2026-09-29 08:2xZ)
--   pg_stat_user_tables.seq_scan on ca_mint_ledger ....... 31,304
--   avg rows per sequential scan ......................... 541,296
--   seq_tup_read ......................................... 16,944,752,750
-- 16.9 billion tuple reads, the single largest I/O consumer on the database.
-- The scans are invisible to pg_stat_statements because they happen inside a
-- PL/pgSQL body and the default pg_stat_statements.track = top does not record
-- nested statements; they were found through pg_stat_user_tables instead.
--
-- MEASURED ON A DISPOSABLE PG16 (524,555 rows, 271 MB heap, production's
-- measured asset/action distribution, identical index set):
--   buffers per call   104,327 (75,696 hit + 28,631 read)  ->  4,378 (0 read)
--   wall time          310-347 ms                          ->  76-140 ms
--   plan               1 parallel seq scan + 2 heap-fetching index scans
--                      ->  3 index-only scans
-- 23.8x less I/O per call. Index cost: 26 MB + 16 kB on a 424 MB table.
--
-- 23.8x is the ceiling, not the promise. The replica was freshly vacuumed, so
-- its visibility map was complete and every index-only scan stayed off the
-- heap. Production measured relallvisible = 18,037 of relpages = 23,554, i.e.
-- 76.6% all-visible, so roughly a quarter of pages still require a heap fetch
-- and the real gain will land below the replica's figure. That is also why
-- this migration does not stop at the indexes.
--
-- LOCKING
-- Both indexes are created CONCURRENTLY. ca_mint_ledger is on the hot money
-- path and takes writes continuously; a plain CREATE INDEX holds SHARE and
-- blocks those writes for the length of the build. Measured build times on the
-- replica were 541 ms plain and 622 ms concurrent, so the cost of CONCURRENTLY
-- is negligible and the risk it removes is not.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so this file
-- cannot be shipped by .github/workflows/apply-merged-migration.yml, which
-- sends its file in one transaction. It is applied through an autocommit
-- session instead, and NEVER inside the :50-:03 UTC break window.

-- (1) r and ra: the asset-scoped net-issuance sums become index-only.
--     Column order (asset, created_at) serves both the bare asset filter and
--     the asset + created_at range; action and amount ride along as payload so
--     the heap is never touched.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ca_mint_ledger_asset_created_net_idx
  ON public.ca_mint_ledger (asset, created_at)
  INCLUDE (action, amount);

-- (2) c: the baseline-correction sum. The partial predicate is written to match
--     the query's predicate EXACTLY -- Postgres's predicate-implication prover
--     does not reason about one LIKE pattern implying another, so a broader
--     'register-opening-baseline%' predicate would silently fail to match and
--     the scan would stay on the heap.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ca_mint_ledger_baseline_correction_idx
  ON public.ca_mint_ledger (asset, created_at)
  INCLUDE (action, amount)
  WHERE op_id LIKE 'register-opening-baseline-correction:%';

-- (3) Keep the visibility map fresh, or (1) and (2) quietly stop working.
--     An index-only scan is only index-only for pages the visibility map marks
--     all-visible. ca_mint_ledger is append-mostly on the money path and
--     carries (default) autovacuum settings: at the default insert scale factor
--     of 0.2 it needs ~105,000 inserts before an insert-triggered vacuum, and
--     production shows autovacuum_count = 0 with last_autovacuum NULL since the
--     last stats reset. Left alone, the map decays, the heap fetches come back,
--     and this migration silently reverts to the behaviour it was written to
--     fix. Scale factor 0 plus an absolute threshold is the same idiom already
--     used on ca_hand_transfers (150000) and daily_challenge_progress_events
--     (300000), scaled here to a much smaller table.
ALTER TABLE public.ca_mint_ledger SET (
  autovacuum_vacuum_scale_factor        = 0.0,
  autovacuum_vacuum_threshold           = 5000,
  autovacuum_vacuum_insert_scale_factor = 0.0,
  autovacuum_vacuum_insert_threshold    = 20000,
  autovacuum_analyze_scale_factor       = 0.0,
  autovacuum_analyze_threshold          = 5000
);

-- NOT ADDED, ON PURPOSE
-- b : SELECT min(created_at) WHERE op_id LIKE 'register-opening-baseline:%'
--     already costs 4 buffers. ca_mint_ledger_created_idx is (created_at DESC),
--     so a backward scan walks ascending and the baseline rows -- the oldest in
--     the table -- are found immediately. It needs no index and gets none.
--
-- An index is not a fix for an unbounded aggregate that keeps growing. This
-- buys roughly 24x, not permanence: fn_ca_mint_register_vs_supply re-derives
-- the entire net issuance from the beginning of time on every call, so its cost
-- still grows linearly with the ledger. The durable fix is a maintained
-- running total (a supply checkpoint the sweep reads forward from), which is a
-- larger change against money-path code and is deliberately not attempted here.

-- @live-proof: (SELECT count(*) FROM pg_index i
--   JOIN pg_class c ON c.oid = i.indexrelid
--   WHERE i.indrelid = 'public.ca_mint_ledger'::regclass
--     AND c.relname IN ('ca_mint_ledger_asset_created_net_idx',
--                       'ca_mint_ledger_baseline_correction_idx')
--     AND i.indisvalid) = 2
--   AND (SELECT array_to_string(reloptions, ',') FROM pg_class
--        WHERE oid = 'public.ca_mint_ledger'::regclass)
--       LIKE '%autovacuum_vacuum_insert_scale_factor=0%'
--
-- indisvalid matters: a CREATE INDEX CONCURRENTLY that fails leaves an INVALID
-- index behind that the planner will not use, and counting it would let this
-- migration certify a fix that is not there.
