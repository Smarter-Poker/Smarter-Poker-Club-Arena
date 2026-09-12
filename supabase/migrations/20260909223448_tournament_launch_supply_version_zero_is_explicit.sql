-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909223448; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909223448   (the stamp IS the apply time, UTC: 2026-09-09 22:34:48)
--   name        tournament_launch_supply_version_zero_is_explicit
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 3899 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909223448 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     CONSTRAINT     tournament_launch_receipts_supply_version_check on public.tournament_launch_receipts

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

-- The tournament manager selects tournament_launch_receipts.supply_version
-- before choosing the legacy launch protocol or the pending conserved-supply
-- protocol. Production had no such column, so the capability check depended
-- on PostgREST returning one particular 42703 error. That made the committed
-- caller a phantom-column violation and made schema-cache wording part of the
-- launch contract.
--
-- Make the pre-activation state explicit: every existing and new receipt is
-- version 0, and a validated constraint makes version 1 impossible. This is
-- intentionally not the chip-supply activation. The staged activation drops
-- this named constraint, installs its 0-or-1 replacement, and only then changes
-- the default for newly snapshotted launches to 1. No wallet, stack, seat,
-- receipt, grant, trigger, scheduled job, or historical value is repaired here.

DO $preconditions$
DECLARE
  v_type text;
  v_not_null boolean;
  v_default text;
BEGIN
  IF to_regclass('public.tournament_launch_receipts') IS NULL THEN
    RAISE EXCEPTION 'tournament_launch_receipts is required before sealing supply_version';
  END IF;

  SELECT pg_catalog.format_type(a.atttypid, a.atttypmod),
         a.attnotnull,
         pg_get_expr(d.adbin, d.adrelid)
    INTO v_type, v_not_null, v_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d
      ON d.adrelid = a.attrelid
     AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.tournament_launch_receipts'::regclass
     AND a.attname = 'supply_version'
     AND a.attnum > 0
     AND NOT a.attisdropped;

  IF FOUND AND (
       v_type IS DISTINCT FROM 'smallint'
       OR v_not_null IS DISTINCT FROM true
       OR regexp_replace(coalesce(v_default, ''), '::smallint', '', 'g') IS DISTINCT FROM '0'
  ) THEN
    RAISE EXCEPTION
      'existing tournament_launch_receipts.supply_version is not the sealed smallint NOT NULL DEFAULT 0 capability';
  END IF;
END;
$preconditions$;

ALTER TABLE public.tournament_launch_receipts
  ADD COLUMN IF NOT EXISTS supply_version smallint NOT NULL DEFAULT 0;

DO $install_zero_only_constraint$
DECLARE
  v_expression text;
BEGIN
  SELECT regexp_replace(pg_get_expr(c.conbin, c.conrelid), '\s+', '', 'g')
    INTO v_expression
    FROM pg_constraint c
   WHERE c.conrelid = 'public.tournament_launch_receipts'::regclass
     AND c.conname = 'tournament_launch_receipts_supply_version_check';

  IF FOUND AND v_expression IS DISTINCT FROM '(supply_version=0)' THEN
    RAISE EXCEPTION
      'tournament_launch_receipts_supply_version_check already has incompatible semantics: %',
      v_expression;
  END IF;

  IF NOT FOUND THEN
    ALTER TABLE public.tournament_launch_receipts
      ADD CONSTRAINT tournament_launch_receipts_supply_version_check
      CHECK (supply_version = 0) NOT VALID;
  END IF;
END;
$install_zero_only_constraint$;

ALTER TABLE public.tournament_launch_receipts
  VALIDATE CONSTRAINT tournament_launch_receipts_supply_version_check;

COMMENT ON COLUMN public.tournament_launch_receipts.supply_version IS
  'Launch chip-supply protocol: sealed to 0 until the conserved-supply activation transaction installs version 1.';

DO $postconditions$
DECLARE
  v_invalid bigint;
  v_validated boolean;
BEGIN
  SELECT count(*)
    INTO v_invalid
    FROM public.tournament_launch_receipts
   WHERE supply_version IS DISTINCT FROM 0;

  SELECT c.convalidated
    INTO v_validated
    FROM pg_constraint c
   WHERE c.conrelid = 'public.tournament_launch_receipts'::regclass
     AND c.conname = 'tournament_launch_receipts_supply_version_check'
     AND regexp_replace(pg_get_expr(c.conbin, c.conrelid), '\s+', '', 'g') =
       '(supply_version=0)';

  IF v_invalid <> 0 OR v_validated IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'supply_version zero-only seal did not verify: invalid_rows=%, validated=%',
      v_invalid,
      v_validated;
  END IF;
END;
$postconditions$;
