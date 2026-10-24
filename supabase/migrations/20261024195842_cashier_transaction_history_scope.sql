-- 20261024195842_cashier_transaction_history_scope.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-24, on the Cashier: "INSTEAD OF IT SAYING 575 AVAILABLE - 0
-- SELECTED. THAT SHOULD BE THE 'TRANSACTION HISTORY' WHERE AGENTS AND PLAYERS
-- CAN SEE ALL OF THERE TRANSACTION HISTORY. BUT OWNERS, CO OWNERS AND ADMINS
-- CAN FILTER BETWEEN 'ALL CLUB TRANSACTIONS' AND THERE OWN CLUB TRANSACTIONS."
--
-- fn_cashier_transaction_history is the one door behind that view:
--
--   p_scope = 'club'  an owner, co-owner or admin reads every chip_transactions
--                     row of the club ("All Club Transactions");
--   anything else     every viewer, staff included, reads only the rows they
--                     are a side of ("My Transactions"). An agent reads their
--                     own history, not their downline's (the Full Statement
--                     keeps the downline book), and 'club' asked by anyone
--                     who is not staff is answered with their own rows: the
--                     scope can narrow a book, never widen it.
--
-- Every row is presented exactly as fn_club_trade_ledger presents it (the
-- arena name on both sides, a treasury-funded seat as the Club Bank send it
-- is, a send's operator named only to the operator and the member paid), so
-- the horse and naming laws hold for this door as they do for that one.
-- fn_club_trade_ledger itself is not touched; its body and its post-deploy
-- pin (scripts/verification-harness/cashier-release-contract.sql) stand.
--
-- The cash-out legs need no change here. fn_cashier_cashout_transition
-- already credits WHOEVER ACCEPTED the request (the accepter's agent wallet,
-- chip_transactions.to_user_id = accepter); the client reads each leg by the
-- wallet that moved (src/components/wallet/describeChipTransaction.ts,
-- ledgerDirection), as the Full Statement does.
--
-- Read-only: no money path, no table lock, one CREATE in one transaction.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_cashier_transaction_history(
  p_club_id uuid,
  p_scope text DEFAULT 'mine',
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
 RETURNS TABLE(id uuid, created_at timestamp with time zone, transaction_type text, amount numeric, from_user_id uuid, to_user_id uuid, notes text, metadata jsonb, from_name text, to_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_role text;
  v_scope text := lower(btrim(coalesce(p_scope, 'mine')));
  -- The Cashier exposes 250 rows and asks for one sentinel row to decide
  -- whether another page exists, exactly as fn_club_trade_ledger does.
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 251);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF v_viewer IS NULL OR p_club_id IS NULL THEN RETURN; END IF;
  IF v_scope NOT IN ('club', 'mine') THEN
    RAISE EXCEPTION 'transaction_history_scope_invalid' USING ERRCODE = '22023';
  END IF;
  v_role := public.fn_club_bank_role(p_club_id, v_viewer);
  IF v_role IS NULL THEN RETURN; END IF;

  IF v_scope = 'club' AND v_role IN ('owner', 'co_owner', 'admin') THEN
    RETURN QUERY
    SELECT ct.id, ct.created_at,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE ct.transaction_type END,
           ct.amount,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND v_viewer IS DISTINCT FROM ct.from_user_id AND v_viewer IS DISTINCT FROM ct.to_user_id) THEN NULL ELSE ct.from_user_id END,
           ct.to_user_id,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR ct.notes ~* 'horse'
                  OR (ct.transaction_type = 'club_bank_send' AND ct.notes = 'Club Bank Send') THEN NULL
                ELSE ct.notes END,
           CASE WHEN ct.transaction_type IN ('club_bank_send', 'horse_treasury_funding')
                THEN jsonb_build_object('destination', coalesce(ct.metadata ->> 'destination', 'player_wallet'))
                ELSE ct.metadata END,
           CASE WHEN pf.id IS NOT NULL AND NOT (ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND v_viewer IS DISTINCT FROM ct.from_user_id AND v_viewer IS DISTINCT FROM ct.to_user_id))
                THEN public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name) END,
           CASE WHEN pt.id IS NOT NULL THEN public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name) END
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
     ORDER BY ct.created_at DESC, ct.id DESC LIMIT v_limit OFFSET v_offset;
  ELSE
    RETURN QUERY
    SELECT ct.id, ct.created_at,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE ct.transaction_type END,
           ct.amount,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND v_viewer IS DISTINCT FROM ct.from_user_id AND v_viewer IS DISTINCT FROM ct.to_user_id) THEN NULL ELSE ct.from_user_id END,
           ct.to_user_id,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR ct.notes ~* 'horse'
                  OR (ct.transaction_type = 'club_bank_send' AND ct.notes = 'Club Bank Send') THEN NULL
                ELSE ct.notes END,
           CASE WHEN ct.transaction_type IN ('club_bank_send', 'horse_treasury_funding')
                THEN jsonb_build_object('destination', coalesce(ct.metadata ->> 'destination', 'player_wallet'))
                ELSE ct.metadata END,
           CASE WHEN pf.id IS NOT NULL AND NOT (ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND v_viewer IS DISTINCT FROM ct.from_user_id AND v_viewer IS DISTINCT FROM ct.to_user_id))
                THEN public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name) END,
           CASE WHEN pt.id IS NOT NULL THEN public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name) END
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
       AND (ct.from_user_id = v_viewer OR ct.to_user_id = v_viewer)
     ORDER BY ct.created_at DESC, ct.id DESC LIMIT v_limit OFFSET v_offset;
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_cashier_transaction_history(uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cashier_transaction_history(uuid, text, integer, integer) TO authenticated, service_role;

-- Read back the posture before COMMIT: definer, the two pinned settings, and
-- no anonymous door.
DO $post$
DECLARE v_fn regprocedure := 'public.fn_cashier_transaction_history(uuid,text,integer,integer)'::regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.oid = v_fn AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public, pg_temp', 'lock_timeout=5s']::text[]
  ) THEN
    RAISE EXCEPTION 'POST-APPLY: fn_cashier_transaction_history posture is not definer + pinned settings';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-APPLY: fn_cashier_transaction_history grants are wrong';
  END IF;
END $post$;

COMMIT;
