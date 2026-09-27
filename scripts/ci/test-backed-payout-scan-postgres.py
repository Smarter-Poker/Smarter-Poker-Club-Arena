#!/usr/bin/env python3
"""Real socket-only PG17 comparison of the installed scalar and batch selection.
Only the unchanged reconciliation dependency uses a finite fixture adapter.
No provider access, production identity, real payer or scheduled task is used.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'scripts/ci/fixtures/backed-payout-scan'
MIGRATION = ROOT / 'supabase/migrations/20260927050956_batch_backed_payout_shortfall_discovery_without_changing_set.sql'
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--scratch', default=os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
parser.add_argument('--baseline', action='store_true')
args = parser.parse_args()
pg = Path(args.pg_bin).resolve()
env = {'PATH': str(pg)+':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '5'}
cluster = Path(tempfile.mkdtemp(prefix='ca-backed-scan-', dir=args.scratch))
socket = Path(tempfile.mkdtemp(prefix='ca-bs-'))
data = cluster/'data'
started = False

def run(argv, sql=None, error=None, timeout=120):
    result = subprocess.run([str(v) for v in argv], input=sql, text=True,
                            capture_output=True, env=env, timeout=timeout)
    if error is not None:
        assert result.returncode and error in result.stderr, result.stderr+result.stdout
    elif result.returncode:
        raise RuntimeError(result.stderr+result.stdout)
    return result.stdout.strip()

def query(sql, error=None, role='postgres', timeout=120):
    prefix = 'SET ROLE '+role+';\n' if role else ''
    return run([pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',socket,
                '-U','fixture_admin','-d','postgres'], prefix+sql, error, timeout)

def check(condition, detail):
    assert query('SELECT ('+condition+');') == 't', detail

def outcome(apply, limit):
    # Compare output, deduped alerts, exact reconcile invocation order and all
    # changed fixture financial rows, then abort the same private transaction.
    return query('BEGIN; SELECT public.fn_pay_backed_payout_shortfalls('+apply+','+limit+');'+'''
      SELECT jsonb_build_object(
       'alerts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY context::text) FROM financial_alerts a),
       'log',(SELECT jsonb_agg(to_jsonb(b) ORDER BY tournament_id) FROM tournament_payout_backfill_log b),
       'calls',(SELECT jsonb_agg(to_jsonb(c)) FROM fixture_reconcile_calls c),
       'wallets',(SELECT jsonb_agg(to_jsonb(w)-'id' ORDER BY related_entity_id,type,category,amount,user_id)
                  FROM wallet_transactions w)); ROLLBACK;''')

try:
    assert ' 17.' in run([pg/'postgres','--version']), 'PostgreSQL 17 required'
    run([pg/'initdb','-D',data,'-U','fixture_admin','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(socket)+"'\nautovacuum=off\n")
    started = True
    run([pg/'pg_ctl','-D',data,'-l',cluster/'server.log','-w','start'])
    query('CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; GRANT ALL ON SCHEMA public TO postgres;',role=None)
    check("inet_server_addr() IS NULL AND current_setting('listen_addresses')=''",'private endpoint')
    query((FIXTURE/'setup.sql').read_text())
    captured=json.loads((FIXTURE/'baseline.json').read_text())
    for fn in captured['functions']:
        query(fn['definition'])
        query('REVOKE ALL ON FUNCTION public.'+fn['signature']+' FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.'+fn['signature']+' TO service_role;')
        check("md5(pg_get_functiondef('public."+fn['signature']+"'::regprocedure))='"+fn['md5']+"'",'captured definition hash')
    original=next(f['definition'] for f in captured['functions'] if f['signature'].startswith('fn_pay_backed'))
    scalar=next(f['definition'] for f in captured['functions'] if f['signature'].startswith('fn_tournament_conservation'))
    migration=MIGRATION.read_text()
    batch=(FIXTURE/'batch-selection.sql').read_text().rstrip()
    assert '$scan$'+batch+'$scan$' in migration, 'fixture scan differs from installed source'
    begin=original.index('    SELECT t.id, t.name, t.club_id, t.prize_pool,')
    end=original.index('\n  LOOP',begin)
    expected=original[:begin]+batch+original[end:]
    digest=hashlib.md5(expected.encode()).hexdigest()
    assert digest in migration
    query((FIXTURE/'cases.sql').read_text())
    before_catalog=query("SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig) ORDER BY oid) FROM pg_proc WHERE oid IN ('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure,'fn_tournament_conservation_delta(uuid)'::regprocedure);")
    expected_outcomes={(a,l):outcome(a,l) for a,l in [('false','500'),('true','500'),('NULL','500'),('false','0'),('false','-9'),('false','NULL'),('true','1')]}
    query("GRANT EXECUTE ON FUNCTION fn_pay_backed_payout_shortfalls(boolean,integer) TO authenticated;")
    query(migration,'BACKED_PAYOUT_SCAN_AUTHORITY_CHANGED')
    query("REVOKE EXECUTE ON FUNCTION fn_pay_backed_payout_shortfalls(boolean,integer) FROM authenticated;")
    query("ALTER FUNCTION fn_tournament_conservation_delta(uuid) SET statement_timeout='9s';")
    query(migration,'BACKED_PAYOUT_SCAN_PREIMAGE_CHANGED')
    query(scalar)
    query('ALTER TABLE tournament_guarantee_overlays DROP CONSTRAINT tournament_guarantee_overlays_pkey;')
    query(migration,'BACKED_PAYOUT_SCAN_SINGLETON_KEYS_CHANGED')
    # A valid deferred unique key admits duplicate rows inside its transaction.
    # The scalar raises while a join multiplies rows: installation must refuse
    # this real constraint, not rely on an empty current duplicate snapshot.
    query('ALTER TABLE tournament_guarantee_overlays ADD CONSTRAINT fixture_deferred UNIQUE(tournament_id) DEFERRABLE INITIALLY DEFERRED;')
    check("EXISTS(SELECT FROM pg_index WHERE indrelid='tournament_guarantee_overlays'::regclass AND indisunique AND indisvalid AND NOT indimmediate)",'deferred key fixture')
    query(migration,'BACKED_PAYOUT_SCAN_SINGLETON_KEYS_CHANGED')
    duplicate="BEGIN; INSERT INTO tournaments(id) VALUES(md5('deferred-only')::uuid); INSERT INTO tournament_guarantee_overlays VALUES(md5('deferred-only')::uuid,1),(md5('deferred-only')::uuid,2);"
    query(duplicate+" SELECT fn_tournament_conservation_delta(md5('deferred-only')::uuid); ROLLBACK;",'more than one row returned by a subquery')
    assert query(duplicate+" SELECT count(*) FROM tournaments t JOIN tournament_guarantee_overlays o ON o.tournament_id=t.id WHERE t.id=md5('deferred-only')::uuid; ROLLBACK;")=='2', 'deferred duplicates do not demonstrate join multiplicity'
    query('ALTER TABLE tournament_guarantee_overlays DROP CONSTRAINT fixture_deferred; ALTER TABLE tournament_guarantee_overlays ADD PRIMARY KEY(tournament_id);')
    print('backed-payout-scan-deferred-singleton-refused')
    covering=next(i['definition'] for i in captured['indexes'] if 'idx_rake_records_club_data_tournament_window ' in i['definition'])
    query('DROP INDEX public.idx_rake_records_club_data_tournament_window;')
    query(migration,'BACKED_PAYOUT_SCAN_COVER_CHANGED')
    query(covering.replace('rake_amount <> (0)::numeric','rake_amount > (0)::numeric')+';')
    query(migration,'BACKED_PAYOUT_SCAN_COVER_CHANGED')
    query('DROP INDEX public.idx_rake_records_club_data_tournament_window; '+covering+';')
    query(migration.replace('COMMIT;',"DO $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; COMMIT;"),'fixture rollback')
    check("md5(pg_get_functiondef('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure))='9bf0cce25df7f2c4dcae32f2c42d2cd3'",'rollback restored definition')
    if not args.baseline: query(migration)
    if not args.baseline: query(migration,'BACKED_PAYOUT_SCAN_PREIMAGE_CHANGED')
    check("md5(pg_get_functiondef('fn_tournament_conservation_delta(uuid)'::regprocedure))='0d3b61282e592f3f938e77dcb1bf4a98'",'scalar unchanged')
    assert before_catalog==query("SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig) ORDER BY oid) FROM pg_proc WHERE oid IN ('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure,'fn_tournament_conservation_delta(uuid)'::regprocedure);"), 'catalog changed'
    actual=query("SELECT pg_get_functiondef('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure);")+'\n'
    if args.baseline:
        assert 'WITH eligible AS MATERIALIZED' in actual, 'baseline repeats scalar conservation lookups per eligible event'
    assert actual==expected, 'only the exact SELECT may change'
    for pair,wanted in expected_outcomes.items():
        actual_outcome=outcome(*pair)
        if actual_outcome != wanted:
            before=[json.loads(x) for x in wanted.splitlines()]; after=[json.loads(x) for x in actual_outcome.splitlines()]
            raise AssertionError('whole caller behavior differs: '+str(pair)+' results='+str((before[0],after[0]))+' calls='+str((before[1]['calls'],after[1]['calls'])))
    prefix=batch[:batch.rindex('    SELECT t.id, t.name, t.club_id, t.prize_pool,')].replace('v_window_days','30')
    assert query(prefix+''' SELECT count(*) FROM deltas d WHERE d.delta IS DISTINCT FROM public.fn_tournament_conservation_delta(d.id)
      OR d.wallet_prizes IS DISTINCT FROM (SELECT COALESCE(sum(w.amount),0) FROM wallet_transactions w WHERE w.related_entity_id=d.id AND w.type='credit' AND w.category='prize');''')=='0', 'scalar delta/prize comparison'
    # Exact cutoff evaluated in one transaction, so the fixture never expires
    # while the assertions are being prepared on a contended host.
    boundary=query("BEGIN; UPDATE tournaments SET ended_at=now()-interval '30 days' WHERE name='case-21'; UPDATE tournaments SET ended_at=now()-interval '30 days'+interval '1 microsecond' WHERE name='case-22';"+prefix+" SELECT NOT EXISTS(SELECT FROM eligible WHERE name='case-21') AND EXISTS(SELECT FROM eligible WHERE name='case-22'); ROLLBACK;")
    assert boundary=='t', 'exclusive thirty-day cutoff changed'
    empty=query("BEGIN; DELETE FROM tournaments; SELECT fn_pay_backed_payout_shortfalls(); ROLLBACK;")
    assert json.loads(empty)['events_paid']==0 and json.loads(empty)['alerts_raised']==0
    # Two real connections qualify statement/snapshot visibility, with no cache.
    command=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(socket),'-U','fixture_admin','-d','postgres']
    connection=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,env=env)
    event="md5('event-60')::uuid"
    comparison="SELECT json_build_array(public.fn_tournament_conservation_delta("+event+"),("+prefix+" SELECT delta FROM deltas WHERE id="+event+"));"
    try:
        def exchange(sql):
            connection.stdin.write(sql+'\n'); connection.stdin.flush()
            line=connection.stdout.readline().strip()
            assert line, connection.stderr.read()
            return json.loads(line)
        initial=exchange('SET ROLE postgres; BEGIN ISOLATION LEVEL REPEATABLE READ; '+comparison)
        assert initial[0]==initial[1]
        query("INSERT INTO wallet_transactions(related_entity_id,type,category,amount,user_id) VALUES("+event+",'credit','prize',1,"+event+");")
        assert exchange(comparison)==initial, 'repeatable read snapshot changed'
        fresh=exchange('COMMIT; '+comparison)
        assert fresh[0]==fresh[1]==initial[0]-1, 'next statement misses committed receipt'
        connection.stdin.close(); assert connection.wait(timeout=5)==0, connection.stderr.read()
    finally:
        if connection.poll() is None: connection.terminate(); connection.wait(timeout=5)
    print('backed-payout-scan-two-session-snapshot-passed')
    for role in ['anon','authenticated']:
        query('SELECT public.fn_pay_backed_payout_shortfalls();','permission denied for function',role=role)
    query('BEGIN; SELECT public.fn_pay_backed_payout_shortfalls(); ROLLBACK;',role='service_role')
    check("NOT (SELECT rolsuper FROM pg_roles WHERE rolname='postgres') AND (SELECT rolbypassrls FROM pg_roles WHERE rolname='postgres')",'real owner role attributes')
    # A realistic healthy event set makes the LIMIT unable to avoid the scan.
    query('''INSERT INTO tournaments(id,name,prize_pool,ended_at,status)
      SELECT md5('large-'||n)::uuid,'large-'||n,100,now()-interval '1 day','COMPLETED' FROM generate_series(1,12000)n;
      INSERT INTO wallet_transactions(related_entity_id,type,category,amount)
      SELECT id,'debit','tournament_buyin',100 FROM tournaments WHERE name LIKE 'large-%';
      INSERT INTO wallet_transactions(related_entity_id,type,category,amount)
      SELECT id,'credit','prize',100 FROM tournaments WHERE name LIKE 'large-%';
      ANALYZE;''')
    # Both are the read-only selection relation, not the volatile caller. Run on
    # identical data; report timing without inferring CPU or provider savings.
    old_read="SELECT count(*) FROM tournaments t WHERE t.status='COMPLETED' AND NOT (COALESCE(t.variant,'')='satellite' OR upper(COALESCE(t.tournament_type,''))='SATELLITE' OR t.satellite_target_id IS NOT NULL) AND COALESCE(t.variant,'')<>'spin' AND t.ended_at>now()-interval '30 days' AND fn_tournament_conservation_delta(t.id)>0.01;"
    values=[]
    for label,sql in [('scalar',old_read),('batch',prefix+' SELECT count(*) FROM deltas WHERE delta>0.01;')]:
        start=time.monotonic(); value=query(sql); elapsed=time.monotonic()-start
        values.append(value); print(json.dumps({'selection':label,'eligible_fixture_events':12080,'positive':value,'seconds':round(elapsed,3)}))
    assert values[0]==values[1], 'large data candidate mismatch'
    print('backed-payout-scan-native-acceptance-passed')
finally:
    if started and (data/'postmaster.pid').exists():run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
    shutil.rmtree(cluster)
    shutil.rmtree(socket)
