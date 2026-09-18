-- Isolated future-contract financial qualification. Wallet registration,
-- final pool/entitlement materialization and terminal payout are actual owners.
-- The already-played hand, start snapshot and causal elimination scene are
-- synthetic opening state. This does not prove a production launch or activate
-- R46. The complete transaction, including its temporary future ABI, rolls back.
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='8s';
DO $local$ BEGIN
 IF current_database() !~ '^r46_mtt_isolation_' OR current_user<>'postgres'
    OR inet_server_addr() IS NOT NULL OR (SELECT count(*) FROM public.tournaments)<>1
    OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id='30000000-0000-0000-0000-000000000001'
       AND name='Atomic Probe Template') THEN
  RAISE EXCEPTION 'qualifier probe requires the exact owned structural fixture';
 END IF;
END $local$;
ALTER TABLE public.tournaments ALTER COLUMN max_players DROP NOT NULL;
SET LOCAL session_replication_role=replica;
UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2';
SET LOCAL session_replication_role=origin;

CREATE FUNCTION pg_temp.qualifier_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
 RAISE NOTICE 'QUALIFIER PASS: %',label;
END $f$;

CREATE FUNCTION pg_temp.qualifier_financial_state() RETURNS jsonb LANGUAGE plpgsql AS $state$
DECLARE t text; a jsonb; result jsonb:='{}';
BEGIN
 FOR t IN SELECT unnest(ARRAY['tournaments','tournament_players','tables','table_seats','club_members',
  'chip_ledger','wallet_transactions','tournament_escrow','tournament_obligations','tournament_payouts',
  'tournament_tickets','tournament_refund_entitlements','tournament_satellite_settlements',
  'tournament_satellite_awards','tournament_satellite_remainders','tournament_rake_settlements',
  'rake_records','rake_attributions','agent_commissions','player_stats','vip_points_carry',
  'club_wallets','union_wallets']) UNION SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'accounting_tournament_%' LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb) FROM public.%I r',t) INTO a;
  result:=result||jsonb_build_object(t,a);
 END LOOP;
 RETURN result;
END $state$;
CREATE FUNCTION pg_temp.qualifier_refuse_final_close() RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN
 IF NEW.id::text=current_setting('native.qualifier_fault_table',true) AND NEW.status='closed' THEN
  PERFORM pg_temp.qualifier_assert((SELECT prize_balance=0 AND prize_out=105 AND closed_at IS NOT NULL
    FROM public.tournament_escrow WHERE tournament_id=NEW.tournament_id),
    'injected close failure occurs only after the real 105 payout and escrow close');
  RAISE EXCEPTION 'injected qualifier final close refusal' USING ERRCODE='PZ013';
 END IF;
 RETURN NEW;
END $fault$;
CREATE TRIGGER native_qualifier_final_close BEFORE UPDATE ON public.tables
 FOR EACH ROW EXECUTE FUNCTION pg_temp.qualifier_refuse_final_close();

CREATE FUNCTION pg_temp.qualifier_case(case_name text,survivors integer,settle_now boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql AS $case$
DECLARE
 club uuid:=md5('l04:'||case_name||':club')::uuid;
 source_id uuid:=md5('l04:'||case_name||':source')::uuid;
 target_id uuid:=md5('l04:'||case_name||':target')::uuid;
 v_table_id uuid:=md5('l04:'||case_name||':table')::uuid;
 u uuid; session_id uuid; request_id uuid; i integer; q uuid[]; r jsonb; first_receipt jsonb;
 before_money jsonb; after_money jsonb; refused boolean; event_row public.tournaments%ROWTYPE;
BEGIN
 IF survivors NOT IN (1,2) THEN RAISE EXCEPTION 'fixture survivor count'; END IF;
 -- Opening wallets/identities and authored future-format event are explicit
 -- fixtures, not production data and not a forged creator acceptance test.
 PERFORM set_config('session_replication_role','replica',true);
 INSERT INTO public.clubs(id,club_id,name) VALUES(club,CASE WHEN survivors=2 THEN 993001 ELSE 993002 END,'Native Qualifier '||case_name);
 INSERT INTO public.tournaments(id,name,buy_in_amount,buy_in_fee,starting_chips,start_time,status,
   current_players,max_players,min_players,current_level,club_id,prize_pool,total_rake,bounty_pool,
   entry_contract_locked,is_rebuy,is_reentry,rebuy_levels,late_reg_levels,late_reg_mins,
   tournament_type,variant,format_contract,satellite_target_id,satellite_target,satellite_seats)
 VALUES(target_id,'Native Qualifier Target '||case_name,45,5,1000,clock_timestamp()+interval '1 day','REGISTERING',
   0,NULL,3,0,club,0,0,0,false,false,false,0,0,0,'MTT','freezeout','mtt-v2',NULL,NULL,NULL),
  (source_id,'Native Qualifier Source '||case_name,26.25,0,1000,clock_timestamp()+interval '1 hour','REGISTERING',
   0,NULL,3,0,club,0,0,0,false,false,false,0,0,0,'SATELLITE','satellite','mtt-v2',target_id,target_id,2);
 FOR i IN 1..4 LOOP
  u:=md5('l04:'||case_name||':user:'||i)::uuid;
  session_id:=md5('l04:'||case_name||':session:'||i)::uuid;
  INSERT INTO auth.users(id) VALUES(u);
  INSERT INTO public.users(id,username) VALUES(u,'native_qualifier_'||case_name||'_'||i);
  INSERT INTO public.profiles(id,username,display_name) VALUES(u,'native_qualifier_'||case_name||'_'||i,'Native Qualifier');
  INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance,joined_at)
   VALUES(club,u,'player','active',300,clock_timestamp()-interval '1 day');
  INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES(session_id,u,now(),now());
 END LOOP;
 PERFORM set_config('session_replication_role','origin',true);
 FOR i IN 1..4 LOOP
  u:=md5('l04:'||case_name||':user:'||i)::uuid;
  session_id:=md5('l04:'||case_name||':session:'||i)::uuid;
  request_id:=md5('l04:'||case_name||':request:'||i)::uuid;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','session_id',session_id)::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r:=public.fn_register_for_tournament_request(source_id,request_id);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.qualifier_assert((r->>'ok')::boolean AND (r->>'cost')::numeric=26.25,case_name||': actual authenticated entry '||i);
 END LOOP;
 PERFORM pg_temp.qualifier_assert((SELECT prize_balance=105 AND gross_in=105 FROM public.tournament_escrow WHERE tournament_id=source_id),case_name||': four real entries fund exactly 105');

 -- Synthetic accepted final-hand scene: survivors retain positive chips;
 -- every eliminated player has a distinct already-recorded causal sequence.
 -- Both overflow eliminations share one eliminated_at deliberately: timestamp
 -- ordering must never replace the recorded sequence or rank the survivors.
 PERFORM set_config('session_replication_role','replica',true);
 UPDATE public.tournaments SET status='RUNNING',started_at=clock_timestamp()-interval '1 hour',
  entry_contract_locked=true,current_players=4 WHERE id=source_id;
 SELECT * INTO event_row FROM public.tournaments WHERE id=source_id;
 INSERT INTO public.tournament_satellite_economic_snapshots(tournament_id,target_tournament_id,configured_seats,
  ticket_value,promised_seat_value,funded_source_pool,source_contract_hash,target_contract_hash,source_started_at,capture_source)
 VALUES(source_id,target_id,2,50,100,105,
  public.fn_managed_game_contract_hash(public.fn_managed_game_contract_document('tournament',to_jsonb(event_row))),
  (SELECT public.fn_managed_game_contract_hash(public.fn_managed_game_contract_document('tournament',to_jsonb(t))) FROM public.tournaments t WHERE id=target_id),
  event_row.started_at,'start_trigger');
 INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id,seat_game_scope,seat_admission_key)
 VALUES(v_table_id,'Native Qualifier Table',source_id,'running','live',survivors,'tournament',club,'table:'||v_table_id,'tournament:'||source_id);
 FOR i IN 1..4 LOOP
  u:=md5('l04:'||case_name||':user:'||i)::uuid;
  UPDATE public.tournament_players SET status=CASE WHEN i<=survivors THEN 'playing' ELSE 'eliminated' END,
   chips=CASE WHEN i<=survivors THEN 4000/survivors ELSE 0 END,
   position=CASE WHEN i<=survivors THEN NULL ELSE i END,
   elimination_sequence=CASE WHEN i<=survivors THEN NULL ELSE 5-i END,
   eliminated_at=CASE WHEN i<=survivors THEN NULL ELSE now() END,
   table_id=v_table_id,seat_number=i,club_id=club
   WHERE tournament_id=source_id AND user_id=u;
  INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,left_at,leave_pending,is_sitting_out,is_away,club_id,active_game_scope,active_parent_key)
  VALUES(md5('l04:'||case_name||':seat:'||i)::uuid,v_table_id,i,u,CASE WHEN i<=survivors THEN 4000/survivors ELSE 0 END,
   CASE WHEN i<=survivors THEN 'active' ELSE 'left' END,CASE WHEN i<=survivors THEN NULL ELSE now()-interval '1 minute' END,
   false,false,false,club,CASE WHEN i<=survivors THEN 'table:'||v_table_id ELSE NULL END,CASE WHEN i<=survivors THEN 'tournament:'||source_id ELSE NULL END);
 END LOOP;
 PERFORM set_config('session_replication_role','origin',true);
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 PERFORM set_config('request.jwt.claim.sub','',true);
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 r:=public.fn_finalize_tournament_entry_pool_locked(source_id,'engine.entry_window_close','immediate');
 PERFORM pg_temp.qualifier_assert((r->>'ok')::boolean AND (r->>'prize_pool')::numeric=105,case_name||': real entry close freezes funded pool');
 SELECT array_agg(user_id ORDER BY user_id) INTO q FROM public.tournament_players WHERE tournament_id=source_id AND status='playing';
 EXECUTE 'SET LOCAL ROLE service_role';
 r:=public.fn_get_satellite_qualifier_state(source_id);
 EXECUTE 'RESET ROLE';
 PERFORM pg_temp.qualifier_assert(r->>'state'='qualifying' AND (r->>'full_ticket_count')::integer=2 AND r->'qualifier_ids'=to_jsonb(q),case_name||': full-ticket depth excludes the separate cash remainder');
 PERFORM pg_temp.qualifier_assert((SELECT count(*)=3 AND sum(ticket_value+remainder_value)=105 FROM public.tournament_satellite_entitlements WHERE tournament_id=source_id),case_name||': real immutable entitlement owner produces two tickets plus 5 bubble');

 IF survivors=2 THEN
  refused:=false;
  BEGIN PERFORM public.fn_settle_satellite_tournament(source_id,q[1]);
  EXCEPTION WHEN SQLSTATE '55000' THEN refused:=position('still has 2 live players' in SQLERRM)>0; END;
  PERFORM pg_temp.qualifier_assert(refused,case_name||': original v2 authority demonstrates the multi-survivor refusal');
 END IF;
 refused:=false;
 BEGIN PERFORM public.fn_settle_satellite_qualifiers(source_id,q||md5('wrong qualifier')::uuid);
 EXCEPTION WHEN SQLSTATE '22004' THEN refused:=true;
 WHEN SQLSTATE '55000' THEN refused:=position('cohort differs' in SQLERRM)>0; END;
 PERFORM pg_temp.qualifier_assert(refused,case_name||': mismatched observed cohort cannot pay');
 refused:=false;
 BEGIN
  PERFORM set_config('session_replication_role','replica',true);
  -- A valid legacy MTT retains its finite recorded capacity. Reach the
  -- cohort authority's format refusal without violating065's row constraint.
  UPDATE public.tournaments SET format_contract='mtt-v1',max_players=40 WHERE id=source_id;
  PERFORM set_config('session_replication_role','origin',true);
  PERFORM public.fn_settle_satellite_qualifiers(source_id,q);
 EXCEPTION WHEN SQLSTATE '55000' THEN refused:=position('recorded new MTT source' in SQLERRM)>0; END;
 PERFORM pg_temp.qualifier_assert(refused AND (SELECT format_contract='mtt-v2' AND max_players IS NULL FROM public.tournaments WHERE id=source_id),case_name||': legacy funded format cannot enter cohort authority');

 -- A pending accepted hand must hold the cohort even if stack counts look final.
 PERFORM set_config('session_replication_role','replica',true);
 INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result,committed_at)
 VALUES(v_table_id,1000000+survivors,md5('l04:'||case_name||':hand')::uuid,repeat('1',64),'{}',now());
 PERFORM set_config('session_replication_role','origin',true);
 EXECUTE 'SET LOCAL ROLE service_role';
 r:=public.fn_get_satellite_qualifier_state(source_id);
 refused:=false;
 BEGIN PERFORM public.fn_settle_satellite_qualifiers(source_id,q);
 EXCEPTION WHEN SQLSTATE '55000' THEN refused:=position('accepted hand/elimination remains unresolved' in SQLERRM)>0; END;
 EXECUTE 'RESET ROLE';
 PERFORM pg_temp.qualifier_assert(r->>'state'='unresolved' AND refused AND NOT EXISTS(SELECT 1 FROM public.tournament_satellite_settlements WHERE tournament_id=source_id),case_name||': delayed hand completion cannot release or pay qualifiers');
 PERFORM set_config('session_replication_role','replica',true);
 UPDATE public.hand_atomic_commits SET post_commit_completed_at=now() WHERE table_id=v_table_id;
 -- An independently pending causal candidate remains a barrier even after the
 -- accepted hand writer completed. Its already-eliminated roster row is an
 -- explicit inconsistent opening witness, never authority to pay through it.
 INSERT INTO public.tournament_knockout_candidates(id,tournament_id,eliminated_user_id,
   table_id,seat_id,seat_joined_at,hand_id,hand_number,stack_before,stack_after,state)
 SELECT md5('l04:'||case_name||':candidate')::uuid,source_id,user_id,v_table_id,id,joined_at,
   md5('l04:'||case_name||':hand')::uuid,1000000+survivors,1000,0,'pending'
 FROM public.table_seats WHERE id=md5('l04:'||case_name||':seat:4')::uuid;
 PERFORM set_config('session_replication_role','origin',true);
 EXECUTE 'SET LOCAL ROLE service_role';
 r:=public.fn_get_satellite_qualifier_state(source_id);
 refused:=false;
 BEGIN PERFORM public.fn_settle_satellite_qualifiers(source_id,q);
 EXCEPTION WHEN SQLSTATE '55000' THEN refused:=position('accepted hand/elimination remains unresolved' in SQLERRM)>0; END;
 EXECUTE 'RESET ROLE';
 PERFORM pg_temp.qualifier_assert(r->>'state'='unresolved' AND refused AND NOT EXISTS(
   SELECT 1 FROM public.tournament_satellite_settlements WHERE tournament_id=source_id),
   case_name||': pending causal elimination blocks an otherwise completed hand');
 -- End the disclosed opening inconsistency. This does not claim an actual
 -- elimination workflow; the test concerns the terminal admission boundary.
 PERFORM set_config('session_replication_role','replica',true);
 UPDATE public.tournament_knockout_candidates SET state='eliminated',resolved_at=now()
   WHERE id=md5('l04:'||case_name||':candidate')::uuid;
 PERFORM set_config('session_replication_role','origin',true);
 IF NOT settle_now THEN
  RETURN jsonb_build_object('tournament_id',source_id,'qualifier_ids',q,'target_id',target_id,'table_id',v_table_id);
 END IF;
 before_money:=pg_temp.qualifier_financial_state();
 PERFORM set_config('native.qualifier_fault_table',v_table_id::text,true);
 refused:=false;
 BEGIN PERFORM public.fn_settle_satellite_qualifiers(source_id,q);
 EXCEPTION WHEN SQLSTATE 'PZ013' THEN refused:=true; END;
 PERFORM set_config('native.qualifier_fault_table','',true);
 PERFORM pg_temp.qualifier_assert(refused AND before_money=pg_temp.qualifier_financial_state(),case_name||': late close refusal rolls all actual financial and lifecycle effects back');
 EXECUTE 'SET LOCAL ROLE service_role';
 first_receipt:=public.fn_settle_satellite_qualifiers(source_id,q);
 EXECUTE 'RESET ROLE';
 PERFORM pg_temp.qualifier_assert((first_receipt->>'fully_settled')::boolean AND (first_receipt->>'receipt_version')::integer=3
  AND first_receipt->'qualifier_ids'=to_jsonb(q) AND NOT(first_receipt?'winner_id') AND NOT(first_receipt?'winner_amount'),case_name||': actual terminal caller returns cohort without invented champion');
 PERFORM pg_temp.qualifier_assert((SELECT count(*)=survivors FROM public.tournament_players WHERE tournament_id=source_id AND status='winner' AND position IS NULL AND chips>0),case_name||': enabled legacy ranker preserves tied qualifiers');
 PERFORM pg_temp.qualifier_assert((SELECT count(*)=4-survivors AND count(DISTINCT position)=4-survivors FROM public.tournament_players WHERE tournament_id=source_id AND status='eliminated' AND position>survivors),case_name||': causal eliminated positions remain distinct');
 PERFORM pg_temp.qualifier_assert((SELECT count(*)=2 AND sum(amount)=100 FROM public.tournament_satellite_awards WHERE tournament_id=source_id)
  AND (SELECT count(*)=1 AND min(amount)=5 AND min(place)=3 FROM public.tournament_satellite_remainders WHERE tournament_id=source_id),case_name||': exact two 50 tickets and separate 5 bubble');
 PERFORM pg_temp.qualifier_assert((SELECT user_id=md5('l04:'||case_name||':user:3')::uuid FROM public.tournament_satellite_remainders WHERE tournament_id=source_id),case_name||': recorded bubble gets remainder without sorting survivors');
 PERFORM pg_temp.qualifier_assert((SELECT count(*)=2 FROM public.tournament_players WHERE tournament_id=target_id AND source_satellite_id=source_id)
  AND (SELECT prize_balance=90 AND fee_balance=10 FROM public.tournament_escrow WHERE tournament_id=target_id),case_name||': funded target seats preserve 45 plus 5 economics');
 PERFORM pg_temp.qualifier_assert((SELECT prize_balance=0 AND fee_balance=0 AND prize_out=105 AND closed_at IS NOT NULL FROM public.tournament_escrow WHERE tournament_id=source_id),case_name||': source escrow closes exact zero');
 PERFORM pg_temp.qualifier_assert((SELECT status='COMPLETED' AND current_players=0 FROM public.tournaments WHERE id=source_id)
  AND (SELECT lifecycle='closed' AND current_players=0 FROM public.tables WHERE id=v_table_id)
  AND NOT EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=v_table_id AND left_at IS NULL),case_name||': authoritative terminal caller closes all source felt');
 SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) INTO before_money FROM public.tournament_payouts p WHERE tournament_id=source_id;
 EXECUTE 'SET LOCAL ROLE service_role';
 r:=public.fn_settle_satellite_qualifiers(source_id,q);
 PERFORM pg_temp.qualifier_assert(r=first_receipt,case_name||': exact replay returns immutable cohort receipt');
 r:=public.fn_resolve_satellite_qualifier_outcome(source_id,q);
 EXECUTE 'RESET ROLE';
 SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) INTO after_money FROM public.tournament_payouts p WHERE tournament_id=source_id;
 PERFORM pg_temp.qualifier_assert((r->>'satellite_committed')::boolean AND r->'receipt'=first_receipt AND before_money=after_money,case_name||': lost-response resolver proves same commit with no second payout');
 -- The browser reads only its own immutable disposition after reconnect.
 FOR i IN 1..4 LOOP
  u:=md5('l04:'||case_name||':user:'||i)::uuid;
  session_id:=md5('l04:'||case_name||':session:'||i)::uuid;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','session_id',session_id)::text,true);
  PERFORM set_config('request.jwt.claim.sub',u::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r:=public.fn_get_my_satellite_qualifier_result(source_id);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.qualifier_assert(r->>'user_id'=u::text AND r->>'tournament_id'=source_id::text
   AND (r->>'receipt_version')::integer=3 AND (r->>'qualified')::boolean=(i<=survivors)
   AND (CASE WHEN i<=survivors THEN r->'position'='null'::jsonb ELSE (r->>'position')::integer=i END)
   AND (r->>'amount')::numeric=CASE WHEN i<=2 THEN 50 WHEN i=3 THEN 5 ELSE 0 END
   AND r->>'delivery_kind'=CASE WHEN i<=2 THEN 'seat' WHEN i=3 THEN 'remainder' ELSE 'none' END
   AND NOT(r?'qualifier_ids') AND NOT(r?'awards'),case_name||': authenticated entrant '||i||' receives only its real committed result');
  refused:=false;
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN PERFORM public.fn_get_my_satellite_qualifier_result(md5('foreign event')::uuid);
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.qualifier_assert(refused,case_name||': an authenticated viewer cannot read an event it did not enter');
 END LOOP;
 EXECUTE 'SET LOCAL ROLE anon';
 refused:=false;
 BEGIN PERFORM public.fn_get_my_satellite_qualifier_result(source_id);
 EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
 EXECUTE 'RESET ROLE';
 PERFORM pg_temp.qualifier_assert(refused,case_name||': anonymous result lookup is refused by function ACL');
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 PERFORM set_config('request.jwt.claim.sub','',true);
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 RETURN first_receipt;
END $case$;

SELECT 'SATELLITE_QUALIFIER_NATIVE_EVIDENCE='||jsonb_build_object(
 'two_survivors',pg_temp.qualifier_case('two',2),'same_hand_overflow',pg_temp.qualifier_case('overflow',1))::text;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'SATELLITE_QUALIFIERS_NATIVE_PASS';
ROLLBACK;
