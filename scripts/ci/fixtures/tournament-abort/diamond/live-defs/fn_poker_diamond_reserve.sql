CREATE OR REPLACE FUNCTION public.fn_poker_diamond_reserve(p_user_id uuid, p_purpose text, p_target_id uuid, p_entry_key text, p_amount numeric, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 v_request jsonb; v_previous public.poker_diamond_movements%ROWTYPE;
 v_wallet bigint; v_arena uuid; v_asset text; v_platform boolean; v_union uuid;
 v_min numeric; v_max numeric; v_status text; v_custody uuid; v_journal uuid;
 v_locked bigint; v_days integer; v_left bigint; v_take bigint; v_lot record; v_receipt jsonb;
BEGIN
 IF p_user_id IS NULL OR p_target_id IS NULL OR p_request_id IS NULL
    OR p_purpose IS NULL OR p_purpose NOT IN ('cash_seat','tournament_entry')
    OR p_entry_key IS NULL OR length(p_entry_key) NOT BETWEEN 1 AND 160
    OR p_amount IS NULL OR p_amount <= 0 OR p_amount > 2147483647 OR p_amount <> trunc(p_amount) THEN
   RAISE EXCEPTION 'invalid_diamond_reservation' USING ERRCODE = '22023';
 END IF;
 v_request := jsonb_build_object('user_id',p_user_id,'purpose',p_purpose,'target_id',p_target_id,
   'entry_key',p_entry_key,'amount',p_amount,'action','reserve');
 -- All operations for one wallet serialize on that profile, including shop spend/refunds.
 -- NO KEY UPDATE, not UPDATE (20261021234940): it still serializes every
 -- writer of this wallet (FOR UPDATE, NO KEY UPDATE and UPDATE all
 -- refuse it), and it no longer refuses the FOR KEY SHARE that a
 -- foreign-key check from a row pointing at this profile takes.
 SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;
 SELECT * INTO v_previous FROM public.poker_diamond_movements WHERE request_id=p_request_id;
 IF FOUND THEN
   IF v_previous.request <> v_request THEN RAISE EXCEPTION 'idempotency_payload_mismatch'; END IF;
   RETURN v_previous.receipt;
 END IF;
 IF p_purpose='cash_seat' THEN
   SELECT t.club_id,t.min_buy_in,t.max_buy_in,t.status INTO v_arena,v_min,v_max,v_status
   FROM public.tables t WHERE t.id=p_target_id FOR SHARE;
   IF NOT FOUND OR v_min IS NULL OR v_max IS NULL OR p_amount<v_min OR p_amount>v_max THEN
     RAISE EXCEPTION 'invalid_diamond_table_buy_in';
   END IF;
 ELSE
   SELECT t.club_id,t.buy_in_amount+COALESCE(t.buy_in_fee,0),t.status
   INTO v_arena,v_min,v_status FROM public.tournaments t
     JOIN public.clubs c ON c.id=t.club_id
     JOIN public.ca_arena_settings a ON a.id=1 AND a.club_id=c.id
   WHERE t.id=p_target_id AND c.asset='diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND a.tournaments_enabled
   FOR SHARE OF t;
   IF NOT FOUND THEN
     RAISE EXCEPTION 'diamond_tournaments_not_open' USING ERRCODE='55000';
   END IF;
   IF v_min IS NULL OR p_amount<>v_min THEN RAISE EXCEPTION 'invalid_diamond_entry_price'; END IF; END IF;
 SELECT asset,is_platform,union_id INTO v_asset,v_platform,v_union FROM public.clubs WHERE id=v_arena FOR SHARE;
 IF v_asset IS DISTINCT FROM 'diamonds' OR v_platform IS DISTINCT FROM true OR v_union IS NOT NULL THEN
   RAISE EXCEPTION 'diamond_asset_required';
 END IF;
 IF v_status IS NULL OR v_status IN ('completed','cancelled','closed','archived') THEN
   RAISE EXCEPTION 'diamond_target_closed';
 END IF;
 SELECT settlement_window_days INTO v_days FROM public.ca_arena_settings WHERE id=1 AND club_id=v_arena;
 IF v_days IS NULL THEN RAISE EXCEPTION 'diamond_arena_policy_missing'; END IF;
 IF EXISTS(SELECT 1 FROM public.diamond_debts WHERE user_id=p_user_id AND settled_at IS NULL AND amount>0) THEN
   RAISE EXCEPTION 'diamond_debt_requires_settlement';
 END IF;
 -- Lock lots before evaluating age/freeze, so a concurrent dispute cannot slip through.
 PERFORM id FROM public.diamond_purchase_lots WHERE user_id=p_user_id ORDER BY created_at,id FOR UPDATE;
 SELECT COALESCE(sum(GREATEST(issued-consumed-refunded-arena_reserved,0)),0) INTO v_locked
 FROM public.diamond_purchase_lots WHERE user_id=p_user_id
 AND (frozen_at IS NOT NULL OR created_at>now()-make_interval(days=>v_days));
 IF v_wallet IS NULL OR v_wallet-v_locked<p_amount THEN
   -- RULING 14 / DR16. A lot frozen or younger than the settlement window is not depositable,
   -- and this door has refused it by this name since Phase 3. The rule mode is READ here so
   -- DR16 has a consumer and a flip means something (the DR15 shape, 20260908041432). The
   -- refusal stands in both modes: the lot reservation below draws only on settled lots, so
   -- an unsettled lot admitted here would sit in custody with nothing for a chargeback to
   -- find. Armed, the same refusal is raised under the rule's own code with the numbers in
   -- its DETAIL; a raise cannot file an incident that survives it (20260906102549), so the
   -- evidence rides in the error, where the Postgres log counts it. The leading token is
   -- what the engine and the client match on and does not change.
   IF v_locked>0 AND v_wallet IS NOT NULL AND v_wallet>=p_amount
      AND public.fn_ca_diamond_rule_mode('DR16:deposit_inside_settlement_window')='refuse' THEN
     RAISE EXCEPTION 'insufficient_settled_diamonds' USING ERRCODE='P0416',
       DETAIL=format('DR16:deposit_inside_settlement_window refused %s: %s purchased diamond(s) frozen or inside the %s-day settlement window; %s settled',
                     p_amount, v_locked, v_days, v_wallet-v_locked);
   END IF;
   RAISE EXCEPTION 'insufficient_settled_diamonds';
 END IF;
 INSERT INTO public.poker_diamond_custody(user_id,arena_id,purpose,target_id,entry_key,balance)
 VALUES(p_user_id,v_arena,p_purpose,p_target_id,p_entry_key,p_amount) RETURNING id INTO v_custody;
 v_left:=p_amount;
 FOR v_lot IN SELECT id,GREATEST(issued-consumed-refunded-arena_reserved,0) available
 FROM public.diamond_purchase_lots WHERE user_id=p_user_id AND frozen_at IS NULL
 AND created_at<=now()-make_interval(days=>v_days) ORDER BY created_at,id LOOP
   EXIT WHEN v_left=0;
   v_take:=LEAST(v_left,v_lot.available);
   IF v_take>0 THEN
     UPDATE public.diamond_purchase_lots SET arena_reserved=arena_reserved+v_take WHERE id=v_lot.id;
     INSERT INTO public.poker_diamond_lot_reservations(custody_id,lot_id,amount) VALUES(v_custody,v_lot.id,v_take);
     v_left:=v_left-v_take;
   END IF;
 END LOOP;
 -- Journal the transfer before the balance update so the existing DR6 audit
 -- sees its evidence inside this same atomic transaction.
 INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,reference_id,
 description,source,issuance_class,counterparty,metadata)
 VALUES(p_user_id,'arena_deposit','arena_deposit',-p_amount::integer,v_wallet-p_amount,
 'poker-reserve:'||p_request_id,'Reserved diamonds for Poker Arena','poker_arena','arena',
 'arena_custody:'||v_custody,jsonb_build_object('custody_id',v_custody,'request_id',p_request_id,
 'purpose',p_purpose,'target_id',p_target_id,'purchased_reserved',p_amount-v_left)) RETURNING id INTO v_journal;
 UPDATE public.profiles SET diamonds=diamonds-p_amount::integer,updated_at=now() WHERE id=p_user_id;
 v_receipt:=jsonb_build_object('success',true,'custody_id',v_custody,'request_id',p_request_id,
 'amount',p_amount,'available_balance',v_wallet-p_amount,'custody_balance',p_amount,'journal_id',v_journal);
 INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,source_account,
 destination_account,wallet_journal_id,request,receipt)
 VALUES(p_request_id,v_custody,p_user_id,'reserve',p_amount,'player:'||p_user_id,
 'arena_custody:'||v_custody,v_journal,v_request,v_receipt);
 RETURN v_receipt;
END $function$

