-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905172924; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905172924   (the stamp IS the apply time, UTC: 2026-09-05 17:29:24)
--   name        drop_redundant_hand_history_rit_pot_awards
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1680 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905172924 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)

--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

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
