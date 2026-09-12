-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905103832; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905103832   (the stamp IS the apply time, UTC: 2026-09-05 10:38:32)
--   name        a_horse_is_stamped_on_its_seat_trigger
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 650 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905103832 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TRIGGER        needs, trg_stamp_seat_horse_id
--     DROP           TRIGGER trg_stamp_seat_horse_id
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

BEGIN;
-- table_seats is written continuously by the engine. CREATE TRIGGER needs an
-- AccessExclusiveLock on it, and the first attempt at this deadlocked against
-- a live engine transaction. Wait politely and give up quickly rather than
-- becoming the thing that blocks the felt: a failed apply costs a retry, a
-- lock queue on this table costs seated players their turn.
SET LOCAL lock_timeout = '4s';

DROP TRIGGER IF EXISTS trg_stamp_seat_horse_id ON public.table_seats;
CREATE TRIGGER trg_stamp_seat_horse_id
  BEFORE INSERT OR UPDATE OF user_id ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_seat_horse_id();

COMMIT;
