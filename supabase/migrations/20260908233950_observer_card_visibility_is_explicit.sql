-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260908233950; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260908233950   (the stamp IS the apply time, UTC: 2026-09-08 23:39:50)
--   name        observer_card_visibility_is_explicit
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1942 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260908233950 IS ALREADY IN
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

-- observer_card_visibility_is_explicit
BEGIN;

DO $observer_policy_precondition$
BEGIN
  IF to_regclass('public.tables') IS NULL THEN
    RAISE EXCEPTION 'OBSERVER_CARD_VISIBILITY_TABLES_MISSING';
  END IF;

  IF NOT (
    SELECT c.relrowsecurity
      FROM pg_class c
     WHERE c.oid = 'public.tables'::regclass
  ) THEN
    RAISE EXCEPTION 'OBSERVER_CARD_VISIBILITY_TABLES_RLS_DISABLED';
  END IF;
END;
$observer_policy_precondition$;

ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS observer_show_cards boolean NOT NULL DEFAULT false;

UPDATE public.tables
   SET observer_show_cards = false
 WHERE observer_show_cards IS NULL;

ALTER TABLE public.tables
  ALTER COLUMN observer_show_cards SET DEFAULT false,
  ALTER COLUMN observer_show_cards SET NOT NULL;

COMMENT ON COLUMN public.tables.observer_show_cards IS
  'When true, non-seated observers may see tabled cards at showdown or during an all-in runout. False is the privacy default.';

DO $observer_policy_postimage$
DECLARE
  v_type oid;
  v_not_null boolean;
  v_default text;
BEGIN
  SELECT a.atttypid, a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
    INTO v_type, v_not_null, v_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d
      ON d.adrelid = a.attrelid
     AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.tables'::regclass
     AND a.attname = 'observer_show_cards'
     AND NOT a.attisdropped;

  IF v_type IS DISTINCT FROM 'boolean'::regtype
     OR v_not_null IS DISTINCT FROM true
     OR v_default IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION
      'OBSERVER_CARD_VISIBILITY_POSTIMAGE_MISMATCH type=% not_null=% default=%',
      v_type::regtype,
      v_not_null,
      v_default;
  END IF;

  IF NOT (
    SELECT c.relrowsecurity
      FROM pg_class c
     WHERE c.oid = 'public.tables'::regclass
  ) THEN
    RAISE EXCEPTION 'OBSERVER_CARD_VISIBILITY_TABLES_RLS_DISABLED_POSTIMAGE';
  END IF;
END;
$observer_policy_postimage$;

COMMIT;
