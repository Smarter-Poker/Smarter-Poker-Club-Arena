-- The week's cash play and satellite entries (after union-pnl-award-owner/seed.sql).
-- Tables TB1, TB2 are Midway's; P1 (club A) buys in on TB1 and is moved to
-- TB2; P2 (club B) buys in on TB2. Hand H (manifest captured, link lost) and
-- hand H2 (no manifest) are recognized with no game scope; both cash out.
INSERT INTO public.clubs VALUES(public.u('U'),'chips'),(public.u('A'),'chips'),(public.u('B'),'chips');
INSERT INTO public.profiles VALUES(public.u('up1'),true),(public.u('up2'),false);
CREATE FUNCTION public.hx_scope() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('host_club_id',public.u('U'),'game_union_id',public.u('U'),'is_private',false,'tournament_id',NULL,'asset','chips','unit_scale',2) $$;
CREATE FUNCTION public.hx_event(p_source text, p_row uuid, p_at timestamptz, p_tx xid8, p_op text, p_before jsonb, p_after jsonb) RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.union_pnl_inventory_events VALUES(nextval('public.hx_ev'),p_source,p_row,p_at,p_tx,p_op,p_before,p_after) $$;
CREATE FUNCTION public.hx_seat(p_seat text, p_table text, p_user text, p_club text, p_join timestamptz, p_occ text, p_stack numeric, p_left timestamptz DEFAULT NULL)
 RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('id',public.u(p_seat),'stack',p_stack,'club_id',public.u(p_club),'left_at',p_left,'user_id',public.u(p_user),
  'table_id',public.u(p_table),'joined_at',p_join,'occupancy_id',public.u(p_occ)) $$;
-- a cash debit onto a table: ledger row, funding receipt, original flow
CREATE FUNCTION public.hx_cash_in(p text, p_table text, p_user text, p_club text, p_seat text, p_occ text, p_join timestamptz, p_amount numeric, p_at timestamptz)
 RETURNS void LANGUAGE plpgsql AS $$
DECLARE x xid8:=public.hx_frame(p_at); l jsonb;
BEGIN
 INSERT INTO public.chip_ledger VALUES(public.u('l'||p),'player_wallet',public.u(p_user),'table_stack',public.u(p_table),p_amount,'buyin',public.u(p_club),NULL,p_at,'posted',nextval('public.hx_seq'),md5(p));
 INSERT INTO public.cash_participant_funding_receipts(id,recorded_at,operation_kind,operation_key,user_id,table_id,seat_id,occupancy_id,seat_joined_at,source_ledger_id,
  account_type,account_entity_id,funding_club_id,funding_union_id,asset,unit_scale,amount,balance_before,balance_after,transaction_id)
 VALUES(public.u('r'||p),p_at,'buyin',p,public.u(p_user),public.u(p_table),public.u(p_seat),public.u(p_occ),p_join,public.u('l'||p),
  'player_wallet',public.u(p_user),public.u(p_club),public.u('U'),'chips',2,p_amount,1000,1000-p_amount,x);
 SELECT jsonb_build_object('id',public.u('l'||p),'status','posted','club_id',public.u(p_club),'to_type','table_stack','to_entity_id',public.u(p_table),
  'from_type','player_wallet','from_entity_id',public.u(p_user),'amount',p_amount,'category','buyin','table_id',public.u(p_table),'created_at',p_at) INTO l;
 INSERT INTO public.union_pnl_original_flows VALUES(public.u('l'||p),x,p_at,public.hx_scope(),l);
 PERFORM public.hx_event('table_seats',public.u(p_seat),p_at,x,'UPDATE',NULL,public.hx_seat(p_seat,p_table,p_user,p_club,p_join,p_occ,p_amount));
END $$;
-- a cash-out: the vacated seat row and the table_cashout ledger row, one transaction
CREATE FUNCTION public.hx_cash_out(p text, p_table text, p_user text, p_club text, p_seat text, p_occ text, p_join timestamptz, p_amount numeric, p_at timestamptz,
 p_category text DEFAULT 'table_cashout') RETURNS void LANGUAGE plpgsql AS $$
DECLARE x xid8:=public.hx_frame(p_at); l jsonb;
BEGIN
 INSERT INTO public.chip_ledger VALUES(public.u('l'||p),'table_stack',public.u(p_table),'player_wallet',public.u(p_user),p_amount,p_category,public.u(p_club),NULL,p_at,'posted',nextval('public.hx_seq'),md5(p));
 SELECT jsonb_build_object('id',public.u('l'||p),'status','posted','club_id',public.u(p_club),'to_type','player_wallet','to_entity_id',public.u(p_user),
  'from_type','table_stack','from_entity_id',public.u(p_table),'amount',p_amount,'category',p_category,'table_id',public.u(p_table),'created_at',p_at) INTO l;
 INSERT INTO public.union_pnl_original_flows VALUES(public.u('l'||p),x,p_at,public.hx_scope(),l);
 PERFORM public.hx_event('table_seats',public.u(p_seat),p_at,x,'UPDATE',public.hx_seat(p_seat,p_table,p_user,p_club,p_join,p_occ,p_amount),
  public.hx_seat(p_seat,p_table,p_user,p_club,p_join,p_occ,p_amount,p_at));
END $$;
-- a seat move receipt, as atomic seat moves write it
CREATE FUNCTION public.hx_move(p text, p_user text, p_club text, p_from text, p_from_seat int, p_src text, p_to text, p_to_seat int, p_dst text, p_amount numeric, p_at timestamptz)
 RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.cash_seat_move_receipts VALUES(public.u(p),public.u(p_user),NULL,public.u(p_club),public.u(p_from),p_from_seat,public.u(p_src),public.u(p_to),p_to_seat,
  public.u(p_dst),p_amount,jsonb_build_object('ok',true,'move_id',public.u(p),'player_id',public.u(p_user),'from_table_id',public.u(p_from),'to_table_id',public.u(p_to),
  'source_seat_number',p_from_seat,'to_seat_number',p_to_seat,'source_occupancy_id',public.u(p_src),'destination_occupancy_id',public.u(p_dst),'stack',p_amount,
  'idempotency_key','seatmove:'||public.u(p)::text),p_at,public.hx_frame(p_at)) $$;
-- a hand whose provenance was accepted without its manifest link
CREATE FUNCTION public.hx_unlinked_hand(p text, p_table text, p_number bigint, p_stacks jsonb, p_rake numeric, p_deal timestamptz, p_commit timestamptz,
 p_manifest boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE req jsonb; hash text; sr jsonb; atomic jsonb; x xid8:=public.hx_frame(p_commit); parts jsonb:='[]'; s jsonb; lin jsonb; occ uuid;
BEGIN
 req:=jsonb_build_object('bbj',0,'ref',NULL,'rake',p_rake,'units','[]'::jsonb,'inflow',0,'stacks',p_stacks,
  'hand_row',jsonb_build_object('actions',jsonb_build_array(jsonb_build_object('timestamp',(extract(epoch FROM p_deal)*1000)::bigint))),
  'table_id',public.u(p_table),'hand_number',p_number);
 hash:=encode(extensions.digest(convert_to(req::text,'UTF8'),'sha256'),'hex');
 sr:=jsonb_build_object('success',true,'mode','delta','tournament_id',NULL,'hand_id',public.u('s'||p),'request',req);
 atomic:=jsonb_build_object('table_id',public.u(p_table),'hand_number',p_number,'hand_id',public.u(p),'payload_hash',hash,'stack_result',sr,'committed_at',p_commit);
 INSERT INTO public.cash_hand_provenance_receipts(table_id,hand_number,hand_id,accepted_at,payload_hash,accepted_request,manifest_id,atomic_receipt,stack_claim,
  stack_settlement,version,status,game_scope,participants,signed_external_net,rake,bbj,all_players_included,funding_provenance_complete,issues,transaction_id)
 VALUES(public.u(p_table),p_number,public.u(p),p_commit+interval '50 ms',hash,req,NULL,atomic,
  jsonb_build_object('table_id',public.u(p_table),'hand_id',public.u('s'||p),'status','succeeded','completed_at',p_commit,'result',sr),
  jsonb_build_object('table_id',public.u(p_table),'hand_id',public.u('s'||p),'settlement_type','hand_stacks','state','final'),
  1,'uncertified',NULL,p_stacks,0,p_rake,0,false,false,'["original_dealt_manifest_missing"]',x);
 INSERT INTO public.union_pnl_cash_outcomes VALUES(public.u(p_table),p_number,public.u(p),x,p_commit,hash,'{}',
  jsonb_build_object('reason','accepted_cash_provenance_link_missing','status','blocked','accepted_bbj',0,'accepted_rake',p_rake,
   'basis_certified',false,'all_players_included',false,'accepted_external_net',0));
 IF p_manifest THEN
  FOR s IN SELECT value FROM jsonb_array_elements(p_stacks) LOOP
   occ:=(SELECT (e.after_row->>'occupancy_id')::uuid FROM public.union_pnl_inventory_events e WHERE e.source_name='table_seats'
     AND e.row_id=(s->>'seat_id')::uuid ORDER BY e.event_id DESC LIMIT 1);
   lin:=public.fn_cash_original_funding_lineage((s->>'user_id')::uuid,public.u(p_table),(s->>'seat_id')::uuid,occ,(s->>'seat_joined_at')::timestamptz,p_deal,false);
   parts:=parts||jsonb_build_array((s-'stack')||jsonb_build_object('occupancy_id',occ,'is_horse',true,'funding_lineage',lin,'funding_receipts',lin->'funding_receipts'));
  END LOOP;
  INSERT INTO public.cash_hand_participant_manifests VALUES(public.u('m'||p),public.u(p_table),p_number,p_deal,'engine',public.u('lease'),'[]',public.hx_scope(),parts,'[]',true);
 END IF;
END $$;
SELECT public.hx_event('tables',public.u(t),'2026-09-20 00:00+00',NULL,'INSERT',NULL,
 jsonb_build_object('id',public.u(t),'club_id',public.u('U'),'union_id',public.u('U'),'is_private',false,'tournament_id',NULL)) FROM (VALUES('TB1'),('TB2')) v(t);
SELECT public.hx_cash_in('p1in','TB1','up1','A','s1','occ1','2026-09-22 10:00+00',100,'2026-09-22 10:00+00');
SELECT public.hx_move('mv1','up1','A','TB1',1,'occ1','TB2',2,'occ2',100,'2026-09-22 10:30+00');
SELECT public.hx_event('table_seats',public.u('s2'),'2026-09-22 10:30+00',NULL,'UPDATE',NULL,public.hx_seat('s2','TB2','up1','A','2026-09-22 10:30+00','occ2',100));
SELECT public.hx_cash_in('p2in','TB2','up2','B','s3','occ3','2026-09-22 10:40+00',50,'2026-09-22 10:40+00');
SELECT public.hx_unlinked_hand('H','TB2',5000001,jsonb_build_array(
  jsonb_build_object('stack',110,'seat_id',public.u('s2'),'user_id',public.u('up1'),'stack_before',100,'seat_joined_at','2026-09-22T10:30:00+00:00'),
  jsonb_build_object('stack',39.5,'seat_id',public.u('s3'),'user_id',public.u('up2'),'stack_before',50,'seat_joined_at','2026-09-22T10:40:00+00:00')),
 0.5,'2026-09-22 11:00+00','2026-09-22 11:01+00',true);
SELECT public.hx_event('table_seats',public.u('s2'),'2026-09-22 11:05+00',NULL,'UPDATE',NULL,public.hx_seat('s2','TB2','up1','A','2026-09-22 10:30+00','occ2',110));
SELECT public.hx_event('table_seats',public.u('s3'),'2026-09-22 11:05+00',NULL,'UPDATE',NULL,public.hx_seat('s3','TB2','up2','B','2026-09-22 10:40+00','occ3',39.5));
SELECT public.hx_unlinked_hand('H2','TB2',5000002,jsonb_build_array(
  jsonb_build_object('stack',109,'seat_id',public.u('s2'),'user_id',public.u('up1'),'stack_before',110,'seat_joined_at','2026-09-22T10:30:00+00:00'),
  jsonb_build_object('stack',40.5,'seat_id',public.u('s3'),'user_id',public.u('up2'),'stack_before',39.5,'seat_joined_at','2026-09-22T10:40:00+00:00')),
 0,'2026-09-22 11:10+00','2026-09-22 11:11+00',false);
SELECT public.hx_cash_out('p1out','TB2','up1','A','s2','occ2','2026-09-22 10:30+00',109,'2026-09-22 12:00+00');
SELECT public.hx_cash_out('p2out','TB2','up2','B','s3','occ3','2026-09-22 10:40+00',40.5,'2026-09-22 12:01+00');
-- P2 queues an add-on of 7 (escrowed from the wallet, funding receipt pa1) that the
-- next hand's obligations return unapplied: its wallet credit is audited as
-- player_funding (the rake context of that transaction), and the application
-- receipt of the same transaction records the refund.
DO $$
DECLARE x xid8:=public.hx_frame('2026-09-22 11:20+00'); y xid8:=public.hx_frame('2026-09-22 11:21+00');
BEGIN
 INSERT INTO public.chip_ledger VALUES(public.u('lpa1'),'player_wallet',public.u('up2'),'table_stack',public.u('TB2'),7,'addon',public.u('B'),NULL,'2026-09-22 11:20+00','posted',nextval('public.hx_seq'),md5('pa1'));
 INSERT INTO public.cash_participant_funding_receipts(id,recorded_at,operation_kind,operation_key,user_id,table_id,seat_id,occupancy_id,seat_joined_at,source_ledger_id,
  account_type,account_entity_id,funding_club_id,funding_union_id,asset,unit_scale,amount,balance_before,balance_after,pending_addon_id,transaction_id)
 VALUES(public.u('rpa1'),'2026-09-22 11:20+00','addon','pa1',public.u('up2'),public.u('TB2'),public.u('s3'),public.u('occ3'),'2026-09-22 10:40+00',public.u('lpa1'),
  'player_wallet',public.u('up2'),public.u('B'),public.u('U'),'chips',2,7,960,953,public.u('pa1'),x);
 INSERT INTO public.union_pnl_original_flows VALUES(public.u('lpa1'),x,'2026-09-22 11:20+00',public.hx_scope(),jsonb_build_object('id',public.u('lpa1'),'status','posted',
  'club_id',public.u('B'),'to_type','table_stack','to_entity_id',public.u('TB2'),'from_type','player_wallet','from_entity_id',public.u('up2'),'amount',7,'category','addon',
  'table_id',public.u('TB2'),'created_at','2026-09-22 11:20+00'));
 INSERT INTO public.chip_ledger VALUES(public.u('lpr1'),'table_stack',public.u('TB2'),'player_wallet',public.u('up2'),7,'player_funding',public.u('B'),NULL,'2026-09-22 11:21+00','posted',nextval('public.hx_seq'),md5('pr1'));
 INSERT INTO public.union_pnl_original_flows VALUES(public.u('lpr1'),y,'2026-09-22 11:21+00',public.hx_scope(),jsonb_build_object('id',public.u('lpr1'),'status','posted',
  'club_id',public.u('B'),'to_type','player_wallet','to_entity_id',public.u('up2'),'from_type','table_stack','from_entity_id',public.u('TB2'),'amount',7,'category','player_funding',
  'table_id',public.u('TB2'),'settlement_id','rake:'||public.u('H2')::text,'created_at','2026-09-22 11:21+00'));
 INSERT INTO public.cash_funding_application_receipts VALUES(public.u('pa1'),public.u('rpa1'),'2026-09-22 11:21+00',public.u('occ3'),NULL,0,7,y);
END $$;
INSERT INTO public.accounting_payable_earning_sources VALUES('cash_rake_accrual',public.u('A'),public.u('U'),'2026-09-22 11:01+00',0.5);
-- satellites: us1 wins a seat in S, us2 an entry-only ticket in S2; both enter T_TGT
SELECT public.hx_t('S','U','COMPLETED','INSERT',15,0,NULL,NULL,false);
SELECT public.hx_t('S2','U','COMPLETED','INSERT',20,0,NULL,NULL,false);
SELECT public.hx_t('T_TGT','U','COMPLETED','INSERT',27,3,NULL,NULL,false);
SELECT public.hx_entry('rs1','sreg1','S','us1','A',15,public.hx_l('ls1','S','us1',true,15,'tournament_buyin','A','2026-09-23 08:00+00'),'2026-09-23 08:00+00');
SELECT public.hx_entry('rs2','sreg2','S2','us2','B',20,public.hx_l('ls2','S2','us2',true,20,'tournament_buyin','B','2026-09-23 08:05+00'),'2026-09-23 08:05+00');
INSERT INTO public.tournament_satellite_settlements VALUES(public.u('S'),public.u('T_TGT'),NULL,1,ARRAY[public.u('us1')],'2026-09-23 09:00+00',3),
 (public.u('S2'),public.u('T_TGT'),public.u('us2'),0,NULL,'2026-09-23 09:05+00',2);
INSERT INTO public.tournament_satellite_awards(tournament_id,place,user_id,delivery_kind,amount,registration_id,ticket_id,created_at)
 VALUES(public.u('S'),1,public.u('us1'),'seat',30,public.u('ts1'),NULL,'2026-09-23 09:00+00'),
 (public.u('S2'),1,public.u('us2'),'ticket',30,NULL,public.u('tk2'),'2026-09-23 09:05+00');
INSERT INTO public.tournament_tickets VALUES(public.u('tk2'),public.u('U'),public.u('us2'),30,'redeemed','2026-09-23 10:00+00','tournament_entry_only',
 public.u('T_TGT'),public.u('S2'),'2026-09-23 09:05+00');
SELECT public.hx_event('tournament_players',public.u(r),t,public.hx_frame(t),'INSERT',NULL,jsonb_build_object('id',public.u(r),'tournament_id',public.u('T_TGT'),
 'user_id',public.u(usr),'club_id',public.u(c),'registered_at',t,'source_satellite_id',public.u(s),'status','registered'))
 FROM (VALUES('ts1','us1','A','S','2026-09-23 09:00+00'::timestamptz),('ts2','us2','B','S2','2026-09-23 10:00+00')) v(r,usr,c,s,t);
SELECT public.hx_touch(r,'T_TGT','2026-09-24 12:00+00') FROM (VALUES('ts1'),('ts2')) v(r);
SELECT public.hx_award('as1','T_TGT','us1','ts1','A',50,'{}','2026-09-25 12:00+00');
