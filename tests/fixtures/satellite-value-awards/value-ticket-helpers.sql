CREATE OR REPLACE FUNCTION public.fn_ca_satellite_value_ticket_marked(p_ticket_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $function$
 SELECT EXISTS(SELECT 1 FROM public.tournament_tickets t
   JOIN public.tournament_payouts p ON p.tournament_id=t.source_satellite_id
   WHERE t.id=p_ticket_id AND p.source='satellite_ticket' AND p.metadata->>'ticket_id'=p_ticket_id::text
     AND p.metadata->>'ticket_contract'='same_value_entry_v1');
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_assert_satellite_value_ticket(p_ticket_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $function$
DECLARE
 t public.tournament_tickets%ROWTYPE; a public.tournament_satellite_awards%ROWTYPE;
 h public.tournament_satellite_settlements%ROWTYPE; p public.tournament_payouts%ROWTYPE;
 l public.chip_ledger%ROWTYPE; d public.poker_diamond_tournament_ledger%ROWTYPE;
 v_asset text; v_count integer; v_amount numeric;
BEGIN
 SELECT * INTO t FROM public.tournament_tickets WHERE id=p_ticket_id;
 SELECT * INTO a FROM public.tournament_satellite_awards
  WHERE tournament_id=t.source_satellite_id AND place=t.source_satellite_award_place;
 SELECT * INTO h FROM public.tournament_satellite_settlements WHERE tournament_id=a.tournament_id;
 SELECT * INTO p FROM public.tournament_payouts WHERE id=a.payout_id;
 v_asset:=CASE WHEN public.fn_poker_diamond_tournament(t.source_satellite_id) THEN 'diamonds' ELSE 'chips' END;
 IF t.id IS NULL OR a.ticket_id IS DISTINCT FROM t.id OR h.tournament_id IS NULL OR p.id IS NULL
  OR t.issued_by IS DISTINCT FROM '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid
  OR t.status NOT IN ('issued','redeemed') OR t.redemption_mode IS DISTINCT FROM 'tournament_entry_only'
  OR t.source_refund_entitlement_id IS NOT NULL
  OR t.holder_id IS DISTINCT FROM a.user_id OR t.value IS DISTINCT FROM a.amount
  OR t.source_tournament_id IS DISTINCT FROM h.target_id OR t.value IS DISTINCT FROM h.ticket_cost
  OR a.delivery_kind IS DISTINCT FROM 'ticket' OR a.payout_source IS DISTINCT FROM 'satellite_ticket'
  OR round(t.entry_prize+t.entry_bounty,2) IS DISTINCT FROM h.target_buy_in
  OR t.entry_fee IS DISTINCT FROM h.target_fee
  OR p.tournament_id IS DISTINCT FROM a.tournament_id OR p.user_id IS DISTINCT FROM a.user_id
  OR p.amount IS DISTINCT FROM a.amount OR p.source IS DISTINCT FROM a.payout_source
  OR p.idempotency_key IS DISTINCT FROM a.idempotency_key
  OR p.metadata->>'ticket_contract' IS DISTINCT FROM 'same_value_entry_v1'
  OR p.metadata->>'ticket_id' IS DISTINCT FROM t.id::text
  OR p.metadata->>'delivery_kind' IS DISTINCT FROM 'ticket'
  OR p.metadata->>'satellite_target_id' IS DISTINCT FROM h.target_id::text
  OR p.metadata->>'asset' IS DISTINCT FROM v_asset
  OR p.metadata->>'wallet_chips_credited' IS DISTINCT FROM '0'
  OR public.fn_poker_diamond_tournament(h.target_id) IS DISTINCT FROM (v_asset='diamonds')
  OR EXISTS(SELECT 1 FROM public.wallet_credit_idempotency WHERE key=a.idempotency_key)
  OR EXISTS(SELECT 1 FROM public.chip_ledger WHERE idempotency_key='ticket:'||t.id::text||':closed-target-cash') THEN
  RAISE EXCEPTION 'VALUE_TICKET_ISSUE_IDENTITY_UNPROVEN %',p_ticket_id USING ERRCODE='P0404';
 END IF;
 IF v_asset='chips' THEN
  SELECT * INTO l FROM public.chip_ledger WHERE idempotency_key=a.idempotency_key||':ticket_escrow';
  IF l.id IS NULL OR l.status IS DISTINCT FROM 'posted' OR l.from_type IS DISTINCT FROM 'prize_liability'
   OR l.from_entity_id IS DISTINCT FROM a.tournament_id OR l.to_type IS DISTINCT FROM 'escrow'
   OR l.to_entity_id IS DISTINCT FROM t.id OR l.amount IS DISTINCT FROM t.value
   OR l.category IS DISTINCT FROM 'ticket_issue' OR l.club_id IS DISTINCT FROM t.club_id
   OR l.tournament_id IS DISTINCT FROM a.tournament_id
   OR l.metadata->>'kind' IS DISTINCT FROM 'direct_satellite_entry_ticket'
   OR l.metadata->>'ticket_contract' IS DISTINCT FROM 'same_value_entry_v1'
   OR l.metadata->>'ticket_id' IS DISTINCT FROM t.id::text
   OR l.metadata->>'payout_id' IS DISTINCT FROM p.id::text
   OR l.metadata->>'satellite_id' IS DISTINCT FROM a.tournament_id::text
   OR l.metadata->>'satellite_target_id' IS DISTINCT FROM h.target_id::text
   OR l.metadata->>'user_id' IS DISTINCT FROM t.holder_id::text
   OR l.pre_from_balance IS DISTINCT FROM round(h.pool-(a.place-1)*h.ticket_cost,2)
   OR l.post_from_balance IS DISTINCT FROM round(h.pool-a.place*h.ticket_cost,2)
   OR l.pre_to_balance IS DISTINCT FROM 0::numeric OR l.post_to_balance IS DISTINCT FROM t.value
   OR (SELECT count(*) FROM public.chip_transactions x
       WHERE x.transaction_type='tournament_ticket_issue' AND x.club_id=t.club_id
        AND x.from_user_id IS NULL AND x.to_user_id=t.holder_id AND x.amount=t.value
        AND x.metadata->>'ticket_id'=t.id::text AND x.metadata->>'payout_id'=p.id::text
        AND x.metadata->>'ledger_id'=l.id::text AND x.metadata->>'ticket_contract'='same_value_entry_v1')<>1
   OR EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger x
       WHERE x.idempotency_key='poker-value-ticket-issue:'||t.id::text) THEN
   RAISE EXCEPTION 'VALUE_TICKET_CHIP_BACKING_UNPROVEN %',t.id USING ERRCODE='P0404';
  END IF;
  SELECT count(*),coalesce(sum(amount),0) INTO v_count,v_amount FROM public.chip_ledger
   WHERE from_type='escrow' AND from_entity_id=t.id AND category='ticket_redeem';
 ELSE
  SELECT * INTO d FROM public.poker_diamond_tournament_ledger
   WHERE idempotency_key='poker-value-ticket-issue:'||t.id::text;
  IF d.id IS NULL OR d.tournament_id IS DISTINCT FROM a.tournament_id OR d.user_id IS DISTINCT FROM t.holder_id
   OR d.kind IS DISTINCT FROM 'prize' OR d.amount IS DISTINCT FROM t.value
   OR d.prize_part IS DISTINCT FROM t.value OR d.bounty_part IS DISTINCT FROM 0::bigint
   OR d.fee_part IS DISTINCT FROM 0::bigint OR d.custody_id IS NOT NULL
   OR d.request->>'delivery' IS DISTINCT FROM 'satellite_value_ticket'
   OR d.request->>'ticket_id' IS DISTINCT FROM t.id::text
   OR d.request->>'payout_id' IS DISTINCT FROM p.id::text
   OR NOT EXISTS(SELECT 1 FROM (
       SELECT id,user_id,amount,type,metadata FROM public.diamond_transactions
       UNION ALL SELECT id,user_id,amount,type,metadata FROM public.ca_diamond_journal_archive) j
       WHERE j.id=d.wallet_journal_id
       AND j.user_id=t.holder_id AND j.amount=0 AND j.type='tournament_satellite_ticket'
       AND j.metadata->>'ticket_id'=t.id::text AND (j.metadata->>'amount')::numeric=t.value)
   OR (SELECT coalesce(sum(m.amount),0) FROM public.poker_diamond_movements m
       WHERE m.wallet_journal_id=d.wallet_journal_id AND m.action='release'
        AND m.destination_account='ticket_escrow:'||t.id::text) IS DISTINCT FROM t.value
   OR EXISTS(SELECT 1 FROM public.chip_ledger WHERE to_type='escrow' AND to_entity_id=t.id AND category='ticket_issue')
   OR EXISTS(SELECT 1 FROM public.chip_transactions WHERE metadata->>'ticket_id'=t.id::text) THEN
   RAISE EXCEPTION 'VALUE_TICKET_DIAMOND_BACKING_UNPROVEN %',t.id USING ERRCODE='P0404';
  END IF;
  SELECT count(*),coalesce(sum(amount),0) INTO v_count,v_amount FROM public.poker_diamond_tournament_ledger
   WHERE idempotency_key='poker-value-ticket-entry:'||t.id::text AND kind='entry'
    AND user_id=t.holder_id AND request->>'ticket_id'=t.id::text;
 END IF;
 IF (t.status='issued' AND (v_count<>0 OR v_amount<>0))
  OR (t.status='redeemed' AND (v_count<>1 OR v_amount IS DISTINCT FROM t.value)) THEN
  RAISE EXCEPTION 'VALUE_TICKET_CONSUMPTION_UNPROVEN %',t.id USING ERRCODE='P0404';
 END IF;
 RETURN v_asset;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_value_ticket_float(p_user_id uuid DEFAULT NULL)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $function$
 SELECT coalesce(sum(t.value),0)::numeric FROM public.tournament_tickets t
 JOIN public.poker_diamond_tournament_ledger l ON l.idempotency_key='poker-value-ticket-issue:'||t.id::text
  AND l.tournament_id=t.source_satellite_id AND l.user_id=t.holder_id AND l.amount=t.value
  AND l.kind='prize' AND l.request->>'delivery'='satellite_value_ticket'
  AND l.request->>'ticket_id'=t.id::text
 WHERE t.status='issued' AND (p_user_id IS NULL OR t.holder_id=p_user_id)
  AND public.fn_ca_satellite_value_ticket_marked(t.id)
  AND public.fn_poker_diamond_tournament(t.source_satellite_id)
  AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger used
    WHERE used.idempotency_key='poker-value-ticket-entry:'||t.id::text AND used.kind='entry'
      AND used.user_id=t.holder_id AND used.amount=t.value
      AND used.request->>'ticket_id'=t.id::text);
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_value_ticket_journal_net(p_journal_ids uuid[])
RETURNS TABLE(journal_id uuid,net numeric) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $function$
 SELECT l.wallet_journal_id,sum(CASE WHEN l.kind='prize' THEN -l.amount ELSE l.amount END)::numeric
 FROM public.poker_diamond_tournament_ledger l
 JOIN public.tournament_tickets t ON l.request->>'ticket_id'=t.id::text
 WHERE l.wallet_journal_id=ANY(p_journal_ids)
  AND l.user_id=t.holder_id AND l.amount=t.value
  AND public.fn_ca_satellite_value_ticket_marked(t.id)
  AND public.fn_poker_diamond_tournament(t.source_satellite_id)
  AND ((l.kind='prize' AND l.tournament_id=t.source_satellite_id
        AND l.idempotency_key='poker-value-ticket-issue:'||t.id::text)
    OR (l.kind='entry' AND l.idempotency_key='poker-value-ticket-entry:'||t.id::text))
  AND ((l.kind='prize' AND l.request->>'delivery'='satellite_value_ticket')
    OR (l.kind='entry' AND l.request->>'source'='satellite_value_ticket'))
  AND l.request->>'ticket_contract'='same_value_entry_v1'
 GROUP BY l.wallet_journal_id;
$function$;
