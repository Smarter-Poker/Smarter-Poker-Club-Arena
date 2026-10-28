CREATE OR REPLACE FUNCTION smarter_private.split_rakeback_payout_complete(p_payout uuid, p_calculation bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE pp public.rakeback_period_payouts%ROWTYPE;c public.accounting_rakeback_period_calculations%ROWTYPE;
BEGIN
 SELECT * INTO pp FROM public.rakeback_period_payouts WHERE id=p_payout;
 SELECT * INTO c FROM public.accounting_rakeback_period_calculations WHERE id=p_calculation;
 IF pp.id IS NULL OR c.id IS NULL OR c.payer_kind IS DISTINCT FROM 'split' OR pp.status IS DISTINCT FROM 'paid'
  OR pp.rakeback_period_id IS DISTINCT FROM c.period_id OR pp.club_id IS DISTINCT FROM c.club_id
  OR pp.user_id IS DISTINCT FROM c.player_id OR pp.payout_amount IS DISTINCT FROM c.rakeback_amount
  OR NOT EXISTS(SELECT 1 FROM public.rakeback_periods r WHERE r.id=c.period_id AND r.status='paid')
 THEN RETURN false; END IF;
 IF(SELECT count(*)FROM public.accounting_rakeback_payer_transfers t WHERE t.payout_id=pp.id)
   <>(SELECT count(*)FROM smarter_private.rakeback_certificate_payers(c.id)g WHERE g.owed>0)
 THEN RETURN false; END IF;
 RETURN NOT EXISTS(
 SELECT 1 FROM smarter_private.rakeback_certificate_payers(c.id)g
 LEFT JOIN public.accounting_rakeback_payer_transfers t ON t.payout_id=pp.id AND t.payer_kind=g.payer_kind AND t.payer_entity_id=g.payer_entity
 LEFT JOIN public.chip_ledger l ON l.id=t.ledger_id
 LEFT JOIN public.wallet_transactions w ON w.id=t.wallet_transaction_id
 WHERE g.owed>0 AND(t.payout_id IS NULL OR t.calculation_id IS DISTINCT FROM c.id OR t.period_id IS DISTINCT FROM c.period_id
  OR t.amount IS DISTINCT FROM g.owed OR l.amount IS DISTINCT FROM g.owed OR l.club_id IS DISTINCT FROM c.club_id
  OR NOT COALESCE(CASE WHEN g.payer_kind='club' THEN l.from_type='club_treasury' AND l.from_entity_id=g.payer_entity
    WHEN l.from_type IN('player_wallet','agent_wallet') THEN l.from_entity_id=g.payer_entity
    ELSE l.from_type='club_treasury' AND l.from_entity_id=c.club_id AND l.metadata->>'owner_share_payer'=g.payer_entity::text END,false)
  OR l.to_type IS DISTINCT FROM 'player_wallet' OR l.to_entity_id IS DISTINCT FROM c.player_id OR l.category IS DISTINCT FROM 'rakeback' OR l.status IS DISTINCT FROM 'posted'
  OR l.idempotency_key IS DISTINCT FROM 'round3-period:v3:'||c.period_id::text||':payer:'||g.payer_kind||':'||g.payer_entity::text
  OR l.metadata->>'certificate_id' IS DISTINCT FROM c.id::text OR l.metadata->>'payout_id' IS DISTINCT FROM pp.id::text
  OR l.metadata->>'period_id' IS DISTINCT FROM c.period_id::text OR l.metadata->>'source_fingerprint' IS DISTINCT FROM c.source_fingerprint
  OR l.pre_from_balance-l.post_from_balance IS DISTINCT FROM g.owed OR l.post_to_balance-l.pre_to_balance IS DISTINCT FROM g.owed
  OR w.user_id IS DISTINCT FROM c.player_id OR w.type IS DISTINCT FROM 'credit' OR w.amount IS DISTINCT FROM g.owed
  OR w.wallet_type IS DISTINCT FROM 'PLAYER' OR w.category IS DISTINCT FROM 'rakeback'
  OR w.related_entity_id IS DISTINCT FROM pp.id OR w.balance_after IS DISTINCT FROM l.post_to_balance
  OR(g.payer_kind='agent' AND l.from_type='player_wallet' AND(SELECT count(*)FROM public.wallet_transactions wd WHERE wd.related_entity_id=pp.id
    AND wd.user_id=g.payer_user AND wd.wallet_type='PLAYER' AND wd.type='debit' AND wd.category='rakeback'
    AND wd.amount=g.owed AND wd.balance_after=l.post_from_balance)<>1)
  OR(SELECT count(*)FROM public.settlement_invoices i WHERE i.source_ledger_id=l.id AND i.status='paid' AND i.chips_transferred
    AND i.message_sent AND i.gross_amount=g.owed AND i.net_amount=g.owed AND i.deductions=0)<>1));
EXCEPTION WHEN check_violation OR data_exception OR no_data_found THEN
 RETURN false;
END $function$
;
