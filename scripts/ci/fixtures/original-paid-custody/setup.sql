CREATE SCHEMA original_paid_fixture;
CREATE FUNCTION original_paid_fixture.expected_custody() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('tournament_id',t.id,'user_id',p.user_id,'destination_table_id',s.table_id,
  'destination_seat_number',1,'generation',l.lease_generation,'instance_id',l.instance_id,'engine_version',l.engine_version,
  'candidate_id',c.id,'entitlement_id',e.id,'wallet_transaction_id',w.id,
  'candidate',to_jsonb(c),'original_seat',to_jsonb(oldseat),'player',to_jsonb(p),'entitlement',to_jsonb(e),
  'ledger',to_jsonb(j),'wallet',to_jsonb(w),'live_seats',jsonb_build_array(to_jsonb(s)),
  'funded_supply',317500,'grant_chips',2500,'scoring_excess',5000)
 FROM public.tournaments t JOIN public.tournament_players p ON p.tournament_id=t.id
 JOIN public.tournament_knockout_candidates c ON c.tournament_id=t.id AND c.eliminated_user_id=p.user_id
 JOIN public.table_seats oldseat ON oldseat.id=c.seat_id
 JOIN public.tournament_refund_entitlements e ON e.tournament_id=t.id AND e.user_id=p.user_id
 JOIN public.chip_ledger j ON j.id=e.source_ledger_id
 JOIN public.wallet_transactions w ON w.related_entity_id=t.id AND w.user_id=p.user_id
 JOIN public.engine_tournament_leases l ON l.tournament_id=t.id
 JOIN public.table_seats s ON s.id='b7400000-0000-4000-8000-000000000002'
 WHERE t.id='b7200000-0000-4000-8000-000000000001' AND p.user_id='b7100000-0000-4000-8000-000000000001';
$$;
CREATE TABLE original_paid_fixture.input AS SELECT original_paid_fixture.expected_custody() AS expected;
