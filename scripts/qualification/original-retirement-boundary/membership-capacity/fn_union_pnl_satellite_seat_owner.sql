CREATE OR REPLACE FUNCTION public.fn_union_pnl_satellite_seat_owner(p_registration_id uuid, p_tournament_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH reg AS (
  SELECT e.after_row r FROM public.union_pnl_inventory_events e
  WHERE e.source_name='tournament_players' AND e.row_id=p_registration_id ORDER BY e.event_id LIMIT 1
 ), who AS (
  SELECT (r->>'user_id')::uuid user_id,(r->>'source_satellite_id')::uuid satellite_id,(r->>'registered_at')::timestamptz registered_at,
   (r->>'tournament_id')::uuid target_id
  FROM reg WHERE (p_tournament_id IS NULL OR r->>'tournament_id'=p_tournament_id::text)
   AND r->>'source_satellite_id' IS NOT NULL AND r->>'user_id' IS NOT NULL AND r->>'tournament_id' IS NOT NULL
 ), award AS (
  SELECT a.tournament_id,a.user_id FROM who w
  JOIN public.tournament_satellite_awards a ON a.tournament_id=w.satellite_id AND a.user_id=w.user_id
  JOIN public.tournament_satellite_settlements s ON s.tournament_id=a.tournament_id AND s.target_id=w.target_id
  WHERE (a.delivery_kind='seat' AND a.registration_id=p_registration_id)
   OR (a.delivery_kind='ticket' AND a.registration_id IS NULL AND EXISTS(SELECT 1 FROM public.tournament_tickets t WHERE t.id=a.ticket_id
     AND t.holder_id=w.user_id AND t.source_satellite_id=w.satellite_id AND t.source_tournament_id=w.target_id
     AND t.status='redeemed' AND t.redemption_mode='tournament_entry_only' AND t.redeemed_at=w.registered_at))
 ), entry AS (
  SELECT count(*) n,count(DISTINCT r.funding_club_id) clubs,min(r.funding_club_id::text)::uuid club,
   count(*) FILTER(WHERE r.operation='entry') entries,
   count(*) FILTER(WHERE r.asset IS DISTINCT FROM 'chips' OR r.amount IS NULL OR r.amount<=0 OR r.funding_club_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM (SELECT row.* FROM public.chip_ledger row WHERE row.id=r.ledger_id OFFSET 0) l WHERE l.status='posted' AND l.from_type='player_wallet' AND l.from_entity_id=r.user_id
     AND l.to_type='prize_liability' AND l.to_entity_id=r.tournament_id AND l.tournament_id=r.tournament_id AND l.amount=r.amount
     AND l.club_id=r.funding_club_id AND l.category IN ('tournament_buyin','rebuy','addon') AND l.row_hash IS NOT NULL)) bad
  FROM award a JOIN public.tournament_participant_funding_receipts r ON r.tournament_id=a.tournament_id AND r.user_id=a.user_id
 )
 SELECT CASE WHEN (SELECT count(*) FROM award)=1 AND e.n>0 AND e.entries>=1 AND e.clubs=1 AND e.bad=0 THEN e.club END FROM entry e
$function$;
