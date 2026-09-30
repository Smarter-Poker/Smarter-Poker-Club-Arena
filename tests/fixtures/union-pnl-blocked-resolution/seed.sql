-- Scenario builder. One table = one race: an accepted previous hand, a direct
-- add-on receipt committed just before the next hand's manifest, the blocked
-- hand, and the occupancy's following hand. Shapes copied from production
-- rows (table 0756dae6 hand 15560751: dealt 75.10, add-on 147.90 committed
-- 34ms before the manifest, next hand dealt 223.00 + its own result).
CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_cash_outcomes
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
INSERT INTO public.union_pnl_weekly_capture VALUES(true,'2026-09-01 00:00:00+00',1);

CREATE FUNCTION pg_temp.seed_race(p_table uuid, p_hn bigint, p_t0 timestamptz, p_prev_after numeric, p_dealt numeric,
  p_late numeric, p_late_kind text, p_result numeric, p_next_before numeric, p_extra_issue text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u1 uuid:=md5(p_table::text||'u1')::uuid; u2 uuid:=md5(p_table::text||'u2')::uuid;
 o1 uuid:=md5(p_table::text||'o1')::uuid; o2 uuid:=md5(p_table::text||'o2')::uuid;
 s1 uuid:=md5(p_table::text||'s1')::uuid; s2 uuid:=md5(p_table::text||'s2')::uuid;
 club uuid:='c1000000-0000-0000-0000-000000000001'; un uuid:='fade0000-0000-0000-0000-000000000001';
 g jsonb; j timestamptz:=p_t0-interval '10 minutes'; mp uuid:=md5(p_table::text||'mp')::uuid; mh uuid:=md5(p_table::text||'mh')::uuid;
 mn uuid:=md5(p_table::text||'mn')::uuid; issue jsonb; ev jsonb; rec record; hid uuid:=md5(p_table::text||'h')::uuid;
BEGIN
 g:=jsonb_build_object('asset','chips','is_private',false,'unit_scale',2,'host_club_id',club,'game_union_id',un,'tournament_id',NULL);
 -- funding: buy-ins at join, then the late credit just before the manifest
 FOR rec IN SELECT * FROM (VALUES (u1,o1,s1,170::numeric,'buyin',j+interval '1 second','l1'),(u2,o2,s2,100::numeric,'buyin',j+interval '1 second','l2'),
   (u1,o1,s1,p_late,p_late_kind,p_t0-interval '35 milliseconds','l3')) v(u,o,s,amt,kind,at,tag) LOOP
  INSERT INTO public.chip_ledger VALUES(md5(p_table::text||rec.tag)::uuid,CASE WHEN rec.kind='horse_funding' THEN 'club_treasury' ELSE 'player_wallet' END,
   rec.u,'table_stack',p_table,rec.amt,rec.kind,club,'posted');
  INSERT INTO public.cash_participant_funding_receipts(id,recorded_at,operation_kind,user_id,table_id,seat_id,occupancy_id,seat_joined_at,
   source_ledger_id,funding_club_id,funding_union_id,asset,unit_scale,amount,transaction_id)
  VALUES(md5(p_table::text||rec.tag||'r')::uuid,rec.at,rec.kind,rec.u,p_table,rec.s,rec.o,j,md5(p_table::text||rec.tag)::uuid,club,un,'chips',2,rec.amt,'1'::xid8);
 END LOOP;
 -- previous accepted hand (ready)
 INSERT INTO public.cash_hand_participant_manifests VALUES(mp,p_table,p_hn-1,p_t0-interval '40 seconds','i',gen_random_uuid(),'[]',g,
  jsonb_build_array(jsonb_build_object('user_id',u1,'occupancy_id',o1,'seat_id',s1,'seat_joined_at',j,'stack_before',170),
                    jsonb_build_object('user_id',u2,'occupancy_id',o2,'seat_id',s2,'seat_joined_at',j,'stack_before',100)),'[]',true);
 INSERT INTO public.cash_hand_provenance_receipts(table_id,hand_number,hand_id,accepted_at,payload_hash,manifest_id,status,game_scope,participants,
  all_players_included,funding_provenance_complete,issues,transaction_id)
 VALUES(p_table,p_hn-1,md5(p_table::text||'hp')::uuid,p_t0-interval '30 seconds','hp',mp,'captured',g,
  jsonb_build_array(jsonb_build_object('user_id',u1,'occupancy_id',o1,'stack_before',170,'stack_after',p_prev_after),
                    jsonb_build_object('user_id',u2,'occupancy_id',o2,'stack_before',100,'stack_after',270-p_prev_after)),true,true,'[]','1'::xid8);
 INSERT INTO public.union_pnl_cash_outcomes VALUES(p_table,p_hn-1,md5(p_table::text||'hp')::uuid,'1'::xid8,p_t0-interval '30 seconds','hp',g,
  jsonb_build_object('status','ready','basis_certified',true,'all_players_included',true,'game_scope',g,'issues','[]'::jsonb,'accepted_rake',0,
   'participants',jsonb_build_array(jsonb_build_object('user_id',u1,'earning_club_id',club,'ownership_certified',true,'observed_stack_delta',p_prev_after-170),
     jsonb_build_object('user_id',u2,'earning_club_id',club,'ownership_certified',true,'observed_stack_delta',170-p_prev_after))));
 -- the hand dealt from the stale roster
 issue:=jsonb_build_array(jsonb_build_object('reason','original_seat_or_starting_stack_unproven','user_id',u1));
 INSERT INTO public.cash_hand_participant_manifests VALUES(mh,p_table,p_hn,p_t0,'i',gen_random_uuid(),'[]',g,
  jsonb_build_array(jsonb_build_object('user_id',u1,'occupancy_id',o1,'seat_id',s1,'seat_joined_at',j,'stack_before',p_dealt),
                    jsonb_build_object('user_id',u2,'occupancy_id',o2,'seat_id',s2,'seat_joined_at',j,'stack_before',270-p_prev_after)),issue,false);
 INSERT INTO public.cash_hand_provenance_receipts(table_id,hand_number,hand_id,accepted_at,payload_hash,manifest_id,status,game_scope,participants,
  all_players_included,funding_provenance_complete,issues,transaction_id)
 VALUES(p_table,p_hn,hid,p_t0+interval '10 seconds','hh',mh,'uncertified',g,
  jsonb_build_array(jsonb_build_object('user_id',u1,'occupancy_id',o1,'stack_before',p_dealt,'stack_after',p_dealt+p_result),
                    jsonb_build_object('user_id',u2,'occupancy_id',o2,'stack_before',270-p_prev_after,'stack_after',270-p_prev_after-p_result)),
  true,false,issue,'1'::xid8);
 ev:=jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',true,'game_scope',g,'hand_id',hid,
  'scope','single_accepted_cash_hand','accepted_rake',0,
  'issues',jsonb_build_array('original_cash_funding_incomplete',issue->0)||CASE WHEN p_extra_issue IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_extra_issue) END,
  'participants',jsonb_build_array(jsonb_build_object('user_id',u1,'earning_club_id',club,'ownership_certified',true,'observed_stack_delta',p_result),
     jsonb_build_object('user_id',u2,'earning_club_id',club,'ownership_certified',true,'observed_stack_delta',-p_result)));
 INSERT INTO public.union_pnl_cash_outcomes VALUES(p_table,p_hn,hid,'1'::xid8,p_t0+interval '10 seconds','hh',g,ev);
 -- the occupancy's next dealt hand
 INSERT INTO public.cash_hand_participant_manifests VALUES(mn,p_table,p_hn+1,p_t0+interval '20 seconds','i',gen_random_uuid(),'[]',g,
  jsonb_build_array(jsonb_build_object('user_id',u1,'occupancy_id',o1,'seat_id',s1,'seat_joined_at',j,'stack_before',p_next_before),
                    jsonb_build_object('user_id',u2,'occupancy_id',o2,'seat_id',s2,'seat_joined_at',j,'stack_before',270-p_prev_after-p_result)),'[]',true);
END $$;
