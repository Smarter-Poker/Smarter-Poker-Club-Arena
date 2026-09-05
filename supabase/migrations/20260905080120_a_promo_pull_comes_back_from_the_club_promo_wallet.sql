-- 20260905080120_a_promo_pull_comes_back_from_the_club_promo_wallet.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- Found on the line-by-line re-read of UnionWalletModal after #3067. The
-- modal's Pull (Clawback) tab called fn_union_clawback_from_club for every
-- wallet it was opened on - including the PROMO wallet. That function knows
-- one route: club CHIP TREASURY -> union CHIP BANK. Opened on the promo
-- wallet, a pull took chips out of the club's Club Bank, put them in the
-- union bank, and the promo wallet's figure on screen went UP by the amount.
-- The same wrong-account shape as the 2026-09-05 send bug, in the other
-- direction, one tab over.
--
-- This is the inverse of fn_union_promo_send(destination => 'club'):
--
--   fn_union_clawback_promo_from_club(union, club, amount, notes, op)
--     clubs.promo_balance  -  amount     (refused below zero, never negative)
--     union_wallets.promo_wallet + amount
--     ONE chip_ledger row promo_wallet(club) -> union_wallet, keyed on the op
--     union_wallet_transactions: promo_wallet credit, tx_type promo_clawback,
--       period_id = op (the (union_id, tx_type, period_id) unique index makes a
--       retry answer 'duplicate' instead of pulling twice)
--     chip_transactions: union_promo_clawback on the club, balance_after =
--       the club promo wallet after
--
-- Who: the union owner or a union_lead, exactly as fn_union_clawback_from_club.
-- A club must be in the union. There is no opening-grant floor here: the
-- promo wallet holds nothing a club was granted at opening; the floor on the
-- bank clawback stays where it is.
--
-- Probed on production in a self-aborting DO block before this was applied
-- (CLAUDE.md 11.5 section 2); numbers in the changelog.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_union_clawback_promo_from_club(
  p_union_id uuid,
  p_club_id uuid,
  p_amount numeric,
  p_notes text DEFAULT NULL::text,
  p_op_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_amt       numeric := round(COALESCE(p_amount, 0), 2);
  v_op        uuid := COALESCE(p_op_id, gen_random_uuid());
  v_is_lead   boolean;
  v_club_name text;
  v_pot_after numeric;
  v_after     numeric;
  v_note      text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authenticated');
  END IF;
  IF v_amt <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;
  IF v_amt > 1e9 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Send Limit');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM union_admins ua
     WHERE ua.union_id = p_union_id AND ua.user_id = v_uid AND ua.role = 'union_lead'
  ) OR EXISTS (
    SELECT 1 FROM unions u WHERE u.id = p_union_id AND u.owner_id = v_uid
  ) INTO v_is_lead;
  IF NOT v_is_lead THEN
    RETURN jsonb_build_object('success', false, 'error', 'union lead access required');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM union_clubs uc WHERE uc.union_id = p_union_id AND uc.club_id = p_club_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'club is not in this union');
  END IF;

  -- Lock the union wallet first, then the club: the same order every union
  -- -> club money door takes, so two of them cannot deadlock each other.
  PERFORM 1 FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'union wallet not found');
  END IF;
  SELECT c.name INTO v_club_name FROM clubs c WHERE c.id = p_club_id FOR UPDATE;
  IF v_club_name IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  v_note := COALESCE(NULLIF(btrim(p_notes), ''),
                     'Promo Pulled Back From ' || v_club_name || ' Promo Wallet');

  -- CHIP STANDARD 2.4: ONE journal row, promo_wallet(club) -> union_wallet,
  -- keyed on the op. The union_wallets trigger is skipped; the clubs trigger
  -- writes the row with the union wallet as its counterparty.
  PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', p_union_id, NULL,
    'union_promo_clawback:' || v_op::text, ARRAY['union_wallets']);
  PERFORM set_config('app.ledger_correlation', v_op::text, true);

  UPDATE clubs
     SET promo_balance = COALESCE(promo_balance, 0) - v_amt, updated_at = now()
   WHERE id = p_club_id AND COALESCE(promo_balance, 0) >= v_amt
   RETURNING promo_balance INTO v_pot_after;
  IF NOT FOUND THEN
    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
    RETURN jsonb_build_object('success', false, 'error', 'insufficient club promo wallet balance',
      'club_promo', (SELECT COALESCE(promo_balance, 0) FROM clubs WHERE id = p_club_id),
      'requested', v_amt);
  END IF;

  UPDATE union_wallets
     SET promo_wallet = COALESCE(promo_wallet, 0) + v_amt, updated_at = now()
   WHERE union_id = p_union_id
   RETURNING promo_wallet INTO v_after;
  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);

  INSERT INTO union_wallet_transactions
    (union_id, club_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by)
  VALUES
    (p_union_id, p_club_id, 'promo_wallet', 'credit', v_amt, v_after, 'promo_clawback', v_op,
     v_note, v_uid);

  INSERT INTO chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, metadata)
  VALUES
    (p_club_id, v_uid, NULL, v_amt, 'union_promo_clawback', v_note, v_pot_after,
     jsonb_build_object('union_id', p_union_id, 'op_id', v_op,
                        'source', 'club_promo_wallet',
                        'club_promo_after', v_pot_after,
                        'union_promo_after', v_after));

  RETURN jsonb_build_object('success', true, 'amount', v_amt, 'op_id', v_op,
                            'club_promo_after', v_pot_after, 'promo_after', v_after);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'duplicate', true,
                            'error', 'operation already processed');
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_union_clawback_promo_from_club(uuid, uuid, numeric, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_clawback_promo_from_club(uuid, uuid, numeric, text, uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.fn_union_clawback_promo_from_club(uuid, uuid, numeric, text, uuid) IS
  'The inverse of fn_union_promo_send(club): pulls promo back from clubs.promo_balance into union_wallets.promo_wallet. Union owner or union_lead. Op-keyed via (union_id, tx_type, period_id).';

COMMIT;
