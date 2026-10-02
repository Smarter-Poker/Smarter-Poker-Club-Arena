-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260819211747 as "union_pnl_invoice_types_and_ownership_hardening"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- ============================================================================
-- AUDIT FIX PASS 1 (2026-08-19)
-- 1. settlement_invoices CHECK constraints rejected the union<->club player
--    P&L invoice ('union_club_pnl', and to_entity_type 'union'). The insert
--    was swallowed by a console.warn, so the entire weekly player win/loss
--    square-up silently wrote nothing. Verified by reproduction: 23514.
-- 2. Ownership triggers were BEFORE INSERT only, so a later UPDATE could
--    drift union_id (e.g. the engine boot sweep resurrecting a closed table).
--    Add UPDATE enforcement.
-- 3. tournaments RLS was blanket "Public read access", so private club
--    tournaments were world-readable. Scope reads to union/club membership.
-- ============================================================================

-- 1. Invoice type + entity type ---------------------------------------------
ALTER TABLE settlement_invoices DROP CONSTRAINT IF EXISTS settlement_invoices_invoice_type_check;
ALTER TABLE settlement_invoices ADD CONSTRAINT settlement_invoices_invoice_type_check
  CHECK (invoice_type = ANY (ARRAY[
    'union_to_club','club_to_agent','agent_to_subagent','agent_to_player',
    'union_club_pnl','club_to_union'
  ]));

ALTER TABLE settlement_invoices DROP CONSTRAINT IF EXISTS settlement_invoices_to_entity_type_check;
ALTER TABLE settlement_invoices ADD CONSTRAINT settlement_invoices_to_entity_type_check
  CHECK (to_entity_type = ANY (ARRAY['club','agent','player','union']));

-- 2. Ownership drift protection on UPDATE ------------------------------------
CREATE OR REPLACE FUNCTION fn_enforce_table_union_ownership_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    -- A non-private game under a union club must always carry the union.
    -- This survives the engine boot sweep (which UPDATEs closed -> waiting).
    IF v_union IS NOT NULL AND NEW.union_id IS DISTINCT FROM v_union THEN
      NEW.union_id := v_union;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_tables_union_ownership_upd ON tables;
CREATE TRIGGER trg_tables_union_ownership_upd
BEFORE UPDATE ON tables
FOR EACH ROW EXECUTE FUNCTION fn_enforce_table_union_ownership_update();

CREATE OR REPLACE FUNCTION fn_enforce_tournament_union_ownership_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NOT NULL AND NEW.union_id IS DISTINCT FROM v_union THEN
      NEW.union_id := v_union;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_tournaments_union_ownership_upd ON tournaments;
CREATE TRIGGER trg_tournaments_union_ownership_upd
BEFORE UPDATE ON tournaments
FOR EACH ROW EXECUTE FUNCTION fn_enforce_tournament_union_ownership_update();

-- 3. tournaments read policy: private games are club-only -------------------
DROP POLICY IF EXISTS "Public read access" ON tournaments;
CREATE POLICY tournaments_select_scoped ON tournaments
  FOR SELECT
  USING (
    COALESCE(is_private, false) = false
    OR club_id IS NULL
    OR is_club_member(club_id, (SELECT auth.uid()))
    OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = tournaments.club_id AND c.owner_id = (SELECT auth.uid()))
  );

-- Assertions -----------------------------------------------------------------
DO $$
DECLARE v_ok boolean;
BEGIN
  SELECT pg_get_constraintdef(oid) LIKE '%union_club_pnl%' INTO v_ok
    FROM pg_constraint WHERE conname = 'settlement_invoices_invoice_type_check';
  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: union_club_pnl not permitted by invoice_type check';
  END IF;

  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('trg_tables_union_ownership_upd','trg_tournaments_union_ownership_upd')) <> 2 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: update-ownership triggers missing';
  END IF;
END $$;
