#!/usr/bin/env python3
"""Finite native PostgreSQL 17 request-outcome/CAS qualification; no production."""
import argparse, os, pathlib, subprocess, tempfile, shutil, time, select, re
ROOT=pathlib.Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--pg-bin',default=os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'));p.add_argument('--scratch',default=os.environ.get('TMPDIR'));a=p.parse_args()
if os.uname().sysname=='Darwin' and not str(a.scratch).startswith('/Volumes/SmarterWork/agent-work/'):
    raise SystemExit('SSD scratch required')
pg=pathlib.Path(a.pg_bin); work=pathlib.Path(tempfile.mkdtemp(prefix='hold-native-',dir=a.scratch)); port='55597'
# Unix-domain sockets have a platform path limit; data stays in caller-owned scratch.
sock=pathlib.Path(tempfile.mkdtemp(prefix='lh-',dir='/Volumes/SmarterWork/agent-work')) if os.uname().sysname=='Darwin' and len(str(work))>85 else work
def run(cmd,**kw):
    r=subprocess.run([str(x) for x in cmd],text=True,capture_output=True,**kw)
    if r.returncode: raise RuntimeError(f'{cmd[0]} exit {r.returncode}: {r.stderr}')
    return r
def sql(s):return run([pg/'psql','-XAtq','-h',sock,'-p',port,'-d','postgres','-v','ON_ERROR_STOP=1'],input=s).stdout.strip()
def load(path):return sql(pathlib.Path(path).read_text())
def call(action,rid,extra='',cluster='00000000-0000-4000-a000-000000000002'):
    return f"fn_lightning_operator_control('{cluster}','{action}','native hold qualification','{{\"request_id\":\"{rid}\"{extra}}}'::jsonb)"
def check(expr,msg):sql(f"DO $check$ BEGIN IF NOT coalesce(({expr}),false) THEN RAISE EXCEPTION 'FAIL {msg}'; END IF; END $check$;")
A='11111111-0000-4000-a000-000000000001';B='11111111-0000-4000-a000-000000000002';R='11111111-0000-4000-a000-000000000003';N='11111111-0000-4000-a000-000000000004'
def wait_locked(proc):
    data=b''; deadline=time.monotonic()+5
    while b'LOCKED\n' not in data:
        if time.monotonic()>deadline:raise AssertionError('lock backend readiness timeout')
        if proc.poll() is not None:raise AssertionError('lock backend ended')
        if select.select([proc.stdout],[],[],.1)[0]:data+=os.read(proc.stdout.fileno(),4096)
# Every sql call has its own session, so install service claim as database default.
try:
    run([pg/'initdb','-D',work/'db','-A','trust','--no-locale'])
    run([pg/'pg_ctl','-D',work/'db','-l',work/'pg.log','-o',f"-k {sock} -p {port} -c listen_addresses=''",'start'])
    load(ROOT/'scripts/dev/fixtures/lightning-template-boundary.sql')
    load(ROOT/'scripts/dev/fixtures/lightning-release-hold-ground.sql')
    predecessor=(ROOT/'scripts/dev/fixtures/lightning-template-predecessors.sql').read_text()
    load_body=re.search(r'CREATE OR REPLACE FUNCTION public.fn_lightning_operator_control.*?\$function\$\s*;',predecessor,re.S)
    assert load_body, 'maintained operator fixture missing'
    sql(load_body.group())
    load(ROOT/'scripts/dev/fixtures/lightning-release-hold-preimage.sql')
    sql("ALTER DATABASE postgres SET request.jwt.claim.role='service_role';")
    sig="'public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure"
    check(f"md5(pg_get_functiondef({sig}))='e99c43433703d45dac01948de8ef77d8'",'exact current preimage')
    # Before: stale owner A can resume B's hold; missing resolver is INVALID_ACTION.
    check(f"({call('pause',B)}->>'ok')::boolean",'before pause')
    check(f"({call('resume',R,',\"expected_pause_request_id\":\"'+A+'\"')}->>'ok')::boolean",'before foreign hold defect reproduced')
    check(f"{call('resolve_release_hold',N,',\"expected_action\":\"pause\"')}->>'code'='INVALID_ACTION'",'before unknown unresolved')
    print('PASS exact e99 predecessor reproduces foreign hold resume and missing outcome resolver')
    sql('TRUNCATE lightning_operator_request,cash_cluster_events,lightning_cluster_control; UPDATE cash_games SET cluster_mode=\'must_move\';')
    migration=next((ROOT/'supabase/migrations').glob('*_lightning_release_hold_outcome_ownership.sql'))
    acl=sql(f"SELECT proacl::text||proowner::text||proconfig::text FROM pg_proc WHERE oid={sig}")
    load(ROOT/'scripts/dev/fixtures/lightning-release-hold-ddl-guards.sql')
    load(migration);load(migration)
    print('Native PostgreSQL: '+run([pg/'postgres','--version']).stdout.strip())
    print('Installed metadata: '+sql(f"SELECT jsonb_build_object('definition_md5',md5(pg_get_functiondef(oid)),'owner',pg_get_userbyid(proowner),'acl',proacl::text,'config',proconfig,'security_definer',prosecdef) FROM pg_proc WHERE oid={sig}"))
    assert acl==sql(f"SELECT proacl::text||proowner::text||proconfig::text FROM pg_proc WHERE oid={sig}")
    resolver=lambda rid,action='pause',extra='',cluster='00000000-0000-4000-a000-000000000002':call('resolve_release_hold',rid,',\"expected_action\":\"'+action+'\"'+extra,cluster)
    check(f"{resolver(N)} @> '{{\"ok\":false,\"resolved\":false,\"code\":\"REQUEST_OUTCOME_UNKNOWN\",\"request_id\":\"{N}\",\"cluster_id\":\"00000000-0000-4000-a000-000000000002\",\"action\":\"pause\"}}'",'bound missing outcome')
    check('NOT EXISTS(SELECT 1 FROM lightning_operator_request) AND NOT EXISTS(SELECT 1 FROM cash_cluster_events)','missing resolver zero effects')
    check(f"({call('pause',A)}->>'ok')::boolean",'pause A')
    check(f"{resolver(A)}->'answer'=(SELECT answer FROM lightning_operator_request WHERE request_id='{A}')",'exact committed pause answer')
    check(f"{resolver(A,'resume')}->>'code'='INVALID_ARGS'",'resolve action identity')
    check(f"{resolver(A,cluster='00000000-0000-4000-a000-000000000003')}->>'code'='INVALID_ARGS'",'resolve cluster identity')
    # A foreign newer owner B survives cleanup expecting A.
    sql(f"UPDATE lightning_cluster_control SET paused_request_id='{B}' WHERE cluster_id='00000000-0000-4000-a000-000000000002';")
    extra=',\"expected_pause_request_id\":\"'+A+'\"'
    check(f"{call('resume',R,extra)}->>'code'='HOLD_OWNERSHIP_CHANGED'",'foreign CAS refused')
    check("(SELECT cluster_mode='paused' FROM cash_games WHERE id='00000000-0000-4000-a000-000000000002') AND (SELECT count(*)=1 FROM cash_cluster_events)",'foreign CAS zero resume events')
    check(f"{resolver(R,'resume',extra)}->'answer'=(SELECT answer FROM lightning_operator_request WHERE request_id='{R}')",'negative original answer preserved')
    check(f"{resolver(R,'resume',',\"expected_pause_request_id\":\"'+B+'\"')}->>'code'='INVALID_ARGS'",'resolve expected owner binding')
    check(f"{call('resume',R,',\"expected_pause_request_id\":\"'+B+'\"')}->>'code'='INVALID_ARGS'",'replay expected owner binding')
    for value in ['null','123','\"broken\"']:
        check(f"{call('resume',N,',\"expected_pause_request_id\":'+value)}->>'code'='INVALID_ARGS'",'strict expected UUID')
    # Same correct owner resumes once, then exact request replays without another event.
    check(f"({call('resume',N,',\"expected_pause_request_id\":\"'+B+'\"')}->>'ok')::boolean",'own CAS resume')
    events=sql('SELECT count(*) FROM cash_cluster_events')
    check(f"({call('resume',N,',\"expected_pause_request_id\":\"'+B+'\"')}->>'replayed')::boolean",'same expected replay')
    assert events==sql('SELECT count(*) FROM cash_cluster_events')
    check(f"{resolver(N,'resume')}->>'code'='INVALID_ARGS'",'scoped cannot resolve unscoped')
    # Service-only resolver; ordinary unscoped operator retains pause/resume.
    check(f"{call('resume','22222222-0000-4000-a000-000000000001')}->>'code'='ALREADY'",'nonpaused already')
    sql("SET request.jwt.claim.role='authenticated'; DO $q$ BEGIN IF "+resolver(A)+"->>'code'<>'NOT_AUTHORIZED' THEN RAISE EXCEPTION 'resolver auth'; END IF; END $q$;")
    for action in ['pause','resume']:
        sql("SET request.jwt.claim.role='authenticated'; DO $q$ BEGIN IF NOT ("+call(action,'33333333-0000-4000-a000-00000000000'+str(1 if action=='pause' else 2))+"->>'ok')::boolean THEN RAISE EXCEPTION 'ordinary caller'; END IF; END $q$;")
    # Genuine independent backend holds the request lock; resolver must neither answer absent nor write.
    held='44444444-0000-4000-a000-000000000001'
    child=subprocess.Popen([str(pg/'psql'),'-XAtq','-h',str(sock),'-p',port,'-d','postgres','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    child.stdin.write(f"BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('lightning_operator_request:{held}',0)); SELECT 'LOCKED'; SELECT pg_sleep(30); ROLLBACK;\n");child.stdin.flush()
    wait_locked(child)
    try:
        before=sql('SELECT count(*) FROM lightning_operator_request')
        check(f"{resolver(held)}->>'code'='REQUEST_IN_PROGRESS'",'request in progress preserved unknown')
        assert before==sql('SELECT count(*) FROM lightning_operator_request')
    finally:
        child.terminate();child.communicate(timeout=5)
    # Force a request row to appear while a caller waits for the Cluster lock.
    # This directly exercises the second replay identity check, not just its source.
    raced='55555555-0000-4000-a000-000000000001'
    locker=subprocess.Popen([str(pg/'psql'),'-XAtq','-h',str(sock),'-p',port,'-d','postgres','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    waiter=None
    try:
        locker.stdin.write("BEGIN; SELECT id FROM cash_games WHERE id='00000000-0000-4000-a000-000000000002' FOR UPDATE; SELECT 'LOCKED';\n");locker.stdin.flush()
        wait_locked(locker)
        waiter=subprocess.Popen([str(pg/'psql'),'-XAtq','-h',str(sock),'-p',port,'-d','postgres','-v','ON_ERROR_STOP=1','-c','SELECT '+call('resume',raced,',"expected_pause_request_id":"'+A+'"')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        deadline=time.monotonic()+5
        while sql("SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%"+raced+"%'")!='1':
            if time.monotonic()>deadline:raise AssertionError('caller did not reach Cluster lock')
            time.sleep(.02)
        locker.stdin.write("INSERT INTO lightning_operator_request(request_id,cluster_id,action,args,answer) VALUES ('"+raced+"','00000000-0000-4000-a000-000000000002','resume','{\"expected_pause_request_id\":\""+B+"\"}','{\"ok\":true}'); COMMIT;\n");locker.stdin.flush()
        out,err=waiter.communicate(timeout=5)
        assert waiter.returncode==0 and 'INVALID_ARGS' in out,(out,err)
    finally:
        locker.terminate();locker.communicate(timeout=5)
        if waiter and waiter.poll() is None:waiter.terminate();waiter.communicate(timeout=5)
    # All three current admission guards still execute in the exact native body.
    for column,value,code in [('template_name',"'classic'",'LIGHTNING_TEMPLATE_NOT_ALLOWED'),('handedness','9','LIGHTNING_TABLE_SIZE_NOT_ALLOWED'),('variant',"'short_deck'",'LIGHTNING_VARIANT_NOT_ALLOWED')]:
        sql("BEGIN; UPDATE cash_games SET "+column+"="+value+" WHERE id='00000000-0000-4000-a000-000000000002'; DO $g$ BEGIN IF "+call('resume','66666666-0000-4000-a000-000000000001')+"->>'code'<>'"+code+"' THEN RAISE EXCEPTION 'current admission guard'; END IF; END $g$; ROLLBACK;")
    check("NOT EXISTS(SELECT 1 FROM ca_money_rpc_registry WHERE proname='fn_lightning_operator_control')",'registry decision unchanged')
    check(f"NOT public.fn_ca_money_rpc_writes_balances((SELECT prosrc FROM pg_proc WHERE oid={sig}))",'production registry classifier unchanged')
    print('PASS native committed/negative/missing outcomes, global contention, strict identity, CAS, replay, ordinary callers, ACL and idempotent install')
finally:
    stopped=subprocess.run([str(pg/'pg_ctl'),'-D',str(work/'db'),'-m','immediate','stop'],capture_output=True)
    if stopped.returncode != 0:
        raise RuntimeError(f'UNKNOWN cleanup: isolated PostgreSQL stop exit {stopped.returncode}; retain {work} and {sock}; {stopped.stderr.decode(errors="replace")}')
    shutil.rmtree(work)
    if sock!=work:shutil.rmtree(sock)

    print('Cleanup: isolated PostgreSQL stopped and owned data/socket scratch removed')
