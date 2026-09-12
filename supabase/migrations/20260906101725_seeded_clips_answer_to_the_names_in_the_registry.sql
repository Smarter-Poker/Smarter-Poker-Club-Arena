-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260906101725; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260906101725   (the stamp IS the apply time, UTC: 2026-09-06 10:17:25)
--   name        seeded_clips_answer_to_the_names_in_the_registry
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 2407 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260906101725 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)
--
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
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

-- Seeded clips answer to the names in the registry.
--
-- The 149 clips inherited from the retired ClipLibrary.ts array carry that
-- file's short codes in `source` - 'HCL', 'LODGE', 'JLITTLE'. The registry
-- names channels the way a person would: 'Hustler Casino Live', 'The Lodge',
-- 'Jonathan Little'. A horse's slice is a list of registry NAMES, so on the
-- first live probe every horse matched nothing in its own slice and widened
-- to the whole pool - the feature worked, quietly, as though it were absent.
--
-- The prefix join in the seed migration caught 9 of 18 codes by luck (BRAD
-- against 'Brad Owen'), which is worse than catching none: half a feature
-- working looks like the whole thing working.
--
-- Mapped explicitly here, because these eighteen are a closed set from a file
-- that no longer exists - there is nothing to infer and nothing to maintain.
-- Everything the scraper adds from now on is written with the registry name
-- directly and never needs this.

WITH code_to_name(code, name) AS (VALUES
  ('HCL','Hustler Casino Live'), ('LODGE','The Lodge'), ('LATB','Live at the Bike'),
  ('TCH','TCH Live'), ('TRITON','Triton Poker'), ('POKERGO','PokerGO'),
  ('WSOP','World Series of Poker'), ('WPT','World Poker Tour'),
  ('EPT','European Poker Tour'), ('BRAD','Brad Owen'), ('NEEME','Andrew Neeme'),
  ('MARIANO','Mariano'), ('RAMPAGE','Rampage Poker'), ('WOLFGANG','Wolfgang Poker'),
  ('JLITTLE','Jonathan Little'), ('POLK','Doug Polk Poker'),
  ('DANIEL','Daniel Negreanu'), ('HELLMUTH','Phil Hellmuth')
)
UPDATE public.poker_clips pc
SET source    = m.name,
    source_id = cs.id
FROM code_to_name m
JOIN public.content_sources cs ON cs.domain = 'poker' AND cs.name = m.name
WHERE pc.source = m.code;

DO $$
DECLARE v_unlinked int; v_legacy int; v_sources int;
BEGIN
  SELECT count(*) INTO v_unlinked FROM public.poker_clips WHERE source_id IS NULL;
  SELECT count(*) INTO v_legacy   FROM public.poker_clips
   WHERE source !~ ' ' AND source = upper(source);
  SELECT count(DISTINCT source) INTO v_sources FROM public.poker_clips;

  IF v_unlinked <> 0 THEN
    RAISE EXCEPTION 'poker_clips: % clips still unlinked to a source', v_unlinked;
  END IF;
  IF v_legacy <> 0 THEN
    RAISE EXCEPTION 'poker_clips: % clips still carry a ClipLibrary short code', v_legacy;
  END IF;

  RAISE NOTICE 'poker_clips: every clip linked, % distinct source names', v_sources;
END $$;
