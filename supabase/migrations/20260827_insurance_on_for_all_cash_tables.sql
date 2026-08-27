-- ═══════════════════════════════════════════════════════════════════════════
-- INSURANCE ON FOR ALL CASH TABLES — Dan 2026-08-26:
-- "go ahead and publish this for all cash games."
--
-- Scope: every non-tournament table that is live (running/waiting) or is a
-- template (a launched template copies the whole row, so enabling templates
-- covers future launches). Closed historical rows are left untouched — they
-- can never deal a hand again and the write would touch ~90k dead rows.
--
-- Tournaments are EXCLUDED on purpose: the insurance ledger step is
-- cash-only (ServerTableEngineSettlement gates on !isTournamentTable), and
-- the engine gains a matching tournament gate in the same PR as this
-- migration so a stray flag can never move tournament chips outside the
-- bank ledger.
--
-- Companion code change (same PR): HorseFleetManager's two table INSERTs now
-- set insurance_enabled: true so future fleet cash tables are covered, and
-- CreateTableModal defaults the toggle ON for new club cash tables (hosts
-- can still switch it off per table).
--
-- The house economics on every contract (pinned in InsuranceEngine.test.ts):
--   premium = insured x P(strict loss | not push) x 1.20
--   -> 20% edge over fair cost, banked by the union (or standalone club)
--      through record_insurance_transaction (bank delta = premium - payout).
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE tables
   SET insurance_enabled = true
 WHERE tournament_id IS NULL
   AND (status IN ('running', 'waiting') OR COALESCE(is_template, false));

-- The migration aborts on its own assumption violations (Tier-2 protocol).
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
