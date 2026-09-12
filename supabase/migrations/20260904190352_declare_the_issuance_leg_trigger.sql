-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260904190352; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260904190352   (the stamp IS the apply time, UTC: 2026-09-04 19:03:52)
--   name        declare_the_issuance_leg_trigger
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1935 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260904190352 IS ALREADY IN
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

-- The undeclared-trigger guard shipped ~19:00 on 2026-09-04 and caught its
-- first real change within the hour: zz_ca_issuance_leg_is_registered, a
-- DEFERRABLE CONSTRAINT TRIGGER on chip_ledger that fires on any mint, burn,
-- issuance_reserve or chip_retirement leg.
--
-- It is legitimate. It arrived with PR #2984, "feat(chip-std): Phase 3 - one
-- Mint, no negatives, the legacy doors nobody calls are closed", which merged
-- to main minutes before the baseline in
-- 20260904182847_every_trigger_on_a_money_table_is_declared was seeded from
-- live - so it was created through a reviewed migration and simply missed the
-- snapshot by a few minutes.
--
-- Declaring it here rather than re-seeding the whole baseline, because that is
-- the workflow the guard exists to enforce: a trigger on a money table is
-- named by a human in a migration, once, with provenance. Re-snapshotting from
-- live would bless whatever happens to be there, which is exactly what the
-- guard is meant to prevent.

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES (
  'chip_ledger',
  'zz_ca_issuance_leg_is_registered',
  'Declared 2026-09-04. Arrived via PR #2984 (chip-std Phase 3, one Mint / no negatives), minutes after the baseline snapshot was taken. Constraint trigger requiring every system_mint / system_burn / issuance_reserve / chip_retirement leg on chip_ledger to be registered.'
)
ON CONFLICT (table_name, trigger_name) DO NOTHING;

DO $$
DECLARE v_undecl int;
BEGIN
  SELECT count(*) INTO v_undecl FROM public.fn_undeclared_money_triggers();
  IF v_undecl <> 0 THEN
    RAISE EXCEPTION
      'post-condition failed: % money-table trigger(s) still undeclared after this migration. Run SELECT * FROM fn_undeclared_money_triggers() - each one is an unreviewed change on a chip path until somebody names it.',
      v_undecl;
  END IF;
  RAISE NOTICE 'all money-table triggers declared.';
END $$;
