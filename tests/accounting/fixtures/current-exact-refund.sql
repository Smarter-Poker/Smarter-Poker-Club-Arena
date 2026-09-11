CREATE OR REPLACE FUNCTION public.fn_settle_tournament_refund_exact(p_tournament_id uuid, p_user_id uuid, p_source_wallet_club_id uuid, p_total_owed numeric, p_refund_prize numeric, p_refund_bounty numeric, p_refund_fee numeric, p_source text, p_description text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total numeric := round(COALESCE(p_total_owed,0),2);
  v_prize numeric := round(COALESCE(p_refund_prize,0),2);
  v_bounty numeric := round(COALESCE(p_refund_bounty,0),2);
  v_fee numeric := round(COALESCE(p_refund_fee,0),2);
  v_ob public.tournament_obligations%ROWTYPE;
  v_seeded_paid numeric := 0;
  v_pay numeric;
  v_key text;
  v_rows integer;
  v_token uuid;
  v_source_debits numeric;
  v_source_credits numeric;
  v_balance_before numeric;
  v_balance_after numeric;
  v_credit_ledger_id uuid;
  v_wallet_transaction_id uuid;
  v_prev_category text;
  v_prev_counterparty text;
  v_prev_counterparty_entity text;
  v_prev_tournament text;
  v_prev_tournament_id text;
  v_prev_idempotency text;
  v_entitlement record;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_source_wallet_club_id IS NULL
     OR p_total_owed IS NULL OR p_refund_prize IS NULL
     OR p_refund_bounty IS NULL OR p_refund_fee IS NULL
     OR p_total_owed::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_prize::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_bounty::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_fee::text IN ('NaN','Infinity','-Infinity')
     OR p_total_owed IS DISTINCT FROM v_total
     OR p_refund_prize IS DISTINCT FROM v_prize
     OR p_refund_bounty IS DISTINCT FROM v_bounty
     OR p_refund_fee IS DISTINCT FROM v_fee
     OR v_total <= 0 OR v_prize < 0 OR v_bounty < 0 OR v_fee < 0
     OR p_source IS NULL OR length(btrim(p_source)) = 0
     OR p_description IS NULL OR length(btrim(p_description)) = 0 THEN
    RAISE EXCEPTION 'exact refund payer received an invalid contract'
      USING ERRCODE = '22003';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.ca_settle_sources s
     WHERE s.source = lower(btrim(p_source))) THEN
    RAISE EXCEPTION 'exact refund source % is not a platform authority',p_source
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exact refund tournament % does not exist',p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'exact refund escrow prelock');

  SELECT * INTO v_ob FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'refund' AND o.place IS NULL AND o.user_id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    SELECT round(COALESCE(sum(w.amount),0),2) INTO v_seeded_paid
      FROM public.wallet_transactions w
     WHERE w.related_entity_id = p_tournament_id
       AND w.user_id = p_user_id AND w.type = 'credit'
       AND lower(w.category) IN ('refund','tournament_refund');
    IF v_seeded_paid > v_total THEN
      RAISE EXCEPTION 'refund ledger already exceeds exact entitlement'
        USING ERRCODE = 'P0404';
    END IF;
    INSERT INTO public.tournament_obligations(
      tournament_id,kind,place,user_id,amount_owed,amount_paid,source)
    VALUES(
      p_tournament_id,'refund',NULL,p_user_id,v_total,v_seeded_paid,p_source)
    RETURNING * INTO v_ob;
  ELSE
    IF v_ob.amount_owed::text IN ('NaN','Infinity','-Infinity')
       OR v_ob.amount_paid::text IN ('NaN','Infinity','-Infinity')
       OR v_ob.amount_owed < 0 OR v_ob.amount_paid < 0
       OR v_ob.amount_paid > v_ob.amount_owed
       OR v_total < v_ob.amount_owed THEN
      RAISE EXCEPTION 'existing refund obligation is incompatible with exact entitlement'
        USING ERRCODE = 'P0404';
    END IF;
  END IF;

  v_pay := round(v_total - v_ob.amount_paid,2);
  IF v_pay <= 0 OR v_pay IS DISTINCT FROM round(v_prize + v_bounty + v_fee,2) THEN
    RAISE EXCEPTION
      'exact refund components %, %, % do not equal newly owed amount %',
      v_prize,v_bounty,v_fee,v_pay USING ERRCODE = '23514';
  END IF;

  -- The caller cannot choose money. Resolve one deterministic, still-open
  -- immutable entitlement whose stored club and rails exactly match this
  -- tranche. Satellite entry value is ordinary funded target escrow under
  -- the approved cash rule. Its original transfer must be proved exactly;
  -- a ticket already issued for this entitlement consumes that same value.
  SELECT e.* INTO v_entitlement
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.refund_wallet_club_id = p_source_wallet_club_id
     AND e.gross = v_pay
     AND e.refund_prize = v_prize
     AND e.refund_bounty = v_bounty
     AND e.refund_fee = v_fee
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND e.entitlement_kind IN ('wallet_charge','satellite_seat','tournament_ticket')
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id)
   ORDER BY e.entitlement_kind,e.id
   LIMIT 1;
  IF v_entitlement.id IS NULL THEN
    RAISE EXCEPTION
      'refund source club and component rails do not match one immutable entitlement'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT count(*) INTO v_rows FROM public.chip_ledger l
   WHERE l.id=v_entitlement.source_ledger_id
     AND l.club_id=v_entitlement.refund_wallet_club_id
     AND l.to_type='prize_liability'
     AND l.to_entity_id=v_entitlement.tournament_id
     AND l.amount=v_entitlement.gross
     AND (
       (v_entitlement.entitlement_kind='wallet_charge'
        AND l.tournament_id=v_entitlement.tournament_id
        AND l.from_type='player_wallet'
        AND l.from_entity_id=v_entitlement.user_id
        AND lower(l.category)=v_entitlement.charge_category)
       OR (v_entitlement.entitlement_kind='satellite_seat'
        AND l.from_type='prize_liability'
        AND l.from_entity_id=v_entitlement.source_satellite_id
        AND l.metadata->>'user_id'=v_entitlement.user_id::text
        AND l.metadata->>'registration_id'=v_entitlement.registration_id::text)
       OR (v_entitlement.entitlement_kind='tournament_ticket'
        AND l.tournament_id=v_entitlement.tournament_id
        AND l.from_type='escrow'
        AND l.from_entity_id=v_entitlement.source_ticket_id
        AND l.category='ticket_redeem'
        AND l.metadata->>'user_id'=v_entitlement.user_id::text
        AND l.metadata->>'registration_id'=v_entitlement.registration_id::text
        AND EXISTS (
          SELECT 1 FROM public.tournament_tickets tk
           WHERE tk.id=v_entitlement.source_ticket_id
             AND tk.holder_id=v_entitlement.user_id AND tk.status='redeemed'
             AND tk.redemption_mode='tournament_entry_only'
             AND tk.value=v_entitlement.gross
             AND tk.entry_prize=v_entitlement.refund_prize
             AND tk.entry_bounty=v_entitlement.refund_bounty
             AND tk.entry_fee=v_entitlement.refund_fee
             AND tk.source_satellite_id=v_entitlement.source_satellite_id)));
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'refund entitlement lost its exact funded source'
      USING ERRCODE = 'P0404';
  END IF;
  v_key := 'tourney:' || p_tournament_id::text
           || ':refund-entitlement:'
           || v_entitlement.id::text;

  v_token := gen_random_uuid();
  INSERT INTO public.tournament_refund_authorizations(
    token,idempotency_key,tournament_id,obligation_id,user_id,
    source_wallet_club_id,entitlement_id,
    amount_paid_before,amount_paid_now,refund_prize,refund_bounty,refund_fee,
    source,description,created_at)
  VALUES(
    v_token,v_key,p_tournament_id,v_ob.id,p_user_id,
    p_source_wallet_club_id,v_entitlement.id,
    v_ob.amount_paid,v_pay,v_prize,v_bounty,v_fee,
    lower(btrim(p_source)),p_description,transaction_timestamp());
  -- Wallet debits and funded satellite transfers are separate sources.
  -- The immutable entitlement fixes the recipient club. Existing cash refunds
  -- reduce capacity; a value already returned as a ticket cannot fund cash.
  SELECT round(COALESCE(sum(l.amount),0),2) INTO v_source_debits
    FROM public.chip_ledger l
   WHERE l.tournament_id = p_tournament_id
     AND l.club_id = p_source_wallet_club_id
     AND l.from_type = 'player_wallet'
     AND l.from_entity_id = p_user_id
     AND l.to_type = 'prize_liability'
     AND l.to_entity_id = p_tournament_id
     AND l.category IN ('tournament_buyin','rebuy','addon');
  SELECT v_source_debits + round(COALESCE(sum(e.gross),0),2)
    INTO v_source_debits
    FROM public.tournament_refund_entitlements e
    JOIN public.chip_ledger l ON l.id=e.source_ledger_id
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.refund_wallet_club_id=p_source_wallet_club_id
     AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
     AND l.club_id=e.refund_wallet_club_id
     AND l.to_type='prize_liability' AND l.to_entity_id=e.tournament_id
     AND l.amount=e.gross
     AND l.metadata->>'user_id'=e.user_id::text
     AND l.metadata->>'registration_id'=e.registration_id::text
     AND ((e.entitlement_kind='satellite_seat'
           AND l.from_type='prize_liability'
           AND l.from_entity_id=e.source_satellite_id)
       OR (e.entitlement_kind='tournament_ticket'
           AND l.from_type='escrow' AND l.from_entity_id=e.source_ticket_id
           AND l.category='ticket_redeem'))
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id);
  SELECT round(COALESCE(sum(l.amount),0),2) INTO v_source_credits
    FROM public.chip_ledger l
   WHERE l.tournament_id = p_tournament_id
     AND l.club_id = p_source_wallet_club_id
     AND l.from_type = 'prize_liability'
     AND l.from_entity_id = p_tournament_id
     AND l.to_type = 'player_wallet'
     AND l.to_entity_id = p_user_id
     AND l.category IN ('refund','tournament_refund');
  IF v_source_debits IS NULL OR v_source_credits IS NULL
     OR v_source_debits::text IN ('NaN','Infinity','-Infinity')
     OR v_source_credits::text IN ('NaN','Infinity','-Infinity')
     OR v_source_debits < 0 OR v_source_credits < 0
     OR round(v_source_debits-v_source_credits,2) < v_pay THEN
    RAISE EXCEPTION
      'source club % has only % of exact tournament debit left for refund %',
      p_source_wallet_club_id,
      round(v_source_debits-v_source_credits,2),v_pay
      USING ERRCODE = 'P0404';
  END IF;

  SELECT m.chip_balance INTO v_balance_before
    FROM public.club_members m
   WHERE m.user_id = p_user_id AND m.club_id = p_source_wallet_club_id
   FOR UPDATE;
  IF NOT FOUND OR v_balance_before IS NULL
     OR v_balance_before::text IN ('NaN','Infinity','-Infinity')
     OR v_balance_before IS DISTINCT FROM round(v_balance_before,2) THEN
    RAISE EXCEPTION
      'exact source wallet % for player % is absent or invalid',
      p_source_wallet_club_id,p_user_id USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
  VALUES(v_key,p_user_id,v_pay)
  ON CONFLICT(key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'exact refund credit key % was already claimed',v_key
      USING ERRCODE = '23505';
  END IF;

  v_prev_category := current_setting('app.ledger_category',true);
  v_prev_counterparty := current_setting('app.ledger_counterparty',true);
  v_prev_counterparty_entity := current_setting(
    'app.ledger_counterparty_entity',true);
  v_prev_tournament := current_setting('app.ledger_tournament',true);
  v_prev_tournament_id := current_setting('app.ledger_tournament_id',true);
  v_prev_idempotency := current_setting('app.ledger_idempotency_key',true);
  PERFORM public.fn_ca_declare_ledger(
    'refund','prize_liability',p_tournament_id,NULL,v_key,NULL);
  PERFORM set_config('app.ledger_tournament',p_tournament_id::text,true);
  PERFORM set_config('app.ledger_tournament_id',p_tournament_id::text,true);
  UPDATE public.club_members
     SET chip_balance = chip_balance + v_pay,updated_at = now()
   WHERE user_id = p_user_id AND club_id = p_source_wallet_club_id
     AND chip_balance IS NOT DISTINCT FROM v_balance_before
  RETURNING chip_balance INTO v_balance_after;
  PERFORM set_config('app.ledger_category',COALESCE(v_prev_category,''),true);
  PERFORM set_config('app.ledger_counterparty',COALESCE(v_prev_counterparty,''),true);
  PERFORM set_config('app.ledger_counterparty_entity',
                     COALESCE(v_prev_counterparty_entity,''),true);
  PERFORM set_config('app.ledger_tournament',COALESCE(v_prev_tournament,''),true);
  PERFORM set_config('app.ledger_tournament_id',COALESCE(v_prev_tournament_id,''),true);
  PERFORM set_config('app.ledger_idempotency_key',COALESCE(v_prev_idempotency,''),true);
  IF v_balance_after IS NULL
     OR v_balance_after IS DISTINCT FROM round(v_balance_before+v_pay,2) THEN
    RAISE EXCEPTION 'exact source wallet changed during refund'
      USING ERRCODE = '40001';
  END IF;
  SELECT count(*),min(l.id::text)::uuid INTO v_rows,v_credit_ledger_id
    FROM public.chip_ledger l
   WHERE l.idempotency_key = v_key
     AND l.tournament_id = p_tournament_id
     AND l.club_id = p_source_wallet_club_id
     AND l.from_type = 'prize_liability'
     AND l.from_entity_id = p_tournament_id
     AND l.to_type = 'player_wallet'
     AND l.to_entity_id = p_user_id
     AND l.category = 'refund' AND l.amount = v_pay;
  IF v_rows <> 1 OR v_credit_ledger_id IS NULL THEN
    RAISE EXCEPTION 'exact source-wallet credit % has no single journal row',v_key
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM set_config('app.ca_exact_refund_token',v_token::text,true);
  INSERT INTO public.wallet_transactions(
    user_id,wallet_type,amount,type,category,description,
    related_entity_id,table_id,hand_id,balance_after)
  VALUES(
    p_user_id,'PLAYER',v_pay,'credit','refund',p_description,
    p_tournament_id,NULL,NULL,v_balance_after)
  RETURNING id INTO v_wallet_transaction_id;
  PERFORM set_config('app.ca_exact_refund_token','',true);
  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_authorizations a
     WHERE a.token = v_token) THEN
    RAISE EXCEPTION 'exact refund authorization % was not consumed',v_token
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows FROM public.tournament_refund_tranches tr
   WHERE tr.wallet_transaction_id = v_wallet_transaction_id
     AND tr.idempotency_key = v_key
     AND tr.tournament_id = p_tournament_id
     AND tr.obligation_id = v_ob.id AND tr.user_id = p_user_id
     AND tr.source_wallet_club_id = p_source_wallet_club_id
     AND tr.entitlement_id = v_entitlement.id
     AND tr.credit_ledger_id = v_credit_ledger_id
     AND tr.amount_paid_before = v_ob.amount_paid
     AND tr.amount_paid_now = v_pay
     AND tr.refund_prize = v_prize
     AND tr.refund_bounty = v_bounty
     AND tr.refund_fee = v_fee
     AND tr.source = lower(btrim(p_source))
     AND tr.description = p_description;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'exact refund credit % has no single component receipt',v_key
      USING ERRCODE = 'P0404';
  END IF;

  UPDATE public.tournament_obligations
     SET amount_paid = amount_paid + v_pay,
         amount_owed = v_total,
         source = p_source,
         updated_at = now(),settled_at = now()
   WHERE id = v_ob.id AND amount_paid = v_ob.amount_paid
  RETURNING * INTO v_ob;
  IF v_ob.id IS NULL OR v_ob.amount_paid IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'exact refund obligation did not close at %',v_total
      USING ERRCODE = '40001';
  END IF;
  RETURN jsonb_build_object(
    'ok',true,'fully_settled',true,'remaining',0,
    'obligation_id',v_ob.id,'idempotency_key',v_key,
    'entitlement_id',v_entitlement.id,
    'entitlement_kind',v_entitlement.entitlement_kind,
    'source_wallet_club_id',p_source_wallet_club_id,
    'credit_ledger_id',v_credit_ledger_id,
    'wallet_transaction_id',v_wallet_transaction_id,
    'already_paid',round(v_total-v_pay,2),'paid',v_pay,
    'amount_owed',v_total,'amount_paid',v_total,
    'refund_prize',v_prize,'refund_bounty',v_bounty,'refund_fee',v_fee);
END;
$function$
;
