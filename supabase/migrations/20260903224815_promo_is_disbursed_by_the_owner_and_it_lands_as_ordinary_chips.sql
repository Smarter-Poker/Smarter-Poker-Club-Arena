-- PROMO IS DISBURSED BY THE OWNER, AND IT LANDS AS ORDINARY CHIPS.
--
-- 2026-09-03, Dan (binding): "PROMO FUNDS ARE PAID DIRECTLY TO CLUBS, OR
-- PLAYERS DIRECTLY FROM THE UNION OWNER (OR CLUB OWNERS WITHOUT ANY UNION
-- AFFILIATION)... FOR NOW, PROMO'S ARE DISBURSED MANUALLY BY OWNERS, AND
-- LEADER BOARDS IS THE ONLY PROMO THAT GETS PAID OUT BY THE PROMO WALLET."
-- And: "PROMO CHIPS ARE TREATED EXACTLY LIKE REGULAR CHIPS ALWAYS... THEY ARE
-- RAKED OUT OF THE POTS, SO THEY ARE THE SAME CHIPS... THE WHOLE POINT IS TO
-- GIVE IT BACK TO THE PLAYERS TO SPEND RIGHT BACK IN THE UNION OR CLUB."
--
-- Until now there was no owner-facing way to do that. The promo float has taken
-- 60,023.71 from the BBJ over its life and paid out 0.00, because the routes
-- that existed went sideways rather than out: union promo to a club's promo
-- float, club promo to an agent's promo float, an agent function reading a
-- column no sweep maintains. Nothing put promo chips in a player's hands.
--
-- fn_promo_disburse is the one door:
--
--     union owner  ->  a member club             (union promo_wallet -> club treasury)
--     union owner  ->  a player in a member club (union promo_wallet -> player chips)
--     club owner   ->  a player in that club     (club promo_balance -> player chips)
--
-- A club inside a union cannot disburse: its union owner does that, which is
-- Dan's rule and also the only reading under which "club owners WITHOUT ANY
-- UNION AFFILIATION" means anything.
--
-- Everything it moves lands as ORDINARY chips - chip_treasury or chip_balance,
-- never a promo_balance, never a playthrough lock. Promo chips came out of the
-- pots; they go back to the felt as the same chips.
--
-- Each disbursement declares its counterparty (so no leg lands in suspense),
-- is keyed on an op id (so a retried click cannot pay twice), refuses a source
-- that cannot cover it, and leaves a chip_transactions receipt naming the
-- owner who authorised it.
--
-- Leaderboards stay the one automatic promo payout: fn_payout_leaderboard,
-- run daily by leaderboard-payout-waterfall-daily, spends seed first, then the
-- promo float, then the operating wallet.

CREATE OR REPLACE FUNCTION public.fn_promo_disburse(
  p_source_kind text,
  p_source_id   uuid,
  p_target_kind text,
  p_target_id   uuid,
  p_amount      numeric,
  p_note        text  DEFAULT NULL,
  p_club_id     uuid  DEFAULT NULL,
  p_op_id       uuid  DEFAULT NULL)
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
    IF EXISTS (SELECT 1 FROM clubs c WHERE c.id = v_club AND c.union_id IS NOT NULL) THEN
      RETURN jsonb_build_object('success', false, 'error',
        'This Club Belongs To A Union; Its Union Owner Disburses The Promo');
    END IF;
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

    /* One journal row per disbursement: the union's promo float is the
       counterparty, and the union_wallets trigger is skipped so the
       destination's own trigger writes the single row. */
    PERFORM public.fn_ca_declare_ledger('promo_disbursement', 'union_wallet', v_union, NULL,
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

    PERFORM public.fn_ca_declare_ledger('promo_disbursement', 'promo_wallet', v_club, NULL,
                                        'promo_disburse:' || v_op::text, ARRAY['clubs']);
    PERFORM set_config('app.ledger_correlation', v_op::text, true);

    UPDATE clubs
       SET promo_balance = promo_balance - v_amt, updated_at = now()
     WHERE id = v_club
     RETURNING round(promo_balance, 2) INTO v_after;
  END IF;

  /* ORDINARY CHIPS (Dan, 2026-09-03): a club takes them into its treasury and a
     player into their cashable balance. Never promo_balance, never a
     playthrough lock - these chips were raked out of the pots and they go back
     to the felt as the same chips. */
  IF v_tgt = 'club' THEN
    UPDATE clubs
       SET chip_treasury = COALESCE(chip_treasury, 0) + v_amt, updated_at = now()
     WHERE id = v_club
     RETURNING round(chip_treasury, 2) INTO v_to_after;
  ELSE
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
                        'lands_as', 'ordinary_chips'),
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
    'lands_as', 'ordinary_chips');
END
$function$;

REVOKE ALL ON FUNCTION public.fn_promo_disburse(text, uuid, text, uuid, numeric, text, uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_promo_disburse(text, uuid, text, uuid, numeric, text, uuid, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_promo_disburse(text, uuid, text, uuid, numeric, text, uuid, uuid) IS
  'The one owner-facing promo door (Dan, 2026-09-03): a union owner sends promo to a member '
  'club or to a player in one, and an unaffiliated club owner sends it to a player in that '
  'club. It always lands as ordinary chips. Op-keyed, declared, and refused when the float '
  'is short. Leaderboards remain the only automatic promo payout.';