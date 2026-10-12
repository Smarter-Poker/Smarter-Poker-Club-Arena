BEGIN;
-- Anonymous literal shape qualification only. No captured user or hand data.
SET ROLE postgres; SET request.jwt.claim.role='service_role';SET request.jwt.claims='{"role":"service_role"}';
CREATE OR REPLACE FUNCTION cash_retirement_native.anonymous_prepare_additional(p_case integer) RETURNS jsonb LANGUAGE plpgsql AS $shape$
DECLARE n integer:=CASE p_case WHEN 5 THEN 5 WHEN 6 THEN 5 WHEN 7 THEN 4 WHEN 8 THEN 9 ELSE 6 END;missing integer:=CASE WHEN p_case IN(8,9) THEN 2 ELSE 1 END;
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
 INSERT INTO public.clubs(id,name,owner_id,chip_treasury) VALUES(club,'Anonymous Table Club '||p_case,'10000000-0000-0000-0000-000000000001',1000);
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
   SELECT to_jsonb(s)||jsonb_build_object('left_at','2026-10-06T15:33:04+00:00') INTO before_row FROM public.table_seats s WHERE id=sid;
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
 FOR item IN SELECT value FROM jsonb_array_elements(expected) LOOP
  uid:=(item#>>'{stack,user_id}')::uuid;sid:=(item#>>'{stack,seat_id}')::uuid;
  INSERT INTO public.union_pnl_inventory_events(event_id,source_name,row_id,observed_at,transaction_id,operation,before_row,after_row)OVERRIDING SYSTEM VALUE
  VALUES((item->>'inventory_event_id')::bigint,'table_seats',sid,'2026-10-06 15:33:22Z',pg_current_xact_id(),CASE WHEN p_case<=6 THEN 'DELETE' ELSE 'UPDATE' END,item->'inventory_before',CASE WHEN p_case<=6 THEN NULL ELSE item->'inventory_before'||jsonb_build_object('user_id',replace(sid::text,'89700000','89000000'),'occupancy_id',replace(sid::text,'89700000','89000000'),'stack',77,'left_at',NULL,'joined_at','2026-10-06T15:33:22+00:00') END);
  INSERT INTO smarter_private.patterned_identity_retirements(old_id,cohort,retired_at)VALUES(uid,'horse','2026-10-06 15:40Z');
  IF p_case<=6 THEN DELETE FROM public.table_seats WHERE id=sid;
  ELSE
   foreign_uid:=replace(sid::text,'89700000','89000000')::uuid;
   INSERT INTO auth.users(id)VALUES(foreign_uid);INSERT INTO public.users(id,username)VALUES(foreign_uid,'anonymous_foreign_'||p_case||'_'||right(sid::text,3));INSERT INTO public.profiles(id,username)VALUES(foreign_uid,'anonymous_foreign_'||p_case||'_'||right(sid::text,3));
   UPDATE public.table_seats SET user_id=foreign_uid,occupancy_id=foreign_uid,stack=77,joined_at='2026-10-06 15:33:22Z' WHERE id=sid;
  END IF;
 END LOOP;

 RETURN jsonb_build_object('submission_id',sub,'request_hash',(SELECT request_hash FROM smarter_private.hand_submissions WHERE submission_id=sub),'table_id',tid,'hand_number',8900000+p_case,'participants',expected);
END $shape$;
INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES('20261006184554','anonymous native predecessor metadata',ARRAY['anonymous qualifier only']);
DO $preimage$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261006184554')
 OR md5(pg_get_functiondef('public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure)) IS DISTINCT FROM '992019226ea1c06a3514a9087ac70be5'
 OR md5(pg_get_functiondef('smarter_private.adopt_retired_cash_original_hand(uuid,text,uuid)'::regprocedure)) IS DISTINCT FROM '81fb89ad4db51ca9eb68754ebb8f384f'
 OR (SELECT count(*) FROM smarter_private.retired_cash_hand_qualification)<>4
 THEN RAISE EXCEPTION 'ADDITIONAL_CASH_QUALIFIED_NATIVE_PREDECESSOR_REQUIRED' USING ERRCODE='55000';END IF;
END $preimage$;
CREATE TEMP TABLE anonymous_authority_inputs AS SELECT cash_retirement_native.anonymous_prepare_additional(n) q FROM generate_series(5,9)n;
INSERT INTO smarter_private.retired_cash_hand_qualification SELECT(q->>'submission_id')::uuid,q->>'request_hash',(q->>'table_id')::uuid,(q->>'hand_number')::bigint,q FROM anonymous_authority_inputs;
DO $authority$
DECLARE q smarter_private.retired_cash_hand_qualification;s smarter_private.hand_submissions;item jsonb;
BEGIN
 FOR q IN SELECT * FROM smarter_private.retired_cash_hand_qualification WHERE submission_id IN('89400000-0000-0000-0000-000000000005'::uuid,'89400000-0000-0000-0000-000000000007'::uuid,'89400000-0000-0000-0000-000000000006'::uuid,'89400000-0000-0000-0000-000000000009'::uuid,'89400000-0000-0000-0000-000000000008'::uuid) LOOP
  SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=q.submission_id FOR UPDATE;
  IF s.submission_id IS NULL OR s.request_hash IS DISTINCT FROM q.request_hash
  OR (s.table_id,s.hand_number) IS DISTINCT FROM(q.table_id,q.hand_number)
  OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=q.table_id AND a.hand_number>=q.hand_number)
  OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs h WHERE h.submission_id=q.submission_id)
  OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals d WHERE d.table_id=q.table_id AND d.hand_number=q.hand_number)
  THEN RAISE EXCEPTION 'ADDITIONAL_CASH_ORIGINAL_CHANGED' USING ERRCODE='55000';END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(q.expected->'participants') LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.request->'p_stacks')x WHERE x=item->'stack')
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.request#>'{p_post_commit_obligations,time_banks}')x WHERE x=item->'time_bank')
   OR NOT EXISTS(SELECT 1 FROM public.cash_hand_participant_manifests m WHERE m.id=(item#>>'{stack,funding_manifest_id}')::uuid
     AND m.funding_provenance_complete AND m.issues='[]'::jsonb AND m.participants @> jsonb_build_array(item->'manifest_participant'))
   OR NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_events e WHERE e.event_id=(item->>'inventory_event_id')::bigint AND e.source_name='table_seats'
     AND e.row_id::text=item#>>'{stack,seat_id}' AND e.before_row @> (item->'inventory_before'))
   THEN RAISE EXCEPTION 'ADDITIONAL_CASH_IMMUTABLE_WITNESS_CHANGED' USING ERRCODE='55000';END IF;
  END LOOP;
 END LOOP;
 IF (SELECT count(*) FROM smarter_private.retired_cash_hand_qualification)<>9
 OR (SELECT sum(jsonb_array_length(expected->'participants')) FROM smarter_private.retired_cash_hand_qualification)<>12
 THEN RAISE EXCEPTION 'ADDITIONAL_CASH_AUTHORITY_CARDINALITY_CHANGED' USING ERRCODE='55000';END IF;
END $authority$;
SELECT 'ADDITIONAL_AUTHORITY_ENVELOPE_NATIVE_PASS';
ROLLBACK;
