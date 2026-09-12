-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260908034354; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260908034354   (the stamp IS the apply time, UTC: 2026-09-08 03:43:54)
--   name        the_phrase_ledger_remembers_what_was_said_at_a_table
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1791 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260908034354 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
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

BEGIN;

ALTER TABLE public.horse_phrase_ledger
  ADD COLUMN IF NOT EXISTS table_id uuid;

REVOKE ALL ON TABLE public.horse_phrase_ledger FROM anon, authenticated;

COMMENT ON COLUMN public.horse_phrase_ledger.table_id IS
  'The table a phrase was said at, when it was said at a table rather than on a post. Nullable: the social rows that predate table talk have neither. Engine-written, service-role only. 2026-09-08.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'horse_phrase_ledger'
       AND column_name = 'table_id'
  ) THEN
    RAISE EXCEPTION 'POST-FLIGHT: horse_phrase_ledger.table_id did not land';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'horse_phrase_ledger'
       AND column_name = 'table_id' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'POST-FLIGHT: table_id must stay nullable - the 6,121 social rows have none';
  END IF;
  IF has_table_privilege('anon', 'public.horse_phrase_ledger', 'SELECT')
     OR has_table_privilege('authenticated', 'public.horse_phrase_ledger', 'SELECT') THEN
    RAISE EXCEPTION 'POST-FLIGHT: horse_phrase_ledger still grants SELECT to a player role';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.horse_phrase_ledger'::regclass) THEN
    RAISE EXCEPTION 'POST-FLIGHT: RLS is off on horse_phrase_ledger';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'horse_phrase_ledger'
       AND cmd IN ('SELECT', 'ALL') AND roles::text ~ '(public|anon|authenticated)'
  ) THEN
    RAISE EXCEPTION 'POST-FLIGHT: a read policy on horse_phrase_ledger would expose horse ids';
  END IF;
END $$;

COMMIT;
