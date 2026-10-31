-- Socket-only regression; test gates never enter production.
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA harness;
CREATE TABLE harness.pass_case(k text PRIMARY KEY,game uuid,hand_id uuid,instance_id uuid,request_id uuid,results jsonb,low_player uuid,high_player uuid,matcher_request uuid);
CREATE FUNCTION harness.pass_case(k text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE g uuid;ids uuid[];lo uuid;hi uuid;win uuid;f jsonb;h uuid;plan jsonb;r jsonb;
BEGIN
 g:=harness.cluster('pass cycle '||k);
 UPDATE cash_games SET template_name='action',ruleset_snapshot=jsonb_set(ruleset_snapshot,'{template}','"action"') WHERE id=g;
 IF to_regprocedure('public.fn_lightning_cash_clock_at_settlement()') IS NOT NULL THEN
  UPDATE public.tables SET is_private=true,union_id=NULL WHERE cluster_id=g;
  UPDATE public.cash_player_session SET scope_type='table',scope_id=table_id,stay_remaining_ms=600000,stay_running=false,stay_last_tick_at='2000-01-01Z' WHERE cluster_id=g;
  UPDATE public.table_seats ts SET occupancy_id=coalesce(occupancy_id,gen_random_uuid()) FROM public.tables t WHERE t.id=ts.table_id AND t.cluster_id=g;
 END IF;
 SELECT array_agg(player_id ORDER BY anchor_seat_id) INTO ids FROM lightning_pool_session WHERE cluster_id=g AND exited_at IS NULL;
 lo:=ids[1];hi:=ids[cardinality(ids)];win:=ids[2];
 f:=public.fn_lightning_form_hand(g,ARRAY[lo,hi,win,ids[3],ids[4],ids[5]],p_target_size=>6::smallint,p_max_size=>6::smallint,p_matcher_version=>'p6s-matcher',p_request_id=>gen_random_uuid(),p_player_platforms=>NULL::jsonb);
 IF f->>'formed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'old hand did not form: %',f;END IF;
 h:=(f->>'hand_id')::uuid;PERFORM harness.deal((f->>'instance_id')::uuid);
 r:=public.fn_lightning_fast_fold(h,lo,gen_random_uuid(),'fast',1);
 IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'low did not fold: %',r;END IF;
 r:=public.fn_lightning_fast_fold(h,hi,gen_random_uuid(),'fast',1);
 IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'high did not fold: %',r;END IF;
 UPDATE lightning_pool_slot SET last_bb_at='2001-01-01Z',idle_since=opened_at WHERE cluster_id=g;
 UPDATE lightning_pool_slot SET last_bb_at='1999-01-01Z' WHERE cluster_id=g AND player_id=hi;
 UPDATE lightning_pool_slot SET last_bb_at='1999-01-02Z' WHERE cluster_id=g AND player_id=lo;
 PERFORM public.fx6_set(g,'{"worker_mode":"form","pass_time_budget_ms":5000,"admission_batch_hands":2,"instance_min":6,"instance_target":6,"instance_max":6,"position_fairness":false}');
 plan:=public.fn_lightning_match_plan(g,clock_timestamp(),'{}'::uuid[],'p6s-matcher',2,NULL::jsonb);
 IF jsonb_array_length(plan->'groups')<>2 OR NOT (plan#>'{groups,0,players}') ? hi::text OR (plan#>'{groups,0,players}') ? lo::text OR NOT (plan#>'{groups,1,players}') ? lo::text THEN RAISE EXCEPTION 'real planner did not split adverse anchors: %',plan;END IF;
 INSERT INTO harness.pass_case VALUES(k,g,h,(f->>'instance_id')::uuid,gen_random_uuid(),harness.results(h,jsonb_build_object(lo::text,jsonb_build_object('d',-1,'c',1,'f','fast'),hi::text,jsonb_build_object('d',-1,'c',1,'f','fast'),win::text,jsonb_build_object('d',2,'c',2))),lo,hi,gen_random_uuid());
END$$;
CREATE FUNCTION harness.pass_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('harness.pass_gate',true)='on' AND (SELECT count(*) FROM lightning_hand WHERE cluster_id=NEW.cluster_id)=2 THEN
  PERFORM pg_advisory_lock(19232,1);PERFORM pg_advisory_unlock(19232,1);
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER pass_test_gate AFTER INSERT ON lightning_hand FOR EACH ROW EXECUTE FUNCTION harness.pass_gate();
CREATE FUNCTION harness.pass_race(k text,expect_cycle boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE conn text:='host='||current_setting('unix_socket_directories')||' port='||current_setting('port')||' dbname='||current_database();
 c record;r jsonb;m jsonb;err text;merr text;deadline timestamptz;spid integer;mpid integer;probe uuid;first_result jsonb;
BEGIN
 SELECT * INTO STRICT c FROM harness.pass_case WHERE pass_case.k=pass_race.k;
 PERFORM harness.dblink_connect('pass_settle',conn);PERFORM harness.dblink_connect('pass_match',conn);
 PERFORM harness.dblink_exec('pass_settle','SET application_name=''pass_settler'';SET deadlock_timeout=''100ms'';SET statement_timeout=''10s''');
 PERFORM harness.dblink_exec('pass_match','SET application_name=''pass_matcher'';SET harness.pass_gate=''on'';SET deadlock_timeout=''100ms'';SET statement_timeout=''10s''');
 SELECT pid INTO spid FROM harness.dblink('pass_settle','SELECT pg_backend_pid()') AS x(pid integer);
 SELECT pid INTO mpid FROM harness.dblink('pass_match','SELECT pg_backend_pid()') AS x(pid integer);
 PERFORM pg_advisory_lock(19232,1);
 PERFORM harness.dblink_send_query('pass_match',format('SELECT public.fn_lightning_match_and_form(%L::uuid,clock_timestamp(),''{}''::uuid[],2,%L::uuid,NULL::jsonb)',c.game,c.matcher_request));
 deadline:=clock_timestamp()+interval '5 seconds';
 LOOP
  PERFORM pg_stat_clear_snapshot();
  EXIT WHEN EXISTS(SELECT FROM pg_stat_activity WHERE pid=mpid AND wait_event='advisory');
  IF clock_timestamp()>deadline THEN RAISE EXCEPTION 'real matcher did not hold first group anchors';END IF;
  PERFORM pg_sleep(.01);
 END LOOP;
 PERFORM harness.dblink_send_query('pass_settle',format('SELECT harness.settle(%L,%L,%L::jsonb,0,0)',c.hand_id,c.request_id,c.results));
 deadline:=clock_timestamp()+interval '5 seconds';
 LOOP
  PERFORM pg_stat_clear_snapshot();EXIT WHEN mpid=ANY(pg_blocking_pids(spid));
  IF clock_timestamp()>deadline THEN RAISE EXCEPTION 'settlement did not wait on real matcher';END IF;
  PERFORM pg_sleep(.01);
 END LOOP;
 IF NOT expect_cycle THEN
  IF NOT EXISTS(SELECT FROM pg_stat_activity WHERE pid=spid AND wait_event='advisory') THEN RAISE EXCEPTION 'settlement waited after pass admission';END IF;
  -- An independent real backend can still take the old instance row while
  -- the candidate waits. Admission therefore precedes every instance lock.
  PERFORM harness.dblink_connect('pass_probe',conn);
  SELECT id INTO probe FROM harness.dblink('pass_probe',format('SELECT id FROM public.lightning_instance WHERE id=%L::uuid FOR UPDATE NOWAIT',c.instance_id)) AS x(id uuid);
  PERFORM harness.dblink_disconnect('pass_probe');
  IF probe IS DISTINCT FROM c.instance_id THEN RAISE EXCEPTION 'original instance is not free before pass admission';END IF;
 END IF;
 PERFORM pg_advisory_unlock(19232,1);
 SELECT answer INTO r FROM harness.dblink_get_result('pass_settle',false) AS x(answer jsonb);err:=harness.dblink_error_message('pass_settle');
 SELECT answer INTO m FROM harness.dblink_get_result('pass_match',false) AS x(answer jsonb);merr:=harness.dblink_error_message('pass_match');
 PERFORM harness.dblink_disconnect('pass_settle');PERFORM harness.dblink_disconnect('pass_match');
 IF expect_cycle THEN
  IF NOT (coalesce(err LIKE '%deadlock detected%',false) OR coalesce(merr LIKE '%deadlock detected%',false) OR coalesce(m::text LIKE '%40P01%',false)) THEN RAISE EXCEPTION 'current seat-order baseline did not reproduce cycle: %,%,%,%',r,m,err,merr;END IF;
 ELSE
  IF r->>'ok' IS DISTINCT FROM 'true' OR m->>'formed' IS DISTINCT FROM '2' OR m->>'ok' IS DISTINCT FROM 'true' OR coalesce(m::text LIKE '%40P01%',false) THEN RAISE EXCEPTION 'candidate matcher/settlement failed: %,%,%,%',r,m,err,merr;END IF;
  IF r->>'request_hash' IS DISTINCT FROM (SELECT request_hash FROM harness.pass_expected) THEN RAISE EXCEPTION 'canonical request hash changed from original serial settlement';END IF;
  IF (SELECT count(*) FROM hand_atomic_commits WHERE hand_id=(r->>'hand_history_id')::uuid)<>1 THEN RAISE EXCEPTION 'candidate not one physical commit';END IF;
  first_result:=r;
  r:=harness.settle(c.hand_id,c.request_id,c.results,0,0);
  IF (r-'replay') IS DISTINCT FROM first_result OR r->>'replay' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'candidate replay not stored receipt';END IF;
 END IF;
END$$;
SELECT harness.pass_case('before');
SELECT harness.pass_case('after');
SELECT harness.pass_race('before',true);
\echo 'PASS pass: current seat-order settlement and actual two-group matcher reproduce 40P01'

BEGIN;
SELECT harness.settle(hand_id,request_id,results,0,0)->>'request_hash' AS hash FROM harness.pass_case WHERE k='after' \gset serial_
SELECT jsonb_agg(jsonb_build_object('id',ts.id,'stack',ts.stack) ORDER BY ts.id) AS snapshot FROM table_seats ts JOIN tables t ON t.id=ts.table_id WHERE t.cluster_id=(SELECT game FROM harness.pass_case WHERE k='after') \gset expected_
ROLLBACK;
CREATE TABLE harness.pass_expected AS SELECT :'expected_snapshot'::jsonb anchors, :'serial_hash'::text request_hash;
CREATE TABLE harness.pass_metadata AS SELECT proowner,proacl,prosecdef,proconfig,provolatile,proparallel FROM pg_proc WHERE oid='public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure;
__PASS_MIGRATION__
SELECT harness.pass_race('after',false);
\echo 'PASS pass: shared admission precedes instance lock; two real groups and one physical settlement finish with exact replay'

DO $$BEGIN
 IF (SELECT anchors FROM harness.pass_expected) IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('id',ts.id,'stack',ts.stack) ORDER BY ts.id) FROM table_seats ts JOIN tables t ON t.id=ts.table_id WHERE t.cluster_id=(SELECT game FROM harness.pass_case WHERE k='after')) THEN RAISE EXCEPTION 'money differs from original serial rollback';END IF;
 IF (SELECT to_jsonb(m) FROM harness.pass_metadata m) IS DISTINCT FROM (SELECT jsonb_build_object('proowner',proowner,'proacl',proacl,'prosecdef',prosecdef,'proconfig',proconfig,'provolatile',provolatile,'proparallel',proparallel) FROM pg_proc WHERE oid='public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure) THEN RAISE EXCEPTION 'metadata changed';END IF;
END$$;
\echo 'PASS pass: concurrent exact money equals original serial rollback and metadata remains unchanged'

CREATE FUNCTION harness.parallel_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('harness.parallel_gate',true)='on' AND (SELECT count(*) FROM lightning_settlement_marker WHERE txid=NEW.txid)=1 THEN
  PERFORM pg_advisory_lock_shared(19233,1);PERFORM pg_advisory_unlock_shared(19233,1);
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER parallel_test_gate AFTER INSERT ON lightning_settlement_marker FOR EACH ROW EXECUTE FUNCTION harness.parallel_gate();
CREATE FUNCTION harness.parallel_cases() RETURNS void LANGUAGE plpgsql AS $$
DECLARE g uuid;ids uuid[];f jsonb;h uuid;j int;members uuid[];
BEGIN
 g:=harness.cluster('shared settlers');
 PERFORM public.fx6_set(g,'{"worker_mode":"form"}');
 UPDATE cash_games SET template_name='action',ruleset_snapshot=jsonb_set(ruleset_snapshot,'{template}','"action"') WHERE id=g;
 IF to_regprocedure('public.fn_lightning_cash_clock_at_settlement()') IS NOT NULL THEN
  UPDATE public.tables SET is_private=true,union_id=NULL WHERE cluster_id=g;
  UPDATE public.cash_player_session SET scope_type='table',scope_id=table_id,stay_remaining_ms=600000,stay_running=false,stay_last_tick_at='2000-01-01Z' WHERE cluster_id=g;
  UPDATE public.table_seats ts SET occupancy_id=coalesce(occupancy_id,gen_random_uuid()) FROM public.tables t WHERE t.id=ts.table_id AND t.cluster_id=g;
 END IF;
 SELECT array_agg(player_id ORDER BY anchor_seat_id) INTO ids FROM lightning_pool_session WHERE cluster_id=g AND exited_at IS NULL;
 FOR j IN 0..1 LOOP
  members:=ids[(1+j*6):(6+j*6)];
  f:=public.fn_lightning_form_hand(g,members,p_target_size=>6::smallint,p_max_size=>6::smallint,p_matcher_version=>'p6s-matcher',p_request_id=>gen_random_uuid(),p_player_platforms=>NULL::jsonb);
  IF f->>'formed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'parallel hand not formed %',f;END IF;
  h:=(f->>'hand_id')::uuid;PERFORM harness.deal((f->>'instance_id')::uuid);
  INSERT INTO harness.pass_case VALUES('parallel'||j,g,h,(f->>'instance_id')::uuid,gen_random_uuid(),harness.results(h,jsonb_build_object(members[1]::text,jsonb_build_object('d',1,'c',2),members[2]::text,jsonb_build_object('d',-1,'c',2))),members[1],members[6],gen_random_uuid());
 END LOOP;
END$$;
CREATE FUNCTION harness.parallel_race() RETURNS void LANGUAGE plpgsql AS $$
DECLARE conn text:='host='||current_setting('unix_socket_directories')||' port='||current_setting('port')||' dbname='||current_database();c record;r jsonb;first_result jsonb;pids int[]:='{}';v_pid int;j int;deadline timestamptz;gate bigint;g uuid;
BEGIN
 PERFORM pg_advisory_lock(19233,1);
 FOR j IN 0..1 LOOP
  SELECT * INTO STRICT c FROM harness.pass_case WHERE k='parallel'||j;
  g:=c.game;
  PERFORM harness.dblink_connect('parallel'||j,conn);
  PERFORM harness.dblink_exec('parallel'||j,'SET harness.parallel_gate=''on'';SET statement_timeout=''10s''');
  SELECT x.pid INTO v_pid FROM harness.dblink('parallel'||j,'SELECT pg_backend_pid()') AS x(pid int);pids:=array_append(pids,v_pid);
  PERFORM harness.dblink_send_query('parallel'||j,format('SELECT harness.settle(%L,%L,%L::jsonb,0,0)',c.hand_id,c.request_id,c.results));
 END LOOP;
 gate:=hashtextextended('lightning_matcher:'||g::text,0);
 deadline:=clock_timestamp()+interval '5 seconds';
 LOOP
  PERFORM pg_stat_clear_snapshot();
  EXIT WHEN (SELECT count(*) FROM pg_locks WHERE pid=ANY(pids) AND locktype='advisory' AND mode='ShareLock' AND granted AND classid=((gate>>32)&4294967295)::oid AND objid=(gate&4294967295)::oid)=2
   AND (SELECT count(*) FROM pg_stat_activity WHERE pid=ANY(pids) AND wait_event='advisory')=2;
  IF clock_timestamp()>deadline THEN RAISE EXCEPTION 'disjoint settlers did not both pass shared admission';END IF;
  PERFORM pg_sleep(.01);
 END LOOP;
 -- The actual matcher refuses contention without acquiring a row or forming.
 r:=public.fn_lightning_match_and_form(g,clock_timestamp(),'{}'::uuid[],2,gen_random_uuid(),NULL::jsonb);
 IF r->>'reason' IS DISTINCT FROM 'pass_in_progress' OR r->>'formed' IS DISTINCT FROM '0' THEN RAISE EXCEPTION 'matcher did not respect shared settlers %',r;END IF;
 PERFORM pg_advisory_unlock(19233,1);
 FOR j IN 0..1 LOOP
  SELECT answer INTO r FROM harness.dblink_get_result('parallel'||j,false) AS x(answer jsonb);
  PERFORM harness.dblink_disconnect('parallel'||j);
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'parallel settler failed %',r;END IF;
  IF (SELECT count(*) FROM hand_atomic_commits WHERE hand_id=(r->>'hand_history_id')::uuid)<>1 THEN RAISE EXCEPTION 'parallel settler not one physical commit';END IF;
  first_result:=r;SELECT * INTO STRICT c FROM harness.pass_case WHERE k='parallel'||j;
  r:=harness.settle(c.hand_id,c.request_id,c.results,0,0);
  IF r->>'replay' IS DISTINCT FROM 'true' OR (r-'replay') IS DISTINCT FROM first_result THEN RAISE EXCEPTION 'parallel exact receipt replay changed';END IF;
 END LOOP;
END$$;
SELECT harness.parallel_cases();
SELECT harness.parallel_race();
\echo 'PASS pass: disjoint same-cluster settlers hold shared admission simultaneously; real matcher skips; both commit once and replay exact receipts'
