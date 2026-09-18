"""Whole-generation disposition in the existing real F06 PostgreSQL gate."""
import hashlib
import json
import subprocess
import sys
import time


def qualify(root, out, cmd, command, run, probe, require, results, held, money, service):
    here = root / 'scripts/ci/probes/f06-shared-hand-lane'
    migration = root / 'supabase/migrations/20260918064213_interrupted_tournament_generation_disposition.sql'
    built = command([sys.executable, here / 'build-generation-migration.py', '--check'])
    require(built.returncode == 0, built.stdout + built.stderr)
    paths = [migration, here / 'generation-authority.sql', here / 'generation-preimages.json',
             here / 'build-generation-migration.py', here / 'generation_qualification.py']
    results['generationInputs'] = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    run('generation-seed-exact-batch-shape', """
    ALTER TABLE hand_atomic_commits ADD COLUMN post_commit_result jsonb;
    ALTER TABLE tables ADD COLUMN max_players integer DEFAULT 9;
    UPDATE hand_atomic_commits SET post_commit_result=' {"ok":true}' WHERE post_commit_completed_at IS NOT NULL;
    DO $$DECLARE i integer;k integer;j integer;n integer;st numeric;t uuid;tab uuid;g uuid;u uuid;hn bigint;
    BEGIN FOR i IN 101..103 LOOP
      t:=md5('gt'||i)::uuid;g:=md5('gg'||i)::uuid;
      n:=CASE WHEN i=101 THEN 34 ELSE 1 END;
      INSERT INTO tournaments VALUES(t,'RUNNING',CASE WHEN i=101 THEN 'mtt-v1' ELSE 'spin-v1' END,9,n*3);
      INSERT INTO engine_tournament_leases VALUES(t,'generation-owner','2bbc5d5c',now(),now(),g,2);
      FOR k IN 1..n LOOP
        tab:=md5('gtab'||i||':'||k)::uuid;hn:=2000000+i*100+k;
        INSERT INTO tables(id,tournament_id,status) VALUES(tab,t,'running');
        FOR j IN 1..CASE WHEN i=103 THEN 2 ELSE 3 END LOOP
          u:=md5('gu'||i||':'||k||':'||j)::uuid;
          INSERT INTO table_seats VALUES(md5('gs'||i||':'||k||':'||j)::uuid,tab,u,j,1000,NULL,NULL,md5('go'||i||':'||k||':'||j)::uuid);
          INSERT INTO tournament_players VALUES(md5('gr'||i||':'||k||':'||j)::uuid,t,tab,u,j,1000,'playing');
        END LOOP;
        INSERT INTO hand_state_snapshots(table_id,hand_number,state_json)
        SELECT tab,hn,jsonb_build_object('stage','preflop','pot',270,'players',jsonb_agg(jsonb_build_object(
        'user_id',user_id,'seat',seat_number,'stack',stack-CASE seat_number WHEN 1 THEN 50 WHEN 2 THEN 220 ELSE 0 END,
        'totalInvested',CASE seat_number WHEN 1 THEN 50 WHEN 2 THEN 220 ELSE 0 END,
        'deadInvested',CASE seat_number WHEN 2 THEN 120 ELSE 0 END,'individualAnteInvested',0,'returnedUncalled',0) ORDER BY seat_number))
        FROM table_seats WHERE table_id=tab;
        INSERT INTO smarter_private.f06_hand_permits SELECT md5('gp'||i||':'||k)::uuid,t,tab,f06_lifecycle,hn,
          md5('ghc'||i||':'||k)::uuid,g,'reserved',NULL FROM tables WHERE id=tab;
        IF i=101 AND k>30 THEN
          INSERT INTO hand_atomic_commits VALUES(tab,hn,md5('gh'||k)::uuid,now(),'{"ok":true}');
          INSERT INTO hand_history(table_id,hand_number) VALUES(tab,hn);
          UPDATE hand_state_snapshots SET is_complete=true WHERE table_id=tab;
        END IF;
        IF (i=101 AND k=34) OR i>101 THEN
          INSERT INTO smarter_private.f06_operations(break_id,tournament_id,source_table_id,lifecycle,boundary_id,origin_generation)
          SELECT md5('gpark'||i)::uuid,t,tab,f06_lifecycle,md5('gb'||i)::uuid,g FROM tables WHERE id=tab;
        END IF;
      END LOOP;
    END LOOP;END $$;
    CREATE FUNCTION fixture_generation_expected(i integer) RETURNS jsonb LANGUAGE sql AS $$
    WITH owner AS (SELECT * FROM engine_tournament_leases WHERE tournament_id=md5('gt'||i)::uuid),
    tabs AS (SELECT x.* FROM tables x JOIN owner l ON l.tournament_id=x.tournament_id WHERE lower(x.status)<>'closed' AND NOT coalesce(x.is_deleted,false)),
    roster AS (SELECT jsonb_build_object('seat_id',s.id,'occupancy_id',s.occupancy_id,'registration_id',p.id,
      'user_id',s.user_id,'table_id',s.table_id,'seat_number',s.seat_number,'stack',s.stack,'chips',p.chips) x,s.id,s.table_id,s.user_id
      FROM table_seats s JOIN tabs tab ON tab.id=s.table_id JOIN tournament_players p ON p.tournament_id=tab.tournament_id
      AND p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number WHERE s.left_at IS NULL AND p.status='playing')
    SELECT jsonb_build_object('tournament_id',l.tournament_id,'generation',l.lease_generation,'instance_id',l.instance_id,
      'engine_version',l.engine_version,'format_contract',e.format_contract,
      'open_tables',(SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'deleted',is_deleted,'lifecycle',f06_lifecycle) ORDER BY id) FROM tabs),
      'roster',(SELECT jsonb_agg(x ORDER BY id) FROM roster),
      'parks',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.break_id),'[]') FROM smarter_private.f06_operations o
        WHERE o.tournament_id=l.tournament_id AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')),
      'accepted',(SELECT coalesce(jsonb_agg(jsonb_build_object('permit',to_jsonb(p),'atomic_hash',md5(to_jsonb(c)::text)) ORDER BY p.permit_id),'[]')
        FROM smarter_private.f06_hand_permits p JOIN hand_atomic_commits c USING(table_id,hand_number)
        WHERE p.tournament_id=l.tournament_id AND p.state='accepted'
        AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits later WHERE later.table_id=p.table_id AND later.hand_number>p.hand_number)),
      'hands',(SELECT jsonb_agg(jsonb_build_object('permit',to_jsonb(p),'snapshot_id',s.id,'snapshot_hash',md5(to_jsonb(s)::text),
        'roster',(SELECT jsonb_agg(r.x ORDER BY r.user_id) FROM roster r WHERE r.table_id=p.table_id),
        'break_id',(SELECT break_id FROM smarter_private.f06_operations WHERE source_table_id=p.table_id AND state NOT IN('acknowledged','withdrawn_before_manifest')))
        ORDER BY p.permit_id) FROM smarter_private.f06_hand_permits p JOIN hand_state_snapshots s USING(table_id,hand_number)
        WHERE p.tournament_id=l.tournament_id AND p.state='reserved' AND NOT s.is_complete))
    FROM owner l JOIN tournaments e ON e.id=l.tournament_id $$;
    INSERT INTO fixture_expected_inputs SELECT i,fixture_generation_expected(i) FROM generate_series(101,103) i;
    """)
    def abort(i=101):
        return "SELECT fn_f06_abort_unsettled_generation(md5('generation-receipt%d')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=%d));" % (i, i)
    def manager(g='gg101', t='gt101'):
        return "SET request.jwt.claims='{\"role\":\"service_role\"}';SET app.smarter_data_actor='tournament-manager';SELECT set_config('app.smarter_tournament_id',md5('%s')::uuid::text,false);SELECT set_config('app.smarter_tournament_lease_generation',md5('%s')::uuid::text,false);" % (t, g)
    request = """SET request.jwt.claims='{"role":"service_role"}';
    SELECT set_config('request.headers',jsonb_build_object('x-smarter-data-actor','tournament-manager','x-smarter-data-protocol','2',
    'x-smarter-tournament-id',md5('gt101')::uuid,'x-smarter-tournament-lease-generation',md5('gg101')::uuid)::text,true);
    SET request.method='POST';SELECT smarter_private.fn_smarter_data_api_pre_request();"""
    before = run('generation-money-before', money)
    accepted_sql = "SELECT jsonb_build_object('accepted',(SELECT jsonb_agg(h ORDER BY permit_id) FROM smarter_private.f06_hand_permits h WHERE state='accepted'),'atomic',(SELECT jsonb_agg(c ORDER BY table_id,hand_number) FROM hand_atomic_commits c),'park',(SELECT to_jsonb(o) FROM smarter_private.f06_operations o WHERE break_id=md5('gpark101')::uuid));"
    accepted_before = run('generation-accepted-before', accepted_sql)
    probe('generation-baseline-door-absent', service + abort(), error='42883')
    installer = migration.read_text()
    for name, signature in [('successor-helper', 'smarter_private.f06_generation_aborted(uuid,uuid)'),
                            ('original-identity', 'smarter_private.f06_immutable_identity()'),
                            ('accepted-guard', 'smarter_private.f06_aborted_hand_guard()'),
                            ('park-adoption', 'public.fn_f06_claim_custody(uuid,uuid,uuid,uuid,bigint)')]:
        run('generation-drift-' + name, 'BEGIN;ALTER FUNCTION '+signature+' SET search_path=pg_catalog,pg_temp;'+installer, error='F06_GENERATION_PREIMAGE_CHANGED')
    # A PostgreSQL frame can outlive CREATE OR REPLACE. Model a scheduler pause
    # before the old guard's first permit read without changing its predicates.
    # Use a private clone so the intentional counterexample cannot taint the
    # actual batch/financial regression below.
    import re
    guard = next(row['definition'] for row in json.loads((here / 'generation-preimages.json').read_text())['functions']
                 if row['proname'] == 'f06_aborted_hand_guard')
    seam = 'BEGIN\n SELECT tournament_id INTO t'
    require(guard.count(seam) == 1, 'Exact old guard scheduling seam missing')
    paused = guard.replace(seam, 'BEGIN\n PERFORM pg_advisory_xact_lock(18092031);\n SELECT tournament_id INTO t')
    source_db = cmd[-1]
    clone_db = 'f06_generation_install_boundary'
    require(re.fullmatch('[a-z][a-z0-9_]*', source_db) is not None, 'Unexpected fixture database identity')
    run('generation-admission-clone', 'CREATE DATABASE ' + clone_db + ' TEMPLATE ' + source_db + ';')
    writer = None
    try:
        cmd[-1] = clone_db
        run('generation-old-frame-pause', paused)
        with held('SELECT pg_advisory_lock(18092031);'):
            writer = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True)
            writer.stdin.write("SET application_name='generation-old-history-frame';INSERT INTO hand_history(table_id,hand_number) VALUES(md5('gtab102:1')::uuid,2010201);\n")
            writer.stdin.close()
            writer.stdin = None
            deadline = time.monotonic() + 4
            while command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='generation-old-history-frame' AND wait_event_type='Lock');").stdout.strip() != 't':
                require(writer.poll() is None and time.monotonic() < deadline, 'Old guard frame did not reach actual lock barrier')
                time.sleep(.02)
            run('generation-restore-exact-old-catalog', guard)
            run('generation-two-share-drains-refuse-old-frame', installer, error='55P03: F06_GENERATION_INSTALL_ADMISSION_BUSY')
            run('generation-admission-refusal-atomic', "SELECT to_regclass('smarter_private.f06_generation_aborts') IS NULL AND md5(pg_get_functiondef('smarter_private.f06_aborted_hand_guard()'::regprocedure))='fccb0507e74649a7176d6dc233b0a820';", 't')
            unlocked = re.sub(r'DO \$admission\$[\s\S]*?END \$admission\$;', '', installer, count=1)
            require(unlocked != installer, 'No-lock counterfactual unchanged')
            run('generation-counterfactual-no-drain-install', unlocked)
            run('generation-dispose-ahead-of-old-frame', service + abort(102))
        old_out, old_err = writer.communicate(timeout=4)
        (out / 'generation-old-frame-counterexample.log').write_text(old_out + old_err)
        require(writer.returncode == 0, 'Old guard counterexample failed: ' + old_err)
        run('generation-counterexample-late-history', "SELECT (SELECT count(*) FROM smarter_private.f06_generation_abort_hands WHERE table_id=md5('gtab102:1')::uuid)||'|'||(SELECT count(*) FROM hand_history WHERE table_id=md5('gtab102:1')::uuid);", '1|1')
        run('generation-new-frame-refuses-late-history', "INSERT INTO hand_history(table_id,hand_number) VALUES(md5('gtab102:1')::uuid,2010201);", error='F06_ABORTED_HAND_FENCED')
    finally:
        if writer is not None and writer.poll() is None:
            writer.terminate()
            writer.wait(timeout=4)
        cmd[-1] = source_db
        run('generation-admission-clone-cleanup', 'DROP DATABASE ' + clone_db + ';')
    with held("SELECT 1 FROM engine_tournament_leases WHERE tournament_id=md5('gt103')::uuid FOR KEY SHARE;SELECT 1 FROM hand_history LIMIT 1;"):
        run('generation-install', installer)

    probe('generation-baseline-timestamp-alone-accepted-failed-postcommit', """DO $$DECLARE body text;BEGIN
      body:=pg_get_functiondef('fn_f06_abort_unsettled_generation(uuid,jsonb)'::regprocedure);
      IF strpos(body,'AND c.post_commit_result->''ok''=''true''::jsonb')=0 THEN RAISE EXCEPTION 'missing actual postcommit predicate'; END IF;
      EXECUTE replace(body,'AND c.post_commit_result->''ok''=''true''::jsonb','');
      END $$;
      UPDATE hand_atomic_commits SET post_commit_result='{"ok":false}' WHERE table_id=md5('gtab101:34')::uuid;
      UPDATE fixture_expected_inputs SET expected=fixture_generation_expected(101) WHERE i=101;
      """ + service + abort())
    require(run('generation-install-money', money) == before, 'Generation installation changed money')
    run('generation-private-receipts-closed', "SELECT NOT has_table_privilege('service_role','smarter_private.f06_generation_aborts','INSERT') AND NOT has_table_privilege('authenticated','smarter_private.f06_generation_abort_hands','SELECT') AND NOT has_function_privilege('authenticated','fn_f06_abort_unsettled_generation(uuid,jsonb)','EXECUTE');", 't')
    probe('generation-browser-refused', 'SET ROLE authenticated;' + service + abort(), error='42501')
    changes = [
        ('changed-generation', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{generation}',to_jsonb(gen_random_uuid())) WHERE i=101;", 'F06_GENERATION_LEASE_CHANGED'),
        ('missing-hand', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{hands}',(expected->'hands')-0) WHERE i=101;", 'F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED'),
        ('duplicate-hand', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{hands}',(expected->'hands')||jsonb_build_array(expected->'hands'->0)) WHERE i=101;", 'F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED'),
        ('accepted-target', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{hands}',(expected->'hands')||jsonb_build_array(jsonb_build_object('permit',(SELECT to_jsonb(h) FROM smarter_private.f06_hand_permits h WHERE permit_id=md5('gp101:34')::uuid)))) WHERE i=101;", 'F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED'),
        ('changed-seat-stack', "UPDATE table_seats SET stack=999 WHERE id=md5('gs101:1:1')::uuid;", 'F06_GENERATION_ROSTER_CHANGED'),
        ('changed-occupancy', "UPDATE table_seats SET occupancy_id=gen_random_uuid() WHERE id=md5('gs101:1:1')::uuid;", 'F06_ABORT_EXPECTED_CHANGED'),
        ('private-evidence', "INSERT INTO hand_private_state VALUES(md5('gtab101:1')::uuid,2010101);", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('dispatch-evidence', "INSERT INTO smarter_private.f06_hand_dispatch VALUES(md5('gp101:1')::uuid,txid_current());", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('missing-snapshot', "DELETE FROM hand_state_snapshots WHERE table_id=md5('gtab101:1')::uuid;", 'F06_ABORT_SNAPSHOT_CHANGED'),
        ('changed-stage', "UPDATE hand_state_snapshots SET stage='flop' WHERE table_id=md5('gtab101:1')::uuid;", 'F06_ABORT_SNAPSHOT_CHANGED'),
        ('bba-double-credit', "UPDATE hand_state_snapshots SET state_json=jsonb_set(state_json,'{players,1,totalInvested}','340') WHERE table_id=md5('gtab101:1')::uuid;", 'F06_ABORT_SAVED_STACKS_CHANGED'),
        ('individual-ante', "UPDATE hand_state_snapshots SET state_json=jsonb_set(state_json,'{players,1,individualAnteInvested}','1') WHERE table_id=md5('gtab101:1')::uuid;", 'F06_ABORT_SAVED_STACKS_CHANGED'),
        ('returned-uncalled', "UPDATE hand_state_snapshots SET state_json=jsonb_set(state_json,'{players,1,returnedUncalled}','1') WHERE table_id=md5('gtab101:1')::uuid;", 'F06_ABORT_SAVED_STACKS_CHANGED'),
        ('dead-exceeds-total', "UPDATE hand_state_snapshots SET state_json=jsonb_set(state_json,'{players,1,deadInvested}','221') WHERE table_id=md5('gtab101:1')::uuid;", 'F06_ABORT_SAVED_STACKS_CHANGED'),
        ('accepted-postcommit-pending', "UPDATE hand_atomic_commits SET post_commit_completed_at=NULL WHERE table_id=md5('gtab101:34')::uuid;", 'F06_GENERATION_ACCEPTED_PROOF_INCOMPLETE'),
        ('accepted-postcommit-failed', "UPDATE hand_atomic_commits SET post_commit_result='{\"ok\":false}' WHERE table_id=md5('gtab101:34')::uuid;UPDATE fixture_expected_inputs SET expected=fixture_generation_expected(101) WHERE i=101;", 'F06_GENERATION_ACCEPTED_PROOF_INCOMPLETE'),
        ('accepted-postcommit-unknown', "UPDATE hand_atomic_commits SET post_commit_result=NULL WHERE table_id=md5('gtab101:34')::uuid;UPDATE fixture_expected_inputs SET expected=fixture_generation_expected(101) WHERE i=101;", 'F06_GENERATION_ACCEPTED_PROOF_INCOMPLETE'),
        ('changed-park-custody', "UPDATE smarter_private.f06_operations SET custody_id=gen_random_uuid() WHERE break_id=md5('gpark101')::uuid;", 'F06_ABORT_EXPECTED_CHANGED'),
        ('late-permit', "INSERT INTO smarter_private.f06_hand_permits SELECT md5('later')::uuid,tournament_id,table_id,lifecycle,hand_number+1,custody_id,generation,'never_started',NULL FROM smarter_private.f06_hand_permits WHERE permit_id=md5('gp101:1')::uuid;", 'F06_GENERATION_PERMIT_CHANGED'),
        ('old-generation-member', "INSERT INTO tables(id,tournament_id,status) VALUES(md5('old-table')::uuid,md5('gt101')::uuid,'waiting');INSERT INTO smarter_private.f06_hand_permits SELECT md5('old-permit')::uuid,tournament_id,id,f06_lifecycle,1900000,gen_random_uuid(),md5('older')::uuid,'reserved',NULL FROM tables WHERE id=md5('old-table')::uuid;", 'F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED'),
        ('started-park', "UPDATE smarter_private.f06_operations SET state='begun',manifest='[]' WHERE break_id=md5('gpark101')::uuid;", 'F06_GENERATION_PARK_CHANGED'),
        ('platform-freeze', "INSERT INTO engine_maintenance_break VALUES(true,now()-interval '3 minutes','last_hand',NULL,NULL);", 'PLATFORM_FROZEN'),
    ]
    for name, change, error in changes:
        probe('generation-' + name, service + change + abort(), error=error)
    for name, lock, error in [
        ('settlement', "SELECT pg_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||md5('gt101')::uuid::text,0));", 'F06_RETRY_CANONICAL_LANE'),
        ('dispatch', "SELECT pg_advisory_xact_lock(hashtextextended('f06:hand:'||md5('gp101:1')::uuid::text,0));", 'F06_HAND_DISPATCH_BUSY'),
        ('player', "SELECT pg_advisory_xact_lock(hashtextextended('table_cap:'||md5('gu101:1:1')::uuid::text,0));", 'F06_ABORT_RETRY_PLAYER_LANE')]:
        with held(lock):
            probe('generation-busy-' + name, service + abort(), error=error)
    # Real request admission holds the same lease KEY SHARE used in production.
    with held(request):
        probe('generation-drains-admitted-manager', "SET LOCAL lock_timeout='150ms';" + service + abort(), error='55P03')
    with held("UPDATE engine_tournament_leases SET lease_generation=md5('raced-gg101')::uuid WHERE tournament_id=md5('gt101')::uuid;", finish='COMMIT'):
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        p.stdin.write("BEGIN;SET application_name='generation-actual-takeover';SET statement_timeout='6s';" + service + abort() + 'ROLLBACK;\n')
        p.stdin.close()
        deadline = time.monotonic() + 3
        while command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='generation-actual-takeover' AND wait_event_type='Lock');").stdout.strip() != 't':
            require(p.poll() is None and time.monotonic() < deadline, 'Generation abort did not wait on actual changing lease')
            time.sleep(.01)
    p.wait(timeout=8)
    output = p.stdout.read() + p.stderr.read()
    (out / 'generation-real-takeover-race.log').write_text(output)
    require(p.returncode != 0 and 'F06_GENERATION_LEASE_CHANGED' in output, 'Generation takeover accepted stale owner: ' + output)
    results['cases'].append({'name': 'generation-real-takeover-refused', 'passed': True})
    run('generation-restore-owned-native-lease', "UPDATE engine_tournament_leases SET lease_generation=md5('gg101')::uuid WHERE tournament_id=md5('gt101')::uuid;")
    # Rollback of the owning disposition leaves no partial headers, children,
    # snapshot completion, park withdrawal or lease deletion behind.
    disposition_state = "SELECT jsonb_build_object('leases',(SELECT jsonb_agg(l ORDER BY tournament_id) FROM engine_tournament_leases l),'permits',(SELECT jsonb_agg(p ORDER BY permit_id) FROM smarter_private.f06_hand_permits p),'parks',(SELECT jsonb_agg(o ORDER BY break_id) FROM smarter_private.f06_operations o),'snapshots',(SELECT jsonb_agg(s ORDER BY id) FROM hand_state_snapshots s),'headers',(SELECT jsonb_agg(a ORDER BY receipt_id) FROM smarter_private.f06_generation_aborts a),'children',(SELECT jsonb_agg(a ORDER BY permit_id) FROM smarter_private.f06_generation_abort_hands a));"
    state_before = run('generation-state-before-rollback', disposition_state)
    probe('generation-full-disposition-rollback', service + abort())
    require(run('generation-state-after-rollback', disposition_state) == state_before, 'Generation rollback leaked state')
    # An accepted settlement wins the shared lane and is never turned into an
    # aborted hand, even when the caller retained an earlier expected batch.
    with held("INSERT INTO hand_atomic_commits VALUES(md5('gtab101:1')::uuid,2010101,md5('winning-hand')::uuid,now(),'{\"ok\":true}');"):
        probe('generation-accepted-settlement-inflight-wins', service + abort(), error='F06_RETRY_CANONICAL_LANE')
    probe('generation-accepted-settlement-committed-refused', service + "INSERT INTO hand_atomic_commits VALUES(md5('gtab101:1')::uuid,2010101,md5('winning-hand')::uuid,now(),'{\"ok\":true}');" + abort(), error='F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED')
    require(run('generation-all-refusals-preserve-money', money) == before, 'Refusal changed money')
    require(run('generation-all-refusals-preserve-accepted', accepted_sql) == accepted_before, 'Refusal changed accepted outcome')
    # Abort holds the real lease/lane. Claim waits, then sees the permanent fence.
    with held(service + abort(), finish='COMMIT'):
        queued = []
        for name, sql in [
            ('claim', "SELECT granted FROM claim_tournament_lease_v2(md5('gt101')::uuid,'late','old',md5('gg101')::uuid);"),
            ('late-roster', request + "UPDATE table_seats SET stack=0 WHERE id=md5('gs101:1:1')::uuid;"),
            ('late-snapshot', request + "UPDATE hand_state_snapshots SET is_complete=false WHERE table_id=md5('gtab101:1')::uuid;"),
            ('duplicate', service + abort()),
            ('different-receipt', service + abort().replace('generation-receipt101', 'another-generation-receipt101')),
        ]:
            p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            p.stdin.write("BEGIN;SET statement_timeout='6s';" + sql + 'COMMIT;\n')
            p.stdin.close()
            queued.append((name, p))
        time.sleep(.1)
        require(all(p.poll() is None for _, p in queued), 'All contenders must wait for the owning transaction')
    for name, p in queued:
        p.wait(timeout=8)
        stdout, stderr = p.stdout.read(), p.stderr.read()
        (out / ('generation-race-' + name + '.log')).write_text(stdout + stderr)
        ok = p.returncode == 0 and stdout.strip() == 'f' if name == 'claim' else (
            p.returncode == 0 and 'aborted_unsettled' in stdout if name == 'duplicate' else
            p.returncode != 0 and ('F06_GENERATION_LEASE_CHANGED' if name == 'different-receipt' else 'TOURNAMENT_MANAGER_FENCED') in stderr)
        require(ok, 'Generation race '+name+' failed: '+stdout+stderr)
        results['cases'].append({'name': 'generation-race-' + name, 'passed': True})
    run('generation-exact-replay', service + abort())
    probe('generation-changed-replay', service + "UPDATE fixture_expected_inputs SET expected=expected||'{\"changed\":true}' WHERE i=101;" + abort(), error='F06_ABORT_CHANGED_REPLAY')
    run('generation-spin-three-players', service + abort(102))
    run('generation-spin-two-players', service + abort(103))
    run('generation-exact-receipt-cardinality', "SELECT (SELECT count(*) FROM smarter_private.f06_generation_aborts)||'|'||(SELECT count(*) FROM smarter_private.f06_generation_abort_hands)||'|'||(SELECT count(*) FROM smarter_private.f06_hand_permits WHERE tournament_id IN(SELECT tournament_id FROM smarter_private.f06_generation_aborts) AND state='aborted_unsettled')||'|'||(SELECT count(*) FROM smarter_private.f06_operations WHERE break_id IN(md5('gpark102')::uuid,md5('gpark103')::uuid) AND state='withdrawn_before_manifest');", '3|32|32|2')
    require(run('generation-money-after', money) == before, 'Generation abort changed stacks, registration, prior history or ledger')
    require(run('generation-accepted-after', accepted_sql) == accepted_before, 'Generation abort changed accepted siblings, postcommit or accepted park')
    for name, sql, error in [
        ('late-atomic', "INSERT INTO hand_atomic_commits VALUES(md5('gtab101:1')::uuid,2010101,gen_random_uuid(),now(),NULL);", 'F06_ABORTED_HAND_FENCED'),
        ('late-history', "INSERT INTO hand_history(table_id,hand_number) VALUES(md5('gtab101:1')::uuid,2010101);", 'F06_ABORTED_HAND_FENCED'),
        ('late-dispatch', "SELECT smarter_private.f06_hand_dispatch_guard(md5('gtab101:1')::uuid,2010101);", 'F06_HAND_PERMIT_FENCED'),
        ('generation-insert', "INSERT INTO engine_tournament_leases VALUES(md5('gt101')::uuid,'late','old',now(),now(),md5('gg101')::uuid,2);", 'F06_ABORTED_GENERATION_FENCED'),
        ('header-update', 'UPDATE smarter_private.f06_generation_aborts SET expected=expected;', 'F06_ABORT_RECEIPT_IMMUTABLE'),
        ('child-delete', 'DELETE FROM smarter_private.f06_generation_abort_hands;', 'F06_ABORT_RECEIPT_IMMUTABLE'),
        ('permit-resurrection', "UPDATE smarter_private.f06_hand_permits SET state='reserved',evidence_id=NULL WHERE permit_id=md5('gp101:1')::uuid;", 'F06_HAND_IDENTITY_IMMUTABLE'),
        ('park-resurrection', "UPDATE smarter_private.f06_operations SET state='park_requested',abort_receipt_id=NULL WHERE break_id=md5('gpark102')::uuid;", 'F06_WITHDRAWAL_IMMUTABLE'),
    ]:
        probe('generation-' + name, sql, error=error)
    run('generation-fresh-owner', "SELECT granted FROM claim_tournament_lease_v2(md5('gt101')::uuid,'next','fixed',md5('fresh-gg101')::uuid);", 't')
    probe('generation-real-accepted-source-custody-adoption', manager('fresh-gg101') + """DO $$DECLARE v jsonb;members jsonb;BEGIN
      v:=fn_f06_claim_custody(md5('gt101')::uuid,md5('fresh-gg101')::uuid,md5('gpark101')::uuid,md5('new-custody')::uuid,0);
      IF v->>'ok' IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations
       WHERE break_id=md5('gpark101')::uuid AND state='park_requested' AND revision=1 AND manifest IS NULL
       AND custody_generation=md5('fresh-gg101')::uuid AND custody_id=md5('new-custody')::uuid
       AND origin_generation=md5('gg101')::uuid AND abort_receipt_id IS NULL)
      THEN RAISE EXCEPTION 'accepted source adoption or original identity changed';END IF;
      SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'source_seat_id',id,'source_seat_number',seat_number,
       'occupancy_id',occupancy_id,'request_id',md5('gmove'||user_id)::uuid,
       'destination_table_id',md5('gtab101:1')::uuid,'destination_seat_number',seat_number+3) ORDER BY user_id)
      INTO members FROM table_seats WHERE table_id=md5('gtab101:34')::uuid AND left_at IS NULL;
      v:=fn_f06_begin_break(md5('gt101')::uuid,md5('fresh-gg101')::uuid,md5('gpark101')::uuid,members);
      IF v->>'ok' IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations
       WHERE break_id=md5('gpark101')::uuid AND state='begun' AND manifest=members)
       OR (SELECT count(*) FROM smarter_private.f06_members WHERE break_id=md5('gpark101')::uuid)<>3
       OR (SELECT count(*) FROM smarter_private.f06_attempts WHERE break_id=md5('gpark101')::uuid AND generation=md5('fresh-gg101')::uuid)<>3
      THEN RAISE EXCEPTION 'accepted source cannot enter genuine F06 manifest adoption';END IF;END $$;""")
    run('generation-fresh-spin-owner', "SELECT granted FROM claim_tournament_lease_v2(md5('gt102')::uuid,'next','fixed',md5('fresh-gg102')::uuid);", 't')
    probe('generation-spin-reservation-unblocked', manager('fresh-gg102', 'gt102') + """DO $$DECLARE v jsonb;BEGIN
      v:=fn_f06_table_state(md5('gt102')::uuid,md5('fresh-gg102')::uuid,md5('gtab102:1')::uuid);
      IF v->>'can_reserve' IS DISTINCT FROM 'true' OR v->>'excluded' IS DISTINCT FROM 'false'
      OR v->'unresolved_permits' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'generation spin reservation not restored';END IF;END $$;""")
    # Previously committed original and successor receipts still have exact replay
    # semantics after all three additive guard replacements.
    run('generation-original-hu-replay-preserved', service + "SELECT fn_f06_abort_unsettled_hand(md5('receipt1')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=1));")
    run('generation-successor-hu-replay-preserved', service + "SELECT fn_f06_abort_successor_unsettled_hand(md5('successor-receipt12')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=12));")
    results['generationAbort'] = {'passed': True, 'events': 3, 'hands': 32, 'acceptedSiblings': 4, 'walletCredit': 0}
