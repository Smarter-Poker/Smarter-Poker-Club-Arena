"""Run the actual source/drift transition triggers in isolated PostgreSQL 17."""
import json, os, pathlib, shutil, subprocess, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[2]
PG = pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
cluster = pathlib.Path(tempfile.mkdtemp(prefix='d-'))
sock = cluster/'s'; sock.mkdir()
owner = ['runuser','-u','postgres','--'] if os.geteuid()==0 else []
if owner:
    shutil.chown(cluster,'postgres'); shutil.chown(sock,'postgres')
env = dict(os.environ, LC_ALL='C')
checks = []
def cmd(args, sql=None):
    r=subprocess.run(owner+list(map(str,args)), input=sql,text=True,capture_output=True,env=env,timeout=45)
    if r.returncode: raise RuntimeError(r.stderr)
    return r.stdout.strip()
def run(sql):
    return cmd([PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','55892','-U','postgres'],sql)
def check(name, sql):
    assert run(sql)=='t', name
    checks.append(name)
try:
    cmd([PG/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale'])
    cmd([PG/'pg_ctl','-D',cluster/'data','-l',cluster/'log','-o',f"-k {sock} -p 55892 -c listen_addresses='' -c shared_buffers=16MB",'-w','start'])
    run("""CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE ca_diamond_incidents(id bigint primary key,rule text,severity text,resolved_at timestamptz,resolved_by uuid,resolution text);
    CREATE TABLE ca_drift_incidents(id integer primary key,source text,metadata jsonb,status text,detected_at timestamptz default now(),resolved_at timestamptz,resolved_by uuid,closure_basis text,root_cause text,correction_ref text,resolution text);
    CREATE TABLE pages(id bigint);
    CREATE FUNCTION fn_ca_diamond_incident_pages() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN INSERT INTO pages VALUES(NEW.id); RETURN NEW; END$$;
    INSERT INTO ca_diamond_incidents VALUES(912032,'DR0','critical',now(),null,'explicit verified source resolution');
    INSERT INTO ca_drift_incidents(id,source,metadata,status) VALUES(1,'ca_diamond_incidents','{"rule":"DR0"}','open');
    """)
    run((ROOT/'scripts/ci/fixtures/diamond-resolution/cause-guard.sql').read_text()+';'+
        "CREATE TRIGGER actual_cause_guard BEFORE UPDATE ON ca_drift_incidents FOR EACH ROW EXECUTE FUNCTION fn_ca_resolution_needs_a_cause();")
    check('baseline-missing-propagation',"SELECT resolved_at IS NULL FROM ca_drift_incidents WHERE id=1")
    migration=next((ROOT/'supabase/migrations').glob('*_diamond_incident_resolution_reaches_its_drift_episode.sql')).read_text()
    run(migration)
    check('historical-source-closes-its-episode',"SELECT status='resolved' AND correction_ref='verified: diamond-source:912032' FROM ca_drift_incidents WHERE id=1")
    run("""INSERT INTO ca_diamond_incidents VALUES(1,'shared','critical',null,null,null),(2,'shared','critical',null,null,null),(3,'other','critical',null,null,null),(4,'info','info',null,null,null);
    INSERT INTO ca_drift_incidents(id,source,metadata,status) VALUES(2,'ca_diamond_incidents','{"rule":"shared"}','open'),(3,'ca_diamond_incidents','{"rule":"other"}','open'),(4,'unrelated','{"rule":"shared"}','open'),(5,'ca_diamond_incidents','{"rule":"info"}','open');
    UPDATE ca_diamond_incidents SET resolved_at=now(),resolution='verified one' WHERE id=1;""")
    check('another-open-critical-keeps-episode-open',"SELECT resolved_at IS NULL FROM ca_drift_incidents WHERE id=2")
    run("UPDATE ca_diamond_incidents SET resolved_at=now() WHERE id=2")
    check('missing-resolution-note-stays-open',"SELECT resolved_at IS NULL FROM ca_drift_incidents WHERE id=2")
    run("UPDATE ca_diamond_incidents SET resolved_at=resolved_at,resolution='verified last' WHERE id=2")
    check('last-source-resolves-episode',"SELECT status='resolved' AND resolution LIKE '%verified last' FROM ca_drift_incidents WHERE id=2")
    check('other-rules-and-sources-untouched',"SELECT bool_and(resolved_at IS NULL) FROM ca_drift_incidents WHERE id IN (3,4,5)")
    run("UPDATE ca_diamond_incidents SET resolved_at=now(),resolution='info complete' WHERE id=4")
    check('noncritical-does-not-close-critical-episode',"SELECT resolved_at IS NULL FROM ca_drift_incidents WHERE id=5")
    run("UPDATE ca_diamond_incidents SET resolved_at=resolved_at WHERE id=2")
    check('duplicate-is-idempotent',"SELECT count(*)=1 FROM ca_drift_incidents WHERE id=2 AND status='resolved'")
    run("UPDATE ca_diamond_incidents SET resolved_at=null WHERE id=2")
    check('reopening-uses-existing-paging-function',"SELECT count(*)=1 FROM pages WHERE id=2")
    run("BEGIN; UPDATE ca_diamond_incidents SET resolved_at=now(),resolution='rollback' WHERE id=3; ROLLBACK;")
    check('source-and-drift-rollback-together',"SELECT d.resolved_at IS NULL AND s.resolved_at IS NULL FROM ca_drift_incidents d JOIN ca_diamond_incidents s ON d.id=s.id WHERE d.id=3")
    check('trigger-function-is-private',"SELECT NOT has_function_privilege('anon','fn_ca_diamond_resolution_reaches_drift()','EXECUTE') AND NOT has_function_privilege('authenticated','fn_ca_diamond_rule_transition_lock()','EXECUTE')")
    # Keep the source transaction open on one connection and ask the same rule
    # lock from another, proving both insert and update serialize contenders.
    for mutation in ("INSERT INTO ca_diamond_incidents VALUES(8,'locked','critical',null,null,null)",
                     "UPDATE ca_diamond_incidents SET resolved_at=now() WHERE id=3"):
        key = 'locked' if mutation.startswith('INSERT') else 'other'
        connection = subprocess.Popen(owner+list(map(str,[PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','55892','-U','postgres'])),
                                      stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
        try:
            connection.stdin.write("BEGIN;"+mutation+";\n\\echo locked\n")
            connection.stdin.flush()
            assert connection.stdout.readline().strip()=='locked'
            check('concurrent-rule-lock-'+key, "SELECT NOT pg_try_advisory_xact_lock(hashtextextended('ca-diamond-rule:"+key+"',0))")
        finally:
            connection.stdin.write('ROLLBACK;\n'); connection.stdin.close()
            assert connection.wait(timeout=10)==0
        check('rule-lock-released-'+key, "SELECT pg_try_advisory_xact_lock(hashtextextended('ca-diamond-rule:"+key+"',0))")
    # Fail the consumer write: the original source update must roll back too.
    run("ALTER TABLE ca_drift_incidents ADD CONSTRAINT refuse_fixture_resolution CHECK(id<>3 OR resolved_at IS NULL)")
    try:
        run("UPDATE ca_diamond_incidents SET resolved_at=now(),resolution='must rollback' WHERE id=3")
        raise AssertionError('consumer failure was swallowed')
    except RuntimeError as e:
        assert 'refuse_fixture_resolution' in str(e)
    check('consumer-failure-cannot-commit-source-success',"SELECT resolved_at IS NULL FROM ca_diamond_incidents WHERE id=3")
    print(json.dumps({'passed':len(checks),'checks':checks,'limit':'Real PostgreSQL trigger transitions. Existing paging function invocation recorded; notification delivery retains its existing qualification.'}))
finally:
    if (cluster/'data/postmaster.pid').exists(): cmd([PG/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
    shutil.rmtree(cluster)
