-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909233558; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909233558   (the stamp IS the apply time, UTC: 2026-09-09 23:35:58)
--   name        ca_the_maintenance_kind_is_the_prefix_the_writer_uses
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1850 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909233558 IS ALREADY IN
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

-- ca_the_maintenance_kind_is_the_prefix_the_writer_uses
--
-- ca_ledger_maintenance_kinds files a routine, recorded maintenance at the
-- severity registered for its reason prefix (split_part(reason, ':', 1)).
-- On 2026-09-09 09:34 the certification fleet's hourly diamond-journal
-- cleanup was registered as 'cert-cleanup'. The writer,
-- cleanup_reserved_certification_account, sets
--   app.ledger_maintenance = 'certification-cleanup:20260906022000:<user>'
-- so its prefix is 'certification-cleanup', the lookup missed, the default
-- 'warning' applied, and every hourly run kept counting into warning
-- incident e2a86da5 (288 occurrences by 23:14 UTC). Register the prefix the
-- writer actually uses; the mistyped row stays so nothing that was filed
-- under it changes meaning.
BEGIN;

INSERT INTO public.ca_ledger_maintenance_kinds (kind, severity, note)
VALUES ('certification-cleanup', 'info',
  'cleanup_reserved_certification_account: the certification fleet removes its own reserved identities (ca-customization-cert-%@example.invalid only, refused while frozen) and their journal rows on an hourly cadence. Every row is preserved whole in ca_ledger_mutation_log and, for diamond_transactions, in ca_diamond_journal_archive before it goes. Expected, scheduled and reversible: recorded, not alarming. This is the prefix the writer sets; cert-cleanup was a mistyped registration of the same maintenance.')
ON CONFLICT (kind) DO UPDATE SET severity = EXCLUDED.severity, note = EXCLUDED.note;

COMMENT ON TABLE public.ca_ledger_maintenance_kinds IS
  'Severity per app.ledger_maintenance reason PREFIX (split_part(reason, '':'', 1)). A kind registered here is filed at that severity by fn_ca_journal_append_only; an unregistered prefix is a warning. The kind must be the exact prefix the writer sets, character for character.';

COMMIT;
