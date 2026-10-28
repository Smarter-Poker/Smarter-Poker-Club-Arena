#!/usr/bin/env python3
"""Isolated PG17 qualification of the actual migration's arrival functions.
Existing platform dependencies are narrow fixtures; no production data/access.
"""
import json, os, pathlib, re, socket, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
PG=os.environ.get('PG_BIN') or ('/opt/homebrew/opt/postgresql@17/bin' if pathlib.Path('/opt/homebrew/opt/postgresql@17/bin/initdb').exists() else '/usr/lib/postgresql/17/bin')
base=os.environ.get('TMPDIR')
if os.uname().sysname=='Darwin' and (not base or not base.startswith('/Volumes/SmarterWork/agent-work/')):
    raise SystemExit('Mac tests require task-owned SSD TMPDIR')
def run(*args, **kw):
    return subprocess.run(args,check=True,text=True,capture_output=True,**kw)
with tempfile.TemporaryDirectory(prefix='horse-arrivals-',dir=base) as td:
    d=pathlib.Path(td); data=d/'data'
    with socket.socket() as sk:
        sk.bind(('127.0.0.1',0)); port=sk.getsockname()[1]
    run(PG+'/initdb','-D',str(data),'-A','trust','-U','postgres','--no-locale')
    run(PG+'/pg_ctl','-D',str(data),'-l',str(d/'postgres.log'),'-o',f"-p {port} -h 127.0.0.1 -c unix_socket_directories='' -c fsync=off",'-w','start')
    def sql(s):
        try: return run(PG+'/psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',str(port),'-U','postgres',input=s).stdout.strip()
        except subprocess.CalledProcessError as e: raise RuntimeError(e.stderr) from e
    def expect_error(s,word):
        try: sql(s)
        except RuntimeError as e:
            assert word in str(e),(word,str(e))
        else: raise AssertionError('Expected '+word)
    def scalar(s,expected):
        value=sql(s); assert value==str(expected),(s,value,expected)
    try:
        sql("""
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.uid',true),'')::uuid $$;
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.engine',true),'')='true' $$;
CREATE FUNCTION public.fn_caller_session_is_live() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.live',true),'')='true' $$;
CREATE FUNCTION public.fn_can_create_games(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.denied',true),'')<>'true' $$;
CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.frozen',true),'')='true' $$;
CREATE TABLE profiles(id uuid PRIMARY KEY,is_horse boolean,status text,horse_status text);
CREATE TABLE ca_horse_active_roster(horse_id uuid PRIMARY KEY);
CREATE TABLE ca_horse_fleet_register(horse_id uuid PRIMARY KEY,retired_at timestamptz);
CREATE TABLE cash_games(id uuid PRIMARY KEY,enabled boolean DEFAULT true,closed_at timestamptz,ruleset_snapshot jsonb DEFAULT '{}',club_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001',union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001',variant text DEFAULT 'plo5',sb numeric DEFAULT 2,bb numeric DEFAULT 5,handedness integer DEFAULT 6,template_name text DEFAULT 'classic',name text DEFAULT 'CHET''S GAME',must_move boolean DEFAULT true,cluster_mode text DEFAULT 'must_move',lightning_enabled boolean DEFAULT false,state text DEFAULT 'live');
CREATE TABLE clubs(id uuid PRIMARY KEY,asset text,is_platform boolean,union_id uuid,is_deleted boolean DEFAULT false,status text DEFAULT 'waiting');
CREATE TABLE tables(id uuid PRIMARY KEY,cluster_id uuid,settings jsonb DEFAULT '{}',tournament_id uuid,club_id uuid,union_id uuid,is_deleted boolean DEFAULT false,status text DEFAULT 'waiting');
CREATE TABLE table_seats(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),table_id uuid,user_id uuid,left_at timestamptz,stack numeric,active_game_scope text,joined_at timestamptz DEFAULT clock_timestamp());
CREATE TABLE test_wallets(user_id uuid PRIMARY KEY,balance numeric NOT NULL);
CREATE FUNCTION fn_ca_horse_roster_seat_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.left_at IS NOT NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.left_at IS NULL AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
 AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=NEW.user_id AND is_horse)
 OR EXISTS(SELECT 1 FROM tables WHERE id=NEW.table_id AND tournament_id IS NOT NULL) THEN RETURN NEW; END IF;
  -- Diamond cash is a distinct asset, never inferred from a caller's club id.
 IF NOT EXISTS(SELECT 1 FROM ca_horse_active_roster WHERE horse_id=NEW.user_id) THEN RAISE EXCEPTION 'horse_not_on_cash_roster'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER existing_admission BEFORE INSERT OR UPDATE ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_ca_horse_roster_seat_guard();
CREATE FUNCTION fn_cash_cluster_open_table(p_game_id uuid,p_role text,p_main_index integer,p_lifecycle text DEFAULT 'opening',p_created_by uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE g record; v_table_id uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO g FROM cash_games WHERE id=p_game_id;
 INSERT INTO tables(id,cluster_id) VALUES(v_table_id,p_game_id);
  RETURN v_table_id;
END $$;
CREATE FUNCTION fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE g uuid:=gen_random_uuid(); t uuid;
BEGIN
 IF current_setting('test.create_fail',true)='true' THEN RAISE EXCEPTION 'ORIGINAL_CREATE_REFUSAL'; END IF;
 INSERT INTO cash_games(id) VALUES(g);
 t:=fn_cash_cluster_open_table(g,'feeder',NULL,'live',auth.uid());
 RETURN jsonb_build_object('ok',true,'game_id',g,'table_id',t);
END $$;
CREATE FUNCTION test_buyin(t uuid,u uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE test_wallets SET balance=balance-100 WHERE user_id=u AND balance>=100;
 IF NOT FOUND THEN RAISE EXCEPTION 'INSUFFICIENT_FUNDS'; END IF;
 INSERT INTO table_seats(table_id,user_id,stack) VALUES(t,u,100);
END $$;
INSERT INTO profiles SELECT ('00000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,true,'active','available' FROM generate_series(1,21) i;
INSERT INTO profiles VALUES('00000000-0000-0000-0000-000000000099',false,'active',NULL);
INSERT INTO ca_horse_active_roster SELECT id FROM profiles WHERE is_horse;
INSERT INTO ca_horse_fleet_register SELECT id,NULL FROM profiles WHERE is_horse;
INSERT INTO test_wallets SELECT id,1000 FROM profiles;
""")
        # Qualify against the actual retained current admission function,
        # not a skeletal substitute for its Diamond/move/settlement branches.
        original=(ROOT/'supabase/migrations/20261027152318_scope_the_horse_cash_roster_to_club_arena.sql').read_text()
        guard=re.search(r'CREATE OR REPLACE FUNCTION public.fn_ca_horse_roster_seat_guard\(\).*?\$function\$;',original,re.S)
        assert guard, 'Actual retained admission source missing'
        sql(guard.group(0))
        migration=ROOT/'supabase/migrations/20261028174728_cash_game_horse_arrivals.sql'
        sql(migration.read_text())
        horse=lambda i:f'00000000-0000-0000-0000-{i:012}'
        arr=lambda ns:"ARRAY["+','.join("'"+horse(i)+"'::uuid" for i in ns)+"]"
        request='10000000-0000-0000-0000-000000000001'
        auth="SET test.uid='00000000-0000-0000-0000-000000000099';SET test.live='true';"
        create=f"SELECT fn_cash_game_create_horse_arrivals('{request}','fade0000-0000-0000-0000-000000000001','2026-10-28T20:00:00Z',{arr(range(1,21))})"
        expect_error(create,'LIVE_SESSION_REQUIRED')
        expect_error(auth+"SET test.create_fail='true';"+create,'ORIGINAL_CREATE_REFUSAL')
        scalar("SELECT count(*) FROM cash_game_horse_arrivals",0)
        result=json.loads(sql(auth+create)); game=result['game_id']; table=result['table_id']
        scalar(auth+create+"->>'game_id'",game)
        expect_error(auth+create.replace(arr(range(1,21)),arr(range(2,22))),'ARRIVAL_REQUEST_MISMATCH')
        scalar(f"SELECT settings->'horse_arrivals'->>'version' FROM tables WHERE id='{table}'",1)
        table2=sql(f"SELECT fn_cash_cluster_open_table('{game}','feeder',NULL)")
        scalar(f"SELECT settings->'horse_arrivals'->>'version' FROM tables WHERE id='{table2}'",1)
        sql(f"UPDATE cash_game_horse_arrivals SET starts_at=clock_timestamp()+interval '1 day' WHERE game_id='{game}'")
        epoch=lambda:sql(f"SELECT reservation_epoch FROM cash_game_horse_arrivals WHERE game_id='{game}'")
        reserve=lambda ns,key,expected=None:"SET test.engine='true';SELECT fn_cash_game_horse_arrival_reserve('"+game+"',"+arr(ns)+",'20000000-0000-0000-0000-"+f'{key:012}'+"',"+(epoch() if expected is None else str(expected))+")"
        buyin=lambda i,t=table:f"SELECT test_buyin('{t}','{horse(i)}')"
        expect_error(reserve(range(1,5),1),'HORSE_ARRIVAL_NOT_DUE')
        sql(f"UPDATE cash_game_horse_arrivals SET starts_at=clock_timestamp()-interval '4 hours' WHERE game_id='{game}'")
        expect_error(reserve([21],2),'HORSE_NOT_ON_GAME_ROSTER')
        expect_error(reserve([1,1],2),'ARRIVAL_IDS_INVALID')
        expect_error(reserve(range(1,5),1).replace("SET test.engine='true';",""),'ENGINE_REQUIRED')
        initial=json.loads(sql(reserve(range(1,5),1)))
        assert initial['reserved_now']==[horse(i) for i in range(1,5)]
        scalar(f"SELECT count(*) FROM cash_game_horse_releases WHERE game_id='{game}'",0)
        scalar(f"SELECT count(*) FROM cash_game_horse_reservations WHERE game_id='{game}'",4)
        # A refusal AFTER the actual trigger must roll back wallet AND arrival.
        sql("CREATE FUNCTION test_refused_buyin(t uuid,u uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM test_buyin(t,u);RAISE EXCEPTION 'AFTER_SEAT_REFUSAL';END $$")
        expect_error(f"SELECT test_refused_buyin('{table}','{horse(1)}')",'AFTER_SEAT_REFUSAL')
        scalar(f"SELECT balance FROM test_wallets WHERE user_id='{horse(1)}'",1000)
        scalar(f"SELECT count(*) FROM cash_game_horse_releases WHERE game_id='{game}'",0)
        expect_error(buyin(5),'HORSE_NOT_RESERVED_FOR_GAME')
        for i in range(1,4): sql(buyin(i))
        sql(f"DELETE FROM ca_horse_active_roster WHERE horse_id='{horse(4)}'")
        expect_error(buyin(4),'horse_not_on_cash_roster')
        scalar(f"SELECT count(*) FROM cash_game_horse_releases WHERE game_id='{game}'",3)
        scalar(f"SELECT balance FROM test_wallets WHERE user_id='{horse(4)}'",1000)
        sql(f"INSERT INTO ca_horse_active_roster VALUES('{horse(4)}')");sql(buyin(4))
        scalar(f"SELECT count(*) FROM cash_game_horse_releases WHERE game_id='{game}'",4)
        scalar(f"SELECT balance FROM test_wallets WHERE user_id='{horse(1)}'",900)
        scalar(reserve(range(1,5),1)+"->>'replayed'",'true')
        expect_error(reserve([5],2),'HORSE_ARRIVAL_NOT_DUE')
        # Humans, normal rejoin/move and unrelated games consume no new slot.
        sql(buyin(99))
        sql(f"UPDATE table_seats SET left_at=clock_timestamp() WHERE user_id='{horse(1)}';"+buyin(1,table2))
        scalar(f"SELECT count(*) FROM cash_game_horse_releases WHERE game_id='{game}'",4)
        other=sql("INSERT INTO cash_games(id) VALUES(gen_random_uuid()) RETURNING id")
        other_table=sql(f"SELECT fn_cash_cluster_open_table('{other}','main',1)")
        sql(buyin(21,other_table))
        sql(f"UPDATE cash_game_horse_releases SET released_at=clock_timestamp()-interval '20 minutes' WHERE game_id='{game}'")
        # Two stale workers compete for the ONE shared pending reservation.
        def concurrent(commands):
            procs=[subprocess.Popen([PG+'/psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',str(port),'-U','postgres'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in commands]
            for proc,command in zip(procs,commands): proc.stdin.write(command);proc.stdin.close()
            outcomes=[]
            for proc in procs:
                proc.stdout.read();proc.stderr.read();proc.wait();outcomes.append(proc.returncode)
            assert sorted(outcomes)==[0,3],outcomes
        observed=epoch()
        concurrent([reserve([i],i,observed) for i in [5,6]])
        scalar(f"SELECT count(*) FROM cash_game_horse_reservations WHERE game_id='{game}'",1)
        scalar(f"SELECT count(*) FROM cash_game_horse_releases WHERE game_id='{game}'",4)
        # A late reserved entry cannot permit a simultaneous sixth identity.
        concurrent([buyin(i) for i in [5,6]])
        scalar(f"SELECT count(*) FROM cash_game_horse_releases WHERE game_id='{game}'",5)
        expect_error(reserve([7],7),'HORSE_ARRIVAL_NOT_DUE')
        sql(f"UPDATE cash_game_horse_releases SET released_at=clock_timestamp()-interval '20 minutes' WHERE game_id='{game}'")
        # Replace a no-longer-eligible pending choice in the original request
        # boundary; its old in-flight buy-in is then refused, without an expiry loop.
        sql(reserve([7],70));old_epoch=epoch();sql(reserve([8],80))
        expect_error(buyin(7),'HORSE_NOT_RESERVED_FOR_GAME')
        expect_error(reserve([7],71,old_epoch),'ARRIVAL_RESERVATION_STALE')
        scalar(f"SELECT count(*) FROM cash_game_horse_releases WHERE game_id='{game}'",5)
        sql(f"UPDATE cash_games SET enabled=false WHERE id='{game}'")
        expect_error(buyin(8),'HORSE_ARRIVAL_NOT_DUE')
        sql(f"UPDATE cash_games SET enabled=true WHERE id='{game}'")
        expect_error("SET test.frozen='true';"+reserve([9],90),'PLATFORM_FROZEN')
        expect_error("SET test.frozen='true';"+buyin(8),'PLATFORM_FROZEN')
        # Exhaust exactly the selected twenty, admitting each through the real
        # trigger. Reservations alone never advance the cadence.
        arrived=set(json.loads(sql(f"SELECT coalesce(json_agg(horse_id),'[]'::json) FROM cash_game_horse_releases WHERE game_id='{game}'")))
        for i in range(1,21):
            if horse(i) in arrived: continue
            sql(f"UPDATE cash_game_horse_releases SET released_at=clock_timestamp()-interval '20 minutes' WHERE game_id='{game}'")
            sql(reserve([i],100+i));sql(buyin(i))
        scalar(f"SELECT count(*) FROM cash_game_horse_releases WHERE game_id='{game}'",20)
        scalar(f"SELECT fn_cash_game_horse_arrival_snapshot('{game}')->>'new_identity_capacity'",0)
        expect_error(reserve([21],999),'HORSE_NOT_ON_GAME_ROSTER')
        sql("SET ROLE service_role;DO $$ BEGIN BEGIN INSERT INTO cash_game_horse_releases VALUES(gen_random_uuid(),gen_random_uuid(),1,clock_timestamp());RAISE EXCEPTION 'direct write permitted';EXCEPTION WHEN insufficient_privilege THEN NULL;END;END $$;RESET ROLE;")
        # A user-created existing game can be scoped prospectively without
        # replacing its table, changing chips, or legitimizing off-roster seats.
        target='68c3d744-dba6-4de2-9db3-8c1beb711963'
        sql(f"INSERT INTO cash_games(id) VALUES('{target}')")
        target_table=sql(f"SELECT fn_cash_cluster_open_table('{target}','main',1)")
        sql(buyin(1,target_table));sql(buyin(21,target_table));sql(buyin(99,target_table))
        original_time=sql(f"SELECT joined_at FROM table_seats WHERE table_id='{target_table}' AND user_id='{horse(1)}'")
        before_seats=sql(f"SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s WHERE table_id='{target_table}'")
        before_wallets=sql("SELECT jsonb_agg(to_jsonb(w) ORDER BY user_id) FROM test_wallets w")
        attach=f"SELECT fn_cash_game_attach_horse_arrivals('9e8059e6-40ae-462b-b02f-53ad4b514ac9','{target}','2026-10-28T20:00:00Z',{arr(range(1,21))})"
        expect_error(attach,'LIVE_SESSION_REQUIRED')
        expect_error(auth+attach.replace(target,'68c3d744-dba6-4de2-9db3-8c1beb711964'),'ARRIVAL_INTENT_INVALID')
        expect_error(auth+"SET test.frozen='true';"+attach,'PLATFORM_FROZEN')
        sql(f"UPDATE cash_games SET bb=6 WHERE id='{target}'")
        expect_error(auth+attach,'ARRIVAL_TARGET_CHANGED')
        sql(f"UPDATE cash_games SET bb=5 WHERE id='{target}'")
        expect_error(auth+"SET test.denied='true';"+attach,'NOT_AUTHORIZED')
        # Holding the old entry before a policy exists must make attachment
        # refuse promptly; the admitted seat is subsequently observed exactly.
        sql(f"INSERT INTO profiles VALUES('{horse(22)}',true,'active','available');INSERT INTO ca_horse_active_roster VALUES('{horse(22)}');INSERT INTO ca_horse_fleet_register VALUES('{horse(22)}',NULL);INSERT INTO test_wallets VALUES('{horse(22)}',1000)")
        def hold_transaction(command,label):
            proc=subprocess.Popen([PG+'/psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',str(port),'-U','postgres'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            proc.stdin.write("SET application_name='"+label+"';BEGIN;"+command+";SELECT pg_sleep(3);COMMIT;");proc.stdin.close()
            for _ in range(100):
                if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='"+label+"' AND wait_event='PgSleep'")=='1':return proc
            raise AssertionError('Concurrent fixture did not reach held transaction')
        def finish_transaction(proc):
            out=proc.stdout.read();err=proc.stderr.read();proc.wait()
            assert proc.returncode==0,(out,err)
        pending=hold_transaction(buyin(22,target_table),'arrival-attach-admission-race')
        expect_error(auth+attach,'ARRIVAL_ATTACHMENT_BUSY')
        finish_transaction(pending)
        pending=hold_transaction(f"SELECT id FROM cash_games WHERE id='{target}' FOR UPDATE",'arrival-attach-game-race')
        expect_error(auth+attach,'could not obtain lock on row')
        finish_transaction(pending)
        pending=hold_transaction("SELECT pg_advisory_xact_lock(530090,1)",'arrival-attach-maintenance-race')
        expect_error(auth+attach,'ARRIVAL_ATTACHMENT_BUSY')
        finish_transaction(pending)
        scalar(f"SELECT count(*) FROM cash_game_horse_arrivals WHERE game_id='{target}'",0)
        # Capture the committed ordinary entries, before any attachment writes.
        before_seats=sql(f"SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s WHERE table_id='{target_table}'")
        before_wallets=sql("SELECT jsonb_agg(to_jsonb(w) ORDER BY user_id) FROM test_wallets w")
        attached=json.loads(sql(auth+attach))
        assert attached['attachment_observation']['preexisting_off_roster_seated_ids']==[horse(21),horse(22)]
        assert attached['attachment_observation']['initial_selected_observed']==1
        assert attached['attachment_observation']['original_initial_four_verified'] is False
        scalar(f"SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s WHERE table_id='{target_table}'",before_seats)
        scalar("SELECT jsonb_agg(to_jsonb(w) ORDER BY user_id) FROM test_wallets w",before_wallets)
        scalar(f"SELECT released_at FROM cash_game_horse_releases WHERE game_id='{target}' AND horse_id='{horse(1)}'",original_time)
        scalar(f"SELECT count(*) FROM cash_game_horse_releases WHERE game_id='{target}'",1)
        scalar(f"SELECT fn_cash_game_horse_arrival_snapshot('{target}')->>'new_identity_capacity'",3)
        scalar(auth+attach+"->>'replayed'",'true')
        scalar(f"SELECT count(*) FROM cash_game_horse_releases WHERE game_id='{target}'",1)
        expect_error(auth+attach.replace(arr(range(1,21)),arr(range(2,22))),'ARRIVAL_REQUEST_MISMATCH')
        # Execute the retained installed owned-move component against the
        # actual arrival guard. Destination refusal rolls back its internal
        # subtransaction and leaves original source chair and chips intact.
        sql("ALTER TABLE tables ADD COLUMN max_players integer DEFAULT 6,ADD COLUMN lifecycle text DEFAULT 'live',ADD COLUMN current_players integer DEFAULT 0")
        sql("ALTER TABLE table_seats ADD COLUMN seat_number integer DEFAULT 1,ADD COLUMN member_id uuid,ADD COLUMN is_sitting_out boolean,ADD COLUMN sit_out_at timestamptz,ADD COLUMN is_away boolean,ADD COLUMN horse_id uuid,ADD COLUMN status text DEFAULT 'active',ADD COLUMN leave_pending boolean DEFAULT false,ADD COLUMN auto_rebuy boolean,ADD COLUMN time_bank_remaining numeric,ADD COLUMN time_bank_uses_remaining numeric,ADD COLUMN club_id uuid,ADD COLUMN entry_hold text,ADD COLUMN entry_post_agreed boolean")
        sql("CREATE TABLE cash_seat_moves(id uuid PRIMARY KEY,game_id uuid,player_id uuid,from_table_id uuid,to_table_id uuid,state text,expires_at timestamptz,swap_move_id uuid,reason text,note text,executed_at timestamptz,to_seat_number integer)")
        retained=(ROOT/'scripts/ci/retained-horse-arrival-move-fixture.sql').read_text()
        sql(retained+';')
        scalar("SELECT md5(pg_get_functiondef('public.fn_cash_seat_move_execute_before_maintenance_gate(uuid)'::regprocedure))",'10e596aee2721e282dc22c0b45242a83')
        target_table2=sql(f"SELECT fn_cash_cluster_open_table('{target}','feeder',NULL)")
        source_before=sql(f"SELECT to_jsonb(s) FROM table_seats s WHERE table_id='{target_table}' AND user_id='{horse(22)}' AND left_at IS NULL")
        wallets_before_move=sql("SELECT jsonb_agg(to_jsonb(w) ORDER BY user_id) FROM test_wallets w")
        move_id='30000000-0000-0000-0000-000000000001'
        sql(f"INSERT INTO cash_seat_moves(id,game_id,player_id,from_table_id,to_table_id,state,expires_at,reason) VALUES('{move_id}','{target}','{horse(22)}','{target_table}','{target_table2}','pending',clock_timestamp()+interval '1 hour','must_move')")
        moved=json.loads(sql(f"SELECT fn_cash_seat_move_execute_before_maintenance_gate('{move_id}')"))
        assert moved['ok'] is False and moved['reason']=='destination_refused' and 'HORSE_NOT_RESERVED_FOR_GAME' in moved['detail'],moved
        scalar(f"SELECT state FROM cash_seat_moves WHERE id='{move_id}'",'cancelled')
        scalar(f"SELECT to_jsonb(s) FROM table_seats s WHERE table_id='{target_table}' AND user_id='{horse(22)}' AND left_at IS NULL",source_before)
        scalar("SELECT jsonb_agg(to_jsonb(w) ORDER BY user_id) FROM test_wallets w",wallets_before_move)
        scalar(f"SELECT count(*) FROM table_seats WHERE table_id='{target_table2}' AND user_id='{horse(22)}' AND left_at IS NULL",0)
        # Same existing seat updates stay legal. There is no off-list rejoin grant.
        sql(f"UPDATE table_seats SET stack=stack+1 WHERE table_id='{target_table}' AND user_id='{horse(21)}'")
        sql(f"UPDATE table_seats SET left_at=clock_timestamp() WHERE table_id='{target_table}' AND user_id='{horse(21)}'")
        expect_error(buyin(21,target_table),'HORSE_NOT_RESERVED_FOR_GAME')
        scalar(f"SELECT count(*) FROM cash_game_horse_releases WHERE game_id='{target}' AND horse_id='{horse(21)}'",0)
        selected_reserve="SET test.engine='true';SELECT fn_cash_game_horse_arrival_reserve('"+target+"',"+arr([2,3,4])+",'20000000-0000-0000-0000-000000005000',0)"
        sql(selected_reserve)
        for i in [2,3,4]:sql(buyin(i,target_table))
        scalar(f"SELECT count(*) FROM cash_game_horse_releases WHERE game_id='{target}'",4)
        scalar(f"SELECT fn_cash_game_horse_arrival_snapshot('{target}')->>'new_identity_capacity'",0)
        # Existing humans and a repeated same-seat update consume no new slot.
        sql(f"UPDATE table_seats SET stack=stack+1 WHERE table_id='{target_table}' AND user_id='{horse(99)}'")
        scalar(f"SELECT count(*) FROM cash_game_horse_releases WHERE game_id='{target}'",4)
        print(json.dumps({'status':'passed','database':'isolated PostgreSQL17','actual_original_component':'October27 horse seat guard','coverage':['live-auth','creator-rollback-idempotency','main-feeder-markers','early-start','exact-roster','engine-only-reservation','initial-four','actual-admission-cadence','unknown-replay','post-trigger-wallet-and-arrival-rollback','humans','rejoin','unrelated-games','concurrent-reservation-and-entry','no-catchup','stale-reservation-replacement','disabled-game','freeze','exactly-twenty','direct-write-denied','existing-game-auth-shape-freeze','attachment-no-seat-or-wallet-mutation','actual-observed-selected-timestamp','offlist-observed-not-privileged','existing-seat-update-preserved','offlist-rejoin-refused','attachment-idempotency','remaining-initial-capacity','concurrent-prepolicy-admission','busy-game-row-nowait','maintenance-lock-refusal','retained-owned-move-refusal-preserves-source-chair-and-stack']}))
    finally:
        run(PG+'/pg_ctl','-D',str(data),'-m','immediate','-w','stop')
