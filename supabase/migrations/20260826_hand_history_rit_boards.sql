-- ═══════════════════════════════════════════════════════════════════════════
-- hand_history.rit_boards — Run It Twice boards, first-class (2026-08-26)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A run-it-twice hand has been indistinguishable from a normal one in the
-- database since the feature shipped: board 1 went to community_cards and
-- boards 2..N were smuggled through the `actions` JSONB as `rit_board_N:`
-- pseudo-action strings that every reader had to parse back out (recorded as
-- the open item in MIGRATION-CHANGELOG 2026-08-21: "RIT boards are never
-- persisted ... NEXT STEP, and it is small: persist the extra board(s)").
--
-- This column is that record: a JSONB array of boards 2..N in run order,
-- each board an array of engine card strings ('Ahearts', '10diamonds').
-- NULL on every single-run hand — so the 5M+ historical rows and a normal
-- hand look identical to readers, and `rit_boards IS NOT NULL` is the exact
-- predicate for "this hand ran multiple boards".
--
-- Writer: server/src/services/supabase/handHistory.ts (logHandHistory).
-- Readers: src/services/HandHistoryService.ts (mapHandHistoryRow, with a
-- pseudo-action fallback for pre-column rows), replay surfaces.
--
-- Tier 2 (additive, nullable, no backfill). ROLLBACK:
--   ALTER TABLE public.hand_history DROP COLUMN IF EXISTS rit_boards;

ALTER TABLE public.hand_history
  ADD COLUMN IF NOT EXISTS rit_boards jsonb;

COMMENT ON COLUMN public.hand_history.rit_boards IS
  'Run It Twice boards 2..N in run order (JSONB array of arrays of engine card strings, e.g. [["Ahearts","Kdiamonds",...],[...]]). NULL on single-run hands. Board 1 remains community_cards. Added 2026-08-26; boards 2..N also exist as rit_board_N: pseudo-actions in `actions` for rows that predate this column.';

-- Post-apply assertion: the column exists with the right type.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'hand_history'
      AND column_name = 'rit_boards'
      AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'hand_history.rit_boards was not created as jsonb';
  END IF;
END $$;
