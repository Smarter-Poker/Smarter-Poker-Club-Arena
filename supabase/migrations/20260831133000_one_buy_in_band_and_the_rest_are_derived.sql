-- ═══════════════════════════════════════════════════════════════════════════
-- ONE BUY-IN BAND. THE REST ARE DERIVED. (Phase 2 of the live cash audit)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- public.tables carried THREE buy-in column pairs and they disagreed on every
-- live cash table. Measured on production 2026-08-31, on a 1/2 table:
--
--     min_buy_in    / max_buy_in       80.00 / 400.00   40-200 BB   <- enforced
--     min_buyin     / max_buyin        40    / 200      BB units
--     min_buy_in_bb / max_buy_in_bb    2     / 25       WRONG
--
-- Which pair is real is not a matter of opinion. `atomic_table_buyin` — the
-- only hard enforcement of a buy-in anywhere in the product — reads
-- `min_buy_in` / `max_buy_in` and nothing else. So does the engine
-- (ServerTableEngineBase/Dealing/Settlement), so does the lobby through
-- src/lib/cashBuyIn.ts, and so does its server mirror. A census of the whole
-- database found no function, no view, no constraint and no policy that reads
-- any of the other four columns, and a grep of both repositories found exactly
-- one writer: TableConfigPage stamped min_buy_in_bb / max_buy_in_bb on every
-- table it created, in big blinds, beside a sibling it wrote in chips.
--
-- WHY THIS IS NOT COSMETIC. 2/25 is not a stale copy of the truth, it is the
-- DEFAULT from migration 010_table_configuration.sql, still sitting on 103,684
-- of 103,690 rows. A reader that picked max_buy_in_bb off a 1/2 table would cap
-- a player at 50 chips on a table advertising 400 — and there is nothing in the
-- schema that would have stopped it, because the column looks authoritative.
-- That is the same shape as the seat-law bug (PR #2012): a column that reads
-- like configuration, is written by a real product surface, and is wrong.
--
-- 20260828_cash_buyins_are_40bb_to_200bb.sql set out to end this — its own
-- comment says "the vestigial *_bb columns are resynced so the two column
-- families cannot disagree". It resynced the SIX rows its WHERE clause touched
-- and left the other 103,684 on the defaults. Resyncing is the wrong tool: a
-- copy that has to be maintained will drift again the next time a row is
-- inserted. The only version of "cannot disagree" that survives contact with a
-- live database is one the database enforces.
--
-- SO: the four orphans become GENERATED ALWAYS ... STORED columns computed from
-- the canonical pair. They keep their names and their types, so every SELECT
-- anywhere — including any client outside these two repositories — keeps
-- working and starts returning the truth. Postgres refuses a write to them
-- (error 428C9), so the fourth writer of a fifth opinion cannot be added.
--
-- Rounding is deliberately conservative in the direction that cannot mis-sell a
-- seat: the floor rounds UP and the ceiling rounds DOWN, so a naive reader of
-- the derived pair can never offer a buy-in `atomic_table_buyin` would refuse.
--
-- Tournament rows derive to NULL. Their 0/0 is legitimate (see the 2026-08-28
-- migration) and a tournament table has no cash buy-in band; NULL says that,
-- where a stamped 2/25 said something false.
--
-- NOT DROPPED. Dropping is cheaper — metadata only, no rewrite — and nothing in
-- either repository would notice. It is still the wrong call: a SELECT list in
-- a dashboard, a saved query or a PostgREST client outside these repositories
-- would break with no way for us to see it coming, and the failure would land
-- on whoever is on shift. A generated column costs one rewrite of a 58 MB table
-- and breaks nothing.
--
-- LOCK: this is a table rewrite and takes ACCESS EXCLUSIVE on the hottest
-- config table in the product. lock_timeout is set so it FAILS rather than
-- queues — a queued ACCESS EXCLUSIVE parks every reader behind it, which on a
-- felt dealing ~3,400 hands per 15 minutes is the outage this migration exists
-- to prevent. If it times out, run it again; do not raise the timeout.
--
-- Companion code change in the same commit: TableConfigPage stops writing the
-- derived columns (it would now raise 428C9 and break table creation), and
-- tests/unit/buyInBandIsOneColumnPair.test.ts pins the canonical pair so a
-- fifth opinion cannot be introduced in source.

BEGIN;

SET LOCAL lock_timeout = '4s';

-- One statement, so Postgres rewrites the heap once rather than four times.
ALTER TABLE public.tables
  DROP COLUMN min_buy_in_bb,
  DROP COLUMN max_buy_in_bb,
  DROP COLUMN min_buyin,
  DROP COLUMN max_buyin,
  ADD COLUMN min_buy_in_bb integer GENERATED ALWAYS AS (
    CASE WHEN tournament_id IS NULL
          AND COALESCE(big_blind, 0) > 0
          AND min_buy_in IS NOT NULL
         THEN ceil(min_buy_in / big_blind)::integer
    END) STORED,
  ADD COLUMN max_buy_in_bb integer GENERATED ALWAYS AS (
    CASE WHEN tournament_id IS NULL
          AND COALESCE(big_blind, 0) > 0
          AND max_buy_in IS NOT NULL
         THEN floor(max_buy_in / big_blind)::integer
    END) STORED,
  ADD COLUMN min_buyin integer GENERATED ALWAYS AS (
    CASE WHEN tournament_id IS NULL
          AND COALESCE(big_blind, 0) > 0
          AND min_buy_in IS NOT NULL
         THEN ceil(min_buy_in / big_blind)::integer
    END) STORED,
  ADD COLUMN max_buyin integer GENERATED ALWAYS AS (
    CASE WHEN tournament_id IS NULL
          AND COALESCE(big_blind, 0) > 0
          AND max_buy_in IS NOT NULL
         THEN floor(max_buy_in / big_blind)::integer
    END) STORED;

COMMENT ON COLUMN public.tables.min_buy_in IS
  'CANONICAL. Smallest stack this table sells, in CHIPS. Enforced by atomic_table_buyin and read by the engine; every other buy-in column on this table is derived from this one.';
COMMENT ON COLUMN public.tables.max_buy_in IS
  'CANONICAL. Largest stack this table sells, in CHIPS. Enforced by atomic_table_buyin and read by the engine; every other buy-in column on this table is derived from this one.';
COMMENT ON COLUMN public.tables.min_buy_in_bb IS
  'DERIVED, read-only. ceil(min_buy_in / big_blind). NULL on tournament rows and on rows with no blinds. Write min_buy_in instead.';
COMMENT ON COLUMN public.tables.max_buy_in_bb IS
  'DERIVED, read-only. floor(max_buy_in / big_blind). NULL on tournament rows and on rows with no blinds. Write max_buy_in instead.';
COMMENT ON COLUMN public.tables.min_buyin IS
  'DERIVED, read-only. Legacy alias of min_buy_in_bb kept so external SELECT lists keep working. Write min_buy_in instead.';
COMMENT ON COLUMN public.tables.max_buyin IS
  'DERIVED, read-only. Legacy alias of max_buy_in_bb kept so external SELECT lists keep working. Write max_buy_in instead.';

-- ── Assert the three families now agree on every live cash table ──
DO $$
DECLARE
  v_disagree integer;
  v_live     integer;
BEGIN
  SELECT count(*) INTO v_disagree
    FROM public.tables
   WHERE tournament_id IS NULL
     AND COALESCE(big_blind, 0) > 0
     AND (min_buy_in_bb IS DISTINCT FROM min_buyin
       OR max_buy_in_bb IS DISTINCT FROM max_buyin);
  IF v_disagree > 0 THEN
    RAISE EXCEPTION 'the derived buy-in columns disagree on % cash rows', v_disagree;
  END IF;

  SELECT count(*) INTO v_live
    FROM public.tables
   WHERE tournament_id IS NULL
     AND status = 'running'
     AND (min_buy_in_bb, max_buy_in_bb) IS DISTINCT FROM (40, 200);
  IF v_live > 0 THEN
    RAISE EXCEPTION
      'expected every running cash table to derive to the 40-200BB band, % did not', v_live;
  END IF;
END $$;

COMMIT;
