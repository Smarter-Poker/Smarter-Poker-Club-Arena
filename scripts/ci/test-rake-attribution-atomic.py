"""Qualify captured rake authority and atomic refusal under native lock failures.

Existing local PostgreSQL 17 only. Explicit transactional financial recorders
qualify commit/rollback control, not accounting formulas or actual Diamond custody.
No production connection, install, recurring repair or payment is performed.
"""
import datetime
import hashlib
import platform
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
baseline = json.loads((repo/'scripts/ci/probes/rake-attribution-atomic/baseline.json').read_text())
migration = (repo/'supabase/migrations/20260914223105_rake_settlement_requires_complete_attribution.sql').read_text()
before_hash = '7cf1d81246d015b65d416ee6b3f96838'
after_hash = '46128439ae7a46e4fd8ea2889a7dddf8'
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
assert shutil.disk_usage(tempfile.gettempdir()).free > 2*1024**3
cluster = Path(tempfile.mkdtemp(prefix='rake-atomic-'))
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
    return json.loads(sql("SELECT jsonb_build_object('credits',(SELECT COALESCE(sum(amount),0) FROM probe_credits),'credit_rows',(SELECT count(*) FROM probe_credits),'attempt_writes',(SELECT count(*) FROM probe_attribution),'attempts',(SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM probe_attempt),'alerts',(SELECT count(*) FROM financial_alerts),'attributed',(SELECT attributed_at IS NOT NULL FROM tournament_rake_settlements),'settlements',(SELECT count(*) FROM tournament_rake_settlements),'period',(SELECT sum(period_rake_collected) FROM club_wallets),'lifetime',(SELECT sum(lifetime_rake_collected) FROM club_wallets));"))


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


def install_baseline():
    for f in baseline['functions']:
        sql(f['definition']+';')
        sql("REVOKE ALL ON FUNCTION public."+f['signature']+" FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public."+f['signature']+" TO service_role;")
    check('captured current authority definition hash', sql("SELECT md5(pg_get_functiondef('fn_settle_tournament_rake(uuid,text)'::regprocedure));") == before_hash)


def refuse(source, code):
    result = subprocess.run(psql+['-v','VERBOSITY=verbose'], input=source, text=True, capture_output=True, env=env, timeout=25)
    check('SQLSTATE '+code+' is preserved', result.returncode != 0 and ('ERROR:  '+code+':' in result.stderr))
    return result.stderr


def no_partial(label):
    snapshot = state()
    check(label+' has no bank credit', snapshot['credit_rows'] == 0 and snapshot['credits'] == 0)
    check(label+' has no new settlement or attribution', snapshot['settlements'] == 0 and snapshot['attempt_writes'] == 0)
    check(label+' leaves both wallet counters unchanged', snapshot['period'] == 0 and snapshot['lifetime'] == 0)
    return snapshot


def persistent_timeout(candidate):
    reset()
    peer=child()
    send(peer, "BEGIN; UPDATE probe_locks SET n=n+1 WHERE id=2; SELECT 'held';")
    assert line(peer)=='held'
    query=f"SET lock_timeout='50ms'; SELECT fn_settle_tournament_rake('{uid(1)}','native-lock-exhaustion');"
    if candidate:
        refuse(query, '55P03')
        check('real timeout exhaustion stops at four attempts', no_partial('real timeout')['attempts']==4)
    else:
        result=json.loads(sql(query))
        snapshot=state()
        check('current baseline reports ok despite exhausted attribution', result['ok'] and not result['attributed'] and snapshot['attempts']==4)
        check('current baseline retains banked fee after exhaustion', snapshot['credits']==24 and snapshot['settlements']==1 and snapshot['attempt_writes']==0)
    send(peer, 'ROLLBACK;')
    finish(peer)
    if candidate:
        result=settle()
        check('later ordinary retry after lock release commits once', result['attributed'] and state()['credit_rows']==1 and state()['attempt_writes']==1)
        snapshot=state()
        replay=settle()
        check('successful replay carries stored attribution and changes nothing', replay['already_settled'] and replay['attributed'] and replay['attributed_users']==3 and state()==snapshot)

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
    CREATE FUNCTION increment_union_wallet(uuid,numeric,uuid,text) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN INSERT INTO probe_credits VALUES($3,$2); RETURN jsonb_build_object('success',true); END; $$;
    CREATE FUNCTION fn_poker_diamond_tournament(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT mode='diamond' FROM probe_policy; $$;
    CREATE FUNCTION fn_poker_diamond_tournament_settle_fee(uuid,text) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN INSERT INTO probe_credits VALUES($1,7); RETURN jsonb_build_object('amount',7); END; $$;
    CREATE FUNCTION fn_poker_diamond_tournament_close_custody(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('closed',true,'still_held',0); $$;
    CREATE FUNCTION fn_attribute_tournament_rake(uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE n integer; m text;
    BEGIN
      n:=nextval('probe_attempt'); SELECT mode INTO m FROM probe_policy;
      INSERT INTO probe_attribution VALUES(n);
      IF m='permanent' THEN RAISE EXCEPTION 'permanent fixture refusal' USING ERRCODE='23514'; END IF;
      IF m='debug' THEN RAISE EXCEPTION 'cannot find parent statement on pldbgapi2 call stack' USING ERRCODE='XX000'; END IF;
      IF m='synthetic_deadlock' THEN RAISE EXCEPTION 'synthetic persistent deadlock' USING ERRCODE='40P01'; END IF;
      IF m='decline' THEN RETURN jsonb_build_object('ok',false,'reason','fixture_refused'); END IF;
      IF m='null' THEN RETURN NULL; END IF;
      IF m='empty' THEN RETURN jsonb_build_object('ok',true,'members',0,'attributed_users',0); END IF;
      IF m='zero' THEN RETURN jsonb_build_object('ok',true,'members',3,'attributed_users',0); END IF;
      UPDATE probe_locks SET n=probe_locks.n+1 WHERE id=1;
      UPDATE probe_locks SET n=probe_locks.n+1 WHERE id=2;
      RETURN jsonb_build_object('ok',true,'members',3,'attributed_users',3);
    END; $$;''')

    install_baseline()
    persistent_timeout(False)
    reset('permanent')
    result=settle()
    check('current baseline banks despite permanent attribution error', result['ok'] and not result['attributed'] and state()['credits']==24)
    reset('zero')
    result=settle()
    check('current baseline banks despite populated field credited nobody', result['ok'] and not result['attributed'] and state()['credits']==24)
    reset()
    sql(migration)
    check('candidate exact definition hash', sql("SELECT md5(pg_get_functiondef('fn_settle_tournament_rake(uuid,text)'::regprocedure));")==after_hash)
    sql(migration)
    check('candidate exact replay accepted', sql("SELECT md5(pg_get_functiondef('fn_settle_tournament_rake(uuid,text)'::regprocedure));")==after_hash)
    deadlock(True)
    persistent_timeout(True)
    reset()
    peer=child()
    send(peer, "BEGIN; UPDATE probe_locks SET n=n+1 WHERE id=2; SELECT 'held';")
    assert line(peer)=='held'
    # Arm the existing lock-holder session before the caller. Starting a new
    # psql for each poll can miss the 100ms first retry sleep on a busy runner.
    send(peer, """SET application_name='rake-lock-release-observer';
    DO $$
    DECLARE deadline timestamptz := clock_timestamp()+interval '5 seconds';
    BEGIN
      LOOP
        PERFORM pg_stat_clear_snapshot();
        EXIT WHEN EXISTS(
          SELECT 1 FROM pg_stat_activity
          WHERE application_name='rake-atomic-release'
            AND state='active'
            AND wait_event='PgSleep'
        );
        IF clock_timestamp() >= deadline THEN
          RAISE EXCEPTION 'first retry sleep not observed';
        END IF;
        PERFORM pg_sleep(0.001);
      END LOOP;
    END
    $$;
    COMMIT;
    SELECT 'released';""")
    deadline=time.monotonic()+5
    while sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='rake-lock-release-observer' AND state='active' AND wait_event='PgSleep');")!='t':
        assert time.monotonic()<deadline, 'retry observer did not become active'
        time.sleep(.01)
    caller=child()
    send(caller, f"SET application_name='rake-atomic-release'; SET lock_timeout='50ms'; SELECT fn_settle_tournament_rake('{uid(1)}','native-lock-release');")
    assert line(peer)=='released'
    finish(peer)
    result=json.loads(line(caller))
    finish(caller)
    check('real released timeout succeeds on second attempt', result['attributed'] and result['attribution_attempts']==2)
    check('real released timeout has one credit and attribution', state()['credit_rows']==1 and state()['attempt_writes']==1)
    for mode,code,attempts in [('permanent','23514',1),('debug','XX000',1),('synthetic_deadlock','40P01',4),('decline','P0404',1),('null','P0404',1),('zero','P0404',1)]:
        reset(mode)
        refuse(f"SELECT fn_settle_tournament_rake('{uid(1)}','native-{mode}');",code)
        check(mode+' expected attempt count',no_partial(mode)['attempts']==attempts)
    for mode in ['lock','empty','diamond']:
        reset(mode)
        result=settle()
        check(mode+' success still completes',result['ok'] and result['attributed'])
        snapshot=state()
        check(mode+' replay preserves exact state',settle()['already_settled'] and state()==snapshot)
    reset()
    sql(f"UPDATE clubs SET union_id='{uid(3)}';")
    result=settle()
    check('union branch retains amount and destination',result['amount']==24 and result['destination']=='union:'+uid(3) and result['attributed'] and state()['credits']==24)
    for mutation in ["attributed_at=NULL","attributed_users=NULL","attributed_users=-1","attribution_error='legacy refusal'","settled_at=NULL","destination='pending'","destination=NULL"]:
        reset()
        settle()
        sql("UPDATE tournament_rake_settlements SET "+mutation+";")
        before=sql("SELECT row_to_json(s) FROM tournament_rake_settlements s;")
        snapshot=state()
        result=settle()
        check('incomplete prior refused: '+mutation,result['ok'] is False and result['already_settled'] and result['reason']=='settlement_attribution_incomplete')
        check('incomplete prior is preserved: '+mutation,sql("SELECT row_to_json(s) FROM tournament_rake_settlements s;")==before and state()==snapshot)
    reset()
    sql("UPDATE rake_records SET rake_amount=0;")
    result=settle()
    check('zero fee remains a no-credit success',result['ok'] and result['amount']==0 and state()['credit_rows']==0 and settle()['already_settled'])
    reset()
    sql("UPDATE tournaments SET club_id=NULL;")
    result=settle()
    check('no-club existing policy unchanged',result['ok'] and state()['credit_rows']==0 and settle()['already_settled'])
    reset()
    result=json.loads(sql(f"SET ROLE service_role; SELECT fn_settle_tournament_rake('{uid(1)}','native-service');"))
    check('service caller retains execution',result['attributed'] and state()['credit_rows']==1)
    check('browser callers remain refused',sql("SELECT NOT has_function_privilege('anon','fn_settle_tournament_rake(uuid,text)','EXECUTE') AND NOT has_function_privilege('authenticated','fn_settle_tournament_rake(uuid,text)','EXECUTE');")=='t')
    reset()
    sql(f"BEGIN; SELECT fn_settle_tournament_rake('{uid(1)}','native-caller-rollback'); ROLLBACK;")
    no_partial('outer caller rollback')
    sql("GRANT EXECUTE ON FUNCTION fn_settle_tournament_rake(uuid,text) TO authenticated;")
    refuse(migration,'P0001')
    check('permission drift is not overwritten',sql("SELECT has_function_privilege('authenticated','fn_settle_tournament_rake(uuid,text)','EXECUTE');")=='t')
    sql("REVOKE EXECUTE ON FUNCTION fn_settle_tournament_rake(uuid,text) FROM authenticated;")
    target=next(f for f in baseline['functions'] if f['signature'].startswith('fn_settle'))
    drift=target['definition'].replace('BEGIN\n','BEGIN\n  -- unrecognized fixture drift\n',1)
    sql(drift+';')
    drift_hash=sql("SELECT md5(pg_get_functiondef('fn_settle_tournament_rake(uuid,text)'::regprocedure));")
    refuse(migration,'P0001')
    check('unknown predecessor remains byte-identical',sql("SELECT md5(pg_get_functiondef('fn_settle_tournament_rake(uuid,text)'::regprocedure));")==drift_hash)
    install_baseline()
    sql("ALTER FUNCTION fn_settle_tournament_rake(uuid,text) OWNER TO anon;")
    refuse(migration,'P0001')
    check('foreign owner remains unchanged after guard rejection',sql("SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='fn_settle_tournament_rake(uuid,text)'::regprocedure;")=='anon')
    sql("ALTER FUNCTION fn_settle_tournament_rake(uuid,text) OWNER TO postgres;")
    install_baseline()
    sql(migration)
    check('final permissions are exact',sql("SELECT proacl::text FROM pg_proc WHERE oid='fn_settle_tournament_rake(uuid,text)'::regprocedure;")=='{postgres=X/postgres,service_role=X/postgres}')
    check('actual native deadlock was exercised',sql("SELECT deadlocks>=1 FROM pg_stat_database WHERE datname=current_database();")=='t')
    (a.output/'postgres.log').write_text((cluster/'log').read_text())
    result={'completed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'check_count':len(checks),'checks':checks,'before_definition_md5':before_hash,'after_definition_md5':after_hash,'migration_sha256':hashlib.sha256(migration.encode()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'baseline_sha256':hashlib.sha256((repo/'scripts/ci/probes/rake-attribution-atomic/baseline.json').read_bytes()).hexdigest(),'platform':platform.platform(),'postgres':run([pg/'postgres','--version']),'production_connections':0,'scope':'Captured settlement/lane definitions; real row deadlock and lock timeouts; explicit transaction recorders for financial callees. Not complete financial formulas, actual Diamond custody, installed/native release or live incident repair.'}
    (a.output/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:result[k] for k in ['completed_at','check_count','after_definition_md5','production_connections']}))
except BaseException as error:
    (a.output/'FAILURE.json').write_text(json.dumps({'checks_passed':checks,'error':str(error)},indent=2)+'\n')
    raise
finally:
    for proc in children:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    if started:
        run([pg/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
    shutil.rmtree(cluster)
