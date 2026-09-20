"""Bounded native stat-writer probe; no production connections or financial qualification."""
import argparse
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
baseline = json.loads((root / 'scripts/ci/probes/hand-stat-writer-order/baseline.json').read_text())
pg = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
assert shutil.disk_usage('/tmp').free > 2 * 1024**3
cluster = pathlib.Path(tempfile.mkdtemp(prefix='ca-stat-order-', dir='/tmp'))
sock = cluster / 'socket'
sock.mkdir()
psql = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(sock),
        '-p', '55859', '-U', 'postgres', '-d', 'postgres']
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


H='00000000-0000-0000-0000-000000000101'
T='00000000-0000-0000-0000-000000000201'
C='00000000-0000-0000-0000-000000000301'
A='00000000-0000-0000-0000-000000000001'
B='00000000-0000-0000-0000-000000000002'
project=f"SELECT public.fn_project_hand_side_effects_after_post_commit_20260908('{H}');"
forward='SELECT public.ca_roll_hand_stats_forward();'
backward='SELECT public.ca_roll_hand_stats(20);'
legacy=f"UPDATE hand_history SET players=players WHERE id='{H}';"
def seed():
    players=json.dumps([{'userId':A,'stack':110},{'userId':B,'stack':90}])
    sql(f'''TRUNCATE hand_history,hand_projection_outbox,ca_hand_player_idx,ca_hand_player_stat,fixture_facts,trace;
      INSERT INTO hand_history(id,created_at,players,table_id,hand_number,tournament_id)
      VALUES('{H}','2026-09-13 04:00:00+00','{players}','{T}',1,NULL);
      INSERT INTO hand_projection_outbox VALUES('{H}','{T}',1);
      INSERT INTO fixture_facts(user_id,hand_id,created_at,profit,n_players) VALUES
        ('{A}','{H}','2026-09-13 04:00:00+00',10,2),('{B}','{H}','2026-09-13 04:00:00+00',-10,2);
      UPDATE ca_hand_player_stat_state SET rolled_floor='2026-09-13 04:00:01+00',rolled_ceil='2026-09-13 03:59:59+00',complete=false,updated_at=NULL;''')
def facts():
    return sql('SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY user_id,hand_id),\'[]\'::jsonb) FROM ca_hand_player_stat s;')
def cursor():
    return sql('SELECT to_jsonb(s) FROM ca_hand_player_stat_state s;')
def authority():
    return sql("SELECT jsonb_agg(jsonb_build_object('name',oid::regprocedure::text,'owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef) ORDER BY oid::regprocedure::text) FROM pg_proc WHERE proname IN ('ca_roll_hand_stats_forward','ca_roll_hand_stats','fn_project_hand_side_effects_after_post_commit_20260908','trg_ca_stats_live_from_hand');")
def native_pair(first,second,label):
    seed()
    gate.execute('BEGIN; SELECT pg_advisory_xact_lock(91842,1);')
    a,b=Session(label+'-a'),Session(label+'-b')
    a.send("BEGIN; SET LOCAL fixture.gate='1'; "+first+' COMMIT;')
    await_wait(a.name,'advisory')
    b.send('BEGIN; '+second+' COMMIT;')
    await_wait(b.name,'transactionid')
    gate.execute('COMMIT;')
    check(label+' completes both real transactions',a.finish()['ok'] and b.finish()['ok'])
    check(label+' preserves both exact fact rows',facts()==expected_facts)
    if project in (first,second):check(label+' drains only its exact outbox',sql('SELECT count(*) FROM hand_projection_outbox;')=='0')
    a.close();b.close()

try:
    version=run([pg/'postgres','--version'])
    check('uses existing PostgreSQL17 runtime','PostgreSQL) 17.' in version)
    run([pg/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    run([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'log','-o',f"-k {sock} -p 55859 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=8 -c deadlock_timeout=200ms",'-w','start'])
    started=True
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

      CREATE INDEX idx_ca_hand_player_stat_hand_id ON ca_hand_player_stat(hand_id);
      CREATE INDEX idx_ca_hand_player_stat_user_time ON ca_hand_player_stat(user_id,created_at DESC);
      CREATE TABLE ca_hand_player_stat_state(id boolean PRIMARY KEY CHECK(id),rolled_floor timestamptz,rolled_ceil timestamptz,complete boolean,updated_at timestamptz);
      INSERT INTO ca_hand_player_stat_state(id) VALUES(true);
      CREATE TABLE fixture_facts(LIKE ca_hand_player_stat INCLUDING ALL);
      -- Legal differing SETOF orders. Only the captured writer bodies are under
      -- qualification here; these two facts helpers are explicit test inputs.
      CREATE FUNCTION ca_hand_player_facts_one(uuid,uuid) RETURNS SETOF ca_hand_player_stat LANGUAGE sql AS $$SELECT * FROM fixture_facts WHERE hand_id=$1 AND ($2 IS NULL OR user_id=$2) ORDER BY user_id$$;
      CREATE FUNCTION ca_hand_player_facts(timestamptz,timestamptz) RETURNS SETOF ca_hand_player_stat LANGUAGE sql AS $$SELECT * FROM fixture_facts WHERE created_at >= $1 AND created_at < $2 ORDER BY user_id DESC$$;
      CREATE TABLE trace(seq bigserial,user_id uuid);
      CREATE FUNCTION fixture_index_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE n int:=coalesce(nullif(current_setting('fixture.stat_seen',true),''),'0')::int; g int:=coalesce(nullif(current_setting('fixture.gate',true),''),'0')::int;
      BEGIN PERFORM set_config('fixture.stat_seen',(n+1)::text,true);
        IF g>0 AND n=1 THEN PERFORM pg_advisory_xact_lock(91842,g); END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fixture_gate BEFORE INSERT ON ca_hand_player_stat FOR EACH ROW EXECUTE FUNCTION fixture_index_gate();
      CREATE FUNCTION fixture_index_trace() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN INSERT INTO trace(user_id) VALUES(NEW.user_id); RETURN NEW; END$$;
      CREATE TRIGGER fixture_trace AFTER INSERT ON ca_hand_player_stat FOR EACH ROW EXECUTE FUNCTION fixture_index_trace();""")

    sql(f"INSERT INTO clubs VALUES('{C}','diamonds'); INSERT INTO tables VALUES('{T}','{C}',NULL);")
    for item in baseline:
        sql(item['definition'])
        sql('REVOKE ALL ON FUNCTION '+item['signature']+' FROM PUBLIC;')
        if item['signature'].startswith('ca_roll_'):sql('GRANT EXECUTE ON FUNCTION '+item['signature']+' TO service_role;')
        check('captured predecessor body matches '+item['signature'],sql("SELECT md5(pg_get_functiondef('"+item['signature']+"'::regprocedure));")==item['md5'])
    initial_authority=authority()
    seed()
    orders={}
    for label,statement in [('forward',forward),('project',project)]:
        orders[label]=json.loads(sql('BEGIN; '+statement+" SELECT json_agg(user_id ORDER BY seq) FROM trace; ROLLBACK;").splitlines()[-1])
    (args.output/'BASELINE-ORDERS.json').write_text(json.dumps(orders,indent=2))
    check('captured unordered writers accept differing legal SETOF orders',orders['forward']==[B,A] and orders['project']==[A,B])
    seed()
    gate=Session('stat-gate');gate.execute('BEGIN; SELECT pg_advisory_xact_lock(91842,1),pg_advisory_xact_lock(91842,2);')
    a,b=Session('stat-original-forward'),Session('stat-original-project')
    a.send("BEGIN; SET LOCAL fixture.gate='1'; "+forward+' COMMIT;')
    b.send("BEGIN; SET LOCAL fixture.gate='2'; "+project+' COMMIT;')
    await_wait(a.name,'advisory');await_wait(b.name,'advisory');gate.execute('COMMIT;')
    outcomes=[a.finish(),b.finish()]
    (args.output/'BASELINE-DEADLOCK.json').write_text(json.dumps(outcomes,indent=2))
    check('original forward and live projector reproduce unique-index deadlock',any('deadlock detected' in r.get('error','') for r in outcomes))
    a.close();b.close()
    seed();sql(project);expected_facts=facts()
    check('baseline writes fixture profits exactly once',sql('SELECT count(*)=2 AND sum(profit)=0 AND min(profit)=-10 AND max(profit)=10 FROM ca_hand_player_stat;')=='t')
    sql(args.migration.read_text())
    for item in baseline:
        check('guarded migration installs exact candidate '+item['signature'],sql("SELECT md5(pg_get_functiondef('"+item['signature']+"'::regprocedure));")==item['candidate_md5'])
    check('all owners ACLs timeouts and security settings retained',authority()==initial_authority)
    sql(args.migration.read_text())
    check('exact candidate migration replay succeeds',authority()==initial_authority)
    for first,second,label in [(forward,project,'forward-project'),(project,forward,'project-forward'),(backward,project,'backward-project'),(project,backward,'project-backward')]:
        native_pair(first,second,label)
    for first,second,label in [(forward,backward,'forward-owns-bulk'),(backward,forward,'backward-owns-bulk')]:
        seed();before_cursor=cursor()
        gate.execute('BEGIN; SELECT pg_advisory_xact_lock(91842,1);')
        a,b=Session(label+'-a'),Session(label+'-b')
        a.send("BEGIN; SET LOCAL fixture.gate='1'; "+first+' COMMIT;')
        await_wait(a.name,'advisory')
        check(label+' contender returns without awaiting live bulk holder',b.execute(second)=='0')
        check(label+' contender does not change a cursor',cursor()==before_cursor)
        gate.execute('COMMIT;');check(label+' holder completes',a.finish()['ok'])
        b.execute(second);check(label+' deferred run later preserves complete facts',facts()==expected_facts)
        a.close();b.close()
    sql('CREATE TRIGGER fixture_legacy AFTER UPDATE ON hand_history FOR EACH ROW EXECUTE FUNCTION trg_ca_stats_live_from_hand();')
    for first,second,label in [(forward,legacy,'forward-legacy'),(legacy,forward,'legacy-forward'),(backward,legacy,'backward-legacy'),(legacy,backward,'legacy-backward')]:
        native_pair(first,second,label)
    seed();sql("BEGIN; SET LOCAL app.atomic_hand_commit='on'; "+legacy+' COMMIT;')
    check('atomic hand exclusion retains exact empty index and facts',sql('SELECT (SELECT count(*) FROM ca_hand_player_stat)=0 AND (SELECT count(*) FROM ca_hand_player_idx)=0;')=='t')
    for statement,label in [(forward,'forward'),(backward,'backward'),(project,'project')]:
        seed();before_cursor=cursor()
        sql('BEGIN; '+statement+' ROLLBACK;')
        check(label+' rollback preserves all facts cursor and exact outbox',facts()=='[]' and cursor()==before_cursor and sql('SELECT count(*) FROM hand_projection_outbox;')=='1')
        sql(statement);first_facts=facts();sql(statement)
        check(label+' replay does not duplicate facts or change arithmetic',facts()==first_facts==expected_facts)
    seed()
    sql(f"""INSERT INTO ca_hand_player_stat(user_id,hand_id,created_at,profit)
      SELECT '{A}',('11111111-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,
      '2026-09-12 00:00:00+00'::timestamptz+g*interval '1 second',g::numeric FROM generate_series(1,1001)g;""")
    retained=facts();before_cursor=cursor()
    sql('BEGIN; '+forward+' ROLLBACK;')
    check('retention rollback preserves every original row and cursor',facts()==retained and cursor()==before_cursor)
    sql(forward)
    check('unchanged retention keeps exactly latest1000 plus other player',sql(f"SELECT count(*)=1000 AND bool_or(hand_id='{H}') AND min(created_at)='2026-09-12 00:00:03+00'::timestamptz FROM ca_hand_player_stat WHERE user_id='{A}';")=='t' and sql(f"SELECT count(*) FROM ca_hand_player_stat WHERE user_id='{B}';")=='1')
    check('browser roles cannot execute bulk writers',sql("SELECT NOT has_function_privilege('anon','ca_roll_hand_stats_forward()','EXECUTE') AND NOT has_function_privilege('authenticated','ca_roll_hand_stats(integer)','EXECUTE');")=='t')
    check('service role retains both bulk writer entry points',sql("SELECT has_function_privilege('service_role','ca_roll_hand_stats_forward()','EXECUTE') AND has_function_privilege('service_role','ca_roll_hand_stats(integer)','EXECUTE');")=='t')
    for item in baseline:sql(item['definition'])
    changed=baseline[-1]['definition'].replace('BEGIN\n','BEGIN\n -- unexpected private fixture drift\n',1);sql(changed)
    hashes=lambda:[sql("SELECT md5(pg_get_functiondef('"+x['signature']+"'::regprocedure));") for x in baseline]
    before=hashes()
    refused=subprocess.run(psql,input=args.migration.read_text(),text=True,capture_output=True,env=env,timeout=25)
    check('last-writer drift refuses atomically before changing first writer',refused.returncode!=0 and 'hand stat writer changed' in refused.stderr and hashes()==before)
    sql(baseline[-1]['definition'])
    sql('GRANT EXECUTE ON FUNCTION trg_ca_stats_live_from_hand() TO authenticated;')
    refused=subprocess.run(psql,input=args.migration.read_text(),text=True,capture_output=True,env=env,timeout=25)
    check('unexpected browser grant refuses all DDL',refused.returncode!=0 and 'hand stat writer authority changed' in refused.stderr)
    sql('REVOKE EXECUTE ON FUNCTION trg_ca_stats_live_from_hand() FROM authenticated;')
    original=json.loads((root/'scripts/ci/probes/hand-index-writer-order/baseline.json').read_text())
    prior=next(x for x in original if x['signature'].startswith('trg_'))
    sql(prior['definition'])
    refused=subprocess.run(psql,input=args.migration.read_text(),text=True,capture_output=True,env=env,timeout=25)
    check('missing index-order predecessor is refused',refused.returncode!=0 and 'hand stat writer changed' in refused.stderr)
    sql(baseline[-1]['definition']);sql(args.migration.read_text())
    check('final four hashes retain exactly the tested candidates',hashes()==[x['candidate_md5'] for x in baseline])
    result={'passed':True,'checks':checks,'postgres':version,'platform':platform.platform(),'production_connections':0,'scope':'Captured four writer bodies after exact index-order predecessor; minimal schema and explicit legal differing SETOF fact fixtures, two live transactions, bulk deferral, retention and rollback. Diamond projector branch avoids unrelated financial aggregates; legacy uses private UPDATE binding. Not real facts-helper, full current financial schema, Linux, installed or production qualification.','migration_sha256':hashlib.sha256(args.migration.read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}
    (args.output/'RESULT.json').write_text(json.dumps(result,indent=2))
except Exception as exc:
    (args.output/'FAILURE.json').write_text(json.dumps({'error':str(exc),'checks':checks},indent=2))
    raise
finally:
    for session in sessions:
        try:session.close()
        except Exception:pass
    if started:run([pg/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
    if (cluster/'log').exists():shutil.copyfile(cluster/'log',args.output/'postgres.log')
    shutil.rmtree(cluster)
