"""Direct extension of the required native F06 gate, never a production actuator."""
import hashlib
import json
import re
import subprocess
import sys
import time
from contextlib import contextmanager


def qualify(root, out, cmd, command, run, probe, require, results):
    here = root / 'scripts/ci/probes/f06-shared-hand-lane'
    built=command([sys.executable,here/'build-unsettled-migration.py','--check'])
    require(built.returncode==0,built.stdout+built.stderr)
    results['cases'].append({'name':'abort-exact-composed-source','passed':True})
    inputs=sorted(here.glob('*'))
    inputs += [root/'scripts/ci/test-f06-shared-hand-lane.py',
               root/'supabase/migrations/20260918053310_interrupted_sng_hands_keep_stacks_and_fence_their_original_writers.sql',
               root/'scripts/ci/classify-ci-changes.mjs',root/'tests/unit/fixtureNativeCi.test.ts']
    results['unsettledInputs']={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs if p.is_file()}
    run('abort-database', 'CREATE DATABASE f06_unsettled;')
    cmd[-1] = 'f06_unsettled'
    run('abort-fixture', (here / 'unsettled-fixture.sql').read_text())
    original = (root / 'supabase/migrations/20260912100322_tournament_break_original_custody_and_hand_authority.sql').read_text()
    shape = original[original.index('CREATE SEQUENCE'):original.index('CREATE FUNCTION smarter_private.f06_authority')]
    run('abort-original-private-schema', shape)
    captured = json.loads((here / 'unsettled-preimages.json').read_text())['functions']
    definitions = ['SET check_function_bodies=off;']
    for row in captured:
        sig = row['signature']
        if '.' not in sig.split('(')[0]:
            sig = 'public.' + sig
        definitions.append(row['definition'].rstrip() + ';')
        definitions.append('REVOKE ALL ON FUNCTION ' + sig + ' FROM PUBLIC,anon,authenticated,service_role;')
        for role in ['anon', 'authenticated', 'service_role']:
            if role + '=X/' in (row.get('acl') or ''):
                definitions.append('GRANT EXECUTE ON FUNCTION ' + sig + ' TO ' + role + ';')
    definitions += [(here / 'unsettled-lane-preimage.sql').read_text(), 'SET check_function_bodies=on;']
    run('abort-exact-installed-functions', '\n'.join(definitions))
    run('abort-exact-freeze-functions',(here/'unsettled-freeze-preimages.sql').read_text())
    bindings=json.loads((here/'unsettled-bindings.json').read_text())
    run('abort-original-trigger-bindings','\n'.join(b['definition']+';' for b in bindings))
    run('abort-native-postgrest-configuration',"""
      CREATE ROLE authenticator;
      ALTER ROLE authenticator SET pgrst.db_pre_request='smarter_private.fn_smarter_data_api_pre_request';
    """)
    # Eight synthetic HU events reproduce the observed financial boundary:
    # seven total 600 and one 2000; one 600 event retains 70 previous hands.
    seed = """
    DO $$ DECLARE i integer;j integer;t uuid;tab uuid;u uuid;g uuid;n bigint;st numeric;invest numeric;
    BEGIN FOR i IN 1..8 LOOP
    t:=md5('t'||i)::uuid;tab:=md5('tab'||i)::uuid;g:=md5('g'||i)::uuid;n:=100000+i;
    INSERT INTO tournaments VALUES(t,'RUNNING','sng-v1',2,2);
    INSERT INTO tables(id,tournament_id,status) VALUES(tab,t,'waiting');
    INSERT INTO engine_tournament_leases VALUES(t,'original','2bbc5d5c',now(),now(),g,2);
    FOR j IN 1..2 LOOP
      u:=md5('user'||i||':'||j)::uuid;
      st:=CASE WHEN i=2 THEN 1000 WHEN i=5 AND j=1 THEN 238 WHEN i=5 THEN 362 ELSE 300 END;
      INSERT INTO table_seats VALUES(md5('seat'||i||':'||j)::uuid,tab,u,j,st,NULL,NULL,md5('occ'||i||':'||j)::uuid);
      INSERT INTO tournament_players VALUES(md5('reg'||i||':'||j)::uuid,t,tab,u,j,st,'playing');
    END LOOP;
    INSERT INTO hand_state_snapshots(table_id,hand_number,state_json)
    SELECT tab,n,jsonb_build_object('players',jsonb_agg(jsonb_build_object('user_id',user_id,'seat',seat_number,
      'stack',stack-CASE WHEN i=5 THEN seat_number*40 ELSE seat_number*10 END,
      'totalInvested',CASE WHEN i=5 THEN seat_number*40 ELSE seat_number*10 END,
      'deadInvested',0,'returnedUncalled',0,'individualAnteInvested',0) ORDER BY seat_number))
    FROM table_seats WHERE table_id=tab;
    INSERT INTO smarter_private.f06_hand_permits SELECT md5('permit'||i)::uuid,t,tab,f06_lifecycle,n,md5('handcustody'||i)::uuid,g,'reserved',NULL FROM tables WHERE id=tab;
    INSERT INTO smarter_private.f06_operations(break_id,tournament_id,source_table_id,lifecycle,boundary_id,origin_generation,revision,custody_id,custody_generation)
    SELECT md5('park'||i)::uuid,t,tab,f06_lifecycle,md5('boundary'||i)::uuid,g,1,md5('parkcustody'||i)::uuid,g FROM tables WHERE id=tab;
    IF i=5 THEN INSERT INTO hand_history(table_id,hand_number) SELECT tab,generate_series(1,70); END IF;
    END LOOP; END $$;
    CREATE FUNCTION public.fixture_expected(i integer) RETURNS jsonb LANGUAGE sql AS $$
    SELECT jsonb_build_object('tournament_id',l.tournament_id,'table_id',h.table_id,'generation',l.lease_generation,
      'instance_id',l.instance_id,'engine_version',l.engine_version,'permit',to_jsonb(h),
      'park',to_jsonb(o)-'abort_receipt_id','snapshot_id',s.id,'snapshot_hash',md5(to_jsonb(s)::text),
      'roster',(SELECT jsonb_agg(jsonb_build_object('seat_id',ts.id,'occupancy_id',ts.occupancy_id,'registration_id',tp.id,
      'user_id',ts.user_id,'seat_number',ts.seat_number,'stack',ts.stack,'chips',tp.chips) ORDER BY ts.user_id)
      FROM table_seats ts JOIN tournament_players tp ON tp.tournament_id=l.tournament_id AND tp.user_id=ts.user_id
      WHERE ts.table_id=h.table_id AND ts.left_at IS NULL))
    FROM engine_tournament_leases l JOIN smarter_private.f06_hand_permits h ON h.tournament_id=l.tournament_id
    JOIN smarter_private.f06_operations o ON o.source_table_id=h.table_id
    JOIN hand_state_snapshots s ON s.table_id=h.table_id AND NOT s.is_complete
    WHERE l.tournament_id=md5('t'||i)::uuid $$;
    CREATE TABLE fixture_expected_inputs(i integer PRIMARY KEY,expected jsonb);
    INSERT INTO fixture_expected_inputs SELECT i,fixture_expected(i) FROM generate_series(1,8) i;
    """
    run('abort-seed-eight-originals', seed)
    money = """SELECT jsonb_build_object(
    'seats',(SELECT jsonb_agg(s ORDER BY id) FROM table_seats s),
    'roster',(SELECT jsonb_agg(p ORDER BY id) FROM tournament_players p),
    'ledger',(SELECT jsonb_agg(l ORDER BY id) FROM fixture_ledger l),
    'history',(SELECT jsonb_agg(h ORDER BY id) FROM hand_history h));"""
    before = run('abort-financial-before', money)
    run('abort-original-money-equality', """SELECT (SELECT sum(stack) FROM table_seats)||'|'||
    (SELECT sum((p->>'stack')::numeric) FROM hand_state_snapshots CROSS JOIN LATERAL jsonb_array_elements(state_json->'players') p)||'|'||
    (SELECT sum((p->>'totalInvested')::numeric) FROM hand_state_snapshots CROSS JOIN LATERAL jsonb_array_elements(state_json->'players') p)||'|'||
    (SELECT count(*) FROM hand_history);""", '6200|5870|330|70')
    service = "SET request.jwt.claims='{\"role\":\"service_role\"}'; SET app.smarter_data_actor='service';"
    def abort(i=1):
        return "SELECT public.fn_f06_abort_unsettled_hand(md5('receipt" + str(i) + "')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=" + str(i) + "));"
    probe('abort-baseline-authority-absent', service + abort(), error='42883')
    probe('abort-baseline-generation-can-resurrect', """
    DELETE FROM engine_tournament_leases WHERE tournament_id=md5('t1')::uuid;
    SELECT granted FROM claim_tournament_lease_v2(md5('t1')::uuid,'original','2bbc5d5c',md5('g1')::uuid);
    """, 't')
    @contextmanager
    def held(sql, finish='ROLLBACK'):
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            p.stdin.write("BEGIN; SET statement_timeout='6s';" + sql + " SELECT pg_advisory_lock(18092026);\n")
            p.stdin.flush()
            deadline = time.monotonic()+5
            while command(cmd,"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=18092026 AND granted);").stdout.strip()!='t':
                require(p.poll() is None and time.monotonic()<deadline,'Abort native holder failed')
                time.sleep(.02)
            yield p
        finally:
            if p.poll() is None:
                p.stdin.write(finish+';\n');p.stdin.close();p.wait(timeout=8)
            stdout=p.stdout.read();stderr=p.stderr.read()
            require(p.returncode==0,'Abort native holder: '+stdout+stderr)
    installer = (root / 'supabase/migrations/20260918053310_interrupted_sng_hands_keep_stacks_and_fence_their_original_writers.sql').read_text()
    # The failed production installer held operations while a permit reader
    # needed operations. Reproduce that exact DDL prefix in two real sessions.
    admission=re.search(r'-- BEGIN installer relation admission\n[\s\S]*?-- END installer relation admission\n',installer)
    require(admission is not None,'Installer lost relation admission')
    old_installer=installer.replace(admission.group(0),'').rsplit('COMMIT;',1)[0]+'ROLLBACK;'
    prefix,suffix=old_installer.split('ALTER TABLE smarter_private.f06_hand_permits DROP CONSTRAINT',1)
    suffix='ALTER TABLE smarter_private.f06_hand_permits DROP CONSTRAINT'+suffix
    catalog="""SELECT md5(jsonb_build_object(
      'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl::text,p.proowner) ORDER BY p.oid)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','smarter_private') AND p.prokind='f'),
      'columns',(SELECT jsonb_agg(jsonb_build_array(c.oid,a.attname,a.atttypid,a.attnotnull,a.attnum) ORDER BY c.oid,a.attnum)
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN('public','smarter_private') AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_array(c.conrelid,c.conname,pg_get_constraintdef(c.oid)) ORDER BY c.oid)
        FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname IN('public','smarter_private')),
      'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.oid) FROM pg_trigger t WHERE NOT t.tgisinternal),
      'indexes',(SELECT jsonb_agg(indexdef ORDER BY schemaname,indexname) FROM pg_indexes WHERE schemaname IN('public','smarter_private'))
      )::text);"""
    catalog_before=run('abort-installer-original-catalog',catalog)
    reader=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    old_ddl=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    def barrier(sql,process,label):
        deadline=time.monotonic()+5
        while command(cmd,sql).stdout.strip()!='t':
            require(process.poll() is None and time.monotonic()<deadline,'Installer barrier missing: '+label)
            time.sleep(.02)
    try:
        reader.stdin.write("BEGIN; SET application_name='f06-install-reader'; SET statement_timeout='8s'; SET deadlock_timeout='5s'; LOCK TABLE smarter_private.f06_hand_permits IN ACCESS SHARE MODE; SELECT pg_advisory_lock(18092027);\n")
        reader.stdin.flush()
        barrier("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=18092027 AND granted);",reader,'original permit reader')
        old_ddl.stdin.write(prefix+"SET deadlock_timeout='100ms'; SELECT pg_advisory_lock(18092028);\n")
        old_ddl.stdin.flush()
        barrier("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=18092028 AND granted);",old_ddl,'old installer owns operations')
        reader.stdin.write('SELECT count(*) FROM smarter_private.f06_operations; ROLLBACK;\n');reader.stdin.close()
        barrier("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='f06-install-reader' AND wait_event_type='Lock');",reader,'permit reader needs operations')
        # The expected 40P01 can close psql while a large suffix is still being
        # copied into stdin. Let psql read the exact suffix file so the parent
        # always reaches the existing error/rollback assertions.
        old_suffix=out/'abort-baseline-installer-suffix.sql'
        old_suffix.write_text(suffix)
        old_ddl.stdin.write("\\i '"+str(old_suffix)+"'\n");old_ddl.stdin.close()
        old_ddl.wait(timeout=8);reader.wait(timeout=8)
        failure=old_ddl.stdout.read()+old_ddl.stderr.read()
        (out/'abort-baseline-installer-deadlock.log').write_text(failure)
        require(old_ddl.returncode!=0 and '40P01' in failure,'Original installer deadlock not reproduced: '+failure)
        require(reader.returncode==0,'Original reader failed: '+reader.stderr.read())
        results['cases'].append({'name':'abort-baseline-installer-deadlock','passed':True})
    finally:
        for process in [reader,old_ddl]:
            if process.poll() is None:
                process.terminate();process.wait(timeout=5)
    require(command(cmd,catalog).stdout.strip()==catalog_before,'Baseline deadlock leaked catalog changes')
    # Exercise the full installer, not only isolated LOCK statements. Every
    # acquired subset must unwind; persistent contention exhausts one budget.
    for relation,mode in [
      ('smarter_private.f06_hand_permits','ACCESS SHARE'),
      ('public.engine_tournament_leases','ROW EXCLUSIVE'),
      ('smarter_private.f06_operations','ACCESS SHARE'),
      ('public.hand_atomic_commits','ROW EXCLUSIVE'),
      ('public.hand_history','ROW EXCLUSIVE'),
      ('public.ca_declared_money_triggers','ACCESS EXCLUSIVE')]:
        with held('LOCK TABLE '+relation+' IN '+mode+' MODE;'):
            started=time.monotonic()
            failed=command(cmd,installer)
            elapsed=time.monotonic()-started
            text=failed.stdout+failed.stderr
            name='abort-installer-budget-'+relation.split('.')[-1]
            (out/(name+'.log')).write_text(text)
            require(failed.returncode!=0 and '55P03' in text and 'F06_INSTALL_ADMISSION_BUSY' in text and 2.9<=elapsed<4.5,
                    'Installer exceeded admission budget or began schema work: '+text)
        require(command(cmd,catalog).stdout.strip()==catalog_before,'Refused installer leaked catalog changes: '+relation)
        require(command(cmd,money).stdout.strip()==before,'Refused installer changed money: '+relation)
        results['cases'].append({'name':name,'passed':True})
    run('abort-refuses-disabled-original-trigger',"BEGIN; ALTER TABLE public.hand_atomic_commits DISABLE TRIGGER zzzz_f06_accepted_hand;"+installer,error='F06_ABORT_BINDING_CHANGED')
    run('abort-refuses-uninstalled-request-hook',"BEGIN; ALTER ROLE authenticator RESET pgrst.db_pre_request;"+installer,error='F06_ABORT_PRE_REQUEST_NOT_INSTALLED')
    # A last-relation blocker must see every earlier partial lock released.
    # Interleave a new permit reader before it drains to exercise re-admission.
    reader=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    with held('LOCK TABLE public.ca_declared_money_triggers IN ACCESS EXCLUSIVE MODE;'):
        # The 70KB migration exceeds Linux's stdin pipe capacity. Feeding it
        # synchronously can block this parent until admission times out, before
        # the parent reaches the reader-release barrier. psql owns the file read.
        admitted_sql=out/'abort-concurrent-installer.sql'
        admitted_sql.write_text("SET application_name='f06-corrected-installer';"+installer)
        admitted=subprocess.Popen(cmd+['-f',str(admitted_sql)],stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        barrier("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='f06-corrected-installer' AND wait_event='PgSleep');",admitted,'corrected installer releases partial lock set')
        reader.stdin.write("BEGIN;SET lock_timeout='1s'; LOCK TABLE smarter_private.f06_hand_permits IN ACCESS SHARE MODE; SELECT count(*) FROM smarter_private.f06_operations; SELECT pg_advisory_lock(18092029);\n")
        reader.stdin.flush()
        barrier("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=18092029 AND granted);",reader,'original permit reader proceeds through operations')
        run('abort-installer-yields-with-no-application-lock',"""SELECT NOT EXISTS(
          SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
          JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE a.application_name='f06-corrected-installer' AND l.granted
          AND n.nspname IN('public','smarter_private'));""",'t')
        run('abort-installer-yields-before-any-ddl',"""SELECT
          to_regclass('smarter_private.f06_unsettled_hand_aborts') IS NULL
          AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='smarter_private.f06_operations'::regclass
          AND attname='abort_receipt_id' AND NOT attisdropped);""",'t')

    require(admitted.poll() is None,'Installer did not preserve the interleaved permit reader')
    reader.stdin.write('ROLLBACK;\n');reader.stdin.close();reader.wait(timeout=5)
    require(reader.returncode==0,'Interleaved reader failed: '+reader.stderr.read())
    admitted.wait(timeout=8)
    installed=admitted.stdout.read()+admitted.stderr.read()
    (out/'abort-install-after-interleaved-readers-drain.log').write_text(installed)
    require(admitted.returncode==0,'Drained full installer failed: '+installed)
    results['cases'].append({'name':'abort-install-after-interleaved-readers-drain','passed':True})
    postimages=json.loads(run('abort-installed-function-hashes', """SELECT jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,
      'md5',md5(pg_get_functiondef(p.oid)),'acl',p.proacl::text,'owner',pg_get_userbyid(p.proowner)) ORDER BY p.oid::regprocedure::text)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind='f'
      AND (n.nspname='smarter_private' OR p.proname LIKE 'fn_f06_%' OR p.proname IN('claim_tournament_lease_v2','heartbeat_tournament_leases_v3','heartbeat_tournament_leases_v4'));"""))
    for expected in json.loads((here/'unsettled-changed-functions.json').read_text()):
        actual=next(x for x in postimages if x['name']==expected['signature'])
        original=next(x for x in captured if x['signature']==expected['signature'])
        require(actual['md5']==expected['after_md5'] and actual['owner']=='postgres' and actual['acl']==original['acl'],
                'Installed function postimage/owner/ACL changed: '+expected['signature'])
    results['cases'].append({'name':'abort-all-14-postimages-and-acls','passed':True})
    require(run('abort-install-keeps-money', money) == before, 'DDL changed money')
    probe('abort-browser-refused', "SET ROLE authenticated;" + service + abort(), error='42501')
    probe('abort-wrong-service-actor', "SET request.jwt.claims='{\"role\":\"service_role\"}';SET app.smarter_data_actor='tournament-manager';" + abort(), error='F06_ABORT_SERVICE_REQUIRED')
    controls = [
      ('changed-expected', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{instance_id}','\"wrong\"') WHERE i=1;",'F06_ABORT_ORIGINAL_LEASE_CHANGED'),
      ('changed-occupancy', "UPDATE table_seats SET occupancy_id=gen_random_uuid() WHERE id=md5('seat1:1')::uuid;",'F06_ABORT_EXPECTED_CHANGED'),
      ('changed-stack', "UPDATE table_seats SET stack=301 WHERE id=md5('seat1:1')::uuid;",'F06_ABORT_SAVED_STACKS_CHANGED'),
      ('committed-hand', "INSERT INTO hand_atomic_commits VALUES(md5('tab1')::uuid,100001,gen_random_uuid(),NULL);",'F06_ABORT_COMMITTED_OR_DISPATCHED'),
      ('hand-history', "INSERT INTO hand_history(table_id,hand_number) VALUES(md5('tab1')::uuid,100001);",'F06_ABORT_COMMITTED_OR_DISPATCHED'),
      ('dispatch', "INSERT INTO smarter_private.f06_hand_dispatch VALUES(md5('permit1')::uuid,txid_current());",'F06_ABORT_COMMITTED_OR_DISPATCHED'),
      ('begun-park', "UPDATE smarter_private.f06_operations SET state='begun',manifest='{}' WHERE break_id=md5('park1')::uuid;",'F06_ABORT_PARK_NOT_PREMANIFEST'),
      ('wrong-format', "UPDATE tournaments SET format_contract='mtt-v1' WHERE id=md5('t1')::uuid;",'F06_ABORT_SCOPE_CHANGED'),
      ('wrong-lifecycle', "UPDATE tables SET f06_lifecycle=f06_lifecycle+1 WHERE id=md5('tab1')::uuid;",'F06_LIFECYCLE_IMMUTABLE'),
      ('completed-snapshot', "UPDATE hand_state_snapshots SET is_complete=true WHERE table_id=md5('tab1')::uuid;",'F06_ABORT_SNAPSHOT_CHANGED'),
      ('changed-snapshot', "UPDATE hand_state_snapshots SET stage='turn' WHERE table_id=md5('tab1')::uuid;",'F06_ABORT_EXPECTED_CHANGED'),
      ('non-headsup', "UPDATE tournaments SET table_size=6 WHERE id=md5('t1')::uuid;",'F06_ABORT_SCOPE_CHANGED'),
      ('terminal-player', "UPDATE tournament_players SET status='eliminated' WHERE id=md5('reg1:1')::uuid;",'F06_SOURCE_EXCLUDED'),
      ('null-custody-generation', "UPDATE smarter_private.f06_operations SET custody_generation=NULL WHERE break_id=md5('park1')::uuid;UPDATE fixture_expected_inputs SET expected=fixture_expected(1) WHERE i=1;",'F06_ABORT_PARK_NOT_PREMANIFEST'),
      ('null-permit', "UPDATE fixture_expected_inputs SET expected=expected-'permit' WHERE i=1;",'F06_ABORT_ORIGINAL_PERMIT_CHANGED'),
      ('last-hand-freeze', "INSERT INTO engine_maintenance_break VALUES(true,now()-interval '3 minutes','last_hand',NULL,NULL);",'PLATFORM_FROZEN'),
      ('countdown-freeze', "INSERT INTO engine_maintenance_break VALUES(true,now()-interval '3 minutes','counting_down',now()-interval '1 minute',now()+interval '4 minutes');",'PLATFORM_FROZEN'),
      ('v3-release-freeze', """INSERT INTO engine_maintenance_thaws VALUES(3,now()+interval '1 minute',
        '{"complete":true,"sit_out_at":true,"hold_expires_at":true,"addon_period_ends_at":true,"reversible_until":true,
        "reveal_deadline_at":true,"rebuy_prompt_until":true,"bomb_pot_next_due_at":true,"cash_stay_last_tick_at":true,
        "cash_rejoin_expires_at":true,"level_started_at":true,"cluster_break_eligible_since":true,"cluster_move_expires_at":true,
        "reconnect_presence":true,"reconnect_snapshots":true}');""",'PLATFORM_FROZEN'),
    ]
    for name, change, error in controls:
        probe('abort-refuses-' + name, service + change + abort(), error=error)
    probe('abort-truthful-outcome', service + abort() + """
    DO $$BEGIN
    IF (SELECT state FROM smarter_private.f06_hand_permits WHERE permit_id=md5('permit1')::uuid)<>'aborted_unsettled'
    OR (SELECT state FROM smarter_private.f06_operations WHERE break_id=md5('park1')::uuid)<>'withdrawn_before_manifest'
    OR EXISTS(SELECT 1 FROM hand_atomic_commits)
    OR EXISTS(SELECT 1 FROM hand_state_snapshots WHERE table_id=md5('tab1')::uuid AND NOT is_complete)
    THEN RAISE EXCEPTION 'truthful abort outcome missing'; END IF; END $$;
    """)
    # Exact lane holders prove abort never waits lease-first behind a T/G-first
    # owner. Real PostgreSQL locks, not mocked ordering assertions.
    for name, lane in [('global','ca:tournament-terminal-settlement:v1'),('tournament',"ca:tournament-terminal-settlement:v1:"+hashlib.md5(b't1').hexdigest()[0:8]+'-'+hashlib.md5(b't1').hexdigest()[8:12]+'-'+hashlib.md5(b't1').hexdigest()[12:16]+'-'+hashlib.md5(b't1').hexdigest()[16:20]+'-'+hashlib.md5(b't1').hexdigest()[20:])]:
        with held("SELECT pg_advisory_xact_lock(hashtextextended('"+lane+"',0));"):
            probe('abort-'+name+'-first-refuses-without-deadlock',service+abort(),error='F06_RETRY_CANONICAL_LANE')
    manager = """SET request.jwt.claims='{"role":"service_role"}';
    SELECT set_config('request.headers',jsonb_build_object('x-smarter-data-actor','tournament-manager','x-smarter-data-protocol','2',
      'x-smarter-tournament-id',md5('t1')::uuid,'x-smarter-tournament-lease-generation',md5('g1')::uuid)::text,true);
    SET request.method='POST';SELECT smarter_private.fn_smarter_data_api_pre_request();"""
    # An admitted writer owns KEY SHARE. Abort cannot certify while it runs.
    with held(manager):
        probe('abort-drains-admitted-original-writer',"SET LOCAL lock_timeout='150ms';"+service+abort(),error='55P03')
    with held("SELECT pg_advisory_xact_lock(hashtextextended('f06:hand:'||md5('permit1')::uuid::text,0));"):
        probe('abort-original-dispatch-first-refuses-without-deadlock',service+abort(),error='F06_HAND_DISPATCH_BUSY')
    with held("SELECT 1 FROM engine_tournament_leases WHERE tournament_id=md5('t1')::uuid FOR UPDATE;"):
        probe('abort-claim-first-drains-without-deadlock',"SET LOCAL lock_timeout='150ms';"+service+abort(),error='55P03')
        pending=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        pending.stdin.write("BEGIN;SET statement_timeout='6s';"+service+abort()+"COMMIT;");pending.stdin.close()
        deadline=time.monotonic()+4
        while command(cmd,"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%fn_f06_abort_unsettled_hand%');").stdout.strip()!='t':
            require(pending.poll() is None and time.monotonic()<deadline,'Abort did not queue after initial freeze admission')
            time.sleep(.02)
        run('abort-freeze-enters-while-original-lease-drains',
            "INSERT INTO engine_maintenance_break VALUES(true,now()-interval '3 minutes','last_hand',NULL,NULL);")
    pending.wait(timeout=8)
    output=pending.stdout.read()+pending.stderr.read()
    (out/'abort-freeze-after-admission.log').write_text(output)
    require(pending.returncode!=0 and 'PLATFORM_FROZEN' in output,'Queued abort crossed platform freeze: '+output)
    results['cases'].append({'name':'abort-freeze-after-admission','passed':True})
    run('abort-reset-owned-native-freeze','DELETE FROM engine_maintenance_break;')
    # Abort wins; every queued original route is denied after its COMMIT.
    with held(service+abort(),finish='COMMIT'):
        probe('abort-heartbeat-v4-remains-busy',"SELECT state FROM heartbeat_tournament_leases_v4('original',jsonb_build_array(jsonb_build_object('tournament_id',md5('t1')::uuid,'lease_generation',md5('g1')::uuid)));",'busy')
        probe('abort-heartbeat-v3-cannot-cross-drain',"SET LOCAL lock_timeout='150ms';SELECT state FROM heartbeat_tournament_leases_v3('original',jsonb_build_array(jsonb_build_object('tournament_id',md5('t1')::uuid,'lease_generation',md5('g1')::uuid)));",error='55P03')
        queued=[]
        for name,sql in [
            ('late-manager-write',manager+"UPDATE table_seats SET stack=0 WHERE id=md5('seat1:1')::uuid;"),
            ('claim-resurrection',"SELECT granted FROM claim_tournament_lease_v2(md5('t1')::uuid,'original','2bbc5d5c',md5('g1')::uuid);"),
            ('direct-lease-resurrection',"INSERT INTO engine_tournament_leases VALUES(md5('t1')::uuid,'original','2bbc5d5c',now(),now(),md5('g1')::uuid,2);")]:
            proc=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            proc.stdin.write("BEGIN; SET statement_timeout='6s';"+sql+"COMMIT;");proc.stdin.close()
            queued.append((name,proc))
        time.sleep(.15)
        require(all(p.poll() is None for _,p in queued),'Expected real queued lease contenders')
    for name,p in queued:
        p.wait(timeout=8);stdout=p.stdout.read();stderr=p.stderr.read()
        (out/('abort-'+name+'.log')).write_text(stdout+stderr)
        ok=(p.returncode==0 and stdout.strip()=='f') if name=='claim-resurrection' else p.returncode!=0 and ('FENCED' in stderr)
        results['cases'].append({'name':'abort-'+name,'passed':ok});require(ok,stdout+stderr)
    for name,sql,error in [
        ('late-dispatch',"SELECT smarter_private.f06_hand_dispatch_guard(md5('tab1')::uuid,100001);",'F06_HAND_PERMIT_FENCED'),
        ('late-atomic',"INSERT INTO hand_atomic_commits VALUES(md5('tab1')::uuid,100001,gen_random_uuid(),NULL);",'F06_ABORTED_HAND_FENCED'),
        ('late-history',"INSERT INTO hand_history(table_id,hand_number) VALUES(md5('tab1')::uuid,100001);",'F06_ABORTED_HAND_FENCED'),
        ('receipt-mutation',"UPDATE smarter_private.f06_unsettled_hand_aborts SET expected='{}';",'F06_ABORT_RECEIPT_IMMUTABLE'),
        ('permit-mutation',"UPDATE smarter_private.f06_hand_permits SET state='accepted' WHERE permit_id=md5('permit1')::uuid;",'F06_HAND_IDENTITY_IMMUTABLE'),
        ('park-mutation',"UPDATE smarter_private.f06_operations SET custody_id=gen_random_uuid() WHERE break_id=md5('park1')::uuid;",'F06_WITHDRAWAL_IMMUTABLE'),
    ]:
        probe('abort-'+name,sql,error=error)
    run('abort-exact-replay',service+abort())
    probe('abort-changed-replay',service+"UPDATE fixture_expected_inputs SET expected=expected||'{\"unexpected\":true}' WHERE i=1;"+abort(),error='F06_ABORT_CHANGED_REPLAY')
    run('abort-all-eight-originals',service+'\n'.join(abort(i) for i in range(1,9)))
    run('abort-eight-immutable-receipts',"""SELECT
      (SELECT count(*) FROM smarter_private.f06_unsettled_hand_aborts)||'|'||
      (SELECT count(*) FROM smarter_private.f06_hand_permits WHERE state='aborted_unsettled')||'|'||
      (SELECT count(*) FROM smarter_private.f06_operations WHERE state='withdrawn_before_manifest')||'|'||
      (SELECT count(*) FROM hand_state_snapshots WHERE is_complete)||'|'||
      (SELECT count(*) FROM engine_tournament_leases);""",'8|8|8|8|0')
    require(run('abort-financial-after',money)==before,'Abort changed original stacks, prior hands or ledger')
    run('abort-new-generation-claim',"SELECT granted FROM claim_tournament_lease_v2(md5('t1')::uuid,'new-owner','2ad',md5('new-g1')::uuid);",'t')
    fresh=manager.replace("md5('g1')","md5('new-g1')")
    probe('abort-fresh-manager-can-reserve',fresh+"""DO $$DECLARE v jsonb;BEGIN
    v:=fn_f06_table_state(md5('t1')::uuid,md5('new-g1')::uuid,md5('tab1')::uuid);
    IF v->>'can_reserve' IS DISTINCT FROM 'true' OR v->>'excluded' IS DISTINCT FROM 'false'
    OR v->'unresolved_permits' IS DISTINCT FROM '[]'::jsonb
    OR (v->>'hand_number_high_water')::bigint IS DISTINCT FROM 100001 THEN RAISE EXCEPTION 'fresh admission contract changed'; END IF;
    END $$;""")
    probe('abort-old-release-cannot-delete-successor',"""SELECT release_tournament_leases_v2('original',jsonb_build_array(jsonb_build_object('tournament_id',md5('t1')::uuid,'lease_generation',md5('g1')::uuid)));SELECT count(*) FROM engine_tournament_leases;""",'0\n1')
    for version in [3,4]:
        probe('abort-old-heartbeat-v'+str(version),"""SELECT state FROM heartbeat_tournament_leases_v"""+str(version)+"""('original',jsonb_build_array(jsonb_build_object('tournament_id',md5('t1')::uuid,'lease_generation',md5('g1')::uuid)));""",'taken')
    # Independent synthetic object proves a committed accepted outcome wins.
    # Retained eight-object money proof above has already closed unchanged.
    run('abort-accepted-control-seed',seed.split('CREATE FUNCTION public.fixture_expected')[0].replace('1..8','9..9')+
        "INSERT INTO fixture_expected_inputs VALUES(9,fixture_expected(9));")
    with held("INSERT INTO hand_atomic_commits VALUES(md5('tab9')::uuid,100009,md5('accepted9')::uuid,now());",finish='COMMIT'):
        probe('abort-commit-in-flight-wins-lane',service+abort(9),error='F06_RETRY_CANONICAL_LANE')
    probe('abort-committed-accepted-refused',service+abort(9),error='F06_ABORT_ORIGINAL_PERMIT_CHANGED')
    run('abort-accepted-proof-remains-accepted',"SELECT state||'|'||evidence_id::text FROM smarter_private.f06_hand_permits WHERE permit_id=md5('permit9')::uuid;",
        'accepted|'+str(__import__('uuid').UUID(hashlib.md5(b'accepted9').hexdigest())))
    results['unsettledAbort']={'passed':True,'originals':8,'persistedStacks':6200,'snapshotStacks':5870,'uncommittedForcedBlinds':330,'preservedPriorHands':70,'walletCredit':0}
    import runpy
    successor = runpy.run_path(str(here / 'successor_qualification.py'))
    successor['qualify'](root, out, cmd, command, run, probe, require, results, seed, held, money, service)

    generation = runpy.run_path(str(here / "generation_qualification.py"))
    generation["qualify"](root, out, cmd, command, run, probe, require, results, held, money, service)

    mixed = runpy.run_path(str(here / "mixed_qualification.py"))
    mixed["qualify"](root, out, cmd, command, run, probe, require, results, held, money, service)
