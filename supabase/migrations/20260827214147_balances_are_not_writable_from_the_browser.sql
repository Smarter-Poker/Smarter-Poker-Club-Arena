-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827214147; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- BALANCES ARE NOT WRITABLE FROM THE BROWSER — 2026-08-27 (security audit)
--
-- CONFIRMED EXPLOIT: `authenticated` (and `anon`) hold TABLE-level UPDATE on
-- club_members and clubs. RLS policy club_members_update lets a member update
-- their OWN row, and its WITH CHECK pins role/credit/agent columns but says
-- nothing about balances. The only trigger on chip_balance is AFTER UPDATE and
-- merely records the delta. So
--     supabase.from('club_members').update({ chip_balance: 9e8 }).eq('user_id', me)
-- succeeded from the SPA with the anon key, and atomic_table_buyin reads that
-- column as real money. clubs.chip_treasury had the same hole for owners:
-- guard_wallet_balance_write is installed on wallets.balance and
-- clubs.chip_pool, but never on chip_treasury — the column fn_club_bank_send
-- actually moves.
--
-- WHY A TRIGGER AND NOT A REVOKE: the privileges are TABLE-level, so a
-- column-level REVOKE is a no-op (verified: has_column_privilege still true
-- afterwards). Revoking the table grant and re-granting a column list would
-- work, but the safe list has to be inferred from client code and one missed
-- column silently breaks a legitimate flow.
--
-- WHY current_user AND NOT auth.role(): auth.role() reads the JWT claim and
-- stays 'authenticated' even inside a SECURITY DEFINER function, so it cannot
-- tell a direct browser write from a legitimate RPC. current_user is the
-- EXECUTING role: it is 'authenticated'/'anon' for a PostgREST write, the
-- function owner inside any SECURITY DEFINER RPC, and 'service_role' for the
-- engine. That is exactly the line we need.
--
-- 66 functions legitimately write these columns — far more than
-- guard_wallet_balance_write's whitelist — so a stack-matching guard would
-- break buy-ins, cashouts, joins and transfers. This blocks only the browser.
-- Verified first: of the 29 SECURITY INVOKER writers, just 3 are callable by
-- `authenticated` (atomic_table_withdraw, promo_apply_playthrough,
-- reconcile_ledger_nightly) and every one of them is invoked solely by the
-- server under the service role — no client path reaches them.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_block_browser_balance_writes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_changed text;
BEGIN
  -- Only end-user roles are policed. DEFINER functions run as their owner and
  -- the engine runs as service_role; both pass straight through.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'club_members' THEN
    IF NEW.chip_balance  IS DISTINCT FROM OLD.chip_balance  THEN v_changed := 'chip_balance';
    ELSIF NEW.held_chips IS DISTINCT FROM OLD.held_chips    THEN v_changed := 'held_chips';
    ELSIF NEW.locked_chips IS DISTINCT FROM OLD.locked_chips THEN v_changed := 'locked_chips';
    ELSIF NEW.promo_balance IS DISTINCT FROM OLD.promo_balance THEN v_changed := 'promo_balance';
    END IF;
  ELSIF TG_TABLE_NAME = 'clubs' THEN
    IF NEW.chip_treasury IS DISTINCT FROM OLD.chip_treasury THEN v_changed := 'chip_treasury';
    ELSIF NEW.chip_pool  IS DISTINCT FROM OLD.chip_pool     THEN v_changed := 'chip_pool';
    END IF;
  END IF;

  IF v_changed IS NULL THEN
    RETURN NEW;  -- not a balance write; the row's other columns are unaffected
  END IF;

  RAISE EXCEPTION
    'Direct balance mutation of %.% from the browser is forbidden. Chips move only through the money RPCs.',
    TG_TABLE_NAME, v_changed
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

DROP TRIGGER IF EXISTS trg_block_browser_balance_writes ON public.club_members;
CREATE TRIGGER trg_block_browser_balance_writes
  BEFORE UPDATE ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_block_browser_balance_writes();

DROP TRIGGER IF EXISTS trg_block_browser_treasury_writes ON public.clubs;
CREATE TRIGGER trg_block_browser_treasury_writes
  BEFORE UPDATE ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_block_browser_balance_writes();

-- A membership must also not be BORN rich from the browser. The existing
-- trg_membership_starts_with_zero_chips covers the normal path; this is the
-- role-scoped backstop for the same idea.
CREATE OR REPLACE FUNCTION public.fn_block_browser_balance_inserts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.chip_balance, 0) <> 0 OR COALESCE(NEW.promo_balance, 0) <> 0
     OR COALESCE(NEW.held_chips, 0) <> 0 OR COALESCE(NEW.locked_chips, 0) <> 0 THEN
    RAISE EXCEPTION 'A membership created from the browser must start with zero chips.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_block_browser_balance_inserts ON public.club_members;
CREATE TRIGGER trg_block_browser_balance_inserts
  BEFORE INSERT ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_block_browser_balance_inserts();
