-- An award whose payout recorded no entry receipt is still owned by its
-- registration's original funding club when (a) that registration was carried
-- into this week's opening basis through a valid opening resolution (it is in
-- p_resolved: the opening boundary accepted it, bound to its exact population
-- row), (b) exactly one resolution exists for this tournament and player at
-- that boundary, it names this registration (the award's own registration
-- snapshot) and its owning club is the credited club, and (c) the award is the
-- posted, hash-chained ledger credit from this tournament's prize pool to this
-- player's wallet at that club, for the same amount. An award that names any
-- entry receipt is judged by those receipts alone, as before.
CREATE FUNCTION public.fn_union_pnl_award_owner_resolved(c public.tournament_accounting_credit_receipts, p_union_id uuid, p_start timestamp with time zone, p_resolved uuid[])
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT COALESCE(cardinality(c.entry_receipt_ids),0)=0 AND c.asset='chips' AND c.amount>0 AND c.registration_snapshot->>'id' IS NOT NULL
  AND (SELECT count(*) FROM public.union_pnl_opening_registration_resolutions r
       WHERE r.boundary=p_start AND r.union_id=p_union_id AND r.tournament_id=c.tournament_id AND r.user_id=c.user_id)=1
  AND EXISTS(SELECT 1 FROM public.union_pnl_opening_registration_resolutions r
   JOIN public.chip_ledger l ON l.id=c.ledger_id
   WHERE r.boundary=p_start AND r.union_id=p_union_id AND r.tournament_id=c.tournament_id AND r.user_id=c.user_id
    AND r.registration_id=ANY(p_resolved) AND r.registration_id::text=c.registration_snapshot->>'id'
    AND r.proof_md5=md5(r.proof::text) AND r.owning_club_id=c.credited_club_id
    AND l.status='posted' AND l.category IN ('tournament_prize','bounty') AND l.tournament_id=c.tournament_id
    AND l.from_type='prize_liability' AND l.from_entity_id=c.tournament_id
    AND l.to_type='player_wallet' AND l.to_entity_id=c.user_id
    AND l.amount=c.amount AND l.club_id=c.credited_club_id AND l.row_hash IS NOT NULL)
$function$;
