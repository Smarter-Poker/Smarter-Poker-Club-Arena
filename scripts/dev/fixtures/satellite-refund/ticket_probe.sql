BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';

INSERT INTO public.ca_settle_sources(source,note)
VALUES('fn_unregister_from_tournament','isolated Phase 3 refund probe');
INSERT INTO public.club_members(club_id,user_id,chip_balance,status,role)
VALUES('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001',100,'active','player');
INSERT INTO public.tournaments(id,name,buy_in_amount,buy_in_fee,start_time,max_players,status,current_players,prize_pool,bounty_pool,total_rake)
VALUES('c3000000-0000-4000-8000-000000000001','Phase 3 isolated target',180,20,now()+interval '1 day',100,'REGISTERING',1,180,0,20);
INSERT INTO public.tournament_players(id,tournament_id,user_id,status,is_satellite_qualifier)
VALUES('c4000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','registered',true);
INSERT INTO public.tournament_escrow(tournament_id,enforced,opened_from,gross_in,fee_entries_in,prize_balance,bounty_balance,fee_balance)
VALUES('c3000000-0000-4000-8000-000000000001',true,'synthetic funded seat',200,0,200,0,0);
INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,tournament_id,metadata)
VALUES('c5000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','escrow','c9000000-0000-4000-8000-000000000001','prize_liability','c3000000-0000-4000-8000-000000000001',200,'ticket_redeem','c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001',jsonb_build_object('user_id','c1000000-0000-4000-8000-000000000001','registration_id','c4000000-0000-4000-8000-000000000001'));
INSERT INTO public.tournament_refund_entitlements(id,tournament_id,user_id,entitlement_kind,charge_category,refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,source_ledger_id,registration_id,source_satellite_id,source_award_place,source_ticket_id,escrow_bucket,evidence_kind)
VALUES('c6000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','tournament_ticket','tournament_ticket','c2000000-0000-4000-8000-000000000001',200,180,0,20,'c5000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000002',NULL,'c9000000-0000-4000-8000-000000000001','ticket_gross','atomic_tournament_ticket');
INSERT INTO public.rake_records(id,club_id,rake_amount,is_tournament,tournament_id,source,metadata)
VALUES('c7000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000002',20,true,'c3000000-0000-4000-8000-000000000001','fn_register_for_tournament_with_ticket',jsonb_build_object('user_id','c1000000-0000-4000-8000-000000000001','registration_id','c4000000-0000-4000-8000-000000000001','kind','tournament_ticket_entry_fee'));
INSERT INTO public.tournament_tickets(id,club_id,issued_by,holder_id,value,status,redemption_mode,source_tournament_id,source_satellite_id,source_refund_entitlement_id,entry_prize,entry_bounty,entry_fee)
VALUES('c9000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','2d1cd6c3-5700-4af9-a271-d4863fdab20d','c1000000-0000-4000-8000-000000000001',200,'redeemed','tournament_entry_only','c3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000002','c6000000-0000-4000-8000-000000000099',180,0,20);
SET CONSTRAINTS ALL IMMEDIATE;

CREATE TEMP TABLE result(value jsonb);
INSERT INTO result SELECT public.fn_ca_unregister_tournament_player_exact(
 'c3000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001',NULL,'Phase 3 isolated satellite refund','c8000000-0000-4000-8000-000000000001');

DO $verify$
DECLARE r jsonb; replay jsonb; refused boolean; expected_cash boolean:=current_setting('test.expect_cash')::boolean;
BEGIN
 SELECT value INTO r FROM result;
 IF (r->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'refund failed: %',r; END IF;
 IF expected_cash THEN
  IF (r->>'refunded_chips')::numeric IS DISTINCT FROM 200
     OR (r->>'returned_ticket_value')::numeric IS DISTINCT FROM 0
     OR (SELECT chip_balance FROM public.club_members) IS DISTINCT FROM 300::numeric
     OR (SELECT count(*) FROM public.tournament_tickets WHERE status='issued')<>0
     OR (SELECT count(*) FROM public.tournament_refund_tranches)<>1 THEN
   RAISE EXCEPTION 'approved cash outcome missing: %',r;
  END IF;
 ELSE
  IF (r->>'refunded_chips')::numeric IS DISTINCT FROM 0
     OR (r->>'returned_ticket_value')::numeric IS DISTINCT FROM 200
     OR (SELECT chip_balance FROM public.club_members) IS DISTINCT FROM 100::numeric
     OR (SELECT count(*) FROM public.tournament_tickets)<>1 THEN
   RAISE EXCEPTION 'baseline discrepancy did not reproduce: %',r;
  END IF;
 END IF;
 replay:=public.fn_ca_unregister_tournament_player_exact(
  'c3000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001',NULL,'replayed request','c8000000-0000-4000-8000-000000000001');
 IF (replay->>'replayed')::boolean IS DISTINCT FROM true
    OR (replay-'replayed') IS DISTINCT FROM (r-'replayed') THEN
  RAISE EXCEPTION 'same-key replay did not preserve the receipt';
 END IF;
 IF expected_cash THEN
  refused:=false;
  BEGIN
   PERFORM public.fn_settle_tournament_refund_exact(
    'c3000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001',
    400,180,0,20,'fn_unregister_from_tournament','duplicate credit');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN refused:=true;
  END;
  IF NOT refused OR (SELECT chip_balance FROM public.club_members)<>300
     OR (SELECT count(*) FROM public.tournament_refund_tranches)<>1
     OR (SELECT count(*) FROM public.wallet_transactions)<>1 THEN
   RAISE EXCEPTION 'consumed entitlement was paid twice';
  END IF;
  IF (r->>'wallet_chips_from_satellite_entitlements')::numeric IS DISTINCT FROM 200 THEN
   RAISE EXCEPTION 'receipt concealed satellite cash provenance';
  END IF;
 END IF;
 IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.tournament_escrow)<>0
    OR (SELECT sum(rake_amount) FROM public.rake_records)<>0
    OR (SELECT count(*) FROM public.tournament_players)<>0 THEN
  RAISE EXCEPTION 'refund did not close exact escrow/fee/registration state';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.rake_records WHERE rake_amount=-20 AND club_id='c2000000-0000-4000-8000-000000000002') THEN
  RAISE EXCEPTION 'fee reversed against the player funding club instead of its recipient';
 END IF;
 RAISE NOTICE 'PASS exact cash/ticket contract, replay, one credit, original fee recipient, closed escrow';
END;
$verify$;
SELECT jsonb_build_object('cash',value->'refunded_chips','ticket',value->'returned_ticket_value','wallet',(SELECT chip_balance FROM public.club_members),'escrow',(SELECT prize_balance+bounty_balance+fee_balance FROM public.tournament_escrow)) AS observed FROM result;
ROLLBACK;
