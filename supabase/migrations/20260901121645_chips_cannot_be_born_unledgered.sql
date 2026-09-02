-- Chips cannot be born unledgered.
--
-- 2026-09-01 12:05 UTC, fn_ca_supply_snapshot raised a critical: total chip
-- supply rose 4,159,902.13 beyond ledgered issuance in one interval. The cause
-- was not a leak and not play. The 416 Deep Stack Society memberships that
-- migration 20260902050000_user_clubs_are_human_only had deleted were restored
-- from club_financial_quarantine, each row re-INSERTED carrying the
-- chip_balance it held when it was quarantined. 4,159,644.00 chips came back
-- into circulation and the ledger recorded nothing at all.
--
-- The DELETE side had been ledgered correctly an hour earlier
-- (chip_ledger 70eba2a1, 'Retire Automated Player Wallets From User-Created
-- Club', 4,159,644.00 -> chip_retirement). So the books said retired while the
-- chips sat in wallets. The asymmetry, not the restore, is the bug.
--
-- Measured across every balance-bearing table: five of eight auto-ledger on
-- INSERT (clubs, club_wallets, union_wallets, bbj_pools, spin_bonus_pools) and
-- all eight auto-ledger on DELETE. Three ledger the exit and not the entrance:
--
--     club_members   chip_balance, promo_balance
--     agents         agent_wallet_balance, promo_wallet_balance
--     unions         six balance columns
--
-- club_members is the one that fired today. agents is the one that fires next:
-- the pending rebuild of the 32 Deep Stack agent rows carries 3,340,000 in
-- agent_wallet_balance and would have minted every chip of it invisibly.
--
-- Why an INSERT can carry a balance at all: fn_membership_starts_with_zero_chips
-- zeroes an opening balance for a human and returns NEW untouched for a bot or
-- a horse. That exemption is what lets fleet provisioning and quarantine
-- restores work, so it stays -- but what it lets through now gets recorded.
--
-- This migration adds the missing INSERT arm to the three tables, using the
-- same fn_ca_autoledger the other five already use on INSERT and the same
-- column-to-account specs their own DELETE triggers use. It is additive and
-- non-blocking by construction: fn_ca_autoledger never raises, falling back to
-- settlement_suspense and then to ca_ledger_write_failures, so a provisioning
-- INSERT or a restore can never be refused by this change.
--
-- Callers that know the true counterparty should declare it first with
-- fn_ca_declare_ledger('mint','issuance_reserve') -- a restore should declare
-- the retirement it is undoing. Undeclared writes land on settlement_suspense,
-- which is visible and gated, rather than nowhere, which is not.
--
-- The WHEN clauses keep the ordinary case free: a human joining a club inserts
-- with zero balances and the trigger never fires.

CREATE TRIGGER trg_ca_autoledger_insert
  AFTER INSERT ON public.club_members
  FOR EACH ROW
  WHEN (COALESCE(NEW.chip_balance, 0) <> 0 OR COALESCE(NEW.promo_balance, 0) <> 0)
  EXECUTE FUNCTION public.fn_ca_autoledger(
    'chip_balance=player_wallet', 'promo_balance=promo_wallet');

CREATE TRIGGER trg_ca_autoledger_insert
  AFTER INSERT ON public.agents
  FOR EACH ROW
  WHEN (COALESCE(NEW.agent_wallet_balance, 0) <> 0 OR COALESCE(NEW.promo_wallet_balance, 0) <> 0)
  EXECUTE FUNCTION public.fn_ca_autoledger(
    'agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet');

CREATE TRIGGER trg_ca_autoledger_insert
  AFTER INSERT ON public.unions
  FOR EACH ROW
  WHEN (COALESCE(NEW.chip_balance, 0) <> 0
     OR COALESCE(NEW.rake_wallet, 0) <> 0
     OR COALESCE(NEW.main_bbj_balance, 0) <> 0
     OR COALESCE(NEW.backup_bbj_balance, 0) <> 0
     OR COALESCE(NEW.promo_fund_balance, 0) <> 0
     OR COALESCE(NEW.insurance_balance, 0) <> 0)
  EXECUTE FUNCTION public.fn_ca_autoledger(
    'chip_balance=union_bank', 'rake_wallet=union_wallet',
    'main_bbj_balance=bbj_pool', 'backup_bbj_balance=bbj_pool',
    'promo_fund_balance=promo_wallet', 'insurance_balance=insurance_bank');

-- The detector, so this asymmetry cannot come back unnoticed. Any table that
-- ledgers a balance out on DELETE must ledger it in on INSERT.
CREATE OR REPLACE FUNCTION public.fn_ca_unledgered_insert_paths()
RETURNS TABLE (table_name text, ledgers_delete boolean, ledgers_insert boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT c.relname::text,
         bool_or(p.proname = 'fn_ca_autoledger_delete'),
         bool_or(p.proname IN ('fn_ca_autoledger', 'fn_club_members_ledger_writer')
                 AND (t.tgtype & 4) = 4)
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc  p ON p.oid = t.tgfoid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal
     AND n.nspname = 'public'
     AND p.proname IN ('fn_ca_autoledger', 'fn_ca_autoledger_delete',
                       'fn_club_members_ledger_writer')
   GROUP BY c.relname
  HAVING bool_or(p.proname = 'fn_ca_autoledger_delete')
     AND NOT bool_or(p.proname IN ('fn_ca_autoledger', 'fn_club_members_ledger_writer')
                     AND (t.tgtype & 4) = 4);
$$;

COMMENT ON FUNCTION public.fn_ca_unledgered_insert_paths() IS
  'Balance-bearing tables that ledger a DELETE but not an INSERT - i.e. rows that '
  'can be born holding chips with nothing recorded. Must return zero rows. '
  'Added 2026-09-01 after the Deep Stack quarantine restore minted 4,159,644.00 '
  'chips through club_members INSERT with no ledger entry.';

-- The migration proves its own claim rather than asserting it.
DO $$
DECLARE v_left text;
BEGIN
  SELECT string_agg(table_name, ', ') INTO v_left
    FROM public.fn_ca_unledgered_insert_paths();
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'Tables can still be born holding unledgered chips: %', v_left;
  END IF;
END $$;

-- Operator telemetry, not public surface: it describes the shape of the
-- platform's ledger triggers. Closed here so the function is never reachable
-- without an account (also applied on its own as
-- 20260901123000_the_drift_detector_is_operator_only).
REVOKE ALL ON FUNCTION public.fn_ca_unledgered_insert_paths() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_unledgered_insert_paths() TO service_role;
