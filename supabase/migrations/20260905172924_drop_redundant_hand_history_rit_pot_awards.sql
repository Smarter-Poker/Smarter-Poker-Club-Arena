-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260905172924 "drop_redundant_hand_history_rit_pot_awards"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0f01b9c5eeb9aff899922e786e521e6d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Drop hand_history.rit_pot_awards — added and withdrawn the same day (2026-09-05)
--
-- I added this column earlier today to record which run/pot paid whom on a
-- run-it-twice hand, having measured that no such record existed: of 6,940
-- multi-board hands, not one carried a board axis or a non-zero pot index.
--
-- That was true when measured and is no longer true. `hand_history.
-- winners_by_board` (shipped 2026-09-04, while this work was in progress)
-- answers the same question through a path that is already complete end to
-- end: the engine writes it, `handReplay.ts` reads it into the ReplayModel,
-- and every hand-history surface draws from that one model. It is live and
-- populated on 299 hands.
--
-- Two columns answering "who won which board" is the failure mode this repo
-- warns about in HandHistoryPanel.tsx: "Do not reintroduce a second source
-- for this - two of them can disagree." The finer pot axis this column would
-- have added is not worth a second source of truth for it.
--
-- Safe to drop: zero rows were ever written (the writer was never deployed),
-- nothing reads it, and it is not referenced by any view, index or function.
--
-- Tier 2 (drop of an empty, unreferenced, same-day column). ROLLBACK:
--   ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS rit_pot_awards jsonb;

ALTER TABLE public.hand_history
  DROP COLUMN IF EXISTS rit_pot_awards;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'hand_history'
      AND column_name = 'rit_pot_awards'
  ) THEN
    RAISE EXCEPTION 'hand_history.rit_pot_awards was not dropped';
  END IF;
END $$;
