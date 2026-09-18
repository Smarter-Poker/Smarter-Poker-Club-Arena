"""Bounded native index-writer probe; no production connections or financial qualification."""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import platform
import select
import shutil
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, required=True)
parser.add_argument('--migration', type=pathlib.Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
root = pathlib.Path(__file__).resolve().parents[2]
baseline = json.loads((root / 'scripts/ci/probes/hand-index-writer-order/baseline.json').read_text())
pg = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
assert shutil.disk_usage('/tmp').free > 2 * 1024**3
cluster = pathlib.Path(tempfile.mkdtemp(prefix='ca-index-order-', dir='/tmp'))
sock = cluster / 'socket'
sock.mkdir()
psql = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(sock),
        '-p', '55839', '-U', 'postgres', '-d', 'postgres']
sessions = []
checks = []
started = False

def run(command, source=None):
    r = subprocess.run([str(x) for x in command], input=source, text=True,
                       capture_output=True, env=env, timeout=25)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()

def sql(source):
    return run(psql, source)

def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS:', name, flush=True)

class Session:
    def __init__(self, name):
        self.name = name
        self.err = tempfile.TemporaryFile()
        self.process = subprocess.Popen(psql, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.err, env={**env, 'PGAPPNAME': name})
        self.buf = b''
        self.number = 0
        sessions.append(self)

    def send(self, source):
        self.number += 1
        self.marker = ('READY_' + str(self.number)).encode()
        self.process.stdin.write((source + '\n\\echo ' + self.marker.decode() + '\n').encode())
        self.process.stdin.flush()

    def finish(self):
        deadline = time.monotonic() + 15
        lines = []
        while time.monotonic() < deadline:
            while b'\n' in self.buf:
                line, self.buf = self.buf.split(b'\n', 1)
                if line == self.marker:
                    return {'ok': True, 'output': b'\n'.join(lines).decode()}
                lines.append(line)
            if self.process.poll() is not None:
                self.err.seek(0)
                return {'ok': False, 'error': self.err.read().decode()}
            if select.select([self.process.stdout], [], [], .03)[0]:
                self.buf += os.read(self.process.stdout.fileno(), 65536)
        raise TimeoutError(self.name + ' exceeded private deadline')

    def execute(self, source):
        self.send(source)
        r = self.finish()
        if not r['ok']:
            raise RuntimeError(r['error'])
        return r['output']

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=3)
        self.err.close()

def await_wait(name, event):
    until = time.monotonic() + 8
    while time.monotonic() < until:
        if sql(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{name}' AND wait_event='{event}';") == '1':
            return
        time.sleep(.04)
    raise AssertionError(name + ' did not reach ' + event)

H = '00000000-0000-0000-0000-000000000101'
T = '00000000-0000-0000-0000-000000000201'
C = '00000000-0000-0000-0000-000000000301'
# Keep the synthetic hand and both cursors close to the private clock. A fixed
# September 13 seed grows the every-seat scan each day and exhausts the session
# deadline on hosted workers; the contention and every assertion stay unchanged.
fixture_hand = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=2)
HAND_AT = fixture_hand.isoformat()
FLOOR_AT = (fixture_hand - datetime.timedelta(hours=1)).isoformat()
LATER_AT = (fixture_hand + datetime.timedelta(hours=1)).isoformat()
project = f"SELECT public.fn_project_hand_side_effects_after_post_commit_20260908('{H}');"
refresh = 'SELECT * FROM public.ca_refresh_hand_player_index(3000);'
every = 'SELECT public.ca_index_every_seat(60);'

def seed(n):
    players = json.dumps([{'userId': f'00000000-0000-0000-0000-{i:012d}', 'stack': 100} for i in range(1, n+1)])
    sql(f"""TRUNCATE hand_history,hand_projection_outbox,ca_hand_player_idx,trace;
      INSERT INTO hand_history(id,created_at,players,table_id,hand_number,tournament_id)
      VALUES('{H}','{HAND_AT}','{players}','{T}',1,NULL);
      INSERT INTO hand_projection_outbox VALUES('{H}','{T}',1);
      UPDATE ca_hand_player_idx_state SET idx_floor='{FLOOR_AT}',idx_ceil='{FLOOR_AT}',backfill_complete=true,rows_indexed=0;
      UPDATE ca_idx_every_seat_state SET cursor_at='{FLOOR_AT}',done=false,hands_seen=0,rows_added=0;""")

def trace_order(statement):
    return json.loads(sql('BEGIN; '+statement+" SELECT coalesce(json_agg(user_id ORDER BY seq),'[]') FROM trace; ROLLBACK;").splitlines()[-1])

def candidate_definition(item):
    s = item['definition']
    name = item['signature']
    if name.startswith(('ca_refresh_', 'ca_index_')):
        needle = 'SELECT user_id, created_at, hand_id FROM expanded'
        expected = 2 if name.startswith('ca_refresh_') else 1
        assert s.count(needle) == expected
        s = s.replace(needle, needle + '\n      ORDER BY user_id, hand_id, created_at')
        key = 'ca_refresh_hand_player_index' if name.startswith('ca_refresh_') else 'ca_index_every_seat'
        assert s.count("hashtext('" + key + "')") == 1
        s = s.replace("hashtext('" + key + "')", "hashtext('ca_hand_player_idx_background')")
    else:
        start = s.index('  INSERT INTO public.ca_hand_player_idx(')
        end = s.index('  ON CONFLICT DO NOTHING;', start)
        s = s[:end] + '  ORDER BY 1, 3\n' + s[end:]
    return s

try:
    version = run([pg / 'postgres', '--version'])
    check('uses existing PostgreSQL17 runtime', 'PostgreSQL) 17.' in version)
    run([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    run([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'log', '-o',
         f"-k {sock} -p 55839 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=8 -c deadlock_timeout=200ms", '-w', 'start'])
    started = True
    # Unordered DISTINCT must remain safe when PostgreSQL selects hash aggregation.
    # The first small-fixture attempt chose sorted aggregation and did not reproduce.
    # This private planner setting exercises the other legal execution plan.
    sql("ALTER ROLE postgres SET enable_sort=off; ALTER ROLE postgres SET work_mem='32MB';")
    sql("""CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE SCHEMA cron; CREATE TABLE cron.job(jobname text);
      CREATE FUNCTION cron.unschedule(text) RETURNS boolean LANGUAGE sql AS 'SELECT true';
      CREATE TABLE hand_history(id uuid PRIMARY KEY,created_at timestamptz,players jsonb,table_id uuid,hand_number bigint,tournament_id uuid,big_blind numeric,winners jsonb,rake_amount numeric,bbj_amount numeric,pot_size numeric);
      CREATE TABLE hand_projection_outbox(hand_id uuid PRIMARY KEY,table_id uuid,hand_number bigint);
      CREATE TABLE clubs(id uuid PRIMARY KEY,asset text);
      CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,tournament_id uuid);
      CREATE TABLE ca_hand_player_idx(user_id uuid,created_at timestamptz,hand_id uuid,PRIMARY KEY(user_id,hand_id));
      CREATE INDEX idx_ca_hand_player_idx_hand_id ON ca_hand_player_idx(hand_id);
      CREATE INDEX idx_ca_hand_player_idx_user_time ON ca_hand_player_idx(user_id,created_at DESC);
      CREATE TABLE ca_hand_player_idx_state(id boolean PRIMARY KEY CHECK(id),idx_floor timestamptz,idx_ceil timestamptz,backfill_complete boolean,rows_indexed bigint,updated_at timestamptz);
      INSERT INTO ca_hand_player_idx_state(id) VALUES(true);
      CREATE TABLE ca_idx_every_seat_state(id boolean PRIMARY KEY CHECK(id),cursor_at timestamptz,done boolean,hands_seen bigint,rows_added bigint,updated_at timestamptz);
      INSERT INTO ca_idx_every_seat_state(id) VALUES(true);
      CREATE TABLE ca_hand_player_stat(user_id uuid,hand_id uuid,created_at timestamptz,is_cash boolean,tournament_id uuid,game_variant text,big_blind numeric,small_blind numeric,n_players integer,seat_position text,my_blind numeric,won_amt numeric,is_winner boolean,invested_actions numeric,aggro_cnt integer,call_cnt integer,vpip boolean,pfr boolean,folded boolean,three_bet boolean,three_bet_opp boolean,faced_three_bet boolean,folded_to_three_bet boolean,cbet_opp boolean,cbet_made boolean,showdown boolean,hand_secs numeric,profit numeric,PRIMARY KEY(user_id,hand_id));
      CREATE FUNCTION ca_hand_player_facts_one(uuid,uuid) RETURNS SETOF ca_hand_player_stat LANGUAGE sql AS 'SELECT * FROM ca_hand_player_stat WHERE false';
      CREATE TABLE trace(seq bigserial,user_id uuid);
      CREATE FUNCTION fixture_index_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE n int:=coalesce(nullif(current_setting('fixture.idx_seen',true),''),'0')::int; g int:=coalesce(nullif(current_setting('fixture.gate',true),''),'0')::int;
      BEGIN PERFORM set_config('fixture.idx_seen',(n+1)::text,true);
        IF g>0 AND n=1 THEN PERFORM pg_advisory_xact_lock(91842,g); END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fixture_gate BEFORE INSERT ON ca_hand_player_idx FOR EACH ROW EXECUTE FUNCTION fixture_index_gate();
      CREATE FUNCTION fixture_index_trace() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN INSERT INTO trace(user_id) VALUES(NEW.user_id); RETURN NEW; END$$;
      CREATE TRIGGER fixture_trace AFTER INSERT ON ca_hand_player_idx FOR EACH ROW EXECUTE FUNCTION fixture_index_trace();""")
    sql(f"INSERT INTO clubs VALUES('{C}','diamonds'); INSERT INTO tables VALUES('{T}','{C}',NULL);")
    for item in baseline:
        sql(item['definition'])
        check('captured body matches '+item['signature'], sql("SELECT md5(pg_get_functiondef('"+item['signature']+"'::regprocedure));") == item['md5'])
        sql('REVOKE ALL ON FUNCTION '+item['signature']+' FROM PUBLIC;')
        if item['signature'].startswith(('ca_refresh_', 'ca_index_')):
            sql('GRANT EXECUTE ON FUNCTION '+item['signature']+' TO service_role;')
    before_authority=sql("SELECT jsonb_agg(jsonb_build_object('name',oid::regprocedure::text,'owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef) ORDER BY oid::regprocedure::text) FROM pg_proc WHERE proname IN ('ca_refresh_hand_player_index','ca_index_every_seat','fn_project_hand_side_effects_after_post_commit_20260908','trg_ca_stats_live_from_hand');")
    selected = None
    for n in [2,3,4,5,8,12,20,32]:
        seed(n)
        a,b = trace_order(refresh),trace_order(project)
        if a and b and a[0] != b[0]:
            selected=(n,a,b)
            break
    (args.output/'BASELINE-ORDERS.json').write_text(json.dumps({'selected':selected},indent=2))
    check('actual baseline refresh and projector visit common keys in different orders', selected is not None)
    n=selected[0]
    seed(n)
    gate=Session('index-gate')
    gate.execute('BEGIN; SELECT pg_advisory_xact_lock(91842,1),pg_advisory_xact_lock(91842,2);')
    a,b=Session('index-baseline-refresh'),Session('index-baseline-project')
    a.send("BEGIN; SET LOCAL fixture.gate='1'; "+refresh+' COMMIT;')
    b.send("BEGIN; SET LOCAL fixture.gate='2'; "+project+' COMMIT;')
    await_wait(a.name,'advisory'); await_wait(b.name,'advisory')
    gate.execute('COMMIT;')
    failures=[a.finish(),b.finish()]
    (args.output/'BASELINE-DEADLOCK.json').write_text(json.dumps(failures,indent=2))
    check('real captured writers reproduce unique-index deadlock', any('deadlock detected' in x.get('error','') for x in failures))
    candidates=[]
    sql(args.migration.read_text())
    for item in baseline:
        definition=candidate_definition(item)
        post_md5=sql("SELECT md5(pg_get_functiondef('"+item['signature']+"'::regprocedure));")
        check('migration installs exact candidate '+item['signature'],post_md5==hashlib.md5(definition.encode()).hexdigest())
        candidates.append({**item,'definition':definition,'post_md5':post_md5})
    after_authority=sql("SELECT jsonb_agg(jsonb_build_object('name',oid::regprocedure::text,'owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef) ORDER BY oid::regprocedure::text) FROM pg_proc WHERE proname IN ('ca_refresh_hand_player_index','ca_index_every_seat','fn_project_hand_side_effects_after_post_commit_20260908','trg_ca_stats_live_from_hand');")
    check('all original owners, permissions, timeouts and security settings retained',before_authority==after_authority)
    sql(args.migration.read_text())
    check('migration is safely repeatable on exact postimages',all(sql("SELECT md5(pg_get_functiondef('"+r['signature']+"'::regprocedure));")==r['post_md5'] for r in candidates))
    (args.output/'CANDIDATES.json').write_text(json.dumps(candidates,indent=2))
    for first,second,label in [(refresh,project,'refresh-first'),(project,refresh,'project-first'),(every,project,'every-seat-first'),(project,every,'project-before-every-seat')]:
        seed(n)
        gate.execute('BEGIN; SELECT pg_advisory_xact_lock(91842,1);')
        a,b=Session('index-'+label+'-a'),Session('index-'+label+'-b')
        a.send("BEGIN; SET LOCAL fixture.gate='1'; "+first+' COMMIT;')
        await_wait(a.name,'advisory')
        b.send('BEGIN; '+second+' COMMIT;')
        await_wait(b.name,'transactionid')
        gate.execute('COMMIT;')
        out=[a.finish(),b.finish()]
        check(label+' completes without deadlock',all(x['ok'] for x in out))
        check(label+' preserves every unique seat',sql('SELECT count(*) FROM ca_hand_player_idx;') == str(n))
        check(label+' atomically drains the exact outbox',sql('SELECT count(*) FROM hand_projection_outbox;') == '0')
        a.close();b.close()
    for first,second,label in [(refresh,every,'refresh-owns-background'),(every,refresh,'every-seat-owns-background')]:
        seed(n)
        gate.execute('BEGIN; SELECT pg_advisory_xact_lock(91842,1);')
        a,b=Session('index-'+label+'-a'),Session('index-'+label+'-b')
        a.send("BEGIN; SET LOCAL fixture.gate='1'; "+first+' COMMIT;')
        await_wait(a.name,'advisory')
        out=b.execute(second)
        check(label+' contender defers before writing', 'locked' in out or '0|0|||f' in out)
        gate.execute('COMMIT;')
        check(label+' holder completes',a.finish()['ok'])
        b.execute(second)
        check(label+' subsequent run preserves full index',sql('SELECT count(*) FROM ca_hand_player_idx;')==str(n))
        a.close();b.close()
    seed(n)
    sql('BEGIN; '+refresh+' ROLLBACK;')
    check('rollback retains original cursor and removes all index writes',sql(f"SELECT (SELECT count(*) FROM ca_hand_player_idx)=0 AND idx_ceil='{FLOOR_AT}'::timestamptz FROM ca_hand_player_idx_state;")=='t')
    sql('BEGIN; '+project+' ROLLBACK;')
    check('rollback retains exact outbox and no partial index',sql('SELECT (SELECT count(*) FROM ca_hand_player_idx)=0 AND (SELECT count(*) FROM hand_projection_outbox)=1;')=='t')
    sql('CREATE TRIGGER fixture_legacy AFTER UPDATE ON hand_history FOR EACH ROW EXECUTE FUNCTION trg_ca_stats_live_from_hand();')
    legacy=f"UPDATE hand_history SET players=players WHERE id='{H}';"
    for first,second,label in [(refresh,legacy,'refresh-vs-legacy'),(legacy,refresh,'legacy-vs-refresh')]:
        seed(n)
        gate.execute('BEGIN; SELECT pg_advisory_xact_lock(91842,1);')
        a,b=Session('index-'+label+'-a'),Session('index-'+label+'-b')
        a.send("BEGIN; SET LOCAL fixture.gate='1'; "+first+' COMMIT;')
        await_wait(a.name,'advisory')
        b.send('BEGIN; '+second+' COMMIT;')
        await_wait(b.name,'transactionid')
        gate.execute('COMMIT;')
        check(label+' remains deadlock free',a.finish()['ok'] and b.finish()['ok'])
        check(label+' preserves every seat',sql('SELECT count(*) FROM ca_hand_player_idx;')==str(n))
        a.close();b.close()
    seed(n)
    sql("BEGIN; SET LOCAL app.atomic_hand_commit='on'; "+legacy+' COMMIT;')
    check('atomic-hand legacy trigger exclusion remains intact',sql('SELECT count(*) FROM ca_hand_player_idx;')=='0')
    check('browser roles cannot execute either bulk writer',sql("SELECT NOT has_function_privilege('anon','ca_refresh_hand_player_index(integer)','EXECUTE') AND NOT has_function_privilege('authenticated','ca_index_every_seat(integer)','EXECUTE');")=='t')
    check('service role retains both bulk writer permissions',sql("SELECT has_function_privilege('service_role','ca_refresh_hand_player_index(integer)','EXECUTE') AND has_function_privilege('service_role','ca_index_every_seat(integer)','EXECUTE');")=='t')
    seed(n)
    sql(f"UPDATE ca_hand_player_idx_state SET idx_floor='{LATER_AT}',idx_ceil='{LATER_AT}',backfill_complete=false;")
    sql(refresh)
    check('backward fill retains every seat and its exact floor',sql("SELECT (SELECT count(*) FROM ca_hand_player_idx)="+str(n)+f" AND idx_floor='{HAND_AT}'::timestamptz AND backfill_complete FROM ca_hand_player_idx_state;")=='t')
    for statement,label in [(refresh,'refresh'),(project,'projector'),(every,'every-seat')]:
        seed(2)
        extra=json.dumps([{'userId':'00000000-0000-0000-0000-000000000001'}, {'userId':'3ebbefd2-c468-4853-8576-10104335b319'}, {'userId':'invalid'}, {'userId':None}, {}])
        sql("BEGIN; SET LOCAL app.atomic_hand_commit='on'; UPDATE hand_history SET players=players||'"+extra+"'::jsonb; COMMIT;")
        sql(statement)
        check(label+' retains legacy and modern UUIDs once and excludes malformed identities',sql('SELECT count(*) FROM ca_hand_player_idx;')=='3')
    seed(n)
    sql(refresh)
    before=sql('SELECT jsonb_agg(to_jsonb(i) ORDER BY user_id,hand_id) FROM ca_hand_player_idx i;')
    sql(refresh)
    check('repeat index refresh preserves exact rows',sql('SELECT jsonb_agg(to_jsonb(i) ORDER BY user_id,hand_id) FROM ca_hand_player_idx i;')==before)
    for item in baseline:sql(item['definition'])
    changed=baseline[-1]['definition'].replace('BEGIN\n','BEGIN\n  -- fixture unexpected body\n',1)
    sql(changed)
    before=[sql("SELECT md5(pg_get_functiondef('"+i['signature']+"'::regprocedure));") for i in baseline]
    refused=subprocess.run(psql,input=args.migration.read_text(),text=True,capture_output=True,env=env,timeout=25)
    check('unrecognized last writer refuses migration before any body changes',refused.returncode!=0 and 'hand index writer changed' in refused.stderr and before==[sql("SELECT md5(pg_get_functiondef('"+i['signature']+"'::regprocedure));") for i in baseline])
    sql(baseline[-1]['definition'])
    sql('GRANT EXECUTE ON FUNCTION trg_ca_stats_live_from_hand() TO authenticated;')
    refused=subprocess.run(psql,input=args.migration.read_text(),text=True,capture_output=True,env=env,timeout=25)
    check('unexpected browser grant refuses migration',refused.returncode!=0 and 'hand index writer authority changed' in refused.stderr)
    sql('REVOKE EXECUTE ON FUNCTION trg_ca_stats_live_from_hand() FROM authenticated;')
    sql(args.migration.read_text())
    check('final four function hashes match qualified candidates',all(sql("SELECT md5(pg_get_functiondef('"+r['signature']+"'::regprocedure));")==r['post_md5'] for r in candidates))
    result={'checks':checks,'postgres':version,'platform':platform.platform(),'production_connections':0,
            'scope':'Real captured index refresh/every-seat/projector bodies; private minimal index fixture, enable_sort=off and work_mem=32MB exercise legal hash aggregation. Diamond branch avoids unrelated financial aggregates; facts-one returns no rows. Not full-schema money, rollup-retention, Linux or production qualification.',
            'migration_sha256':hashlib.sha256(args.migration.read_bytes()).hexdigest(),
            'runner_sha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}
    (args.output/'RESULT.json').write_text(json.dumps(result,indent=2))
except Exception as exc:
    (args.output/'FAILURE.json').write_text(json.dumps({'error':str(exc),'checks':checks},indent=2))
    raise
finally:
    for s in sessions:
        try:s.close()
        except Exception:pass
    if started:
        run([pg/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
    if (cluster/'log').exists():shutil.copyfile(cluster/'log',args.output/'postgres.log')
    shutil.rmtree(cluster)
