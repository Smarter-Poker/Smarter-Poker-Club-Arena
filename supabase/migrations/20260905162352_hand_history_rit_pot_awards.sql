-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905162352; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905162352   (the stamp IS the apply time, UTC: 2026-09-05 16:23:52)
--   name        hand_history_rit_pot_awards
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1749 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905162352 IS ALREADY IN
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
