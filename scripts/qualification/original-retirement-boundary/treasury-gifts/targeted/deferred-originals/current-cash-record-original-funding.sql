CREATE OR REPLACE FUNCTION public.fn_cash_record_original_funding(p_kind text, p_key text, p_user uuid, p_table uuid, p_ledger uuid, p_wallet uuid, p_club uuid, p_amount numeric, p_after numeric, p_pending uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s public.table_seats%ROWTYPE; l public.chip_ledger%ROWTYPE;
 c public.clubs%ROWTYPE; v_id uuid;
BEGIN
 SELECT * INTO STRICT l FROM public.chip_ledger WHERE id=p_ledger;
 SELECT * INTO STRICT s FROM public.table_seats WHERE table_id=p_table AND user_id=p_user AND left_at IS NULL FOR SHARE;
 SELECT * INTO STRICT c FROM public.clubs WHERE id=p_club;
 IF s.occupancy_id IS NULL OR s.joined_at IS NULL
  OR c.asset IS DISTINCT FROM 'chips' OR l.club_id IS DISTINCT FROM p_club
  OR l.amount IS DISTINCT FROM p_amount OR l.to_type IS DISTINCT FROM 'table_stack'
  OR l.to_entity_id IS DISTINCT FROM p_table OR l.category IS DISTINCT FROM p_kind
  OR l.from_type IS DISTINCT FROM (CASE WHEN p_kind='horse_funding' THEN 'club_treasury' ELSE 'player_wallet' END)
  OR l.from_entity_id IS DISTINCT FROM (CASE WHEN p_kind='horse_funding' THEN p_club ELSE p_user END)
 THEN RAISE EXCEPTION 'Original cash funding debit identity mismatch' USING ERRCODE='23514'; END IF;
 IF p_kind<>'horse_funding' AND NOT EXISTS(SELECT 1 FROM public.wallet_transactions w
  WHERE w.id=p_wallet AND w.user_id=p_user AND w.table_id=p_table AND w.type='debit'
    AND w.category=p_kind AND w.amount=p_amount AND w.balance_after=p_after) THEN
  RAISE EXCEPTION 'Original cash funding wallet journal mismatch' USING ERRCODE='23514';
 END IF;
 INSERT INTO public.cash_participant_funding_receipts(operation_kind,operation_key,user_id,table_id,
  seat_id,occupancy_id,seat_joined_at,source_ledger_id,wallet_transaction_id,account_type,
  account_entity_id,funding_club_id,funding_union_id,asset,amount,balance_before,balance_after,pending_addon_id)
 VALUES(p_kind,p_key,p_user,p_table,s.id,s.occupancy_id,s.joined_at,l.id,p_wallet,l.from_type,
  l.from_entity_id,p_club,c.union_id,c.asset,p_amount,p_after+p_amount,p_after,p_pending) RETURNING id INTO v_id;
 RETURN v_id;
END $function$
