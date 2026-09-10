-- Shared real payment DTO helper for the gated version2 read/claim endpoints.
CREATE FUNCTION public.fn_ca_captured_player_payment_dto(p_payment uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
 SELECT jsonb_build_object('payment_id',p.id,'scope',jsonb_build_object(
  'club_id',s.club_id,'funding_union_id',s.funding_union_id,'funding_route',s.funding_route,
  'contract_version',s.contract_version,'payer_user_id',p.payer_user_id),'pool_id',s.id,
  'beneficiary_user_id',p.player_id,'amount',round(p.amount,2)::text,
  'paid_at',to_char(p.paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'earning_closed_through',p.earning_closed_through::text,
  'earning_slices',coalesce((SELECT jsonb_agg(jsonb_build_object(
   'hand_id',x.hand_id,'contributor_id',x.player_id,'week_start',a.earning_week::text,
   'amount_exact',trim_scale(x.amount)::text) ORDER BY a.earning_week,x.hand_id,x.player_id)
   FROM ca_source_player_payment_slices x JOIN ca_source_player_funding_admissions a USING(hand_id,player_id)
   WHERE x.payment_id=p.id),'[]'::jsonb))
 FROM ca_source_player_cash_payments p JOIN ca_source_funding_pools s ON s.id=p.pool_id WHERE p.id=p_payment
$f$;
REVOKE ALL ON FUNCTION fn_ca_captured_player_payment_dto(uuid) FROM PUBLIC,anon,authenticated,service_role;
