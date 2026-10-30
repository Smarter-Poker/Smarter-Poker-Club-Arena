-- live_md5 19cd9ea4fb671379fe84f05d409812a1
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_pay(p_user_id uuid, p_amount numeric, p_idempotency_key text, p_category text, p_tournament_id uuid, p_description text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_arena uuid; v_kind text; v_bank numeric; v_inserted integer; v_drained jsonb; v_credit jsonb; v_e record;
  v_category text := lower(COALESCE(p_category,''));
  v_prior public.poker_diamond_tournament_ledger%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_tournament_id IS NULL OR p_idempotency_key IS NULL
     OR p_amount IS NULL OR p_amount < 1 OR p_amount <> trunc(p_amount) OR p_amount > 2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_pay_requires_whole_diamonds' USING ERRCODE='22023';
  END IF;
  SELECT t.club_id INTO v_arena FROM public.tournaments t JOIN public.clubs c ON c.id=t.club_id
   WHERE t.id=p_tournament_id AND c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL AND t.union_id IS NULL;
  IF v_arena IS NULL THEN RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514'; END IF;
  v_kind := CASE WHEN v_category='bounty' THEN 'bounty'
                 WHEN v_category='prize' THEN 'prize'
                 ELSE NULL END;
  IF v_kind IS NULL THEN
    -- A refund never reaches this door: the Diamond refund authority returns
    -- entries whole through fn_poker_diamond_release.
    RAISE EXCEPTION 'diamond_tournament_pay_unknown_category:%', v_category USING ERRCODE='22023';
  END IF;

  -- The key is claimed before any Diamond moves, as the chip credit claims it.
  INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
  VALUES (p_idempotency_key,p_user_id,p_amount) ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    -- DIAMOND PHASE 11: A RETRY GETS ITS FIRST RECEIPT. The key is the
    -- payment's identity. The same payee, event, bank and amount under it is
    -- this payment, already made: it answers as the first delivery did (true)
    -- and moves nothing. Any other use of the key - another payee, event, bank
    -- or amount, or a key another credit claimed - is refused by name, as every
    -- other Diamond door refuses a reused request id. The description is the
    -- payment's label, not its identity.
    SELECT l.* INTO v_prior FROM public.poker_diamond_tournament_ledger l
     WHERE l.idempotency_key='poker-tournament-pay:'||p_idempotency_key;
    IF NOT FOUND
       OR v_prior.kind IS DISTINCT FROM v_kind
       OR v_prior.tournament_id IS DISTINCT FROM p_tournament_id
       OR v_prior.user_id IS DISTINCT FROM p_user_id
       OR v_prior.amount IS DISTINCT FROM p_amount THEN
      RAISE EXCEPTION 'diamond_tournament_pay_key_reused' USING ERRCODE='22023';
    END IF;
    RETURN true;
  END IF;

  -- The bank this payment draws on: a place from the prize bank, a knockout
  -- (its cash half, the champion's own head, the residual) from the bounty
  -- bank. Each is the sum of the entries' parts less what it already paid.
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  v_bank := CASE WHEN v_kind='bounty' THEN v_e.bounty_balance ELSE v_e.prize_balance END;
  IF v_bank < p_amount THEN
    RAISE EXCEPTION 'diamond_tournament_bank_short' USING ERRCODE='P0404';
  END IF;
  -- A knockout is paid while the event runs, before the terminal opens the
  -- escrow shadow; the shadow is opened here from the Diamond ledger's exact
  -- parts (idempotent, asserted) so the chip shadow never opens itself from a
  -- proportional split at the first bounty.
  PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);

  -- The recipient's wallet first (its journal row is what every drained
  -- row's movement carries), then the custody rows, oldest first.
  v_credit := public.add_diamonds_to_balance(
    p_user_id, p_amount::integer, 'arena_withdraw',
    COALESCE(NULLIF(btrim(p_description),''), CASE WHEN v_kind='bounty' THEN 'Tournament bounty' ELSE 'Tournament prize' END),
    'poker-tournament-pay:'||p_idempotency_key);
  IF COALESCE((v_credit->>'success')::boolean,false) IS NOT TRUE OR NULLIF(v_credit->>'transaction_id','') IS NULL THEN
    RAISE EXCEPTION 'diamond_tournament_pay_credit_failed:%', v_credit->>'error' USING ERRCODE='P0404';
  END IF;
  v_drained := public.fn_poker_diamond_tournament_drain(
    p_tournament_id, v_kind, p_amount::bigint, 'poker-tournament-pay:'||p_idempotency_key, 'player:'||p_user_id::text,
    (v_credit->>'transaction_id')::uuid);

  INSERT INTO public.poker_diamond_tournament_ledger(
    tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,
    idempotency_key,wallet_journal_id,request)
  VALUES (p_tournament_id,v_arena,p_user_id,NULL,v_kind,p_amount::bigint,
    CASE WHEN v_kind='prize' THEN p_amount::bigint ELSE 0 END,
    CASE WHEN v_kind='bounty' THEN p_amount::bigint ELSE 0 END,0,
    'poker-tournament-pay:'||p_idempotency_key,(v_credit->>'transaction_id')::uuid,
    jsonb_build_object('kind',v_kind,'credit_key',p_idempotency_key,'drained',v_drained,'description',p_description));

  -- The escrow shadow follows, as a chip payment's wallet row makes it follow.
  IF v_kind='bounty' THEN
    PERFORM public.fn_ca_escrow_apply(p_tournament_id,'diamond bounty',p_bounty_out => p_amount);
  ELSE
    PERFORM public.fn_ca_escrow_apply(p_tournament_id,'diamond prize',p_prize_out => p_amount);
  END IF;

  IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id))
     IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  -- The answer no longer tells a payment from its retry, so the payment names
  -- its key for the one caller that must know: fn_credit_and_log writes the
  -- payout evidence once, on the call that paid. A retry names nothing.
  PERFORM set_config('app.diamond_tournament_pay_claimed', p_idempotency_key, true);
  RETURN true;
END $function$

