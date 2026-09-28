-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260905162352 "hand_history_rit_pot_awards"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 92372be76d6d3432872f16a94f0a7cd0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- hand_history.rit_pot_awards — per-(run, pot) award breakdown (2026-09-05)
--
-- A run-it-twice hand settles as ONE merged credit per player. `winners` has
-- therefore always recorded a net total with potIndex stamped 0, and across
-- the 6,940 multi-board hands on record not one row carries a board axis or a
-- non-zero pot index. The database could say a hand ran three boards
-- (rit_boards) but never who won which board, from which pot, for how much.
--
-- This column is that record: one entry per (run, pot, winner) share, in award
-- order. NULL on every single-run hand, so historical rows and normal hands
-- look identical and `rit_pot_awards IS NOT NULL` is the exact predicate for
-- "this hand has a per-board settlement breakdown".
--
-- Tier 2 (additive, nullable, no backfill). ROLLBACK:
--   ALTER TABLE public.hand_history DROP COLUMN IF EXISTS rit_pot_awards;

ALTER TABLE public.hand_history
  ADD COLUMN IF NOT EXISTS rit_pot_awards jsonb;

COMMENT ON COLUMN public.hand_history.rit_pot_awards IS
  'Run-it-twice per-(run, pot) award breakdown, in award order: [{"board":1,"potIndex":0,"userId":"...","amount":2.73,"low":false,"handName":"Two Pair"}]. NULL on single-run hands, where `winners` + `pots` already tell the whole story. Board 1..N matches rit_boards run order (board 1 = community_cards). Amounts are post-rake and sum per player to that player''s entry in `winners`. Added 2026-09-05.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'hand_history'
      AND column_name = 'rit_pot_awards'
      AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'hand_history.rit_pot_awards was not created as jsonb';
  END IF;
END $$;
