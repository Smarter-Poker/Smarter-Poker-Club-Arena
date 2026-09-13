#!/usr/bin/env python3
"""Native atomic blind publication and table-birth races on synthetic rows.

The scoped settlement lock is captured SQL. Maintenance is an explicit fixture
boolean, and trusted request context is installed directly. This does not test
PostgREST authentication, real money settlement, or the full platform thaw.
"""
from pathlib import Path
import json
from datetime import datetime
import os
import shutil
import subprocess
import tempfile
import time

repo = Path(__file__).resolve().parents[2]
foundation = next((repo / 'supabase/migrations').glob('*_tournament_blinds_publish_as_one_field.sql'))
migration = next((repo / 'supabase/migrations').glob('*_tournament_blind_publication_authority.sql'))
addon_guard = next((repo / 'supabase/migrations').glob('*_tournament_blind_publication_respects_addon_pause.sql'))
publication_sql = migration.read_text()+addon_guard.read_text()
configured = os.environ.get('POKER_AUDIT_PG_BIN') or os.environ.get('PGBIN')
pg = Path(configured) if configured else Path(subprocess.check_output(
    ['brew', '--prefix', 'postgresql@17'], text=True).strip()) / 'bin'
root = Path(tempfile.mkdtemp(prefix='ca-ab-'))
cluster, sock = root / 'db', root / 's'
sock.mkdir()
port = str(35000 + os.getpid() % 10000)
env = dict(os.environ, PGHOST=str(sock), PGHOSTADDR='', PGPORT=port, PGUSER='postgres', PGDATABASE='postgres')
event = 'c5000000-0000-4000-8000-000000000001'
other = 'c5000000-0000-4000-8000-000000000002'
generation = 'c5000000-0000-4000-8000-000000000003'
table1 = 'c5000000-0000-4000-8000-000000000011'
table2 = 'c5000000-0000-4000-8000-000000000012'
late = 'c5000000-0000-4000-8000-000000000013'
anchor = '2026-09-13T12:10:00Z'
authority = f"SET app.smarter_data_actor='tournament-manager'; SET app.smarter_tournament_id='{event}'; SET app.smarter_tournament_lease_generation='{generation}';"
request = f"SELECT public.fn_publish_tournament_blind_level('{event}','{generation}',0,1,20,40,4);"
fingerprint = "SELECT md5(jsonb_build_array((SELECT jsonb_agg(t ORDER BY id) FROM tournaments t),(SELECT jsonb_agg(t ORDER BY id) FROM tables t))::text);"
passed = []
started = False
children = []
counter = 0

with (root/'results.log').open('w') as log:
    def command(args):
        subprocess.run(args,stdout=log,stderr=log,check=True,timeout=40)

    def q(sql,error=None):
        with tempfile.TemporaryFile(mode='w+') as request_file:
            request_file.write(sql+'\n'); request_file.seek(0)
            result=subprocess.run([str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1'],stdin=request_file,capture_output=True,text=True,env=env,timeout=20)
        log.write(result.stdout+result.stderr); log.flush()
        if error:
            assert result.returncode!=0 and error in result.stderr,result.stderr
        else:
            assert result.returncode==0,result.stderr
        return result.stdout.strip()

    def call(sql=request,error=None,extra=''):
        return q(authority+extra+' SET ROLE service_role; '+sql,error)

    def ok(name):
        passed.append(name); print('PASS '+name,flush=True)

    def reset():
        q('CHECKPOINT;')
        q(f"""TRUNCATE public.tables,public.tournaments,public.engine_tournament_leases;
          UPDATE fixture_maintenance SET frozen=false;
          INSERT INTO tournaments(id) VALUES('{event}'),('{other}');
          INSERT INTO engine_tournament_leases(tournament_id,lease_generation,protocol_version,heartbeat_at) VALUES('{event}','{generation}',2,clock_timestamp());
          INSERT INTO tables(id,tournament_id) VALUES('{table1}','{event}'),('{table2}','{event}');
          INSERT INTO tables(id,tournament_id,status) VALUES('c5000000-0000-4000-8000-000000000021','{event}','closed');
          INSERT INTO tables(id,tournament_id) VALUES('c5000000-0000-4000-8000-000000000022','{other}'),('c5000000-0000-4000-8000-000000000023',NULL);
        """)

    def spawn(sql,name):
        global counter
        counter+=1
        request_file=root/f'async-{counter}.sql';request_file.write_text(authority+f"SET application_name='{name}';"+sql+'\n')
        stream=request_file.open();output=(root/f'async-{counter}.log').open('w+')
        process=subprocess.Popen([str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1'],stdin=stream,stdout=output,stderr=output,env=env)
        child=(process,stream,output);children.append(child);return child

    def finish(child):
        process,stream,output=child
        process.wait(timeout=15);output.seek(0);text=output.read();log.write(text);log.flush()
        assert process.returncode==0,text
        stream.close();output.close();children.remove(child);return text.strip()

    def wait_for(name,kind):
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            if q(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{name}' AND wait_event_type='{kind}';")=='1':return
            time.sleep(.03)
        raise AssertionError('did not observe '+name+' waiting on '+kind)

    try:
        assert ' 17.' in subprocess.check_output([str(pg/'postgres'),'--version'],text=True)
        command([str(pg/'initdb'),'-D',str(cluster),'-U','postgres','--auth=trust','--no-locale'])
        command([str(pg/'pg_ctl'),'-D',str(cluster),'-o',f'-k {sock} -p {port} -c listen_addresses= -c max_wal_size=64MB -c min_wal_size=32MB','-w','start']);started=True
        q("""CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
          CREATE TABLE tournaments(id uuid PRIMARY KEY,status text DEFAULT 'RUNNING',current_level int DEFAULT 0,level_started_at timestamptz DEFAULT '2026-09-13T12:00:00Z',on_break boolean DEFAULT false,add_on_available boolean DEFAULT false,addon_period_triggered boolean DEFAULT false,prize_pool_finalized boolean DEFAULT false,addon_period_ends_at timestamptz,addon_break_minutes integer);
          CREATE TABLE tables(id uuid PRIMARY KEY,tournament_id uuid REFERENCES tournaments(id),status text DEFAULT 'running',is_deleted boolean DEFAULT false,small_blind numeric DEFAULT 10,big_blind numeric DEFAULT 20,ante numeric DEFAULT 2,stakes text DEFAULT '10/20');
          CREATE TABLE engine_tournament_leases(tournament_id uuid PRIMARY KEY,lease_generation uuid,protocol_version int,heartbeat_at timestamptz,instance_id text,engine_version text,acquired_at timestamptz);
          CREATE TABLE fixture_maintenance(frozen boolean);INSERT INTO fixture_maintenance VALUES(false);
          CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT frozen FROM fixture_maintenance$$;
          CREATE FUNCTION fixture_blind_fault() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF current_setting('test.suppress_relation',true)=TG_TABLE_NAME THEN RETURN NULL; END IF;
            IF current_setting('test.alter_relation',true)=TG_TABLE_NAME THEN
              IF TG_TABLE_NAME='tables' THEN NEW.big_blind:=NEW.big_blind+1; ELSE NEW.current_level:=NEW.current_level+1; END IF;
            END IF;
            IF current_setting('test.fail_relation',true)=TG_TABLE_NAME THEN RAISE EXCEPTION 'fixture write failure'; END IF;
            IF TG_TABLE_NAME='tournaments' AND current_setting('test.pause_publish',true)='on' THEN PERFORM pg_sleep(2); END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER fixture_parent_fault BEFORE UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fixture_blind_fault();
          CREATE TRIGGER fixture_table_fault BEFORE UPDATE ON tables FOR EACH ROW EXECUTE FUNCTION fixture_blind_fault();
        """)
        q((repo/'scripts/dev/fixtures/atomic-blind-publication/settlement-lock.sql').read_text())
        q((repo/'scripts/dev/fixtures/atomic-blind-publication/claim-lease.sql').read_text())
        q(foundation.read_text());q(publication_sql);q(foundation.read_text());q(publication_sql);reset()
        holder=spawn('BEGIN;LOCK TABLE tables IN ROW EXCLUSIVE MODE;SELECT pg_sleep(2);SELECT count(*) FROM tournaments;COMMIT;','ddl-busy-fleet');wait_for('ddl-busy-fleet','Timeout')
        attempted=time.monotonic();q(foundation.read_text());assert time.monotonic()-attempted<1
        installer=spawn(publication_sql,'ddl-authority');wait_for('ddl-authority','Lock')
        finish(holder);finish(installer)
        ok('separate schema phases let table writers read the parent without the combined DDL lock cycle')
        before_publish=time.time()
        receipt=json.loads(call());assert receipt['ok'] and receipt['tables_updated']==2
        assert before_publish<=datetime.fromisoformat(receipt['level_started_at']).timestamp()<=time.time()
        assert q(f"SELECT count(*) FROM tables WHERE tournament_id='{event}' AND status='running' AND (small_blind,big_blind,ante,stakes)=(20,40,4,'20/40');")=='2'
        assert q("SELECT count(*) FROM tables WHERE small_blind=10 AND big_blind=20;")=='3'
        assert q(f"SELECT current_level FROM tournaments WHERE id='{event}';")=='1'
        ok('one receipt publishes parent clock and all open tables without touching closed cash or other events')
        before=q(fingerprint);assert json.loads(call())['replayed'];assert q(fingerprint)==before
        ok('lost-response replay changes no table or clock')
        before_anchor=datetime.fromisoformat(receipt['level_started_at']).timestamp()
        q(f"UPDATE tournaments SET level_started_at=level_started_at+interval '5 minutes' WHERE id='{event}';")
        receipt=json.loads(call());assert datetime.fromisoformat(receipt['level_started_at']).timestamp()==before_anchor+300
        ok('replay after thaw retains the shifted durable anchor')
        q(f"INSERT INTO tables(id,tournament_id) VALUES('{late}','{event}');")
        assert q(f"SELECT (small_blind,big_blind,ante,stakes)=(20,40,4,'20/40') FROM tables WHERE id='{late}';")=='t'
        ok('late table birth ignores a stale proposed opening level')
        for relation in ['tables','tournaments']:
            reset();before=q(fingerprint);call(error='fixture write failure',extra=f"SET test.fail_relation='{relation}';");assert q(fingerprint)==before
            ok(relation+' failure rolls every level and table change back')
        for relation in ['tables','tournaments']:
            for mode in ['suppress','alter']:
                reset();before=q(fingerprint);call(error='not fully acknowledged',extra=f"SET test.{mode}_relation='{relation}';");assert q(fingerprint)==before
                ok(mode+' trigger on '+relation+' cannot acknowledge a partial publication')
        for flag in ['UPDATE fixture_maintenance SET frozen=true;',f"UPDATE tournaments SET on_break=true WHERE id='{event}';"]:
            reset();q(flag);before=q(fingerprint);assert json.loads(call())['reason']=='paused';assert q(fingerprint)==before
            ok('persisted pause authority refuses level publication: '+flag.split()[1])
        for remaining,minutes,paused in [(30,None,True),(90,None,False),(540,10,True),(630,11,False),(30,0,True),(-1,10,False)]:
            reset();q(f"UPDATE tournaments SET add_on_available=true,addon_period_triggered=true,addon_break_minutes={minutes if minutes is not None else 'NULL'},addon_period_ends_at=clock_timestamp()+interval '{remaining} seconds' WHERE id='{event}';")
            before=q(fingerprint);receipt=json.loads(call())
            if paused: assert receipt['reason']=='paused' and q(fingerprint)==before
            else: assert receipt['ok']
            ok(f'add-on final-segment gate remaining={remaining}s configured={minutes} paused={paused}')
        for override in ['prize_pool_finalized=true','addon_period_triggered=false','add_on_available=false']:
            reset();q(f"UPDATE tournaments SET add_on_available=true,addon_period_triggered=true,addon_period_ends_at=clock_timestamp()+interval '30 seconds' WHERE id='{event}';")
            q(f"UPDATE tournaments SET {override} WHERE id='{event}';");assert json.loads(call())['ok']
            ok('no add-on hold after '+override)
        reset();q(f"UPDATE tournaments SET status='COMPLETED' WHERE id='{event}';");before=q(fingerprint)
        assert json.loads(call())['reason']=='tournament_not_running';assert q(fingerprint)==before
        ok('terminal events cannot receive another level')
        reset();call();before=q(fingerprint);call(request.replace(',0,1,',',0,2,'),error='does not follow');assert q(fingerprint)==before
        ok('an obsolete previous level cannot overwrite a later publication')
        for expression in ['NULL','-1','10000001',"'NaN'::numeric","'Infinity'::numeric"]:
            reset();before=q(fingerprint);call(request.replace(',20,40,4)',f',20,{expression},4)'),error='Invalid tournament blind');assert q(fingerprint)==before
            ok('malformed blind amount is refused: '+expression)
        reset();before=q(fingerprint)
        for role in ['anon','authenticated']:
            q(authority+' SET ROLE '+role+';'+request,'permission denied')
        call(error='TOURNAMENT_MANAGER_FENCED',extra="SET app.smarter_data_actor='service';")
        call(error='TOURNAMENT_MANAGER_FENCED',extra=f"SET app.smarter_tournament_id='{other}';")
        q(f"UPDATE engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '31 seconds';")
        call(error='TOURNAMENT_MANAGER_FENCED');assert q(fingerprint)==before
        ok('browser generic service cross-event and stale-lease callers cannot publish')

        reset()
        publisher=spawn("SET test.pause_publish='on';"+request,'blind-publisher');wait_for('blind-publisher','Timeout')
        assert q(f"SELECT current_level FROM tournaments WHERE id='{event}';")=='0'
        assert q('SELECT count(*) FROM tables WHERE big_blind=40;')=='0'
        # KEY SHARE must let the existing generation renew while its work lives.
        q('SET lock_timeout=\'300ms\'; UPDATE engine_tournament_leases SET heartbeat_at=clock_timestamp();')
        birth=spawn(f"INSERT INTO tables(id,tournament_id) VALUES('{late}','{event}');",'blind-birth');wait_for('blind-birth','Lock')
        finish(publisher);finish(birth)
        assert q(f"SELECT count(*) FROM tables WHERE tournament_id='{event}' AND status='running' AND big_blind=40;")=='3'
        ok('concurrent birth waits for atomic publication; readers see no partial field and heartbeat remains writable')

        reset()
        publisher=spawn("SET test.pause_publish='on';"+request,'lease-held-publisher');wait_for('lease-held-publisher','Timeout')
        q("UPDATE engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '31 seconds';")
        claimant=spawn(f"SELECT granted FROM claim_tournament_lease_v2('{event}','replacement','fixture','{other}',30);",'next-generation');wait_for('next-generation','Lock')
        finish(publisher);assert finish(claimant)=='t'
        call(error='TOURNAMENT_MANAGER_FENCED')
        ok('actual generation takeover waits for publication then fences the old manager')

        reset()
        holder=spawn('BEGIN;SELECT pg_advisory_xact_lock(530090,1);UPDATE fixture_maintenance SET frozen=true;SELECT pg_sleep(2);COMMIT;','maintenance-holder');wait_for('maintenance-holder','Timeout')
        publisher=spawn(request,'maintenance-blocked-publisher');wait_for('maintenance-blocked-publisher','Lock')
        finish(holder);assert json.loads(finish(publisher))['reason']=='paused'
        assert q(f"SELECT current_level FROM tournaments WHERE id='{event}';")=='0'
        ok('maintenance transition wins its barrier before the waiting publication rechecks pause')
    finally:
        for process,stream,output in children:
            if process.poll() is None: process.terminate();process.wait(timeout=5)
            stream.close();output.close()
        if started:
            subprocess.run([str(pg/'pg_ctl'),'-D',str(cluster),'-m','fast','-w','stop'],stdout=log,stderr=log,check=True,timeout=30)
        shutil.rmtree(cluster,ignore_errors=True)

(root/'results.json').write_text(json.dumps({'passed':passed,'production_database_used':False,'scope':'Actual publication and birth trigger; synthetic tables, direct trusted context, explicit maintenance boolean'},indent=2)+'\n')
print(f'{len(passed)} groups passed; evidence: {root / "results.json"}')
