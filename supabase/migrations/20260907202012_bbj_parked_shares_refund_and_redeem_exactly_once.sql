-- Correct the original BBJ recipient transition: one refund per parked share,
-- source-bank-aware Mini refunds, and one funded redemption with a paid receipt.
-- No historical balances are edited; live unclaimed-share count was zero.
-- Isolated actual-function tests passed; external ledger/home/wallet helpers stubbed.
BEGIN;
CREATE OR REPLACE FUNCTION public.bbj_credit_one_recipient(p_payout_id uuid, p_table_id uuid, p_user_id uuid, p_amount numeric, p_seated boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_claimed integer; v_club uuid; v_after numeric; v_key text; v_park_pool uuid; v_kind text; v_parked numeric; v_paid_at timestamptz;
  v_on_felt boolean := false;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'bbj_credit_one_recipient is service only' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN false;
  END IF;

  -- All recipient transitions serialize on the same pool lock as allocation.
  SELECT bp.pool_id, bp.kind INTO v_park_pool, v_kind
    FROM public.bbj_payouts bp WHERE bp.id=p_payout_id AND bp.table_id=p_table_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'jackpot payout/table identity mismatch'; END IF;
  PERFORM 1 FROM public.bbj_pools WHERE id=v_park_pool FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'jackpot funding pool missing'; END IF;
  SELECT u.amount,u.paid_at INTO v_parked,v_paid_at
    FROM public.bbj_unclaimed_shares u
   WHERE u.payout_id=p_payout_id AND u.user_id=p_user_id FOR UPDATE;
  IF v_parked IS NOT NULL AND v_parked <> p_amount THEN
    RAISE EXCEPTION 'parked jackpot amount cannot change on replay';
  END IF;
  IF v_paid_at IS NOT NULL THEN RETURN false; END IF;

  INSERT INTO bbj_payout_recipients (payout_id, user_id, amount)
  VALUES (p_payout_id, p_user_id, p_amount)
  ON CONFLICT (payout_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN false;  -- already credited under this payout
  END IF;

  IF p_seated THEN
    -- The felt is a derived account: the pool debit (bbj_pool -> table_stack)
    -- is the leg, and the seat row simply holds the chips. Delta-mode hand
    -- writes preserve a credit the engine has not seen yet.
    UPDATE table_seats
       SET stack = COALESCE(stack, 0) + p_amount
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    IF v_claimed > 1 THEN RAISE EXCEPTION 'multiple active seats for jackpot recipient'; END IF;
    IF v_claimed = 1 THEN
      v_on_felt := true;
    END IF;
    -- Seat vanished since the engine snapshot: fall through to the wallet.
  END IF;

  IF NOT v_on_felt THEN
  /* A departed recipient is paid to the wallet of the TABLE's club - the one
     the seat was bought in from - never to a "home" club. Keyed, so a replay
     of the payout cannot pay twice; declared as the felt paying out to the
     wallet, which is what the pool debit already put on the felt. */
  v_key := 'bbj:' || p_payout_id::text || ':' || p_user_id::text;
  INSERT INTO public.wallet_credit_idempotency (key, user_id, amount)
  VALUES (v_key, p_user_id, p_amount)
  ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN false;
  END IF;

  /* THE SEAT'S CLUB FIRST (BBJ audit 2026-09-05). On a union table the
     table belongs to the union's shell club and the player is a member of
     SHARK CLUB or Club JAQK - table_seats.club_id says which one the buy-in
     came from. Resolving tables.club_id first picked the shell club, no
     club_members row matched, the UPDATE below took nothing, the RAISE fired,
     and the entire jackpot payout rolled back unpaid. Every candidate is
     checked for an active membership so a club that cannot take the credit is
     never chosen. */
  SELECT s.club_id INTO v_club FROM public.table_seats s
   WHERE s.table_id = p_table_id AND s.user_id = p_user_id AND s.club_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.club_members cm
                  WHERE cm.user_id = p_user_id AND cm.club_id = s.club_id
                    AND cm.status IN ('active', 'approved'))
   ORDER BY s.joined_at DESC LIMIT 1;
  IF v_club IS NULL THEN
    SELECT t.club_id INTO v_club FROM public.tables t
     WHERE t.id = p_table_id AND t.club_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.club_members cm
                    WHERE cm.user_id = p_user_id AND cm.club_id = t.club_id
                      AND cm.status IN ('active', 'approved'));
  END IF;
  IF v_club IS NULL THEN
    v_club := public.fn_player_home_club(p_user_id, NULL);
  END IF;
  /* PARKED, NOT RAISED (BBJ phase 2.3, 2026-09-06). This used to raise, and
     because every credit runs inside bbj_atomic_payout_v2's single
     transaction, that rolled back the ENTIRE jackpot: the bad-beat holder,
     the hand winner and the whole table were paid nothing because ONE
     table-share recipient held no club membership anywhere. Release the
     claim so a later re-drive can still pay them, hand the chips back to the
     pool they left moments ago in this same transaction (conservation stays
     exact), and record the debt as data. */
  IF v_club IS NULL THEN
    DELETE FROM public.bbj_payout_recipients
     WHERE payout_id = p_payout_id AND user_id = p_user_id;
    DELETE FROM public.wallet_credit_idempotency WHERE key = v_key;

    -- The durable parking row owns the refund. A retry that finds the row
    -- cannot return the same money to the bank a second time.
    INSERT INTO public.bbj_unclaimed_shares (payout_id,pool_id,table_id,user_id,amount,reason)
    VALUES (p_payout_id,v_park_pool,p_table_id,p_user_id,p_amount,
      'no club wallet resolved; share returned once to its funding bank and remains owed')
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    IF v_claimed = 1 THEN
      PERFORM public.fn_ca_declare_ledger('bbj_payout','table_stack',p_table_id,NULL,
        'bbj_park:' || v_key,NULL);
      UPDATE public.bbj_pools
         SET main_balance=main_balance + CASE WHEN v_kind='mini' THEN 0 ELSE p_amount END,
             backup_balance=backup_balance + CASE WHEN v_kind='mini' THEN p_amount ELSE 0 END,
             total_paid_out=total_paid_out-p_amount, updated_at=now()
       WHERE id=v_park_pool;
      PERFORM set_config('app.ledger_category','',true);
      PERFORM set_config('app.ledger_counterparty','',true);
      PERFORM set_config('app.ledger_counterparty_entity','',true);
      PERFORM set_config('app.ledger_idempotency_key','',true);
    END IF;

    RAISE WARNING 'bbj_credit_one_recipient: parked % for % (no club wallet resolves at table %); the rest of the payout stands',
      p_amount, p_user_id, p_table_id;
    RETURN false;
  END IF;
  PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);
  PERFORM public.fn_ca_declare_ledger('bbj_payout', 'table_stack', p_table_id, NULL, v_key, NULL);
  UPDATE public.club_members
     SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = now()
   WHERE user_id = p_user_id AND club_id = v_club
   RETURNING chip_balance INTO v_after;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);
  IF v_after IS NULL THEN
    RAISE EXCEPTION 'bbj_credit_one_recipient: the club wallet for % in % did not take the credit', p_user_id, v_club;
  END IF;
  INSERT INTO public.chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, table_id)
  VALUES (v_club, NULL, p_user_id, p_amount, 'bbj_payout',
          'Bad Beat Jackpot share paid to your club wallet (you had left the table)', v_after, p_table_id);
  END IF;

  -- A previously parked share is NOT still funded on the felt. Its returned
  -- amount must leave the same bank in the same transaction as this credit.
  -- Failure rolls back the seat/wallet credit and its idempotency claims.
  IF v_parked IS NOT NULL THEN
    PERFORM public.fn_ca_declare_ledger('bbj_payout','table_stack',p_table_id,NULL,
      'bbj_redeem:' || p_payout_id::text || ':' || p_user_id::text,NULL);
    UPDATE public.bbj_pools
       SET main_balance=main_balance - CASE WHEN v_kind='mini' THEN 0 ELSE p_amount END,
           backup_balance=backup_balance - CASE WHEN v_kind='mini' THEN p_amount ELSE 0 END,
           total_paid_out=total_paid_out+p_amount, updated_at=now()
     WHERE id=v_park_pool
       AND CASE WHEN v_kind='mini' THEN backup_balance ELSE main_balance END >= p_amount;
    IF NOT FOUND THEN RAISE EXCEPTION 'parked jackpot share lacks its original funding'; END IF;
    PERFORM set_config('app.ledger_category','',true);
    PERFORM set_config('app.ledger_counterparty','',true);
    PERFORM set_config('app.ledger_counterparty_entity','',true);
    PERFORM set_config('app.ledger_idempotency_key','',true);
    UPDATE public.bbj_unclaimed_shares SET paid_at=now(),
      paid_note=CASE WHEN v_on_felt THEN 'credited to table seat; funding reclaimed once'
                    ELSE 'credited to club wallet; funding reclaimed once' END
     WHERE payout_id=p_payout_id AND user_id=p_user_id;
  END IF;
  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.bbj_credit_one_recipient(uuid,uuid,uuid,numeric,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bbj_credit_one_recipient(uuid,uuid,uuid,numeric,boolean) TO service_role;
COMMIT;
