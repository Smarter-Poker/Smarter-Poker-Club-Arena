-- Anonymous literal shape qualification only. No captured user or hand data.
SET ROLE postgres; SET request.jwt.claim.role='service_role';SET request.jwt.claims='{"role":"service_role"}';
CREATE OR REPLACE FUNCTION cash_retirement_native.anonymous_shape(p_case integer) RETURNS jsonb LANGUAGE plpgsql AS $shape$
DECLARE n integer:=CASE WHEN p_case=4 THEN 9 ELSE 6 END;missing integer:=CASE WHEN p_case=4 THEN 2 ELSE 1 END;
 tid uuid:=('89100000-0000-0000-0000-'||lpad(p_case::text,12,'0'))::uuid;
 gid uuid:=('89200000-0000-0000-0000-'||lpad(p_case::text,12,'0'))::uuid;
 mid uuid:=('89300000-0000-0000-0000-'||lpad(p_case::text,12,'0'))::uuid;
 sub uuid:=('89400000-0000-0000-0000-'||lpad(p_case::text,12,'0'))::uuid;
 fc uuid:=('89500000-0000-0000-0000-'||lpad(p_case::text,12,'0'))::uuid;
 club uuid:='89800000-0000-0000-0000-000000000001';
 oldgen uuid:='86500000-0000-0000-0000-000000000001';newgen uuid:='86500000-0000-0000-0000-000000000002';
 i integer;uid uuid;sid uuid;occ uuid;fid uuid;foreign_uid uuid;joined timestamptz;
 b numeric;a numeric;fee numeric:=CASE WHEN p_case=1 THEN 2.5 WHEN p_case=3 THEN 5 ELSE 0 END;
 bbj numeric:=CASE WHEN p_case=3 THEN .5 ELSE 0 END;loss numeric:=CASE WHEN p_case=1 THEN 1 WHEN p_case=3 THEN 6 ELSE 0 END;
 stacks jsonb:='[]';banks jsonb:='[]';players jsonb:='[]';manifest jsonb:='[]';expected jsonb:='[]';
 contrib jsonb:='{}';promos jsonb:='[]';mp jsonb;item jsonb;before_row jsonb;q jsonb;r jsonb;stack_item jsonb;bank_item jsonb;
 base numeric:=0;target numeric:=0;mint_before numeric;currency_before numeric;currency_after numeric;fees_after numeric;
 foreign_before jsonb;foreign_after jsonb;
BEGIN
 PERFORM set_config('session_replication_role','replica',true);
 INSERT INTO public.ca_bbj_policy(id,pivot_threshold,standard_main,standard_backup,pivot_main,pivot_backup,note)
 VALUES(1,100000,.5,.25,.25,.25,'Maintained non-user BBJ policy source') ON CONFLICT(id) DO NOTHING;
 INSERT INTO public.clubs(id,name,owner_id,chip_treasury) VALUES(fc,'Anonymous Funding '||p_case,'10000000-0000-0000-0000-000000000001',1000);
 INSERT INTO public.cash_games(id,club_id,name,template_name,variant,sb,bb,handedness,ruleset_snapshot)
 VALUES(gid,club,'Anonymous Cash '||p_case,'classic','nlh',1,2,n,'{}');
 INSERT INTO public.tables(id,name,tournament_id,game_type,game_variant,status,lifecycle,club_id,small_blind,big_blind,cluster_id,seat_game_scope,seat_admission_key)
 VALUES(tid,'Anonymous Cash '||p_case,NULL,'cash','nlh','running','live',club,1,2,gid,'cluster:'||gid,'cash');
 INSERT INTO public.unions(id,name,owner_id,slug,chip_balance,rake_wallet,bbj_wallet,promo_wallet,total_rake) VALUES('89800000-0000-0000-0000-000000000001','Anonymous Union','10000000-0000-0000-0000-000000000001','anonymous-cash-union',0,0,0,0,0) ON CONFLICT(id) DO NOTHING;
 INSERT INTO public.clubs(id,name,is_union,owner_id,chip_treasury) VALUES('89800000-0000-0000-0000-000000000001','Anonymous Union',true,'10000000-0000-0000-0000-000000000001',1000) ON CONFLICT(id) DO NOTHING;
 UPDATE public.clubs SET union_id='89800000-0000-0000-0000-000000000001' WHERE id IN(fc,club);
 UPDATE public.tables SET is_private=false,union_id='89800000-0000-0000-0000-000000000001' WHERE id=tid;
 FOR i IN 1..n LOOP
  uid:=('89600000-0000-0000-0000-'||lpad((p_case*100+i)::text,12,'0'))::uuid;
  sid:=('89700000-0000-0000-0000-'||lpad((p_case*100+i)::text,12,'0'))::uuid;
  occ:=('89800000-0000-0000-0000-'||lpad((p_case*100+i)::text,12,'0'))::uuid;
  fid:=('89900000-0000-0000-0000-'||lpad((p_case*100+i)::text,12,'0'))::uuid;
  joined:='2026-09-08 12:00Z'::timestamptz+make_interval(secs=>i);
  b:=CASE WHEN i<=missing THEN CASE p_case WHEN 1 THEN 81.10 WHEN 2 THEN 490.75 WHEN 3 THEN 640.25 ELSE CASE i WHEN 1 THEN 180.30 ELSE 120.65 END END ELSE 100 END;
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
  contrib:=contrib||jsonb_build_object(uid::text,10);promos:=promos||jsonb_build_array(jsonb_build_object('user_id',uid,'club_id',club,'wagered',10));
  mp:=jsonb_build_object('seat_id',sid,'user_id',uid,'is_horse',true,'occupancy_id',occ,'stack_before',b,'seat_joined_at',joined,'funding_receipts',jsonb_build_array(jsonb_build_object('id',fid,'account_type','player_wallet','account_entity_id',uid,'funding_club_id',fc)),'funding_lineage',jsonb_build_object('version',1,'issues','[]'::jsonb,'moves','[]'::jsonb));
  manifest:=manifest||jsonb_build_array(mp);
  IF i<=missing THEN
   SELECT to_jsonb(s)||jsonb_build_object('left_at','2026-10-06T15:33:04+00:00') INTO before_row FROM public.table_seats s WHERE id=sid;
   item:=jsonb_build_object('stack',stack_item,'manifest_participant',mp,'inventory_event_id',99000000+p_case*100+i,'inventory_before',before_row,'funding_club_id',fc,'time_bank',bank_item);
   expected:=expected||jsonb_build_array(item);base:=base+b;target:=target+a;
  END IF;
 END LOOP;
 q:=cash_retirement_native.submission_request()||jsonb_build_object('p_table_id',tid,'p_hand_number',8900000+p_case,'p_stacks',stacks,'p_rake',fee,'p_bbj',bbj,'p_ref','anonymous-four-shape-'||p_case);
 q:=jsonb_set(q,'{p_hand_row}',cash_retirement_native.atomic_hand_row()||jsonb_build_object('id',sub,'table_id',tid,'tournament_id',NULL,'hand_number',8900000+p_case,'pot_size',n*10,'rake_amount',fee,'bbj_amount',bbj,'players',players,'started_at','2026-09-08T12:00:15+00:00','ended_at','2026-09-08T12:00:16+00:00','_accepted_post_commit_facts',jsonb_build_object('contributions',contrib,'returned_uncalled','{}'::jsonb,'insurance','[]'::jsonb)));
 q:=jsonb_set(q,'{p_post_commit_obligations}',cash_retirement_native.atomic_hand_obligations()||jsonb_build_object('time_banks',banks,'promo_playthrough',promos,'pending_addons',jsonb_build_object('enabled',true,'max_buy_in',200),'rake',CASE WHEN fee>0 THEN jsonb_build_object('amount',fee,'bbj',bbj,'pot',n*10,'num_players',n,'club_id',club,'method','WEIGHTED_CONTRIBUTED','contributions',contrib,'returned_uncalled','{}'::jsonb,'tournament_id',NULL) ELSE 'null'::jsonb END,'bbj_contribution',CASE WHEN bbj>0 THEN jsonb_build_object('amount',bbj,'club_id',club,'big_blind',2) ELSE 'null'::jsonb END));
 INSERT INTO public.cash_hand_participant_manifests(id,table_id,hand_number,lease_instance_id,lease_generation,request,game_scope,participants,issues,funding_provenance_complete)
 VALUES(mid,tid,8900000+p_case,'atomic-hand-boundary-probe',oldgen,'[]','{}',manifest,'[]',true);
 PERFORM set_config('session_replication_role','origin',true);
 INSERT INTO public.engine_table_leases(table_id,instance_id,lease_generation,protocol_version,heartbeat_at)VALUES(tid,'atomic-hand-boundary-probe',oldgen,2,clock_timestamp());
 INSERT INTO public.hand_state_snapshots(table_id,hand_number,state_json,config_json,dealer_seat,players_json,stage)VALUES(tid,8900000+p_case,'{"stage":"river"}','{}',1,'[]','river');
 r:=public.fn_ca_retain_hand_submission(q);IF r->>'retained' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'ANONYMOUS_RETENTION_REFUSED %',r;END IF;
 PERFORM set_config('session_replication_role','replica',true);
 FOR item IN SELECT value FROM jsonb_array_elements(expected) LOOP
  uid:=(item#>>'{stack,user_id}')::uuid;sid:=(item#>>'{stack,seat_id}')::uuid;
  INSERT INTO public.union_pnl_inventory_events(event_id,source_name,row_id,observed_at,transaction_id,operation,before_row,after_row)OVERRIDING SYSTEM VALUE
  VALUES((item->>'inventory_event_id')::bigint,'table_seats',sid,'2026-10-06 15:33:22Z',pg_current_xact_id(),CASE WHEN p_case<=2 THEN 'DELETE' ELSE 'UPDATE' END,item->'inventory_before',CASE WHEN p_case<=2 THEN NULL ELSE item->'inventory_before'||jsonb_build_object('user_id',replace(sid::text,'89700000','89000000'),'occupancy_id',replace(sid::text,'89700000','89000000'),'stack',77,'left_at',NULL,'joined_at','2026-10-06T15:33:22+00:00') END);
  INSERT INTO smarter_private.patterned_identity_retirements(old_id,cohort,retired_at)VALUES(uid,'horse','2026-10-06 15:40Z');
  IF p_case<=2 THEN DELETE FROM public.table_seats WHERE id=sid;
  ELSE
   foreign_uid:=replace(sid::text,'89700000','89000000')::uuid;
   INSERT INTO auth.users(id)VALUES(foreign_uid);INSERT INTO public.users(id,username)VALUES(foreign_uid,'anonymous_foreign_'||p_case||'_'||right(sid::text,3));INSERT INTO public.profiles(id,username)VALUES(foreign_uid,'anonymous_foreign_'||p_case||'_'||right(sid::text,3));
   UPDATE public.table_seats SET user_id=foreign_uid,occupancy_id=foreign_uid,stack=77,joined_at='2026-10-06 15:33:22Z' WHERE id=sid;
  END IF;
 END LOOP;
 INSERT INTO smarter_private.retired_cash_hand_qualification(submission_id,request_hash,table_id,hand_number,expected)
 SELECT sub,request_hash,tid,8900000+p_case,jsonb_build_object('participants',expected) FROM smarter_private.hand_submissions WHERE submission_id=sub;
 PERFORM set_config('session_replication_role','origin',true);
 UPDATE public.engine_table_leases SET instance_id='successor-one',lease_generation=newgen,heartbeat_at=clock_timestamp() WHERE table_id=tid;
 SELECT coalesce(sum(amount),0) INTO mint_before FROM public.ca_mint_ledger WHERE asset='chips';
 SELECT coalesce((SELECT sum(chip_balance) FROM public.club_members),0)+coalesce((SELECT sum(stack) FROM public.table_seats WHERE left_at IS NULL),0) INTO currency_before;
 SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]') INTO foreign_before FROM public.table_seats s WHERE s.table_id=tid AND s.user_id::text LIKE '89000000%';
 IF p_case=4 THEN UPDATE public.tables SET lifecycle='breaking' WHERE id=tid; END IF;
 r:=public.fn_ca_resume_hand_submission(tid,'successor-one',newgen);
 IF r->>'completed' IS DISTINCT FROM 'true' OR r->>'post_commit_completed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'ANONYMOUS_NATIVE_SHAPE_FAILED %: %',p_case,r;END IF;
 IF (SELECT count(*) FROM smarter_private.retired_cash_hand_custody WHERE submission_id=sub AND state='consumed' AND accepted_time_bank=original_time_bank)<>missing
 OR(SELECT coalesce(sum(amount),0) FROM public.ca_mint_ledger WHERE asset='chips')-mint_before<>base
 OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=tid AND hand_number=8900000+p_case AND stack_result->>'conservation_checked'='true')
 THEN RAISE EXCEPTION 'ANONYMOUS_NATIVE_CUSTODY_OR_MINT_FAILED %',p_case;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(expected)LOOP
  IF(SELECT chip_balance FROM public.club_members WHERE club_id=fc AND user_id=(item#>>'{stack,user_id}')::uuid)<>10000-(item#>>'{stack,stack_before}')::numeric+(item#>>'{stack,stack}')::numeric THEN RAISE EXCEPTION 'ANONYMOUS_FUNDING_WALLET_FAILED %',item;END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]') INTO foreign_after FROM public.table_seats s WHERE s.table_id=tid AND s.user_id::text LIKE '89000000%';
 IF foreign_before IS DISTINCT FROM foreign_after THEN RAISE EXCEPTION 'ANONYMOUS_FOREIGN_CHAIR_CHANGED';END IF;
 SELECT coalesce((SELECT sum(chip_balance) FROM public.club_members),0)+coalesce((SELECT sum(stack) FROM public.table_seats WHERE left_at IS NULL),0) INTO currency_after;
 -- Wallet+felt decrease excludes distributed fees; original hand SUM(delta)=-fees.
 IF currency_after-currency_before<>base-fee-bbj THEN RAISE EXCEPTION 'ANONYMOUS_CURRENCY_CONSERVATION_FAILED before%,after%,base%,fees%',currency_before,currency_after,base,fee+bbj;END IF;
 r:=public.fn_ca_resume_hand_submission(tid,'successor-one',newgen);
 IF r->>'found' IS DISTINCT FROM 'false' OR(SELECT count(*) FROM smarter_private.retired_cash_hand_custody WHERE submission_id=sub)<>missing OR(SELECT coalesce(sum(amount),0) FROM public.ca_mint_ledger WHERE asset='chips')-mint_before<>base THEN RAISE EXCEPTION 'ANONYMOUS_REPLAY_CHANGED';END IF;
 RETURN jsonb_build_object('case',p_case,'participants',n,'missing',missing,'base',base,'target',target,'rake',fee,'bbj',bbj,'currency_delta',currency_after-currency_before,'mint',base,'foreign_unchanged',true,'native_completed',true,'replay_unchanged',true);
END $shape$;
BEGIN;SELECT cash_retirement_native.anonymous_shape(1);ROLLBACK;
BEGIN;SELECT cash_retirement_native.anonymous_shape(2);ROLLBACK;
BEGIN;SELECT cash_retirement_native.anonymous_shape(3);ROLLBACK;
BEGIN;SELECT cash_retirement_native.anonymous_shape(4);ROLLBACK;
