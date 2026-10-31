-- Every wallet entry below is a real owning admission in the isolated catalog.
-- The already-accepted final hand and empty closed target are opening scenes.
DO $value_chips$
DECLARE c jsonb; s uuid; target uuid; dest uuid:=md5('value-ticket-new-destination')::uuid;
 wrong uuid:=md5('value-ticket-wrong-price')::uuid; q uuid[]; u uuid; tk uuid;
 r jsonb; first_receipt jsonb; before_state jsonb; refused boolean; v_wallet numeric;
BEGIN
 c:=pg_temp.qualifier_case('value_closed',2,false);
 s:=(c->>'tournament_id')::uuid;target:=(c->>'target_id')::uuid;
 SELECT array_agg(value::uuid) INTO q FROM jsonb_array_elements_text(c->'qualifier_ids');
 -- These new destinations are authored through the existing row guards.
 INSERT INTO public.tournaments SELECT x.* FROM public.tournaments t,
  LATERAL jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object(
   'id',dest,'format_contract',NULL,'name','Value Ticket Bounty Destination','start_time',now()+interval '5 minutes',
   'blind_structure','[{"smallBlind":5,"bigBlind":10,"ante":0,"durationMinutes":10}]',
   'is_bounty',true,'is_pko',false,'is_mystery_bounty',false,'bounty_amount',10,
   'guaranteed_prize',0,'late_reg_mins',60,'late_reg_levels',10)) x WHERE t.id=target;
 INSERT INTO public.tournaments SELECT x.* FROM public.tournaments t,
  LATERAL jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object(
   'id',wrong,'format_contract',NULL,'name','Value Ticket Wrong Price','buy_in_amount',36,'buy_in_fee',4,
   'blind_structure','[{"smallBlind":5,"bigBlind":10,"ante":0,"durationMinutes":10}]',
   'start_time',now()+interval '5 minutes','guaranteed_prize',0)) x WHERE t.id=target;
 PERFORM set_config('session_replication_role','replica',true);
 UPDATE public.tournaments SET status='COMPLETED',prize_pool_finalized=true WHERE id=target;
 PERFORM set_config('session_replication_role','origin',true);
 before_state:=pg_temp.qualifier_financial_state();
 PERFORM set_config('native.qualifier_fault_table',c->>'table_id',true);
 refused:=false;
 BEGIN PERFORM public.fn_settle_satellite_qualifiers(s,q);
 EXCEPTION WHEN SQLSTATE 'PZ013' THEN refused:=true; END;
 PERFORM set_config('native.qualifier_fault_table','',true);
 PERFORM pg_temp.qualifier_assert(refused AND before_state=pg_temp.qualifier_financial_state(),
   'value vouchers and bubble all roll back when final felt closure refuses');
 first_receipt:=public.fn_settle_satellite_qualifiers(s,q);
 PERFORM pg_temp.qualifier_assert((first_receipt->>'fully_settled')::boolean,
   'closed-target satellite settles through the actual cohort authority');
 PERFORM pg_temp.qualifier_assert((SELECT count(*)=2 AND sum(amount)=100 FROM public.tournament_satellite_awards
   WHERE tournament_id=s AND delivery_kind='ticket') AND NOT EXISTS(SELECT 1 FROM public.tournament_satellite_awards
   WHERE tournament_id=s AND delivery_kind='cash'),'two full-value tickets, no main-prize cash');
 PERFORM pg_temp.qualifier_assert((SELECT count(*)=1 AND sum(amount)=5 FROM public.tournament_payouts
   WHERE tournament_id=s AND source='satellite_remainder'),'only the single bubble receives cash');
 PERFORM pg_temp.qualifier_assert(public.fn_settle_satellite_qualifiers(s,q)=first_receipt,
   'lost-response retry returns the same immutable ticket receipt');
 FOREACH u IN ARRAY q LOOP
  SELECT ticket_id INTO tk FROM public.tournament_satellite_awards WHERE tournament_id=s AND user_id=u;
  PERFORM pg_temp.qualifier_assert(public.fn_ca_assert_satellite_value_ticket(tk)='chips',
    'ticket has the actual posted noncash issue leg');
  PERFORM pg_temp.qualifier_assert((SELECT chip_balance=273.75 FROM public.club_members
    WHERE user_id=u AND club_id=(SELECT club_id FROM public.tournaments WHERE id=s)),
    'a full ticket never credits the winner wallet');
 END LOOP;
 r:=public.fn_ca_pay_closed_target_tickets_in_cash(target,'native value ticket proof');
 PERFORM pg_temp.qualifier_assert((r->>'paid')::integer=0 AND (SELECT count(*)=2 FROM public.tournament_tickets
   WHERE source_satellite_id=s AND status='issued'),'closing the old target never cashes new value tickets');
 u:=q[1];SELECT ticket_id INTO tk FROM public.tournament_satellite_awards WHERE tournament_id=s AND user_id=u;
 PERFORM set_config('request.jwt.claim.sub',u::text,true);
 r:=public.fn_redeem_tournament_ticket(tk);
 PERFORM pg_temp.qualifier_assert(r->>'success'='false'
   AND r->>'error'='Tournament-Entry Tickets Can Only Be Used To Enter A Tournament',
   'actual wallet redemption refuses the value ticket');
 r:=public.fn_cancel_tournament_ticket(tk);
 PERFORM pg_temp.qualifier_assert(r->>'success'='false'
   AND r->>'error'='Returned Tournament-Entry Tickets Cannot Be Cancelled For Chips',
   'actual cancellation cannot convert the value ticket to a wallet credit');
 PERFORM set_config('request.jwt.claim.sub','',true);
 SELECT chip_balance INTO v_wallet FROM public.club_members WHERE user_id=u
   AND club_id=(SELECT club_id FROM public.tournaments WHERE id=s);
 PERFORM pg_temp.qualifier_assert(public.fn_ca_find_tournament_entry_ticket_for(dest,u)->>'ticket_id'=tk::text,
   'another event at equal full value discovers the reusable ticket despite a different bounty split');
 before_state:=pg_temp.qualifier_financial_state();
 r:=public.fn_ca_register_for_tournament_with_ticket_for(wrong,tk,u);
 PERFORM pg_temp.qualifier_assert(r->>'reason'='ticket_entry_contract_mismatch'
   AND before_state=pg_temp.qualifier_financial_state(),'wrong price cannot consume or charge a voucher');
 r:=public.fn_ca_register_for_tournament_with_ticket_for(dest,tk,u);
 PERFORM pg_temp.qualifier_assert((r->>'ok')::boolean AND (r->>'prize_contribution')::numeric=35
   AND (r->>'bounty_contribution')::numeric=10 AND (r->>'fee_contribution')::numeric=5,
   'redemption books the selected event actual prize, bounty and fee');
 PERFORM pg_temp.qualifier_assert((SELECT chip_balance=v_wallet FROM public.club_members WHERE user_id=u
   AND club_id=(SELECT club_id FROM public.tournaments WHERE id=s)), 'redemption keeps the wallet unchanged');
 PERFORM pg_temp.qualifier_assert(public.fn_ca_assert_satellite_value_ticket(tk)='chips'
   AND public.fn_ca_register_for_tournament_with_ticket_for(dest,tk,u)->>'replayed'='true',
   'one committed redemption is replayable without another entry');
 PERFORM pg_temp.qualifier_assert(public.fn_ca_register_for_tournament_with_ticket_for(wrong,tk,u)->>'reason'='ticket_already_used',
   'a second destination cannot spend the same ticket');
 PERFORM pg_temp.qualifier_assert((SELECT prize_balance=35 AND bounty_balance=10 AND fee_balance=5
   FROM public.tournament_escrow WHERE tournament_id=dest),'destination holds exactly the funded split');
 PERFORM pg_temp.qualifier_assert(public.fn_settle_satellite_qualifiers(s,q)=first_receipt,
   'source receipt stays valid after spending a ticket at another destination');
END;
$value_chips$;
SELECT 'SATELLITE_VALUE_CHIPS_PASS';
