-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420011512 "phase7_1_6_chip_pool_segregation"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e751cf5038b35f5b13bf137e0730d864 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- Phase 7.1.6 — Chip pool segregation (enforcement)
-- ──────────────────────────────────────────────────────────────────────────
-- The chip_ledger already enforces performed_by NOT NULL, and an audit of
-- live data shows only the six expected entity types in use
-- (player_wallet, club_treasury, union_bank, agent_wallet, system_mint,
-- system_burn) and no diamond categories. This migration locks those
-- invariants in at the schema level so a future bug can't introduce
-- (a) a typoed/invalid entity type or
-- (b) a diamond-flavoured row in chip_ledger (diamonds belong in
--     diamond_ledger — they must never mix with chip balances).

BEGIN;

-- 1. Entity-type allow-list
ALTER TABLE public.chip_ledger
  DROP CONSTRAINT IF EXISTS chip_ledger_from_type_check;
ALTER TABLE public.chip_ledger
  ADD CONSTRAINT chip_ledger_from_type_check
  CHECK (from_type IN (
    'player_wallet', 'club_treasury', 'union_bank',
    'agent_wallet',  'system_mint',   'system_burn'
  ));

ALTER TABLE public.chip_ledger
  DROP CONSTRAINT IF EXISTS chip_ledger_to_type_check;
ALTER TABLE public.chip_ledger
  ADD CONSTRAINT chip_ledger_to_type_check
  CHECK (to_type IN (
    'player_wallet', 'club_treasury', 'union_bank',
    'agent_wallet',  'system_mint',   'system_burn'
  ));

-- 2. No diamond categories in chip_ledger. Enforces Phase 7 exit criterion:
--    "Diamonds economy is isolated: no ledger row has from_entity_type = 'WALLET'
--     and a diamond category."
ALTER TABLE public.chip_ledger
  DROP CONSTRAINT IF EXISTS chip_ledger_no_diamond_category_check;
ALTER TABLE public.chip_ledger
  ADD CONSTRAINT chip_ledger_no_diamond_category_check
  CHECK (category !~* '^diamond' AND category !~* '_diamond');

-- 3. Category allow-list documented in schema (matches today's live usage +
--    reserved words for future settlement work).
ALTER TABLE public.chip_ledger
  DROP CONSTRAINT IF EXISTS chip_ledger_category_check;
ALTER TABLE public.chip_ledger
  ADD CONSTRAINT chip_ledger_category_check
  CHECK (category IN (
    'buyin', 'cashout', 'rake', 'commission', 'transfer',
    'player_funding', 'agent_funding', 'mint', 'burn',
    'legacy_seed_reconcile', 'rakeback', 'settlement',
    'tournament_buyin', 'tournament_prize', 'bounty',
    'adjustment', 'refund'
  ));

-- 4. Every cross-scope transfer (from_type != to_type, where both sides are
--    non-system) must carry a performed_by that is a real user, not all-zeros.
--    (Trigger rather than CHECK because NOT NULL already handles null and we
--    want a clearer error on the all-zero sentinel.)
CREATE OR REPLACE FUNCTION public.enforce_chip_ledger_performed_by()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.performed_by = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'chip_ledger.performed_by must be a real user, got all-zero sentinel'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Cross-scope between two non-system entity types requires the operator
  -- to be identified — this catches callers who forget to thread userId.
  IF NEW.from_type <> NEW.to_type
     AND NEW.from_type NOT IN ('system_mint', 'system_burn')
     AND NEW.to_type   NOT IN ('system_mint', 'system_burn') THEN
    -- performed_by is already NOT NULL + non-zero here; nothing extra to do.
    NULL;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_chip_ledger_performed_by ON public.chip_ledger;
CREATE TRIGGER trg_chip_ledger_performed_by
  BEFORE INSERT ON public.chip_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_chip_ledger_performed_by();

COMMIT;

