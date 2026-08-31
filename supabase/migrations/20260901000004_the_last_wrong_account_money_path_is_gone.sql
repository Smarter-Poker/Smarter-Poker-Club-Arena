-- =============================================================================
-- THE LAST WRONG-ACCOUNT MONEY PATH IS GONE
-- =============================================================================
-- 2026-08-31, completing phase 3 of 7 of the agent credit and promotion
-- lifecycle work. Dan: "FIX THIS, REMOVE IT IF ITS AN UNUSED LEGACY."
--
-- transfer_chips_agent_to_player debits club_members.chip_balance - the agent's
-- own PLAYER wallet - for what is supposed to be an agent-wallet send. Dan's
-- rule, 2026-08-25 and repeated 2026-08-31: chips move from the main bank to
-- the AGENT WALLET and out from there. It has been the wrong account since the
-- cashier model replaced the one it was written for.
--
-- The phase 3 plan recorded it as having ZERO CALLERS and said to drop it. That
-- was wrong at the time, and the drop was deliberately NOT done then, because
-- it had four references:
--
--   1. pages/api/club-arena/distribute-chips.js in the World Hub called it;
--   2. fn_union_money_path_check lists it, and treats a function that has been
--      "deleted outright" as a breach in its own words;
--   3. fn_club_arena_global_wallet_check lists it;
--   4. fn_union_overload_check lists it.
--
-- All four are now resolved, so the drop is finally safe:
--
--   - The World Hub route is removed in Smarter-Poker-World-Hub#1120. It was
--     unused legacy: its only client was AgentService.distributeFromTreasury,
--     which nothing called, and the route HAD NEVER SUCCESSFULLY RUN - zero
--     chip_distribution / promo_distribution / fraud_attempt_distribute audit
--     rows, and zero chip_transactions of type 'agent_to_player_transfer',
--     measured on production before this file was written.
--   - The three integrity checks are re-created below without the entry, in
--     this same transaction, so the estate never sees a half-state where the
--     function is gone and a guard is still asking for it.
--
-- WHAT REPLACES IT: nothing new. fn_agent_wallet_send has been the correct
-- path all along, and phase 2 ported this function's ONE good idea - the credit
-- draw - onto it. Every surface now uses fn_club_bank_send or
-- fn_agent_wallet_send: the Cashier, the Trade grid, the Wallet Cashier,
-- ChipTransferModal, and as of this change AgentService.transferToPlayer.
--
-- NO TABLE IS TOUCHED. One DROP FUNCTION and three CREATE OR REPLACE on STABLE
-- reporting functions. No lock on club_members or agents.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '25s';

-- -----------------------------------------------------------------------------
-- 1. The guards stop asking for a function that is about to be gone
-- -----------------------------------------------------------------------------
-- fn_union_money_path_check is the one that MUST change: it reports a breach
-- when a listed function does not exist. The other two only match functions
-- that DO exist, so a stale name in their lists is inert rather than wrong -
-- they are tidied in the same breath so a reader is not left wondering.

CREATE OR REPLACE FUNCTION public.fn_union_money_path_check()
 RETURNS TABLE(fn text, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT x.fn,
         'money path no longer reaches club scope (directly or through any '
         || 'function it calls, to 4 levels) — club wallets would be commingled'
    FROM (VALUES
            ('atomic_table_buyin'),('atomic_table_cashout'),
            ('atomic_table_rebuy'),('atomic_table_addon'),
            ('atomic_tournament_register'),('atomic_tournament_unregister'),
            ('process_tournament_rebuy'),
            ('credit_player_wallet'),('atomic_cancel_tournament'),
            ('fn_pay_player_chips'),
            ('atomic_pay_player_rakeback'),('credit_player_rakeback'),
            ('atomic_pay_agent_settlement')
            -- transfer_chips_agent_to_player was here. It is dropped below:
            -- it debited the agent's PLAYER wallet, its only caller was an
            -- unused World Hub route, and fn_agent_wallet_send is the path.
            --
            -- Nothing is added in its place. Widening an estate guard to cover
            -- the replacement is a separate decision with its own blast radius,
            -- and making it silently, inside a migration whose subject is a
            -- removal, is how a guard ends up asserting something nobody chose.
         ) AS x(fn)
   -- A function that has been deleted outright is still a breach; one that
   -- exists but cannot reach club scope is the breach this was written for.
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = x.fn)
      OR NOT public.fn_money_path_reaches_club_scope(x.fn, 4);
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_arena_global_wallet_check()
 RETURNS TABLE(fn text, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.proname::text,
         'Club Arena money path references the global wallets table — every club '
         || 'must be its own standalone wallet, never joined or pooled'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'atomic_table_buyin','atomic_table_cashout','atomic_table_rebuy','atomic_table_addon',
       'atomic_tournament_register','atomic_tournament_unregister','process_tournament_rebuy',
       'atomic_cancel_tournament','fn_pay_player_chips',
       'atomic_pay_player_rakeback','credit_player_rakeback','atomic_pay_agent_settlement')
     AND p.prosrc ~* '(update|insert into|from)\s+(public\.)?wallets\M';
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_overload_check()
 RETURNS TABLE(fn text, signatures bigint, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.proname::text, count(*),
         'money-path function has multiple signatures — callers may silently hit '
         || 'the stale one (this has already happened three times: buy-in, '
         || 'cascading commission, tournament register)'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'atomic_table_buyin','atomic_table_cashout','atomic_table_rebuy','atomic_table_addon',
       'atomic_tournament_register','atomic_tournament_unregister','process_tournament_rebuy',
       'calculate_cascading_commission','credit_agent_commission_from_rake',
       'atomic_distribute_rake','record_tournament_buyin_rake',
       'atomic_pay_agent_settlement','fn_pay_player_chips'
     )
   GROUP BY p.proname
  HAVING count(*) > 1;
$function$;

-- These three are estate telemetry: an operator asks them whether a money path
-- has drifted. Nobody in a browser calls them, and none of them backs an RLS
-- policy (checked: 0 policies reference any of the three). CREATE OR REPLACE
-- does not reset an existing ACL - and on this database the autorevoke event
-- trigger strips PUBLIC anyway - but a fresh apply of this file elsewhere would
-- leave the Postgres default of EXECUTE to PUBLIC on a SECURITY DEFINER
-- function that runs past RLS and never asks who is calling. So the grant is
-- stated rather than assumed. PUBLIC is named as well as the roles: anon
-- inherits whatever PUBLIC holds, so revoking anon alone changes nothing.
REVOKE ALL ON FUNCTION public.fn_union_money_path_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_money_path_check() TO service_role;

REVOKE ALL ON FUNCTION public.fn_club_arena_global_wallet_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_arena_global_wallet_check() TO service_role;

REVOKE ALL ON FUNCTION public.fn_union_overload_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_overload_check() TO service_role;

-- -----------------------------------------------------------------------------
-- 2. The function itself
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.transfer_chips_agent_to_player(uuid, uuid, uuid, numeric);

-- -----------------------------------------------------------------------------
-- 3. Proof
-- -----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_left int;
  v_breach int;
BEGIN
  SELECT count(*) INTO v_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'transfer_chips_agent_to_player';
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'transfer_chips_agent_to_player is still present (% signature(s))', v_left;
  END IF;

  -- The guard that treats a missing function as a breach must now be quiet.
  SELECT count(*) INTO v_breach FROM public.fn_union_money_path_check();
  IF v_breach > 0 THEN
    RAISE EXCEPTION 'fn_union_money_path_check reports % breach(es) after the drop', v_breach;
  END IF;

  SELECT count(*) INTO v_breach FROM public.fn_club_arena_global_wallet_check();
  IF v_breach > 0 THEN
    RAISE EXCEPTION 'fn_club_arena_global_wallet_check reports % breach(es)', v_breach;
  END IF;

  SELECT count(*) INTO v_breach FROM public.fn_union_overload_check();
  IF v_breach > 0 THEN
    RAISE EXCEPTION 'fn_union_overload_check reports % overloaded money path(s)', v_breach;
  END IF;

  -- And the guards themselves stay shut to a caller with no account.
  IF has_function_privilege('anon', 'public.fn_union_money_path_check()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_union_overload_check()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_club_arena_global_wallet_check()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'an integrity check is executable by anon: it runs past RLS and never asks who is calling';
  END IF;

  RAISE NOTICE 'the last wrong-account money path is gone, and every guard is quiet';
END
$verify$;

COMMIT;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- Re-create transfer_chips_agent_to_player from the definition preserved in
-- docs/changelog/2026-08-31-phase3-one-money-path.md and restore the three
-- check functions from this file's git history, in a single transaction.
--
-- No data is touched, so nothing is unwound: the function never moved a chip
-- (zero 'agent_to_player_transfer' rows in chip_transactions on the day it was
-- dropped). Restoring it would also restore the defect - it debits
-- club_members.chip_balance, which is the wrong account - so a rollback should
-- be a stop on the way to a better fix, not a destination.
