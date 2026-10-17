CREATE OR REPLACE FUNCTION public.fn_ca_tournament_refund_plan(p_tournament_id uuid, p_user_id uuid)
 RETURNS TABLE(source_wallet_club_id uuid, gross_remaining numeric, prize_remaining numeric, bounty_remaining numeric, fee_remaining numeric, debit_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_escrow public.tournament_escrow%ROWTYPE;
  v_wallet_count bigint;
  v_wallet_total numeric;
  v_charge_count bigint;
  v_charge_total numeric;
  v_refund_count bigint;
  v_refund_total numeric;
  v_tranche_count bigint;
  v_tranche_total numeric;
  v_wallet_gross numeric;
  v_direct_fee numeric;
  v_satellite_fee numeric;
  v_bounty numeric;
  v_satellite_in numeric;
  v_invalid bigint;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'refund plan requires tournament and player ids'
      USING ERRCODE = '22004';
  END IF;
  PERFORM 1 FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund plan tournament % does not exist',p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id
   ORDER BY e.user_id,e.entitlement_kind,e.id FOR SHARE;
  PERFORM 1 FROM public.tournament_refund_tranches tr
   WHERE tr.tournament_id=p_tournament_id
   ORDER BY tr.user_id,tr.entitlement_id FOR SHARE;

  SELECT count(*),round(COALESCE(sum(w.amount),0),2)
    INTO v_wallet_count,v_wallet_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.type='debit'
     AND lower(w.category) IN ('tournament_buyin','rebuy','addon');
  SELECT count(*),round(COALESCE(sum(e.gross),0),2)
    INTO v_charge_count,v_charge_total
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id
     AND e.entitlement_kind='wallet_charge';
  IF v_wallet_count IS DISTINCT FROM v_charge_count
     OR v_wallet_total IS DISTINCT FROM v_charge_total THEN
    RAISE EXCEPTION
      'tournament % wallet charges and immutable entitlements disagree',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_invalid
    FROM public.tournament_refund_entitlements e
    LEFT JOIN public.chip_ledger l ON l.id=e.source_ledger_id
   WHERE e.tournament_id=p_tournament_id
     AND (
       l.id IS NULL OR l.club_id IS DISTINCT FROM e.refund_wallet_club_id
       OR l.amount IS DISTINCT FROM e.gross
       OR (e.entitlement_kind='wallet_charge' AND (
         l.tournament_id IS DISTINCT FROM e.tournament_id
         OR l.from_type IS DISTINCT FROM 'player_wallet'
         OR l.from_entity_id IS DISTINCT FROM e.user_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM e.tournament_id
         OR lower(l.category) IS DISTINCT FROM e.charge_category))
       OR (e.entitlement_kind='satellite_seat' AND (
         l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM e.source_satellite_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM e.tournament_id
         OR l.metadata->>'user_id' IS DISTINCT FROM e.user_id::text
         OR l.metadata->>'registration_id' IS DISTINCT FROM
              e.registration_id::text))
       OR (e.entitlement_kind='tournament_ticket' AND (
         l.tournament_id IS DISTINCT FROM e.tournament_id
         OR l.from_type IS DISTINCT FROM 'escrow'
         OR l.from_entity_id IS DISTINCT FROM e.source_ticket_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM e.tournament_id
         OR l.category IS DISTINCT FROM 'ticket_redeem'
         OR l.metadata->>'user_id' IS DISTINCT FROM e.user_id::text
         OR l.metadata->>'registration_id' IS DISTINCT FROM
              e.registration_id::text))
     );
  IF v_invalid <> 0 THEN
    RAISE EXCEPTION 'tournament % has % invalid refund entitlement sources',
      p_tournament_id,v_invalid USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(CASE
           WHEN e.escrow_bucket IN ('wallet_gross','ticket_gross')
             THEN e.gross
           WHEN e.escrow_bucket='satellite_gross'
             THEN e.refund_prize+e.refund_bounty ELSE 0 END),0),2),
         round(COALESCE(sum(CASE
           WHEN e.entitlement_kind IN ('wallet_charge','tournament_ticket')
             THEN e.refund_fee
           ELSE 0 END),0),2),
         round(COALESCE(sum(CASE
           WHEN e.entitlement_kind='satellite_seat' THEN e.refund_fee
           ELSE 0 END),0),2),
         round(COALESCE(sum(CASE
           WHEN e.escrow_bucket IN (
             'wallet_gross','satellite_gross','ticket_gross')
             THEN e.refund_bounty ELSE 0 END),0),2),
         round(COALESCE(sum(CASE
           WHEN e.escrow_bucket='satellite_in'
             THEN e.refund_prize+e.refund_bounty ELSE 0 END),0),2)
    INTO v_wallet_gross,v_direct_fee,v_satellite_fee,v_bounty,v_satellite_in
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id;
  SELECT * INTO v_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR SHARE;
  IF v_escrow.tournament_id IS NULL
     OR v_escrow.enforced IS DISTINCT FROM true
     OR v_escrow.gross_in IS DISTINCT FROM v_wallet_gross
     OR v_escrow.fee_entries_in IS DISTINCT FROM v_direct_fee
     OR v_escrow.satellite_fee_in IS DISTINCT FROM v_satellite_fee
     OR v_escrow.bounty_in IS DISTINCT FROM v_bounty
     OR v_escrow.satellite_in IS DISTINCT FROM v_satellite_in THEN
    RAISE EXCEPTION
      'tournament % escrow does not equal its immutable entitlement rails',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*),round(COALESCE(sum(w.amount),0),2)
    INTO v_refund_count,v_refund_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='credit'
     AND lower(w.category) IN ('refund','tournament_refund');
  SELECT count(*),round(COALESCE(sum(tr.amount_paid_now),0),2)
    INTO v_tranche_count,v_tranche_total
    FROM public.tournament_refund_tranches tr
   WHERE tr.tournament_id=p_tournament_id AND tr.user_id=p_user_id;
  IF v_refund_count IS DISTINCT FROM v_tranche_count
     OR v_refund_total IS DISTINCT FROM v_tranche_total THEN
    RAISE EXCEPTION
      'player % tournament % has refund money without exact entitlement tranches',
      p_user_id,p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_tranches tr
    JOIN public.tournament_refund_entitlements e ON e.id=tr.entitlement_id
    WHERE tr.tournament_id=p_tournament_id AND (
      e.tournament_id IS DISTINCT FROM tr.tournament_id
      OR e.user_id IS DISTINCT FROM tr.user_id
      OR e.refund_wallet_club_id IS DISTINCT FROM tr.source_wallet_club_id
      OR e.gross IS DISTINCT FROM tr.amount_paid_now
      OR e.refund_prize IS DISTINCT FROM tr.refund_prize
      OR e.refund_bounty IS DISTINCT FROM tr.refund_bounty
      OR e.refund_fee IS DISTINCT FROM tr.refund_fee)
  ) THEN
    RAISE EXCEPTION 'tournament % has a tranche detached from its entitlement',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  RETURN QUERY
  SELECT e.refund_wallet_club_id,e.gross,e.refund_prize,e.refund_bounty,
         e.refund_fee,1::bigint
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.entitlement_kind='wallet_charge'
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id)
   ORDER BY e.entitlement_kind,e.id;
END;
$function$
