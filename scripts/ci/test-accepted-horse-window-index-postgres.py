#!/usr/bin/env python3
"""Finite exact-byte PG17 qualification. No production connection or source edit.
Follows scripts/ci/test-contract-index-recovery-postgres.py isolation pattern.
Retain this scratch harness for later maintained CI integration by the owner.
"""
import argparse, datetime, hashlib, json, os, pathlib, shutil, subprocess, tempfile, time
P = pathlib.Path
EXPECTED = 'e441bdfc48ab2e782e9dae4cef04737df1a7d27e305e5708e4cfa24b582b4193'
ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument('--root', type=P, required=True)
ap.add_argument('--scratch-parent', type=P, required=True)
ap.add_argument('--output', type=P, required=True)
ap.add_argument('--pg-bin', type=P, required=True)
a = ap.parse_args()
assert __debug__, 'optimized qualification forbidden'
root, parent, output, pg = a.root.resolve(), a.scratch_parent.resolve(), a.output.resolve(), a.pg_bin.resolve()
assert parent.is_dir() and str(parent) != '/' and os.geteuid() != 0
if os.uname().sysname == 'Darwin':
    assert str(parent).startswith('/Volumes/SmarterWork/agent-work/') and parent.stat().st_dev != P('/').stat().st_dev
    assert str(output).startswith('/Volumes/SmarterArchives/agent-evidence/')
assert not output.exists()
output.mkdir(parents=True, mode=0o700)
work = P(tempfile.mkdtemp(prefix='pg2-', dir=parent))
sock, data, logfile = work/'s', work/'d', work/'server.log'
sock.mkdir(mode=0o700)
assert len(str(sock).encode()) < 90
port = '58473'  # Unix socket only, private directory; no TCP listener.
node = shutil.which('node')
assert node
env = {'PATH': str(pg)+':/usr/bin:/bin', 'HOME': str(work), 'TMPDIR': str(work), 'LANG':'C', 'LC_ALL':'C'}
for name in ('postgres', 'psql', 'initdb', 'pg_ctl'):
    assert (pg/name).is_file()
migration = root/'supabase/migrations/20261025210847_indexes_accepted_horse_window_reads.sql'
sqlbytes = migration.read_bytes()
assert hashlib.sha256(sqlbytes).hexdigest() == EXPECTED
parser = root/'scripts/ci/migration-concurrent-preamble.mjs'
history = root/'supabase/migrations/20260908042100_an_accepted_hand_is_one_commit_and_stats_leave_the_hot_path.sql'
started = False
writer = None
commands, checks = [], {}
serial = 0
receipt = {'version':1, 'scope':'isolated_pg17_exact_index_migration', 'migration':str(migration),
           'migrationSha256':EXPECTED, 'parserSha256':hashlib.sha256(parser.read_bytes()).hexdigest(),
           'historicalTableSourceSha256':hashlib.sha256(history.read_bytes()).hexdigest(),
           'productionConnection':False, 'productionInstalled':False, 'checks':checks}

def run(args, sql=None, error=None, extra=None, timeout=25):
    global serial
    childenv = dict(env)
    if extra: childenv.update(extra)
    reply = subprocess.run([str(x) for x in args], input=sql, text=True, capture_output=True,
                           env=childenv, timeout=timeout)
    serial += 1
    (output/f'{serial:03d}.stdout').write_text(reply.stdout)
    (output/f'{serial:03d}.stderr').write_text(reply.stderr)
    command = {'argv':[str(x) for x in args], 'sql':sql, 'exitCode':reply.returncode}
    commands.append(command)
    (output/f'{serial:03d}.json').write_text(json.dumps(command))
    if error:
        assert reply.returncode != 0 and error in reply.stderr, reply.stdout+reply.stderr
    else:
        assert reply.returncode == 0, reply.stdout+reply.stderr
    return reply.stdout.strip()

psql = [pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-h',sock,'-p',port,'-U','postgres','-d','postgres']
def q(sql): return run(psql, sql)
def apply(error=None, extra=None): return run([*psql,'-f',migration], error=error, extra=extra)
def catalog():
    raw=q("""SELECT json_build_object('oid',i.indexrelid::text,'valid',i.indisvalid,'ready',i.indisready,
       'live',i.indislive,'definition',pg_get_indexdef(i.indexrelid)) FROM pg_index i
       WHERE i.indexrelid=to_regclass('public.horse_accepted_window_time')
       AND i.indrelid='public.hand_atomic_commits'::regclass""")
    return json.loads(raw) if raw else None
def fingerprint():
    return q("SELECT md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY hand_id)) FROM public.hand_atomic_commits t")
def wait_for(sql):
    deadline=time.monotonic()+4
    while time.monotonic()<deadline:
        if q(sql)=='t': return
        time.sleep(.03)
    raise AssertionError('own fixture condition not observed')

try:
    version=run([pg/'postgres','--version'])
    assert ' 17.' in version, version
    receipt['binaryVersion']=version
    js="import{readFileSync}from'node:fs';import{pathToFileURL}from'node:url';const{splitConcurrentPreamble}=await import(pathToFileURL(process.argv[2]));process.stdout.write(JSON.stringify(splitConcurrentPreamble(readFileSync(process.argv[1],'utf8'))));"
    shape=json.loads(run([node,'--input-type=module','-e',js,migration,parser]))
    assert shape['ok'] and len(shape['indexes'])==1
    ix=shape['indexes'][0]
    assert (ix['name'],ix['schema'],ix['table'])==('horse_accepted_window_time','public','hand_atomic_commits')
    assert shape['body'].encode()==sqlbytes[sqlbytes.index(b'BEGIN;'):]
    checks['maintainedPreambleParser']=True
    run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(sock)+"'\nport="+port+"\nautovacuum=off\n")
    run([pg/'pg_ctl','-D',data,'-l',logfile,'-w','start'])
    started=True
    identity=json.loads(q("SELECT json_build_object('version',current_setting('server_version_num')::int,'host',inet_server_addr(),'dir',current_setting('data_directory'),'listen',current_setting('listen_addresses'),'port',current_setting('port'))"))
    assert 170000<=identity['version']<180000 and identity['host'] is None and identity['dir']==str(data) and identity['listen']=='' and identity['port']==port
    receipt['serverIdentity']=identity
    old=history.read_text()
    tableddl=old[old.index('CREATE TABLE IF NOT EXISTS public.hand_atomic_commits ('):]
    tableddl=tableddl[:tableddl.index('\n);')+3]
    q(tableddl)
    q("""INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result,committed_at)
       SELECT md5('fixture-table')::uuid,1000000+n,md5('fixture-hand:'||n)::uuid,
       md5(n::text)||md5(n::text),'{}'::jsonb,'2026-10-25 00:00:00+00'::timestamptz+n*interval '1 millisecond'
       FROM generate_series(1,5000)n""")
    original_rows=fingerprint()
    apply()
    first=catalog()
    expected='CREATE INDEX horse_accepted_window_time ON public.hand_atomic_commits USING btree (committed_at, hand_id)'
    assert first and first['valid'] and first['ready'] and first['live'] and first['definition']==expected
    checks['exactSqlCreatesValidReadyDefinition']=first
    apply()
    assert catalog()==first and fingerprint()==original_rows
    checks['idempotentSameOid']=first['oid']

    # Setup is confined to this disposable fixture. The exact migration must
    # refuse the wrong identity, never silently DROP/REINDEX/rebuild it.
    q('DROP INDEX public.horse_accepted_window_time; CREATE INDEX horse_accepted_window_time ON public.hand_atomic_commits (hand_id,committed_at)')
    wrong=catalog()
    apply(error='accepted window index missing, invalid or definition differs')
    assert catalog()==wrong and fingerprint()==original_rows
    checks['wrongColumnsRefusedWithoutRebuild']=wrong
    q('DROP INDEX public.horse_accepted_window_time')

    # Real failed concurrent build: an older own writer makes the exact CIC
    # wait after creating its catalog entry; a bounded session timeout cancels
    # it. No pg_catalog writes or manufactured validity flags are used.
    writer_sql="""SET application_name='horse_window_own_writer'; BEGIN;
       INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result)
       VALUES(md5('fixture-table')::uuid,1999999,md5('uncommitted')::uuid,repeat('a',64),'{}');
       SELECT 'WRITER_READY';
    """
    writer=subprocess.Popen([str(x) for x in psql],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    writer.stdin.write(writer_sql);writer.stdin.flush()
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='horse_window_own_writer' AND state='idle in transaction' AND backend_xid IS NOT NULL)")
    apply(error='57014',extra={'PGOPTIONS':'-c statement_timeout=500ms'})
    invalid=catalog()
    assert invalid and not invalid['valid'] and invalid['definition']==expected
    checks['realConcurrentBuildFailure']=invalid
    writer.stdin.write('ROLLBACK;\n');writer.stdin.close();writer.wait(timeout=5)
    (output/'writer.stdout').write_text(writer.stdout.read());(output/'writer.stderr').write_text(writer.stderr.read());(output/'writer.sql').write_text(writer_sql+'ROLLBACK;\n')
    assert writer.returncode==0
    writer=None
    assert fingerprint()==original_rows
    apply(error='accepted window index missing, invalid or definition differs')
    assert catalog()==invalid and fingerprint()==original_rows
    assert q("SELECT count(*) FROM pg_class WHERE relname LIKE 'horse_accepted_window_time_cc%'")=='0'
    checks['invalidResumeRefusedSameOidNoRepair']=invalid['oid']
    assert hashlib.sha256(migration.read_bytes()).hexdigest()==EXPECTED
    receipt['status']='passed'
except BaseException as error:
    receipt['status']='failed'
    receipt['failure']=str(error)
    raise
finally:
    if writer is not None:
        if writer.stdin and not writer.stdin.closed: writer.stdin.close()
        if writer.poll() is None: writer.terminate()
        writer.wait(timeout=5)
    if started:
        run([pg/'pg_ctl','-D',data,'-w','-m','fast','stop'])
        status=subprocess.run([str(pg/'pg_ctl'),'-D',str(data),'status'],capture_output=True,text=True,env=env,timeout=5)
        assert status.returncode==3, 'own cluster still running'
        checks['ownClusterStopped']=True
    if logfile.exists(): shutil.copyfile(logfile,output/'server.log')
    shutil.rmtree(work)
    checks['ownClusterDataAndSocketRemoved']=not work.exists()
    receipt['commands']=commands
    receipt['completedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    (output/'receipt.json').write_text(json.dumps(receipt,indent=2))
    print(json.dumps({'status':receipt['status'],'migrationSha256':EXPECTED,'checks':list(checks),'receipt':str(output/'receipt.json')}))
