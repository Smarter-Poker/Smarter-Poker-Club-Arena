-- Phase 4 restores the existing wallet RPC as a single transaction.
-- Purchased refund collateral and game custody never leave through this path.
BEGIN;
CREATE TABLE public.diamond_wallet_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  request_id text NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  message text,
  sender_journal_id uuid NOT NULL,
  recipient_journal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sender_id, request_id),
  CHECK(sender_id <> recipient_id)
);
ALTER TABLE public.diamond_wallet_transfers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.diamond_wallet_transfers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.diamond_wallet_transfers TO authenticated;
GRANT ALL ON public.diamond_wallet_transfers TO service_role;
CREATE POLICY wallet_transfer_participants ON public.diamond_wallet_transfers
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) IN (sender_id, recipient_id));
CREATE TRIGGER wallet_transfers_append_only BEFORE UPDATE OR DELETE
  ON public.diamond_wallet_transfers FOR EACH ROW
  EXECUTE FUNCTION public.fn_ca_journal_append_only();

CREATE OR REPLACE FUNCTION public.send_wallet_diamond_transfer(
  p_recipient_id uuid, p_amount integer,
  p_message text DEFAULT NULL, p_reference_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_sender uuid := auth.uid();
  v_previous public.diamond_wallet_transfers%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_sender_balance integer;
  v_recipient_balance integer;
  v_collateral bigint;
  v_cap jsonb;
  v_debt record;
  v_take integer;
  v_settled integer := 0;
  v_sender_journal uuid;
  v_recipient_journal uuid;
  v_debt_journal uuid;
  v_ref text;
BEGIN
  IF v_sender IS NULL THEN
    RAISE EXCEPTION 'authentication_required' USING ERRCODE='42501';
  END IF;
  IF p_recipient_id IS NULL OR p_recipient_id = v_sender
     OR p_amount IS NULL OR p_amount <= 0
     OR p_reference_id IS NULL
     OR p_reference_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{11,127}$'
     OR length(COALESCE(p_message,'')) > 280 THEN
    RAISE EXCEPTION 'invalid_transfer_request' USING ERRCODE='22023';
  END IF;

  -- Shares the authoritative profile locks used by store spending and custody.
  PERFORM 1 FROM public.profiles WHERE id=LEAST(v_sender,p_recipient_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'transfer_profile_not_found'; END IF;
  PERFORM 1 FROM public.profiles WHERE id=GREATEST(v_sender,p_recipient_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'transfer_profile_not_found'; END IF;

  SELECT * INTO v_previous FROM public.diamond_wallet_transfers
    WHERE sender_id=v_sender AND request_id=p_reference_id;
  IF FOUND THEN
    IF v_previous.recipient_id <> p_recipient_id OR v_previous.amount <> p_amount
       OR v_previous.message IS DISTINCT FROM p_message THEN
      RAISE EXCEPTION 'idempotency_payload_mismatch' USING ERRCODE='22023';
    END IF;
    RETURN to_jsonb(v_previous) || jsonb_build_object('success',true);
  END IF;

  -- Rechecked at the writer, even when the UI selected an accepted friend.
  PERFORM 1 FROM public.friendships
    WHERE status='accepted' AND
      ((user_id=v_sender AND friend_id=p_recipient_id) OR
       (user_id=p_recipient_id AND friend_id=v_sender))
    FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'accepted_friend_required' USING ERRCODE='42501'; END IF;

  v_cap := public.fn_check_anti_farming_gift_cap(v_sender,p_recipient_id,p_amount);
  IF (v_cap->>'allowed')::boolean IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('success',false,'code',v_cap->>'code',
      'error',v_cap->>'reason','cap_check',v_cap);
  END IF;
  SELECT diamonds INTO v_sender_balance FROM public.profiles WHERE id=v_sender;
  SELECT diamonds INTO v_recipient_balance FROM public.profiles WHERE id=p_recipient_id;
  -- Preserve the current refundable-purchase restriction. Held purchased units
  -- are already outside available balance, so do not subtract them twice.
  SELECT COALESCE(sum(GREATEST(issued-consumed-refunded-arena_reserved,0)),0)
    INTO v_collateral FROM public.diamond_purchase_lots WHERE user_id=v_sender;
  IF v_sender_balance IS NULL OR v_sender_balance < p_amount
     OR v_sender_balance::bigint-v_collateral < p_amount THEN
    RETURN jsonb_build_object('success',false,'code','insufficient_transferable_diamonds',
      'error','Only Available Diamonds Outside Purchased Refund Collateral Can Be Sent');
  END IF;
  IF v_recipient_balance IS NULL
     OR v_recipient_balance::bigint+p_amount > 2147483647 THEN
    RAISE EXCEPTION 'recipient_balance_limit';
  END IF;

  -- Same debt treatment as the existing authoritative positive-credit path.
  -- Separate transfer journals retain the actual counterparty, not player:unknown.
  FOR v_debt IN SELECT * FROM public.diamond_debts
    WHERE user_id=p_recipient_id AND settled_at IS NULL
    ORDER BY created_at,id FOR UPDATE
  LOOP
    EXIT WHEN v_settled >= p_amount;
    v_take := LEAST(v_debt.amount,p_amount-v_settled);
    IF v_take = v_debt.amount THEN
      UPDATE public.diamond_debts SET settled_at=now(),settled_by='send_wallet_diamond_transfer'
        WHERE id=v_debt.id;
    ELSE
      UPDATE public.diamond_debts SET amount=amount-v_take WHERE id=v_debt.id;
      INSERT INTO public.diamond_debts(user_id,purchase_id,amount,reason,created_at,settled_at,settled_by)
        VALUES(p_recipient_id,v_debt.purchase_id,v_take,
          v_debt.reason || ' (partial settlement of ' || v_debt.id || ')',
          v_debt.created_at,now(),'send_wallet_diamond_transfer');
    END IF;
    v_settled := v_settled+v_take;
  END LOOP;

  v_ref := 'wallet-transfer:' || v_sender || ':' || p_reference_id;
  INSERT INTO public.diamond_transactions(user_id,amount,type,transaction_type,source,
    description,balance_after,reference_id,counterparty,issuance_class,metadata)
  VALUES(v_sender,-p_amount,'diamond_gift_sent','diamond_gift_sent','wallet_diamond_transfer',
    'Diamonds Sent To A Friend',v_sender_balance-p_amount,v_ref || ':sender',
    'player:' || p_recipient_id,'transferred',
    jsonb_build_object('transfer_id',v_id,'recipient_id',p_recipient_id,'message',p_message))
  RETURNING id INTO v_sender_journal;
  INSERT INTO public.diamond_transactions(user_id,amount,type,transaction_type,source,
    description,balance_after,reference_id,counterparty,issuance_class,metadata)
  VALUES(p_recipient_id,p_amount,'diamond_gift_received','diamond_gift_received','wallet_diamond_transfer',
    'Diamonds Received From A Friend',v_recipient_balance+p_amount,v_ref || ':recipient',
    'player:' || v_sender,'transferred',
    jsonb_build_object('transfer_id',v_id,'sender_id',v_sender,'message',p_message))
  RETURNING id INTO v_recipient_journal;
  IF v_settled > 0 THEN
    INSERT INTO public.diamond_transactions(user_id,amount,type,transaction_type,source,
      description,balance_after,reference_id,counterparty,issuance_class,metadata)
    VALUES(p_recipient_id,-v_settled,'debt_settlement','debt_settlement','debt_settlement',
      'Settled Diamonds Owed After A Reversed Purchase',v_recipient_balance+p_amount-v_settled,
      'debt-settlement:' || v_recipient_journal,'receivable:diamond_debts','spend',
      jsonb_build_object('credit_transaction_id',v_recipient_journal,'transfer_id',v_id))
    RETURNING id INTO v_debt_journal;
    PERFORM public.fn_ca_register_diamond_journal_row(v_debt_journal);
    IF NOT EXISTS(SELECT 1 FROM public.ca_mint_ledger
      WHERE diamond_tx_id=v_debt_journal AND action='burn' AND asset='diamonds'
        AND holder_type='player' AND holder_id=p_recipient_id AND amount=v_settled) THEN
      RAISE EXCEPTION 'diamond_debt_retirement_missing';
    END IF;
  END IF;
  UPDATE public.profiles SET diamonds=v_sender_balance-p_amount,
    diamond_balance=v_sender_balance-p_amount,updated_at=now() WHERE id=v_sender;
  UPDATE public.profiles SET diamonds=v_recipient_balance+p_amount-v_settled,
    diamond_balance=v_recipient_balance+p_amount-v_settled,updated_at=now() WHERE id=p_recipient_id;
  INSERT INTO public.diamond_wallet_transfers(id,sender_id,recipient_id,request_id,amount,message,
    sender_journal_id,recipient_journal_id)
  VALUES(v_id,v_sender,p_recipient_id,p_reference_id,p_amount,p_message,
    v_sender_journal,v_recipient_journal)
  RETURNING * INTO v_previous;
  RETURN to_jsonb(v_previous) || jsonb_build_object('success',true);
END;
$fn$;
REVOKE ALL ON FUNCTION public.send_wallet_diamond_transfer(uuid,integer,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.send_wallet_diamond_transfer(uuid,integer,text,text) TO authenticated;
UPDATE public.ca_money_rpc_registry SET status='approved',
  notes='Authenticated atomic available-diamond friend transfer. Request-bound immutable receipt; preserves purchased collateral, custody and debt retirement.'
  WHERE proname='send_wallet_diamond_transfer';
COMMIT;
