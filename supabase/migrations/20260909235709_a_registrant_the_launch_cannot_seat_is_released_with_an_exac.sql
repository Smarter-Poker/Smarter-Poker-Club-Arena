-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909235709; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909235709   (the stamp IS the apply time, UTC: 2026-09-09 23:57:09)
--   name        a_registrant_the_launch_cannot_seat_is_released_with_an_exac
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1674 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909235709 IS ALREADY IN
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

DO $reader$
DECLARE
  v_oid oid := to_regprocedure(
    'public.fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid)');
  v_def text;
  v_old1 text := $t$     OR (v_r.start_authority IN (
           'spin_actual_start','heads_up_sng_actual_start')
       AND EXISTS ($t$;
  v_new1 text := $t$     OR (v_r.start_authority IN (
           'spin_actual_start','heads_up_sng_actual_start','launch_release')
       AND EXISTS ($t$;
  v_old2 text := $t$     OR v_r.start_authority NOT IN (
          'scheduled_clock','spin_actual_start','heads_up_sng_actual_start')$t$;
  v_new2 text := $t$     OR v_r.start_authority NOT IN (
          'scheduled_clock','spin_actual_start','heads_up_sng_actual_start',
          'launch_release')$t$;
  v_changed boolean := false;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid) is not installed';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF position(v_new1 IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1 THEN
      RAISE EXCEPTION 'the seat-first authority clause of fn_ca_tournament_unregistration_receipt was expected exactly once';
    END IF;
    v_def := replace(v_def, v_old1, v_new1); v_changed := true;
  END IF;
  IF position(v_new2 IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1 THEN
      RAISE EXCEPTION 'the authority whitelist of fn_ca_tournament_unregistration_receipt was expected exactly once';
    END IF;
    v_def := replace(v_def, v_old2, v_new2); v_changed := true;
  END IF;
  IF v_changed THEN EXECUTE v_def; END IF;
END
$reader$;
