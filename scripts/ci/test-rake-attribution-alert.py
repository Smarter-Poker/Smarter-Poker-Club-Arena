"""Exercise the actual rake authority against real two-session lock failures.

Only an owned PostgreSQL 17 cluster is used. The settlement authority, lane
helper, guarded retry restoration and Diamond insertion are repository source.
Financial callees are explicit local transaction recorders: this qualifies the
retry/rollback boundary, not the entire accounting or Diamond implementation.
"""
import argparse
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import time
import uuid

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
a.output.mkdir(parents=True, exist_ok=False)
repo = Path(__file__).resolve().parents[2]
preimage = (repo/'scripts/ci/probes/rake-attribution-retry-native-preimage.sql').read_text()
restoration = (repo/'scripts/deploy/2026-09-10-restore-rake-attribution-retries.sql').read_text()
diamond = (repo/'supabase/migrations/20260914032315_a_diamond_tournament_pays_from_its_own_custody.sql').read_text()
start = diamond.index('-- 6. fn_settle_tournament_rake:')
start = diamond.index('DO $do$', start)
end = diamond.index('END $do$;', start) + len('END $do$;')
diamond = diamond[start:end]
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
assert shutil.disk_usage(tempfile.gettempdir()).free > 2*1024**3
cluster = Path(tempfile.mkdtemp(prefix='rake-alert-'))
sock = cluster/'sock'
sock.mkdir()
env = {k:v for k,v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
psql = [str(pg/'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(sock), '-p', '55796', '-U', 'postgres', '-d', 'postgres']
started = False
children = []
checks = []


def run(command, source=None):
    r = subprocess.run(list(map(str, command)), input=source, text=True, capture_output=True, env=env, timeout=25)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def sql(source):
    return run(psql, source)


def uid(i):
    return str(uuid.UUID(int=i))


def check(name, ok):
    assert ok, name
    checks.append(name)


def child():
    proc = subprocess.Popen(psql, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    children.append(proc)
    return proc


def send(proc, source):
    proc.stdin.write(source+'\n')
    proc.stdin.flush()


def line(proc):
    assert select.select([proc.stdout], [], [], 10)[0], 'Native session did not acknowledge within ten seconds'
    value = proc.stdout.readline().strip()
    if not value:
        raise AssertionError('Native session ended without acknowledgment')
    return value


def finish(proc):
    proc.stdin.close()
    proc.stdin = None
    output, errors = proc.communicate(timeout=10)
    assert proc.returncode == 0, errors
    return output.strip()


def reset(mode='lock'):
    sql("TRUNCATE tournaments,tournament_rake_settlements,rake_records,clubs,club_wallets,financial_alerts,probe_credits,probe_attribution; ALTER SEQUENCE probe_attempt RESTART WITH 1; UPDATE probe_locks SET n=0;")
    sql(f"UPDATE probe_policy SET mode='{mode}'; INSERT INTO tournaments VALUES('{uid(1)}','COMPLETED','{uid(2)}','native rake alert',3); INSERT INTO clubs VALUES('{uid(2)}',NULL); INSERT INTO club_wallets VALUES('{uid(2)}',0,0,NULL); INSERT INTO rake_records VALUES('{uid(1)}',24,true);")


def settle():
    return json.loads(sql(f"SELECT fn_settle_tournament_rake('{uid(1)}','native-retry-proof');"))


def state():
    return json.loads(sql("SELECT jsonb_build_object('credits',(SELECT COALESCE(sum(amount),0) FROM probe_credits),'credit_rows',(SELECT count(*) FROM probe_credits),'attempt_writes',(SELECT count(*) FROM probe_attribution),'attempts',(SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM probe_attempt),'alerts',(SELECT count(*) FROM financial_alerts),'attributed',(SELECT attributed_at IS NOT NULL FROM tournament_rake_settlements));"))


def deadlock(expected):
    reset()
    peer = child()
    send(peer, "SET deadlock_timeout='10s'; SET statement_timeout='10s'; BEGIN; UPDATE probe_locks SET n=n+1 WHERE id=2; SELECT 'held';")
    assert line(peer) == 'held'
    caller = child()
    send(caller, f"SET application_name='rake-alert-caller'; SET deadlock_timeout='100ms'; SET statement_timeout='10s'; SELECT fn_settle_tournament_rake('{uid(1)}','native-deadlock');")
    deadline = time.monotonic()+5
    while sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='rake-alert-caller' AND wait_event_type='Lock');") != 't':
        assert time.monotonic() < deadline, 'Caller never reached the real row-lock wait'
        time.sleep(.02)
    send(peer, "UPDATE probe_locks SET n=n+1 WHERE id=1; COMMIT; SELECT 'released';")
    assert line(peer) == 'released'
    result = json.loads(line(caller))
    finish(peer)
    finish(caller)
    check(f'real deadlock attributed={expected}', result['attributed'] is expected)
    snapshot = state()
    check(f'real deadlock retains one settlement credit attributed={expected}', snapshot['credits'] == 24 and snapshot['credit_rows'] == 1)
    check(f'real deadlock rolls back failed attempt attributed={expected}', snapshot['attempt_writes'] == int(expected) and snapshot['attributed'] is expected)
    check(f'real deadlock exact attempts and alerts attributed={expected}', snapshot['attempts'] == (2 if expected else 1) and snapshot['alerts'] == (0 if expected else 1))
    if not expected:
        check('baseline alert is PostgreSQL deadlock detection', sql("SELECT bool_and(message LIKE '%deadlock detected%') FROM financial_alerts;") == 't')
    check(f'exact replay changes nothing attributed={expected}', settle()['already_settled'] and state() == snapshot)


try:
    check('PostgreSQL 17', 'PostgreSQL) 17.' in run([pg/'postgres', '--version']))
    run([pg/'initdb', '-D', cluster/'data', '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    run([pg/'pg_ctl', '-D', cluster/'data', '-l', cluster/'log', '-o', f"-k {sock} -p 55796 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=6 -c timezone=UTC", '-w', 'start'])
    started = True
    sql('''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE tournaments(id uuid PRIMARY KEY,status text,club_id uuid,name text,current_players integer);
    CREATE TABLE tournament_rake_settlements(tournament_id uuid PRIMARY KEY,club_id uuid,amount numeric,destination text,source text,settled_at timestamptz,attributed_at timestamptz,attributed_users integer,union_id uuid,attribution_error text);
    CREATE TABLE rake_records(tournament_id uuid,rake_amount numeric,is_tournament boolean);
    CREATE TABLE clubs(id uuid PRIMARY KEY,union_id uuid);
    CREATE TABLE club_wallets(club_id uuid PRIMARY KEY,period_rake_collected numeric,lifetime_rake_collected numeric,updated_at timestamptz);
    CREATE TABLE financial_alerts(severity text,source text,message text,context jsonb);
    CREATE TABLE probe_credits(club_id uuid,amount numeric);
    CREATE TABLE probe_attribution(attempt integer);
    CREATE TABLE probe_locks(id integer PRIMARY KEY,n integer);
    INSERT INTO probe_locks VALUES(1,0),(2,0);
    CREATE TABLE probe_policy(mode text); INSERT INTO probe_policy VALUES('lock');
    CREATE SEQUENCE probe_attempt;
    CREATE FUNCTION credit_club_rake_to_treasury(uuid,numeric) RETURNS void LANGUAGE sql AS $$ INSERT INTO probe_credits VALUES($1,$2); $$;
    CREATE FUNCTION increment_union_wallet(uuid,numeric,uuid,text) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'union path is outside this fixture'; END; $$;
    CREATE FUNCTION fn_poker_diamond_tournament(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false; $$;
    CREATE FUNCTION fn_attribute_tournament_rake(uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE n integer; m text;
    BEGIN
      n:=nextval('probe_attempt'); SELECT mode INTO m FROM probe_policy;
      INSERT INTO probe_attribution VALUES(n);
      IF m='permanent' THEN RAISE EXCEPTION 'permanent fixture refusal' USING ERRCODE='23514'; END IF;
      IF m='zero' THEN RETURN jsonb_build_object('ok',true,'members',3,'attributed_users',0); END IF;
      UPDATE probe_locks SET n=probe_locks.n+1 WHERE id=1;
      UPDATE probe_locks SET n=probe_locks.n+1 WHERE id=2;
      RETURN jsonb_build_object('ok',true,'members',3,'attributed_users',3);
    END; $$;''')
    sql(preimage)
    check('tracked baseline body is exact', sql("SELECT md5(prosrc) FROM pg_proc WHERE oid='fn_settle_tournament_rake(uuid,text)'::regprocedure;") == '05a512317bb7bdcecfaec19ef8ee4e63')
    deadlock(False)
    sql(restoration)
    sql(restoration)
    check('guarded restoration is idempotent', sql("SELECT md5(prosrc) FROM pg_proc WHERE oid='fn_settle_tournament_rake(uuid,text)'::regprocedure;") == 'be08a61e1a867519048c4692b41ab1fd')
    sql(diamond)
    digest = sql("SELECT md5(prosrc) FROM pg_proc WHERE oid='fn_settle_tournament_rake(uuid,text)'::regprocedure;")
    check('composed current authority matches production including Diamond insertion', digest == '0e7baa1bfeb2a2d0fed749a52f32d520')
    deadlock(True)
    reset()
    peer = child()
    send(peer, "BEGIN; UPDATE probe_locks SET n=n+1 WHERE id=2; SELECT 'held';")
    assert line(peer) == 'held'
    caller = child()
    send(caller, f"SET application_name='rake-alert-timeout'; SET lock_timeout='50ms'; SELECT fn_settle_tournament_rake('{uid(1)}','native-lock-release');")
    deadline = time.monotonic()+5
    while sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='rake-alert-timeout' AND wait_event='PgSleep');") != 't':
        assert time.monotonic() < deadline, 'Caller never reached timeout retry backoff'
        time.sleep(.01)
    send(peer, 'COMMIT;')
    finish(peer)
    result = json.loads(line(caller))
    finish(caller)
    check('real released lock timeout succeeds on the second attempt', result['attributed'] and result['attribution_attempts'] == 2)
    check('released timeout leaves one credit and one attribution', state()['credit_rows'] == 1 and state()['attempt_writes'] == 1 and state()['alerts'] == 0)
    reset()
    peer = child()
    send(peer, "BEGIN; UPDATE probe_locks SET n=n+1 WHERE id=2; SELECT 'held';")
    assert line(peer) == 'held'
    result = json.loads(sql(f"SET lock_timeout='50ms'; SELECT fn_settle_tournament_rake('{uid(1)}','native-lock-exhaustion');"))
    snapshot = state()
    check('real persistent lock timeout is bounded at four attempts', result['attribution_attempts'] == 4 and not result['attributed'] and snapshot['attempts'] == 4)
    check('exhaustion rolls back every attempt but retains one banked fee', snapshot['attempt_writes'] == 0 and snapshot['credit_rows'] == 1 and snapshot['credits'] == 24)
    check('exhaustion records one exact SQLSTATE alert', sql("SELECT count(*)=1 AND bool_and(context->>'sqlstate'='55P03' AND context->>'attempts'='4') FROM financial_alerts;") == 't')
    send(peer, 'ROLLBACK;')
    finish(peer)
    reset('permanent')
    result = settle()
    check('nontransient refusal is tried once and remains open', result['attribution_attempts'] == 1 and not result['attributed'] and state()['alerts'] == 1 and state()['attempt_writes'] == 0)
    reset('zero')
    result = settle()
    check('zero attributed players never stamps a populated tournament complete', not result['attributed'] and sql("SELECT attribution_error='attributed_nobody' AND attributed_at IS NULL FROM tournament_rake_settlements;") == 't')
    reset()
    result = json.loads(sql(f"SET ROLE service_role; SELECT fn_settle_tournament_rake('{uid(1)}','native-service');"))
    check('ordinary service call completes attribution once', result['attributed'] and result['attribution_attempts'] == 1 and state()['credit_rows'] == 1)
    check('browser callers remain refused', sql("SELECT NOT has_function_privilege('anon','fn_settle_tournament_rake(uuid,text)','EXECUTE') AND NOT has_function_privilege('authenticated','fn_settle_tournament_rake(uuid,text)','EXECUTE');") == 't')
    reset()
    sql(f"BEGIN; SELECT fn_settle_tournament_rake('{uid(1)}','native-rollback'); ROLLBACK;")
    check('caller rollback removes settlement and attribution writes', sql('SELECT NOT EXISTS(SELECT 1 FROM tournament_rake_settlements) AND NOT EXISTS(SELECT 1 FROM probe_credits) AND NOT EXISTS(SELECT 1 FROM probe_attribution);') == 't')
    native_log = (cluster/'log').read_text()
    check('both old and current cases reached the real PostgreSQL deadlock detector', sql("SELECT deadlocks>=2 FROM pg_stat_database WHERE datname=current_database();") == 't')
    (a.output/'postgres.log').write_text(native_log)
    result = {'checks': checks, 'check_count': len(checks), 'current_body_md5': digest, 'production_connections': 0, 'scope': 'Actual rake authority retry and rollback boundary with real PostgreSQL deadlock/lock timeout; explicit financial callee recorders. Not general payout, attribution formula, or Diamond certification.'}
    (a.output/'RESULTS.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps({k:result[k] for k in ['check_count','current_body_md5','production_connections']}))
except BaseException as error:
    (a.output/'FAILURE.json').write_text(json.dumps({'checks_passed': checks, 'error': str(error)}, indent=2)+'\n')
    raise
finally:
    for proc in children:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    if started:
        run([pg/'pg_ctl', '-D', cluster/'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster)
