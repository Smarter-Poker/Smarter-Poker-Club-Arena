-- 20260905031715_the_club_promo_wallet_is_where_union_promo_lands.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- DAN'S RULING, 2026-09-05 (resolves a conflict between two written rules):
--
--   The 2026-09-03 promo model (tests/promo-is-disbursed-by-the-owner.law
--   .test.ts, migration ..._promo_disburse) had union promo to a CLUB land as
--   ordinary chips in the club's CLUB BANK (chip_treasury), "never a
--   promo_balance", and refused a union club the use of its own promo wallet
--   ("Its Union Owner Disburses The Promo").
--
--   On 2026-09-05 Dan sent promo from the Midway Union to two clubs, opened
--   each club's Promo Wallet, found 0.00, and reported the chips missing. Put
--   to him as a choice between the two rules, he chose:
--
--     UNION PROMO TO A CLUB LANDS IN THAT CLUB'S PROMO WALLET
--     (clubs.promo_balance). Club staff hand it out from there, into player
--     wallets as cash or into agent promo floats, and it carries its own
--     ledger.
--
--   "Promo chips are treated exactly like regular chips" still holds at the
--   point they reach a PLAYER: a hand-out from the club promo wallet credits
--   club_members.chip_balance, cashable, no playthrough. The club promo wallet
--   is a holding account on the way, the same one a standalone club's BBJ
--   promo slice already sweeps into.
--
-- So this migration brings fn_promo_disburse, the 2026-09-03 door, in line
-- with fn_union_promo_send (migration 20260905030103), which already lands in
-- the club promo wallet:
--
--   1. target 'club': credits clubs.promo_balance, not chip_treasury.
--      lands_as = 'club_promo_wallet'.
--   2. source 'club': a club in a union may spend its OWN promo wallet. The
--      refusal "This Club Belongs To A Union; Its Union Owner Disburses The
--      Promo" is removed - the union funds the wallet; the club spends it.
--      Owner / co-owner authorisation is unchanged.
--
-- Nothing else in the function moves. No data changes here.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_promo_disburse(
  p_source_kind text,
  p_source_id uuid,
  p_target_kind text,
  p_target_id uuid,
  p_amount numeric,
  p_note text DEFAULT NULL::text,
  p_club_id uuid DEFAULT NULL::uuid,
  p_op_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor    uuid := auth.uid();
  v_service  boolean := (COALESCE(auth.role(), '') = 'service_role');
  v_amt      numeric := round(COALESCE(p_amount, 0), 2);
  v_op       uuid := COALESCE(p_op_id, gen_random_uuid());
  v_src      text := lower(COALESCE(p_source_kind, ''));
  v_tgt      text := lower(COALESCE(p_target_kind, ''));
  v_avail    numeric;
  v_after    numeric;
  v_to_after numeric;
  v_club     uuid;
  v_union    uuid;
  v_prior    record;
  v_tx       uuid;
  v_lands_as text;
BEGIN
  IF v_actor IS NULL AND NOT v_service THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not Authenticated');
  END IF;
  IF v_src NOT IN ('union', 'club') THEN
    RETURN jsonb_build_object('success', false, 'error', 'source must be union or club');
  END IF;
  IF v_tgt NOT IN ('club', 'player') THEN
    RETURN jsonb_build_object('success', false, 'error', 'target must be club or player');
  END IF;
  IF v_src = 'club' AND v_tgt = 'club' THEN
    RETURN jsonb_build_object('success', false, 'error', 'a club disburses promo to its players, not to a club');
  END IF;
  IF p_source_id IS NULL OR p_target_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'source and target are required');
  END IF;

  /* A replay of the same op returns the first answer and moves nothing. */
  SELECT id, amount, metadata INTO v_prior
    FROM chip_transactions
   WHERE transaction_type = 'promo_disbursement'
     AND metadata ->> 'op_id' = v_op::text
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'replayed', true,
      'transaction_id', v_prior.id, 'amount', v_prior.amount,
      'source_after', (v_prior.metadata ->> 'source_after')::numeric,
      'recipient_after', (v_prior.metadata ->> 'recipient_after')::numeric);
  END IF;

  IF v_amt <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  END IF;
  IF v_amt <> round(v_amt, 2) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Chips Move In Hundredths At Most');
  END IF;
  IF v_amt > 1e9 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Send Limit');
  END IF;

  -- who may spend this promo float
  IF v_src = 'union' THEN
    v_union := p_source_id;
    IF NOT v_service AND NOT EXISTS (
         SELECT 1 FROM unions u WHERE u.id = v_union AND u.owner_id = v_actor) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Only The Union Owner May Disburse Union Promo');
    END IF;
  ELSE
    v_club := p_source_id;
    /* DAN 2026-09-05: a club inside a union spends its OWN promo wallet - the
       union pays into it (fn_union_promo_send), the club hands it out. The
       2026-09-03 refusal for union clubs is gone. */
    IF NOT v_service AND NOT EXISTS (
         SELECT 1 FROM clubs c WHERE c.id = v_club AND c.owner_id = v_actor)
       AND NOT EXISTS (
         SELECT 1 FROM club_members m
          WHERE m.club_id = v_club AND m.user_id = v_actor
            AND m.role IN ('owner', 'co_owner')) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Only The Club Owner May Disburse Club Promo');
    END IF;
  END IF;

  -- where it is going
  IF v_tgt = 'club' THEN
    IF NOT EXISTS (SELECT 1 FROM union_clubs uc
                    WHERE uc.union_id = v_union AND uc.club_id = p_target_id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'That Club Is Not In This Union');
    END IF;
    v_club := p_target_id;
  ELSE
    /* A player holds chips inside a club, so the club is part of the address.
       Under a union source the club must be one of its member clubs. */
    IF v_src = 'union' THEN
      v_club := p_club_id;
      IF v_club IS NULL THEN
        SELECT m.club_id INTO v_club
          FROM club_members m
          JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
         WHERE m.user_id = p_target_id
           AND COALESCE(m.status, 'active') IN ('active', 'approved')
         ORDER BY m.updated_at DESC NULLS LAST
         LIMIT 1;
      END IF;
      IF v_club IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'That Player Is Not In Any Club Of This Union');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM union_clubs uc
                      WHERE uc.union_id = v_union AND uc.club_id = v_club) THEN
        RETURN jsonb_build_object('success', false, 'error', 'That Club Is Not In This Union');
      END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM club_members m
                    WHERE m.club_id = v_club AND m.user_id = p_target_id
                      AND COALESCE(m.status, 'active') IN ('active', 'approved')) THEN
      RETURN jsonb_build_object('success', false, 'error', 'That Player Is Not An Active Member Of That Club');
    END IF;
  END IF;

  -- the money, declared and keyed
  IF v_src = 'union' THEN
    SELECT COALESCE(promo_wallet, 0) INTO v_avail
      FROM union_wallets WHERE union_id = v_union FOR UPDATE;
    IF v_avail IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Union Wallet Not Found');
    END IF;
    IF v_avail < v_amt THEN
      RETURN jsonb_build_object('success', false, 'error', 'Insufficient Promo Balance',
                                'available', v_avail, 'requested', v_amt);
    END IF;

    /* One journal row per disbursement, in the ledger's own word for this
       money: 'promo'. The union's promo float is the counterparty and the
       union_wallets trigger is skipped, so the destination's own trigger
       writes the single row. */
    PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', v_union, NULL,
                                        'promo_disburse:' || v_op::text, ARRAY['union_wallets']);
    PERFORM set_config('app.ledger_correlation', v_op::text, true);

    UPDATE union_wallets
       SET promo_wallet = promo_wallet - v_amt, updated_at = now()
     WHERE union_id = v_union
     RETURNING round(promo_wallet, 2) INTO v_after;
  ELSE
    SELECT COALESCE(promo_balance, 0) INTO v_avail
      FROM clubs WHERE id = v_club FOR UPDATE;
    IF v_avail IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Club Not Found');
    END IF;
    IF v_avail < v_amt THEN
      RETURN jsonb_build_object('success', false, 'error', 'Insufficient Promo Balance',
                                'available', v_avail, 'requested', v_amt);
    END IF;

    PERFORM public.fn_ca_declare_ledger('promo', 'promo_wallet', v_club, NULL,
                                        'promo_disburse:' || v_op::text, ARRAY['clubs']);
    PERFORM set_config('app.ledger_correlation', v_op::text, true);

    UPDATE clubs
       SET promo_balance = promo_balance - v_amt, updated_at = now()
     WHERE id = v_club
     RETURNING round(promo_balance, 2) INTO v_after;
  END IF;

  /* WHERE IT LANDS (Dan 2026-09-05): a CLUB takes union promo into its PROMO
     WALLET (clubs.promo_balance), to hand out from there. A PLAYER takes it as
     ordinary chips - cashable, no playthrough lock - because promo chips are
     regular chips the moment they reach the felt. */
  IF v_tgt = 'club' THEN
    v_lands_as := 'club_promo_wallet';
    UPDATE clubs
       SET promo_balance = COALESCE(promo_balance, 0) + v_amt, updated_at = now()
     WHERE id = v_club
     RETURNING round(promo_balance, 2) INTO v_to_after;
  ELSE
    v_lands_as := 'ordinary_chips';
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance, 0) + v_amt, updated_at = now()
     WHERE club_id = v_club AND user_id = p_target_id
     RETURNING round(chip_balance, 2) INTO v_to_after;
  END IF;

  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
  PERFORM set_config('app.ledger_autoskip_clubs', '', true);

  IF v_to_after IS NULL THEN
    RAISE EXCEPTION 'promo disbursement credit found no row: % %', v_tgt, p_target_id;
  END IF;

  INSERT INTO chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  VALUES
    (v_club, v_actor,
     CASE WHEN v_tgt = 'player' THEN p_target_id END,
     v_amt, 'promo_disbursement',
     COALESCE(NULLIF(btrim(p_note), ''), 'Promo Disbursement'),
     jsonb_build_object('op_id', v_op,
                        'source_kind', v_src, 'source_id', p_source_id,
                        'target_kind', v_tgt, 'target_id', p_target_id,
                        'authorised_by', v_actor,
                        'source_after', v_after,
                        'recipient_after', v_to_after,
                        'lands_as', v_lands_as),
     v_to_after)
  RETURNING id INTO v_tx;

  IF v_src = 'union' THEN
    INSERT INTO union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
    VALUES
      (v_union, v_club, 'promo_wallet', 'debit', v_amt, v_after, 'promo_disbursement',
       COALESCE(NULLIF(btrim(p_note), ''), 'Promo disbursed by the union owner')
         || ' (' || v_tgt || ')',
       v_actor);
  END IF;

  RETURN jsonb_build_object('success', true, 'replayed', false,
    'transaction_id', v_tx, 'op_id', v_op, 'amount', v_amt,
    'source_kind', v_src, 'target_kind', v_tgt, 'club_id', v_club,
    'source_after', v_after, 'recipient_after', v_to_after,
    'lands_as', v_lands_as);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_promo_disburse(text, uuid, text, uuid, numeric, text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_promo_disburse(text, uuid, text, uuid, numeric, text, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_promo_disburse(text, uuid, text, uuid, numeric, text, uuid, uuid) IS
  'The owner''s promo door. union -> club lands in clubs.promo_balance (the club Promo Wallet, Dan 2026-09-05); union -> player and club -> player land as ordinary cashable chips. A club in a union spends its own promo wallet.';

COMMIT;
