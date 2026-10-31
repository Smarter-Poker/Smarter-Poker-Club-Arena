CREATE OR REPLACE FUNCTION public.fn_ca_issue_diamond_value_ticket(p_satellite_id uuid,p_ticket_id uuid,p_payout_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $function$
DECLARE
 t public.tournament_tickets%ROWTYPE; p public.tournament_payouts%ROWTYPE;
 d public.poker_diamond_tournament_ledger%ROWTYPE;
 v_wallet bigint; v_journal uuid; v_drain jsonb; v_id bigint; v_key text;
BEGIN
 SELECT * INTO t FROM public.tournament_tickets WHERE id=p_ticket_id FOR UPDATE;
 SELECT * INTO p FROM public.tournament_payouts WHERE id=p_payout_id;
 IF t.id IS NULL OR t.status IS DISTINCT FROM 'issued' OR t.source_satellite_id IS DISTINCT FROM p_satellite_id
  OR t.redemption_mode IS DISTINCT FROM 'tournament_entry_only' OR t.value<1 OR t.value<>trunc(t.value)
  OR t.value>2147483647 OR NOT public.fn_poker_diamond_tournament(p_satellite_id)
  OR p.tournament_id IS DISTINCT FROM p_satellite_id OR p.user_id IS DISTINCT FROM t.holder_id
  OR p.amount IS DISTINCT FROM t.value OR p.source IS DISTINCT FROM 'satellite_ticket'
  OR p.metadata->>'ticket_id' IS DISTINCT FROM t.id::text
  OR p.metadata->>'ticket_contract' IS DISTINCT FROM 'same_value_entry_v1'
  OR p.metadata->>'asset' IS DISTINCT FROM 'diamonds' THEN
  RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_ISSUE_CONTRACT_INVALID' USING ERRCODE='P0404';
 END IF;
 v_key:='poker-value-ticket-issue:'||t.id::text;
 SELECT * INTO d FROM public.poker_diamond_tournament_ledger WHERE idempotency_key=v_key;
 IF FOUND THEN
  IF d.tournament_id IS DISTINCT FROM p_satellite_id OR d.user_id IS DISTINCT FROM t.holder_id
   OR d.amount IS DISTINCT FROM t.value OR d.kind IS DISTINCT FROM 'prize'
   OR d.request->>'payout_id' IS DISTINCT FROM p.id::text THEN
   RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_ISSUE_KEY_REUSED' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('success',true,'idempotent',true,'ledger_id',d.id,'journal_id',d.wallet_journal_id);
 END IF;
 IF (SELECT prize_balance FROM public.fn_poker_diamond_tournament_escrow(p_satellite_id))<t.value THEN
  RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_PRIZE_BANK_SHORT' USING ERRCODE='P0404';
 END IF;
 SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=t.holder_id FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_HOLDER_MISSING' USING ERRCODE='P0404'; END IF;
 INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,
  reference_id,description,source,issuance_class,counterparty,metadata)
 VALUES(t.holder_id,'tournament_satellite_ticket','tournament_satellite_ticket',0,v_wallet,v_key,
  'Satellite Award: '||t.value::bigint::text||' Diamond Entry Ticket; Wallet Unchanged',
  'poker_arena','arena','ticket_escrow:'||t.id::text,
  jsonb_build_object('ticket_id',t.id,'payout_id',p.id,'satellite_id',p_satellite_id,
   'amount',t.value,'ticket_contract','same_value_entry_v1','wallet_moved',0)) RETURNING id INTO v_journal;
 v_drain:=public.fn_poker_diamond_tournament_drain(p_satellite_id,'prize',t.value::bigint,
  v_key,'ticket_escrow:'||t.id::text,v_journal);
 INSERT INTO public.poker_diamond_tournament_ledger(tournament_id,arena_id,user_id,custody_id,
  kind,amount,prize_part,bounty_part,fee_part,idempotency_key,wallet_journal_id,registration_id,request)
 VALUES(p_satellite_id,(SELECT club_id FROM public.tournaments WHERE id=p_satellite_id),t.holder_id,NULL,
  'prize',t.value::bigint,t.value::bigint,0,0,v_key,v_journal,NULL,
  jsonb_build_object('kind','prize','delivery','satellite_value_ticket','ticket_id',t.id,
   'payout_id',p.id,'ticket_contract','same_value_entry_v1','drained',v_drain)) RETURNING id INTO v_id;
 PERFORM public.fn_ca_escrow_apply(p_satellite_id,'Diamond value ticket issued',p_prize_out=>t.value);
 IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_satellite_id))
  IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_satellite_id)::numeric THEN
  RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_SOURCE_CUSTODY_DIVERGED' USING ERRCODE='P0404';
 END IF;
 RETURN jsonb_build_object('success',true,'idempotent',false,'ledger_id',v_id,'journal_id',v_journal,'amount',t.value);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_value_ticket_fund_entry(p_tournament_id uuid,p_ticket_id uuid,p_registration_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $function$
DECLARE
 t public.tournament_tickets%ROWTYPE; v_target public.tournaments%ROWTYPE;
 r public.tournament_players%ROWTYPE; v_before record; v_after record;
 v_existing public.poker_diamond_tournament_ledger%ROWTYPE;
 v_custody uuid:=gen_random_uuid(); v_request uuid; v_journal uuid; v_wallet bigint;
 v_key text; v_amount numeric; v_prize numeric; v_fee numeric; v_count integer;
 v_ledger bigint; v_receipt jsonb;
BEGIN
 SELECT * INTO t FROM public.tournament_tickets WHERE id=p_ticket_id FOR UPDATE;
 SELECT * INTO v_target FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
 SELECT * INTO r FROM public.tournament_players WHERE id=p_registration_id FOR UPDATE;
 IF t.id IS NULL OR t.status IS DISTINCT FROM 'issued'
  OR public.fn_ca_assert_satellite_value_ticket(t.id) IS DISTINCT FROM 'diamonds'
  OR NOT public.fn_poker_diamond_tournament(p_tournament_id)
  OR r.tournament_id IS DISTINCT FROM p_tournament_id OR r.user_id IS DISTINCT FROM t.holder_id
  OR r.source_satellite_id IS DISTINCT FROM t.source_satellite_id OR r.is_satellite_qualifier IS DISTINCT FROM true
  OR r.club_id IS DISTINCT FROM t.club_id
  OR v_target.is_bounty IS DISTINCT FROM false OR v_target.is_pko IS DISTINCT FROM false
  OR v_target.is_mystery_bounty IS DISTINCT FROM false OR coalesce(v_target.bounty_amount,0)<>0 THEN
  RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_ENTRY_CONTRACT_INVALID' USING ERRCODE='P0404';
 END IF;
 v_amount:=v_target.buy_in_amount+coalesce(v_target.buy_in_fee,0);
 v_prize:=v_target.buy_in_amount; v_fee:=coalesce(v_target.buy_in_fee,0);
 IF v_amount IS DISTINCT FROM t.value OR v_amount<>trunc(v_amount) OR v_prize<0 OR v_fee<0
  OR v_prize<>trunc(v_prize) OR v_fee<>trunc(v_fee) THEN
  RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_PRICE_MISMATCH' USING ERRCODE='22023';
 END IF;
 v_key:='poker-value-ticket-entry:'||t.id::text;
 SELECT * INTO v_existing FROM public.poker_diamond_tournament_ledger WHERE idempotency_key=v_key;
 IF FOUND THEN RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_ALREADY_COMMITTED' USING ERRCODE='23505'; END IF;
 IF EXISTS(SELECT 1 FROM public.poker_diamond_custody c WHERE c.user_id=t.holder_id
  AND c.purpose='tournament_entry' AND c.target_id=p_tournament_id AND c.state<>'released') THEN
  RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_ENTRY_ALREADY_FUNDED' USING ERRCODE='23505';
 END IF;
 SELECT * INTO v_before FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
 SELECT count(*) INTO v_count FROM public.tournament_players
  WHERE tournament_id=p_tournament_id AND status::text IN ('registered','playing');
 IF v_target.prize_pool IS DISTINCT FROM v_before.prize_balance
  OR v_target.total_rake IS DISTINCT FROM v_before.fee_balance OR v_before.bounty_balance<>0
  OR v_before.prize_balance+v_before.fee_balance IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric
  OR v_target.current_players IS DISTINCT FROM (CASE WHEN v_target.status IN ('ANNOUNCED','REGISTERING') THEN v_count ELSE v_count-1 END) THEN
  RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_TARGET_BANK_DIVERGED' USING ERRCODE='P0404';
 END IF;
 PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);
 SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=t.holder_id FOR NO KEY UPDATE;
 INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,
  reference_id,description,source,issuance_class,counterparty,metadata)
 VALUES(t.holder_id,'tournament_ticket_entry','tournament_ticket_entry',0,v_wallet,v_key,
  'Diamond Value Ticket Used For Tournament Entry; Wallet Unchanged','poker_arena','arena',
  'arena_custody:'||v_custody::text,jsonb_build_object('ticket_id',t.id,'registration_id',r.id,
   'target_id',p_tournament_id,'custody_id',v_custody,'amount',t.value,
   'ticket_contract','same_value_entry_v1','wallet_moved',0)) RETURNING id INTO v_journal;
 INSERT INTO public.poker_diamond_custody(id,user_id,arena_id,purpose,target_id,entry_key,balance,state)
 VALUES(v_custody,t.holder_id,v_target.club_id,'tournament_entry',p_tournament_id,
  'entry:'||r.id::text,t.value::bigint,'active');
 v_request:=uuid_in(md5(v_key)::cstring);
 v_receipt:=jsonb_build_object('success',true,'custody_id',v_custody,'request_id',v_request,
  'amount',t.value,'custody_balance',t.value,'journal_id',v_journal,'ticket_id',t.id);
 INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,
  source_account,destination_account,wallet_journal_id,request,receipt)
 VALUES(v_request,v_custody,t.holder_id,'reserve',t.value::bigint,'ticket_escrow:'||t.id::text,
  'arena_custody:'||v_custody::text,v_journal,jsonb_build_object('action','satellite_value_ticket_entry',
   'ticket_id',t.id,'target_id',p_tournament_id,'registration_id',r.id,'amount',t.value),v_receipt);
 INSERT INTO public.poker_diamond_tournament_ledger(tournament_id,arena_id,user_id,custody_id,
  kind,amount,prize_part,bounty_part,fee_part,idempotency_key,wallet_journal_id,registration_id,request)
 VALUES(p_tournament_id,v_target.club_id,t.holder_id,v_custody,'entry',t.value::bigint,
  v_prize::bigint,0,v_fee::bigint,v_key,v_journal,r.id,
  jsonb_build_object('kind','entry','source','satellite_value_ticket','ticket_id',t.id,
   'ticket_contract','same_value_entry_v1','gross',t.value,'prize',v_prize,'bounty',0,'fee',v_fee,
   'request_id',v_request)) RETURNING id INTO v_ledger;
 UPDATE public.tournaments SET entry_contract_locked=true WHERE id=p_tournament_id AND NOT entry_contract_locked;
 PERFORM public.fn_ca_escrow_apply(p_tournament_id,'Diamond value ticket admission',
  p_gross_in=>t.value,p_fee_entries_in=>v_fee);
 SELECT * INTO v_after FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
 IF v_after.prize_balance IS DISTINCT FROM v_before.prize_balance+v_prize
  OR v_after.fee_balance IS DISTINCT FROM v_before.fee_balance+v_fee OR v_after.bounty_balance<>0
  OR v_after.prize_balance+v_after.fee_balance IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
  RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_ENTRY_CUSTODY_DIVERGED' USING ERRCODE='P0404';
 END IF;
 UPDATE public.tournaments SET current_players=v_count,prize_pool=v_after.prize_balance,
  total_rake=v_after.fee_balance,updated_at=now() WHERE id=p_tournament_id;
 RETURN v_receipt||jsonb_build_object('ledger_id',v_ledger,'registration_id',r.id,
  'prize_contribution',v_prize,'bounty_contribution',0,'fee_contribution',v_fee,'asset','diamonds');
END;
$function$;
