-- Private disposable catalog only. Four real 27-Diamond entries fund 108;
-- the accepted final-hand scene is the same disclosed opening as Chips.
DO $diamond_value$
DECLARE c jsonb; s uuid; target uuid; dest uuid:=md5('diamond-value-destination')::uuid;
 q uuid[]; u uuid; tk uuid; r jsonb; first_receipt jsonb;
 before_total numeric; wallet_before bigint; issue_before jsonb; refused boolean;
BEGIN
 c:=pg_temp.qualifier_diamond_case('diamond_value',2,false);
 s:=(c->>'tournament_id')::uuid;target:=(c->>'target_id')::uuid;
 SELECT array_agg(value::uuid) INTO q FROM jsonb_array_elements_text(c->'qualifier_ids');
 SELECT sum(diamonds)+public.fn_ca_arena_diamonds() INTO before_total FROM public.profiles;
 INSERT INTO public.tournaments SELECT x.* FROM public.tournaments t,
  LATERAL jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object(
   'id',dest,'format_contract',NULL,'name','Diamond Value Ticket Destination',
   'blind_structure','[{"smallBlind":5,"bigBlind":10,"ante":0,"durationMinutes":10}]',
   'buy_in_amount',46,'buy_in_fee',4,'start_time',now()+interval '5 minutes',
   'guaranteed_prize',0,'late_reg_mins',60,'late_reg_levels',10)) x WHERE t.id=target;
 PERFORM set_config('session_replication_role','replica',true);
 UPDATE public.tournaments SET status='COMPLETED',prize_pool_finalized=true WHERE id=target;
 PERFORM set_config('session_replication_role','origin',true);
 first_receipt:=public.fn_settle_satellite_qualifiers(s,q);
 PERFORM pg_temp.qualifier_assert((first_receipt->>'fully_settled')::boolean,
   'Diamond source settles through actual native custody');
 PERFORM pg_temp.qualifier_assert((SELECT count(*)=2 AND sum(amount)=100 FROM public.tournament_satellite_awards
   WHERE tournament_id=s AND delivery_kind='ticket') AND public.fn_ca_diamond_value_ticket_float(NULL)=100,
   'two whole Diamond tickets retain 100 in native ticket backing');
 PERFORM pg_temp.qualifier_assert((SELECT sum(amount)=8 FROM public.tournament_payouts
   WHERE tournament_id=s AND source='satellite_remainder'), 'only the Diamond bubble receives the 8 remainder');
 PERFORM pg_temp.qualifier_assert((SELECT sum(diamonds)+public.fn_ca_arena_diamonds()=before_total FROM public.profiles),
   'Diamond wallet plus arena and ticket custody conserves all 108 funded units');
 PERFORM pg_temp.qualifier_assert(NOT EXISTS(SELECT 1 FROM public.chip_ledger
   WHERE tournament_id=s) AND NOT EXISTS(SELECT 1 FROM public.chip_transactions WHERE metadata->>'satellite_id'=s::text),
   'a Diamond award creates no Chip ledger transfer');
 FOREACH u IN ARRAY q LOOP
  SELECT ticket_id INTO tk FROM public.tournament_satellite_awards WHERE tournament_id=s AND user_id=u;
  PERFORM pg_temp.qualifier_assert(public.fn_ca_assert_satellite_value_ticket(tk)='diamonds',
   'each Diamond ticket proves its zero-wallet native issue leg');
 END LOOP;
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
 SELECT diamonds INTO wallet_before FROM public.profiles WHERE id=u;
 UPDATE public.ca_arena_settings SET tournaments_enabled=false WHERE id=1;
 r:=public.fn_ca_register_for_tournament_with_ticket_for(dest,tk,u);
 PERFORM pg_temp.qualifier_assert(NOT COALESCE((r->>'ok')::boolean,false)
   AND (SELECT status='issued' FROM public.tournament_tickets WHERE id=tk),
   'the closed Diamond switch refuses redemption without consuming the ticket');
 UPDATE public.ca_arena_settings SET tournaments_enabled=true WHERE id=1;
 r:=public.fn_ca_register_for_tournament_with_ticket_for(dest,tk,u);
 PERFORM pg_temp.qualifier_assert((r->>'ok')::boolean AND (r->>'prize_contribution')::numeric=46
   AND (r->>'fee_contribution')::numeric=4 AND public.fn_poker_diamond_tournament_custody(dest)=50,
   'actual Diamond redemption funds the selected 46 plus 4 entry split');
 PERFORM pg_temp.qualifier_assert((SELECT diamonds=wallet_before FROM public.profiles WHERE id=u)
   AND public.fn_ca_diamond_value_ticket_float(NULL)=50,
   'Diamond redemption moves ticket backing into custody without a wallet debit');
 PERFORM pg_temp.qualifier_assert((SELECT sum(diamonds)+public.fn_ca_arena_diamonds()=before_total FROM public.profiles),
   'Diamond redemption preserves combined wallet and arena conservation');
 r:=public.fn_ca_register_for_tournament_with_ticket_for(dest,tk,u);
 PERFORM pg_temp.qualifier_assert((r->>'ok')::boolean AND (r->>'replayed')::boolean
   AND public.fn_poker_diamond_tournament_custody(dest)=50,
   'Diamond lost-ack replay returns the one funded entry');
 PERFORM pg_temp.qualifier_assert(public.fn_settle_satellite_qualifiers(s,q)=first_receipt,
   'the source Diamond settlement receipt survives cross-event redemption');
 EXECUTE 'SET LOCAL ROLE authenticated';
 refused:=false;
 BEGIN PERFORM public.fn_ca_issue_diamond_value_ticket(s,tk,gen_random_uuid());
 EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
 EXECUTE 'RESET ROLE';
 PERFORM pg_temp.qualifier_assert(refused,'a browser cannot invoke private Diamond ticket issuance');
 UPDATE public.ca_arena_settings SET tournaments_enabled=false WHERE id=1;
END;
$diamond_value$;
SELECT 'SATELLITE_VALUE_DIAMONDS_PASS';
