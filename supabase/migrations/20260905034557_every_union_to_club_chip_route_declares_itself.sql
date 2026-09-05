-- 20260905034557_every_union_to_club_chip_route_declares_itself.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard, 2026-09-05 03:5x UTC):
--
-- Dan sent promo from the Midway Union to SHARK CLUB, Club JAQK and a KingFish
-- agent at 02:51 UTC and none of it showed in a promo wallet. PR #3065 found
-- and fixed the cause (the union modal routed a club target through the
-- Club Bank send, and fn_union_promo_send itself credited chip_treasury), and
-- rerouted the money with keyed rows at 03:07 UTC. This migration closes what
-- the incident exposed in the chip standard itself, read from the journal:
--
--   1. fn_union_send_to_club_atomic (the Club Bank route, and the door the
--      modal called) never declared its ledger. Each 5,000 landed as TWO
--      undeclared adjustments through settlement_suspense (02:51:02 and
--      02:51:14 UTC), so a send nobody could find in a wallet was also a
--      send nobody could find in the journal. It now writes one keyed row,
--      union_bank -> club_treasury.
--   2. fn_union_promo_send's bbj_main branch is a jackpot door that Phase 4.3
--      missed: union promo -> bbj_pools.main_balance was undeclared. It now
--      writes one keyed row, union_wallet -> bbj_pool, which the BBJ meter
--      reads as a seed instead of an unexplained bank move.
--   3. fn_club_promo_wallet_send (new in #3065) is a money door with no
--      registry row; fn_ca_money_rpc_drift filed rpc-drift:fn_club_promo_
--      wallet_send at 03:39 UTC. It is registered, and the incident resolved
--      with this migration as its correction_ref.
--
-- Bodies are the live definitions with the declaration added and nothing
-- else changed; ACLs restated in full for check-definer-authorization.
-- Probed rolled back first (a 1.00 send on each route, journal row read).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_union_send_to_club_atomic(p_union_id uuid, p_club_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text, p_created_by uuid DEFAULT NULL::uuid, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_balance numeric;
  v_after numeric;
  v_op uuid := COALESCE(p_op_id, gen_random_uuid());
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM union_clubs uc WHERE uc.union_id = p_union_id AND uc.club_id = p_club_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'club is not in this union');
  END IF;

  SELECT chip_balance INTO v_balance FROM union_wallets
   WHERE union_id = p_union_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union wallet not found');
  END IF;
  IF v_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient union balance',
                              'balance', v_balance, 'requested', p_amount);
  END IF;

  -- CHIP STANDARD (2026-09-05): the Club Bank route declares itself. ONE
  -- journal row, union_bank -> club_treasury, keyed on the operation. Until
  -- today both halves of this send landed in settlement_suspense as two
  -- unrelated adjustments, which is how the 02:51 UTC sends were found.
  PERFORM public.fn_ca_declare_ledger('union_send', 'union_bank', p_union_id, NULL,
    'union_send_to_club:' || v_op::text, ARRAY['union_wallets']);
  PERFORM set_config('app.ledger_correlation', v_op::text, true);

  UPDATE union_wallets
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE union_id = p_union_id
   RETURNING chip_balance INTO v_after;

  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) + p_amount
   WHERE id = p_club_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'club % not found', p_club_id;
  END IF;
  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);

  INSERT INTO union_wallet_transactions (
    union_id, wallet, direction, amount, balance_after, tx_type, club_id, period_id, notes, created_by
  ) VALUES (
    p_union_id, 'chip_balance', 'debit', p_amount, v_after, 'manual_transfer',
    p_club_id, p_op_id, COALESCE(NULLIF(p_notes, ''), 'Union transfer to club'), p_created_by
  );
  INSERT INTO chip_transactions (club_id, amount, transaction_type, notes)
  VALUES (p_club_id, p_amount, 'union_transfer',
          COALESCE(NULLIF(p_notes, ''), 'Union chip distribution'));

  RETURN jsonb_build_object('success', true, 'amount', p_amount, 'union_balance_after', v_after);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'duplicate', true,
                            'error', 'operation already processed');
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_union_send_to_club_atomic(uuid, uuid, numeric, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_send_to_club_atomic(uuid, uuid, numeric, text, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_union_promo_send(p_union_id uuid, p_amount numeric, p_destination text, p_club_id uuid, p_op_id uuid, p_created_by uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_amt        numeric := round(COALESCE(p_amount, 0), 2);
  v_actor      uuid := COALESCE(p_created_by, auth.uid());
  v_promo      numeric;
  v_after      numeric;
  v_club_after numeric;
  v_pool_id    uuid;
  v_club_name  text;
  v_note       text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.fn_union_can_manage_wallets(p_union_id, auth.uid()) THEN
    RETURN jsonb_build_object('success', false,
      'error', 'Only the union owner, co-owner or an admin can send from union wallets.');
  END IF;
  IF v_amt <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;
  IF p_destination NOT IN ('club', 'bbj_main') THEN
    RETURN jsonb_build_object('success', false, 'error', 'destination must be club or bbj_main');
  END IF;
  IF p_op_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'op_id_required');
  END IF;

  SELECT COALESCE(promo_wallet, 0) INTO v_promo
    FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_promo IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union wallet not found');
  END IF;
  IF v_promo < v_amt THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient promo balance',
                              'available', v_promo, 'requested', v_amt);
  END IF;

  IF p_destination = 'club' THEN
    IF p_club_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'club_id required');
    END IF;
    -- A union may only fund ITS OWN clubs. Without this a promo transfer is a
    -- chip mint into any club in the database.
    IF NOT EXISTS (SELECT 1 FROM union_clubs uc
                    WHERE uc.union_id = p_union_id AND uc.club_id = p_club_id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'club is not in this union');
    END IF;
    SELECT c.name INTO v_club_name FROM clubs c WHERE c.id = p_club_id FOR UPDATE;
    IF v_club_name IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'club not found');
    END IF;
    v_note := COALESCE(NULLIF(btrim(p_notes), ''), 'Union Promo Wallet To ' || v_club_name || ' Promo Wallet');

    -- CHIP STANDARD 2.4: ONE journal row, union_wallet -> promo_wallet(club).
    -- The union_wallets trigger is skipped; the clubs trigger writes the row
    -- with the union wallet as its counterparty.
    PERFORM public.fn_ca_declare_ledger('promo_send', 'union_wallet', p_union_id, NULL,
      'union_promo_to_club:' || p_op_id::text, ARRAY['union_wallets']);
    PERFORM set_config('app.ledger_correlation', p_op_id::text, true);

    UPDATE union_wallets SET promo_wallet = promo_wallet - v_amt, updated_at = now()
     WHERE union_id = p_union_id RETURNING promo_wallet INTO v_after;

    -- THE CLUB'S PROMO WALLET. Not chip_treasury: that is the Club Bank, and
    -- a promo send that lands there is a promo send nobody can find.
    UPDATE clubs SET promo_balance = COALESCE(promo_balance, 0) + v_amt, updated_at = now()
     WHERE id = p_club_id RETURNING promo_balance INTO v_club_after;

    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);

    INSERT INTO union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by)
    VALUES
      (p_union_id, p_club_id, 'promo_wallet', 'debit', v_amt, v_after, 'promo_to_club', p_op_id,
       v_note, v_actor);

    INSERT INTO chip_transactions
      (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, metadata)
    VALUES
      (p_club_id, v_actor, NULL, v_amt, 'union_promo_to_club', v_note, v_club_after,
       jsonb_build_object('union_id', p_union_id, 'op_id', p_op_id,
                          'destination', 'club_promo_wallet',
                          'union_promo_after', v_after,
                          'club_promo_after', v_club_after));

    RETURN jsonb_build_object('success', true, 'destination', 'club', 'amount', v_amt,
                              'promo_after', v_after,
                              'club_promo_after', v_club_after,
                              'club_treasury_after', NULL);
  END IF;

  -- destination = 'bbj_main'
  -- CHIP STANDARD (2026-09-05): this branch is a jackpot door and declares
  -- itself like every other one (Phase 4.3). ONE journal row,
  -- union_wallet -> bbj_pool (bbj_pools.main_balance), keyed on the
  -- operation, so the BBJ meter sees the seed and nothing lands in suspense.
  PERFORM public.fn_ca_declare_ledger('promo_send', 'union_wallet', p_union_id, NULL,
    'union_promo_to_bbj:' || p_op_id::text, ARRAY['union_wallets']);
  PERFORM set_config('app.ledger_correlation', p_op_id::text, true);

  UPDATE union_wallets SET promo_wallet = promo_wallet - v_amt, updated_at = now()
   WHERE union_id = p_union_id RETURNING promo_wallet INTO v_after;

  UPDATE bbj_pools
     SET main_balance = COALESCE(main_balance,0) + v_amt,
         pool_amount  = COALESCE(pool_amount,0)  + v_amt,
         updated_at   = now()
   WHERE union_id = p_union_id AND status = 'active'
   RETURNING id INTO v_pool_id;
  IF v_pool_id IS NULL THEN
    RAISE EXCEPTION 'no active BBJ pool for union %', p_union_id;
  END IF;
  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);

  INSERT INTO union_wallet_transactions
    (union_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by)
  VALUES
    (p_union_id, 'promo_wallet', 'debit', v_amt, v_after, 'promo_to_bbj_main', p_op_id,
     COALESCE(NULLIF(p_notes, ''), 'Promo wallet -> main jackpot'), v_actor);

  RETURN jsonb_build_object('success', true, 'destination', 'bbj_main', 'amount', v_amt,
                            'promo_after', v_after, 'pool_id', v_pool_id);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'duplicate', true,
                            'error', 'operation already processed');
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_union_promo_send(uuid, numeric, text, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_promo_send(uuid, numeric, text, uuid, uuid, uuid, text) TO service_role;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_club_promo_wallet_send', 'approved', 'PR #3065 (2026-09-05): club promo wallet -> player wallet or agent promo float; declared promo_send, keyed club_promo_send:<op>; registered by the chip standard the same night'),
  ('fn_union_send_to_club_atomic', 'approved', 'grandfathered at phase-1 baseline; declared 2026-09-05 (union_send, union_bank -> club_treasury, keyed union_send_to_club:<op>)'),
  ('fn_union_promo_send', 'approved', 'grandfathered at phase-1 baseline; club branch declared by #3065, bbj_main branch declared 2026-09-05 (promo_send, union_wallet -> bbj_pool, keyed union_promo_to_bbj:<op>)')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(),
       correction_ref = 'migration 20260905034557_every_union_to_club_chip_route_declares_itself',
       root_cause = 'A new money door (fn_club_promo_wallet_send, PR #3065) was created without a ca_money_rpc_registry row; the drift check filed it within seconds. Registered here; the door already declares a keyed promo_send ledger.'
 WHERE dedupe_key = 'rpc-drift:fn_club_promo_wallet_send' AND status = 'open';

DO $$
DECLARE v_open int; v_left int;
BEGIN
  SELECT count(*) INTO v_open FROM public.ca_drift_incidents WHERE dedupe_key = 'rpc-drift:fn_club_promo_wallet_send' AND status = 'open';
  IF v_open <> 0 THEN RAISE EXCEPTION 'rpc-drift incident still open'; END IF;
  SELECT count(*) INTO v_left FROM public.fn_ca_money_rpc_drift() d WHERE d.proname NOT IN ('fn_cash_seat_move_execute', 'fn_cash_seat_swap_execute');
  IF v_left <> 0 THEN RAISE EXCEPTION 'money rpc drift is not zero for the chip standard doors: %', v_left; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
        AND p.proname IN ('fn_union_send_to_club_atomic', 'fn_union_promo_send') AND p.prosrc LIKE '%fn_ca_declare_ledger%') <> 2 THEN
    RAISE EXCEPTION 'a union to club route still does not declare itself';
  END IF;
END $$;

COMMIT;
