-- Anonymous literal shape qualification only. No captured user or hand data.
SET ROLE postgres; SET request.jwt.claim.role='service_role';SET request.jwt.claims='{"role":"service_role"}';
CREATE OR REPLACE FUNCTION cash_retirement_native.prepare_completed_shape(p_case integer) RETURNS jsonb LANGUAGE plpgsql AS $shape$
DECLARE n integer:=CASE p_case WHEN 5 THEN 5 WHEN 6 THEN 5 WHEN 7 THEN 4 WHEN 8 THEN 9 ELSE 6 END;h public.hand_atomic_commits;out_rows jsonb:='[]';missing integer:=CASE WHEN p_case IN(8,9) THEN 2 ELSE 1 END;
 tid uuid:=('89100000-0000-0000-0000-'||lpad(p_case::text,12,'0'))::uuid;
 gid uuid:=('89200000-0000-0000-0000-'||lpad(p_case::text,12,'0'))::uuid;
 mid uuid:=('89300000-0000-0000-0000-'||lpad(p_case::text,12,'0'))::uuid;
 sub uuid:=('89400000-0000-0000-0000-'||lpad(p_case::text,12,'0'))::uuid;
 fc uuid:=('89500000-0000-0000-0000-'||lpad(p_case::text,12,'0'))::uuid;
 club uuid:=('88700000-0000-0000-0000-'||lpad(p_case::text,12,'0'))::uuid;
 oldgen uuid:='86500000-0000-0000-0000-000000000001';newgen uuid:='86500000-0000-0000-0000-000000000002';
 i integer;uid uuid;sid uuid;occ uuid;fid uuid;foreign_uid uuid;joined timestamptz;
 b numeric;a numeric;fee numeric:=CASE p_case WHEN 5 THEN .4 WHEN 6 THEN 2 WHEN 7 THEN 1.4 ELSE 5 END;
 bbj numeric:=CASE WHEN p_case>=8 THEN .5 ELSE 0 END;loss numeric:=CASE p_case WHEN 5 THEN .2 WHEN 6 THEN 9 WHEN 7 THEN -6 WHEN 8 THEN 0 ELSE -195 END;
 stacks jsonb:='[]';banks jsonb:='[]';players jsonb:='[]';manifest jsonb:='[]';expected jsonb:='[]';
 contrib jsonb:='{}';promos jsonb:='[]';mp jsonb;item jsonb;before_row jsonb;q jsonb;r jsonb;stack_item jsonb;bank_item jsonb;
 base numeric:=0;target numeric:=0;mint_before numeric;currency_before numeric;currency_after numeric;fees_after numeric;
 foreign_before jsonb;foreign_after jsonb;
BEGIN
 PERFORM set_config('session_replication_role','replica',true);
 INSERT INTO public.ca_bbj_policy(id,pivot_threshold,standard_main,standard_backup,pivot_main,pivot_backup,note)
 VALUES(1,100000,.5,.25,.25,.25,'Maintained non-user BBJ policy source') ON CONFLICT(id) DO NOTHING;
 INSERT INTO public.clubs(id,name,owner_id,chip_treasury)VALUES(club,'Anonymous table club '||p_case,'10000000-0000-0000-0000-000000000001',1000);
 INSERT INTO public.clubs(id,name,owner_id,chip_treasury) VALUES(fc,'Anonymous Funding '||p_case,'10000000-0000-0000-0000-000000000001',1000);
 INSERT INTO public.cash_games(id,club_id,name,template_name,variant,sb,bb,handedness,ruleset_snapshot)
 VALUES(gid,club,'Anonymous Cash '||p_case,'classic','nlh',1,2,n,'{}');
 INSERT INTO public.tables(id,name,tournament_id,game_type,game_variant,status,lifecycle,club_id,small_blind,big_blind,cluster_id,seat_game_scope,seat_admission_key)
 VALUES(tid,'Anonymous Cash '||p_case,NULL,'cash','nlh','running','live',club,1,2,gid,'cluster:'||gid,'cash');
 FOR i IN 1..n LOOP
  uid:=('89600000-0000-0000-0000-'||lpad((p_case*100+i)::text,12,'0'))::uuid;
  sid:=('89700000-0000-0000-0000-'||lpad((p_case*100+i)::text,12,'0'))::uuid;
  occ:=('89800000-0000-0000-0000-'||lpad((p_case*100+i)::text,12,'0'))::uuid;
  fid:=('89900000-0000-0000-0000-'||lpad((p_case*100+i)::text,12,'0'))::uuid;
  joined:='2026-09-08 12:00Z'::timestamptz+make_interval(secs=>i);
  b:=CASE WHEN i<=missing THEN CASE p_case WHEN 5 THEN 25 WHEN 6 THEN 100 WHEN 7 THEN 60 WHEN 8 THEN CASE i WHEN 1 THEN 280 ELSE 210 END ELSE CASE i WHEN 1 THEN 450 ELSE 170 END END ELSE 300 END;
  a:=CASE WHEN i=1 THEN b-loss WHEN i=n THEN b+loss-fee-bbj ELSE b END;
  INSERT INTO auth.users(id)VALUES(uid);INSERT INTO public.users(id,username)VALUES(uid,'anonymous_cash_'||p_case||'_'||i);
  INSERT INTO public.profiles(id,username,display_name)VALUES(uid,'anonymous_cash_'||p_case||'_'||i,'Anonymous Native Participant');
  INSERT INTO public.club_members(club_id,user_id,role,status,is_active,chip_balance)VALUES(fc,uid,'player','approved',true,10000-b);
  IF fc<>club THEN INSERT INTO public.club_members(club_id,user_id,role,status,is_active,chip_balance)VALUES(club,uid,'player','approved',true,0);END IF;
  INSERT INTO public.table_seats SELECT(jsonb_populate_record(NULL::public.table_seats,to_jsonb(s)||jsonb_build_object('id',sid,'table_id',tid,'user_id',uid,'seat_number',i,'stack',b,'occupancy_id',occ,'joined_at',joined,'club_id',fc,'active_game_scope','cluster:'||gid,'active_parent_key','cash'))).* FROM public.table_seats s WHERE id='86300000-0000-0000-0000-000000000001';
  INSERT INTO public.chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,table_id)
  VALUES(fid,'player_wallet',uid,'table_stack',tid,b,'buyin',fc,tid);
  INSERT INTO public.wallet_transactions(id,user_id,wallet_type,amount,type,category,balance_after,table_id)VALUES(fid,uid,'PLAYER',b,'debit','buyin',10000-b,tid);
  INSERT INTO public.cash_participant_funding_receipts(id,operation_kind,user_id,table_id,seat_id,occupancy_id,seat_joined_at,source_ledger_id,wallet_transaction_id,account_type,account_entity_id,funding_club_id,asset,amount,balance_before,balance_after)
  VALUES(fid,'buyin',uid,tid,sid,occ,joined,fid,fid,'player_wallet',uid,fc,'chips',b,10000,10000-b);
  stack_item:=jsonb_build_object('seat_id',sid,'user_id',uid,'seat_joined_at',joined,'occupancy_id',occ,'funding_manifest_id',mid,'funding_stack_before',b,'stack_before',b,'stack',a);
  bank_item:=jsonb_build_object('seat_id',sid,'user_id',uid,'seat_joined_at',joined,'occupancy_id',occ,'funding_manifest_id',mid,'funding_stack_before',b,'uses_remaining',2,'seconds_remaining',19);
  stacks:=stacks||jsonb_build_array(stack_item);banks:=banks||jsonb_build_array(bank_item);players:=players||jsonb_build_array(jsonb_build_object('user_id',uid,'stack',a));
  contrib:=contrib||jsonb_build_object(uid::text,100);promos:=promos||jsonb_build_array(jsonb_build_object('user_id',uid,'club_id',club,'wagered',100));
  mp:=jsonb_build_object('seat_id',sid,'user_id',uid,'is_horse',false,'occupancy_id',occ,'stack_before',b,'seat_joined_at',joined,'funding_receipts',jsonb_build_array(jsonb_build_object('id',fid,'account_type','player_wallet','account_entity_id',uid,'funding_club_id',fc)),'funding_lineage',jsonb_build_object('version',1,'issues','[]'::jsonb,'moves','[]'::jsonb));
  manifest:=manifest||jsonb_build_array(mp);
  IF i<=missing THEN
   SELECT jsonb_build_object('id',s.id,'stack',s.stack,'club_id',s.club_id,'left_at','2026-10-06T15:33:04+00:00','user_id',s.user_id,'table_id',s.table_id,'joined_at',s.joined_at,'occupancy_id',s.occupancy_id) INTO before_row FROM public.table_seats s WHERE id=sid;
   item:=jsonb_build_object('stack',stack_item,'manifest_participant',mp,'inventory_event_id',99000000+p_case*100+i,'inventory_before',before_row,'funding_club_id',fc,'time_bank',bank_item);
   expected:=expected||jsonb_build_array(item);base:=base+b;target:=target+a;
  END IF;
 END LOOP;
 q:=cash_retirement_native.submission_request()||jsonb_build_object('p_table_id',tid,'p_hand_number',8900000+p_case,'p_stacks',stacks,'p_rake',fee,'p_bbj',bbj,'p_ref','anonymous-additional-five-shape-'||p_case);
 q:=jsonb_set(q,'{p_hand_row}',cash_retirement_native.atomic_hand_row()||jsonb_build_object('id',sub,'table_id',tid,'tournament_id',NULL,'hand_number',8900000+p_case,'pot_size',n*100,'rake_amount',fee,'bbj_amount',bbj,'players',players,'started_at','2026-09-08T12:00:15+00:00','ended_at','2026-09-08T12:00:16+00:00','_accepted_post_commit_facts',jsonb_build_object('contributions',contrib,'returned_uncalled','{}'::jsonb,'insurance','[]'::jsonb)));
 q:=jsonb_set(q,'{p_post_commit_obligations}',cash_retirement_native.atomic_hand_obligations()||jsonb_build_object('time_banks',banks,'promo_playthrough',promos,'pending_addons',jsonb_build_object('enabled',true,'max_buy_in',200),'rake',CASE WHEN fee>0 THEN jsonb_build_object('amount',fee,'bbj',bbj,'pot',n*100,'num_players',n,'club_id',club,'method','WEIGHTED_CONTRIBUTED','contributions',contrib,'returned_uncalled','{}'::jsonb,'tournament_id',NULL) ELSE 'null'::jsonb END,'bbj_contribution',CASE WHEN bbj>0 THEN jsonb_build_object('amount',bbj,'club_id',club,'big_blind',2) ELSE 'null'::jsonb END));
 INSERT INTO public.cash_hand_participant_manifests(id,table_id,hand_number,lease_instance_id,lease_generation,request,game_scope,participants,issues,funding_provenance_complete)
 VALUES(mid,tid,8900000+p_case,'atomic-hand-boundary-probe',oldgen,'[]','{}',manifest,'[]',true);
 PERFORM set_config('session_replication_role','origin',true);
 INSERT INTO public.engine_table_leases(table_id,instance_id,lease_generation,protocol_version,heartbeat_at)VALUES(tid,'atomic-hand-boundary-probe',oldgen,2,clock_timestamp());
 INSERT INTO public.hand_state_snapshots(table_id,hand_number,state_json,config_json,dealer_seat,players_json,stage)VALUES(tid,8900000+p_case,'{"stage":"river"}','{}',1,'[]','river');
 r:=public.fn_ca_retain_hand_submission(q);IF r->>'retained' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'ANONYMOUS_RETENTION_REFUSED %',r;END IF;

 PERFORM set_config('session_replication_role','replica',true);
 FOR item IN SELECT value FROM jsonb_array_elements(expected)LOOP
  UPDATE public.table_seats SET left_at='2026-10-06 15:33:04Z',status='left',active_game_scope=NULL,active_parent_key=NULL WHERE id=(item#>>'{stack,seat_id}')::uuid;
 END LOOP;
 PERFORM set_config('session_replication_role','origin',true);
 r:=public.fn_ca_commit_hand_settlement(tid,8900000+p_case,q->'p_stacks',fee,bbj,q->>'p_ref',0,q->'p_hand_row',q->'p_units','atomic-hand-boundary-probe',oldgen,q->'p_post_commit_obligations');
 IF r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'ANONYMOUS_COMPLETED_NATIVE_REFUSED %',r;END IF;
 r:=smarter_private.acknowledge_hand_submission(sub,r);
 r:=public.fn_ca_process_hand_post_commit_obligations(sub);
 IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'ANONYMOUS_COMPLETED_POSTCOMMIT_REFUSED %',r;END IF;
 SELECT * INTO h FROM public.hand_atomic_commits WHERE table_id=tid AND hand_number=8900000+p_case;
 PERFORM set_config('session_replication_role','replica',true);
 FOR item IN SELECT value FROM jsonb_array_elements(expected)LOOP
  uid:=(item#>>'{stack,user_id}')::uuid;sid:=(item#>>'{stack,seat_id}')::uuid;
  INSERT INTO smarter_private.patterned_identity_retirements(old_id,cohort,retired_at)VALUES(uid,'horse','2026-10-06 15:40Z');
  IF NOT(p_case=8 AND uid::text LIKE '%802')THEN
   INSERT INTO public.union_pnl_inventory_events(event_id,source_name,row_id,observed_at,transaction_id,operation,before_row,after_row)OVERRIDING SYSTEM VALUE
   VALUES((item->>'inventory_event_id')::bigint,'table_seats',sid,'2026-10-06 15:33:22Z',pg_current_xact_id(),CASE WHEN p_case=7 THEN 'UPDATE' ELSE 'DELETE' END,item->'inventory_before',CASE WHEN p_case=7 THEN item->'inventory_before'||jsonb_build_object('user_id',replace(sid::text,'89700000','89000000'),'occupancy_id',replace(sid::text,'89700000','89000000'),'left_at',NULL,'stack',77,'joined_at','2026-10-06T15:33:22+00:00') ELSE NULL END);
   IF p_case=7 THEN
    foreign_uid:=replace(sid::text,'89700000','89000000')::uuid;
    INSERT INTO auth.users(id)VALUES(foreign_uid);INSERT INTO public.users(id,username)VALUES(foreign_uid,'completed_foreign');INSERT INTO public.profiles(id,username)VALUES(foreign_uid,'completed_foreign');
    UPDATE public.table_seats SET user_id=foreign_uid,occupancy_id=foreign_uid,stack=77,joined_at='2026-10-06 15:33:22Z',left_at=NULL,status='active',active_game_scope='cluster:'||gid,active_parent_key='cash' WHERE id=sid;
   ELSE DELETE FROM public.table_seats WHERE id=sid;END IF;
  END IF;
  out_rows:=out_rows||jsonb_build_array(jsonb_build_object('seat',sid,'occupancy',item#>>'{stack,occupancy_id}','user',uid,'table',tid,'base',item#>'{stack,stack_before}','submission',sub,'hand',8900000+p_case,'stack',item->'stack',
   'hashes',jsonb_build_object('request_hash',(SELECT request_hash FROM smarter_private.hand_submissions WHERE submission_id=sub),'stack_md5',md5(h.stack_result::text),'post_md5',md5(h.post_commit_result::text),'payload_hash',h.payload_hash,'hand_id',h.stack_result->>'hand_id'),
   'manifest_participant',item->'manifest_participant','manifest_complete',true,'manifest_issues','[]'::jsonb,'inventory_event_id',item->'inventory_event_id','inventory_before',item->'inventory_before','retained_seat',(p_case=8 AND uid::text LIKE '%802'),'funding_club',fc,
   'departed',(SELECT jsonb_agg(x) FROM jsonb_array_elements(h.stack_result->'departed')x WHERE x->>'user_id'=uid::text),
   'key',(SELECT to_jsonb(w)FROM public.wallet_credit_idempotency w WHERE w.key='late_seat_settle:'||(h.stack_result->>'hand_id')||':'||uid::text),
   'ledger',(SELECT jsonb_agg(to_jsonb(l))FROM public.chip_ledger l WHERE l.idempotency_key='late_seat_settle:'||(h.stack_result->>'hand_id')||':'||uid::text)));
 END LOOP;
 PERFORM set_config('session_replication_role','origin',true);
 RETURN out_rows;
END $shape$;
