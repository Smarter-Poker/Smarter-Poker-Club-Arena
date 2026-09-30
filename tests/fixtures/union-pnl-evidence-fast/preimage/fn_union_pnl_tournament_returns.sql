CREATE FUNCTION public.fn_union_pnl_tournament_returns(p_tournament uuid DEFAULT NULL,p_registration uuid DEFAULT NULL,p_start timestamptz DEFAULT NULL,p_end timestamptz DEFAULT NULL)
RETURNS TABLE(ledger_id uuid,tournament_id uuid,user_id uuid,credited_club_id uuid,amount numeric,transaction_id xid8,entry_receipt_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT c.ledger_id,c.tournament_id,c.user_id,c.credited_club_id,c.amount,c.transaction_id,c.entry_receipt_ids
 FROM public.tournament_accounting_credit_receipts c
 JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
 WHERE (p_tournament IS NULL OR c.tournament_id=p_tournament)
  AND (p_registration IS NULL OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r
   WHERE r.tournament_id=c.tournament_id AND r.registration_id=p_registration AND r.id=ANY(c.entry_receipt_ids)))
  AND (p_start IS NULL OR b.observed_at>=p_start) AND (p_end IS NULL OR b.observed_at<p_end)
 UNION ALL
 SELECT t.credit_ledger_id,t.tournament_id,t.user_id,t.source_wallet_club_id,t.amount_paid_now,t.transaction_id,ARRAY[r.id]
 FROM public.tournament_refund_tranches t
 JOIN public.tournament_participant_funding_receipts r ON r.entitlement_id=t.entitlement_id
 JOIN public.union_pnl_transaction_frames b ON b.transaction_id=t.transaction_id
 WHERE (p_tournament IS NULL OR t.tournament_id=p_tournament) AND (p_registration IS NULL OR r.registration_id=p_registration)
  AND (p_start IS NULL OR b.observed_at>=p_start) AND (p_end IS NULL OR b.observed_at<p_end)
  AND NOT EXISTS(SELECT 1 FROM public.tournament_accounting_credit_receipts c WHERE c.ledger_id=t.credit_ledger_id);
$$
