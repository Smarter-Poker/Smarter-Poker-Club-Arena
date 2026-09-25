-- ═══════════════════════════════════════════════════════════════════════════
--  THE JACKPOT RATE READ STOPS SCANNING EVERY CONTRIBUTION
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_bbj_mini_for_club` is the slowest statement per call on the platform:
-- 3,589.8 ms mean over 7,621 calls, 27,358 seconds of database time in the
-- 9.8 days since the 2026-09-10 stats reset. It is the club operator's Mini
-- Bad Beat panel: pool balance, tier payability, and the in/out/net per-day
-- rates that are the club's jackpot rake income.
--
-- WHERE THE TIME GOES. Of the tables it touches, `bbj_winners` holds 60 rows
-- and is free. `bbj_contributions` holds 1,565,263 rows over 581 MB, and the
-- `flow` CTE reads it as
--
--     sum(x.backup_portion) FROM bbj_contributions x
--       JOIN pool ON x.pool_id = pool.pool_id
--      WHERE x.created_at > now() - (win.days * interval '1 day')
--
-- There is no index on `created_at` at all, and none of the five existing
-- indexes leads with `pool_id` without also requiring `hand_id` or
-- `table_id`/`hand_number`. Measured plan for that subquery alone, 2026-09-19:
--
--     Parallel Seq Scan on bbj_contributions x
--       Filter: ((pool_id = ...) AND (created_at > now() - '7 days'))
--       Rows Removed by Filter: 733,396      (per worker, 2 loops)
--       Buffers: shared hit=36,903
--     Execution Time: 383.438 ms
--
-- 1.47 million rows examined to return 50,120, to compute one club's daily
-- rate, on every panel open.
--
-- WHY A COVERING INDEX AND NOT JUST (pool_id, created_at). The read is a pure
-- aggregate over `backup_portion`, so INCLUDE lets it finish in the index
-- without 50,120 heap fetches. `bbj_contributions` is append-only in practice
-- (324,497 inserts and ZERO updates or deletes in the window), so the
-- visibility map stays set and index-only scans actually happen, and new rows
-- append to the right-hand edge of each pool rather than splitting pages.
-- Measured cost of the extra index: 74 MB against a 581 MB table whose
-- indexes already total 293 MB, and 33,078 inserts per day to maintain it.
--
-- WHY THIS IS IN THE :55 FREEZE, following 20260905042500 exactly. A plain
-- CREATE INDEX holds a lock that blocks writers for the length of its scan,
-- and a `bbj_contributions` insert happens inside hand settlement
-- (`fn_ca_commit_hand_settlement`, 3,946,449 calls) - so blocking it blocks
-- hands. CREATE INDEX CONCURRENTLY cannot run inside the single transaction a
-- migration must be. During the freeze every table is parked at a hand
-- boundary and nothing is writing, which is what the window is for
-- (CLAUDE.md 13).
--
-- A CONCURRENTLY build was attempted outside the window on 2026-09-19 and was
-- terminated by the client layer in its final phase, leaving the index
-- `indisvalid = false`: invisible to the planner and still maintained on every
-- insert. It was dropped, the table was verified back at 293 MB of indexes and
-- zero invalid indexes in `public`, and the attempt is recorded here so the
-- next reader does not repeat it outside the freeze.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '0';

CREATE INDEX IF NOT EXISTS idx_bbj_contrib_pool_created
  ON public.bbj_contributions (pool_id, created_at)
  INCLUDE (backup_portion);

COMMENT ON INDEX public.idx_bbj_contrib_pool_created IS
  'Serves the flow CTE of fn_bbj_mini_for_club: one pool''s backup_portion over a 0.5 to 7 day window as a range scan instead of a parallel sequential scan that removed 733,396 rows per worker (383 ms for that subquery alone, 3,589.8 ms for the function).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='bbj_contributions'
       AND indexname='idx_bbj_contrib_pool_created'
  ) THEN
    RAISE EXCEPTION 'the jackpot rate read has no index for its range';
  END IF;

  /* An index the planner will not use is not a fix. A CONCURRENTLY build that
     was interrupted leaves exactly this state, and it costs writes while
     serving no read, so refuse rather than report success. */
  IF EXISTS (
    SELECT 1 FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
     WHERE i.relname='idx_bbj_contrib_pool_created' AND NOT x.indisvalid
  ) THEN
    RAISE EXCEPTION 'the range index exists but is INVALID: it would be maintained on every insert and read by nothing';
  END IF;
END $$;

COMMIT;
