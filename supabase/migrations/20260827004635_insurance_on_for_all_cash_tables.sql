-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827004635; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- INSURANCE ON FOR ALL CASH TABLES — Dan 2026-08-26:
-- "go ahead and publish this for all cash games."
-- Scope: every non-tournament table that is live (running/waiting) or a
-- template (launched templates copy the whole row). Closed rows untouched.
-- Tournaments excluded: the insurance ledger is cash-only; the engine gains
-- a matching tournament gate in the companion PR.

UPDATE tables
   SET insurance_enabled = true
 WHERE tournament_id IS NULL
   AND (status IN ('running', 'waiting') OR COALESCE(is_template, false));

DO $$
DECLARE
  v_missing int;
BEGIN
  SELECT count(*) INTO v_missing
    FROM tables
   WHERE tournament_id IS NULL
     AND (status IN ('running', 'waiting') OR COALESCE(is_template, false))
     AND NOT insurance_enabled;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'insurance_on_for_all_cash_tables: % live cash tables still have insurance off', v_missing;
  END IF;

  IF EXISTS (SELECT 1 FROM tables WHERE tournament_id IS NOT NULL AND insurance_enabled) THEN
    RAISE EXCEPTION 'insurance_on_for_all_cash_tables: a tournament table row has insurance enabled';
  END IF;
END $$;
