"""Mixed original/current generation native transaction and late-writer proof."""
import hashlib
import json
import re
import runpy
import subprocess
import sys
import time


def qualify(root, out, cmd, command, run, probe, require, results, held, money, service):
    here = root / 'scripts/ci/probes/f06-shared-hand-lane'
    migration = root / 'supabase/migrations/20260918065923_mixed_generation_disposition_preserves_committed_stacks.sql'
    checked = command([sys.executable, here / 'build-mixed-migration.py', '--check'])
    require(checked.returncode == 0, checked.stdout + checked.stderr)
    paths = [migration, here / 'mixed-authority.sql', here / 'build-mixed-migration.py', here / 'mixed-fixture.sql', here / 'mixed_qualification.py']
    occupancy_source = root / 'supabase/migrations/20260908220604_bind_cashout_requests_to_seat_occupancy.sql'
    paths.append(occupancy_source)
    results['mixedInputs'] = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    run('mixed-native-receipt-schema', (here / 'mixed-fixture.sql').read_text())
    occupancy = re.search(r'CREATE OR REPLACE FUNCTION public\.fn_stamp_seat_occupancy\(\)[\s\S]+?\$function\$;', occupancy_source.read_text())
    require(occupancy is not None, 'Original occupancy authority missing')
    run('mixed-native-occupancy-authority', occupancy.group(0) + """
      REVOKE ALL ON FUNCTION fn_stamp_seat_occupancy() FROM PUBLIC,anon,authenticated,service_role;
      CREATE TRIGGER zzz_stamp_seat_occupancy BEFORE INSERT OR UPDATE ON table_seats
        FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_occupancy();
      CREATE UNIQUE INDEX table_seats_occupancy_id_unique ON table_seats(occupancy_id);""")
    run('mixed-four-table-24-player-seed', 'SELECT fixture_seed_mixed(451);')

    def abort(i=451):
        return "SELECT fn_f06_abort_mixed_unsettled_generation(md5('mixed-receipt%d')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=%d));" % (i, i)

    run('mixed-exact-current-inventory', "SELECT count(*)||'|'||sum(stack)||'|'||count(DISTINCT table_id) FROM table_seats WHERE table_id IN(SELECT id FROM tables WHERE tournament_id=md5('mt451')::uuid) AND left_at IS NULL;", '24|792000|4')
    before = run('mixed-original-money', money)
    witness = """SELECT jsonb_build_object('atomic',(SELECT jsonb_agg(c ORDER BY table_id,hand_number) FROM hand_atomic_commits c),
      'accepted',(SELECT jsonb_agg(p ORDER BY permit_id) FROM smarter_private.f06_hand_permits p WHERE state='accepted'),
      'otherpark',(SELECT to_jsonb(o) FROM smarter_private.f06_operations o WHERE break_id=md5('mpark451')::uuid));"""
    accepted = run('mixed-accepted-sibling-boundary', witness)
    probe('mixed-before-door-absent', service + abort(), error='42883')
    probe('mixed-before-homogeneous-refuses', service + "SELECT fn_f06_abort_unsettled_generation(md5('mixed-receipt451')::uuid,(SELECT expected-'generations' FROM fixture_expected_inputs WHERE i=451));", error='F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED')
    installer = migration.read_text()
    for name, mutation in [
        ('function', 'ALTER FUNCTION fn_stamp_seat_occupancy() SET search_path=pg_catalog,pg_temp;'),
        ('trigger', 'ALTER TABLE table_seats DISABLE TRIGGER zzz_stamp_seat_occupancy;'),
        ('index', 'DROP INDEX table_seats_occupancy_id_unique;'),
    ]:
        run('mixed-installer-refuses-occupancy-' + name, 'BEGIN;' + mutation + installer, error='F06_MIXED_OCCUPANCY_AUTHORITY_CHANGED')
    for name, sig in [('generation-fence', 'smarter_private.f06_generation_aborted(uuid,uuid)'),
                      ('hand-fence', 'smarter_private.f06_aborted_hand_guard()'),
                      ('original-identity', 'smarter_private.f06_immutable_identity()')]:
        run('mixed-installer-refuses-' + name, 'BEGIN;ALTER FUNCTION ' + sig + ' SET search_path=pg_catalog,pg_temp;' + installer, error='F06_GENERATION_PREIMAGE_CHANGED')
    for relation in ('hand_atomic_commits', 'hand_history'):
        with held('LOCK TABLE public.' + relation + ' IN ROW EXCLUSIVE MODE;'):
            started = time.monotonic()
            refused = command(cmd, installer)
            elapsed = time.monotonic() - started
            output = refused.stdout + refused.stderr
            (out / ('mixed-admission-' + relation + '.log')).write_text(output)
            require(refused.returncode != 0 and 'F06_MIXED_INSTALL_ADMISSION_BUSY' in output and 2.9 <= elapsed < 4.5, output)
        run('mixed-refused-admission-no-schema-' + relation, "SELECT to_regclass('smarter_private.f06_mixed_aborts') IS NULL;", 't')
        results['cases'].append({'name': 'mixed-bounded-installation-' + relation, 'passed': True})
    run('mixed-installer', installer)
    require(run('mixed-install-money-unchanged', money) == before, 'Mixed installation changed financial state')
    probe('mixed-browser-refused', 'SET ROLE authenticated;' + service + abort(), error='42501')
    probe('mixed-actor-refused', service + "SET app.smarter_data_actor='tournament-manager';" + abort(), error='F06_ABORT_SERVICE_REQUIRED')
    probe('mixed-actual-valid-bundle-rollback', service + abort())
    require(run('mixed-valid-bundle-rolled-back', money) == before, 'Mixed probe leaked money')
    run('mixed-valid-bundle-no-receipt', 'SELECT count(*) FROM smarter_private.f06_mixed_aborts;', '0')
    probe('mixed-partial-child-write-rolls-back', service + "ALTER TABLE smarter_private.f06_mixed_abort_hands ADD CONSTRAINT fixture_refuse_child CHECK(table_id<>md5('mtab451:2')::uuid);" + abort(), error='23514')
    run('mixed-failed-child-leaves-no-bundle-or-fences', "SELECT (SELECT count(*) FROM smarter_private.f06_mixed_aborts)+(SELECT count(*) FROM smarter_private.f06_mixed_abort_generations)+(SELECT count(*) FROM smarter_private.f06_mixed_abort_hands);", '0')
    run('mixed-private-receipt-acl', "SELECT bool_and(relrowsecurity AND NOT has_table_privilege('service_role',oid,'INSERT,UPDATE,DELETE,SELECT')) FROM pg_class WHERE oid IN('smarter_private.f06_mixed_aborts'::regclass,'smarter_private.f06_mixed_abort_generations'::regclass,'smarter_private.f06_mixed_abort_hands'::regclass);", 't')

    for name, mutation, error in [
        ('changed-lease', "UPDATE engine_tournament_leases SET lease_generation=md5('raced451')::uuid WHERE tournament_id=md5('mt451')::uuid;", 'F06_GENERATION_LEASE_CHANGED'),
        ('missing-whole-hand', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{hands}',(expected->'hands')-0) WHERE i=451;", 'F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED'),
        ('prior-seat-generation', "UPDATE table_seats SET joined_at=joined_at+interval '1 second' WHERE table_id=md5('mtab451:1')::uuid;", 'F06_MIXED_PRIOR_ROSTER_CHANGED'),
        ('prior-stack-drift', "UPDATE table_seats SET stack=stack+1 WHERE table_id=md5('mtab451:1')::uuid;", 'F06_GENERATION_ROSTER_CHANGED'),
        ('prior-occupancy', "UPDATE table_seats SET occupancy_id=gen_random_uuid() WHERE table_id=md5('mtab451:1')::uuid;", 'SEAT_OCCUPANCY_IMMUTABLE'),
        ('prior-registration', "UPDATE tournament_players SET id=gen_random_uuid() WHERE table_id=md5('mtab451:1')::uuid;", 'F06_ABORT_EXPECTED_CHANGED'),
        ('prior-postcommit-incomplete', "UPDATE hand_atomic_commits SET post_commit_completed_at=NULL WHERE table_id=md5('mtab451:1')::uuid;", 'F06_MIXED_PRIOR_INCOMPLETE'),
        ('prior-request-hash', "UPDATE hand_atomic_commits SET post_commit_request_hash=repeat('0',64) WHERE table_id=md5('mtab451:1')::uuid;", 'F06_MIXED_PRIOR_POSTCOMMIT_SEAL'),
        ('prior-payload-hash', "UPDATE hand_atomic_commits SET post_commit_payload_hash=repeat('0',64) WHERE table_id=md5('mtab451:1')::uuid;", 'F06_MIXED_PRIOR_POSTCOMMIT_SEAL'),
        ('prior-rebased', "UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{rebased}','{\"wrong\":1}') WHERE table_id=md5('mtab451:1')::uuid;", 'F06_MIXED_PRIOR_STACK_RECEIPT'),
        ('prior-canonical-is-not-stack-id', "UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{hand_id}',to_jsonb(hand_id::text)) WHERE table_id=md5('mtab451:1')::uuid;", 'F06_MIXED_PRIOR_STACK_RECEIPT'),
        ('prior-later-history', "INSERT INTO hand_history(table_id,hand_number) VALUES(md5('mtab451:1')::uuid,4045101);", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('prior-intervening-atomic-write', "INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,committed_at) VALUES(md5('mtab451:1')::uuid,4045099,gen_random_uuid(),now());", 'F06_MIXED_PRIOR_NOT_LAST_BOUNDARY'),
        ('known-dead-invested-not-double-credited', "UPDATE hand_state_snapshots SET state_json=jsonb_set(state_json,'{pot}','3600') WHERE table_id=md5('mtab451:2')::uuid;", 'F06_ABORT_SAVED_STACKS_CHANGED'),
        ('old-dispatch', "INSERT INTO smarter_private.f06_hand_dispatch VALUES(md5('mp451:1')::uuid,txid_current());", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('current-dispatch', "INSERT INTO smarter_private.f06_hand_dispatch VALUES(md5('mp451:2')::uuid,txid_current());", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('sibling-accepted-incomplete', "UPDATE hand_atomic_commits SET post_commit_completed_at=NULL WHERE table_id=md5('mtab451:4')::uuid;", 'F06_GENERATION_ACCEPTED_PROOF_INCOMPLETE'),
        ('freeze', "INSERT INTO engine_maintenance_break VALUES(true,now()-interval '3 minutes','last_hand',NULL,NULL);", 'PLATFORM_FROZEN'),
    ]:
        probe('mixed-refuses-' + name, service + mutation + abort(), error=error)

    # Historical completed snapshots are neither accepted settlement nor proof
    # of no start. Preserve them byte-for-byte and abort only the unresolved hand.
    completed = "INSERT INTO hand_state_snapshots(table_id,hand_number,is_complete,stage,state_json) VALUES(md5('mtab451:1')::uuid,4045101,true,'complete','{}'),(md5('mtab451:1')::uuid,4045199,true,'complete','{}');"
    probe('mixed-completed-historical-start-does-not-invent-outcome', completed + service + abort() + "DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE permit_id=md5('mp451:1')::uuid AND state='aborted_unsettled') OR (SELECT count(*) FROM hand_state_snapshots WHERE table_id=md5('mtab451:1')::uuid AND is_complete AND state_json='{}')<>2 THEN RAISE EXCEPTION 'historical snapshot or truthful disposition changed'; END IF; END $$;")
    for name, write in [
        ('dispatch', "INSERT INTO smarter_private.f06_hand_dispatch VALUES(md5('mp451:1')::uuid,txid_current());"),
        ('private', "INSERT INTO hand_private_state(table_id,hand_number) VALUES(md5('mtab451:1')::uuid,4045101);"),
        ('history', "INSERT INTO hand_history(table_id,hand_number) VALUES(md5('mtab451:1')::uuid,4045101);"),
    ]:
        probe('mixed-completed-snapshot-cannot-hide-' + name, completed + write + service + abort(), error='F06_ABORT_COMMITTED_OR_DISPATCHED')
    probe('mixed-other-active-snapshot-still-refused', "INSERT INTO hand_state_snapshots(table_id,hand_number,is_complete) VALUES(md5('mtab451:1')::uuid,4045199,false);" + service + abort(), error='F06_MIXED_PRIOR_NOT_LAST_BOUNDARY')
    plan = json.loads(run('mixed-live-snapshot-index-applicability', "SET enable_seqscan=off;EXPLAIN(FORMAT JSON) SELECT EXISTS(SELECT 1 FROM hand_state_snapshots WHERE table_id=md5('mtab451:1')::uuid AND NOT is_complete);"))
    require('one_active_snapshot' in json.dumps(plan), 'Mixed active snapshot proof lost its existing partial index')

    def request(g='mg-current451'):
        return """SET request.jwt.claims='{"role":"service_role"}';
        SELECT set_config('request.headers',jsonb_build_object('x-smarter-data-actor','tournament-manager','x-smarter-data-protocol','2',
        'x-smarter-tournament-id',md5('mt451')::uuid,'x-smarter-tournament-lease-generation',md5('%s')::uuid)::text,true);
        SET request.method='POST';SELECT smarter_private.fn_smarter_data_api_pre_request();""" % g

    with held(request()):
        probe('mixed-drains-real-current-request', "SET LOCAL lock_timeout='150ms';" + service + abort(), error='55P03')
    for generation in ('mg-old451', 'mg-middle451'):
        probe('mixed-stale-request-' + generation, request(generation), error='42501')
    for k in (1, 2):
        with held("SELECT pg_advisory_xact_lock(hashtextextended('f06:hand:'||md5('mp451:%d')::uuid::text,0));" % k):
            probe('mixed-real-hand-lane-' + str(k), service + abort(), error='F06_HAND_DISPATCH_BUSY')

    def barrier(sql, process, label):
        end = time.monotonic() + 4
        while command(cmd, sql).stdout.strip() != 't':
            require(process.poll() is None and time.monotonic() < end, label)
            time.sleep(.02)

    with held("UPDATE engine_tournament_leases SET lease_generation=md5('raced451')::uuid WHERE tournament_id=md5('mt451')::uuid;", finish='COMMIT'):
        pending = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        pending.stdin.write('BEGIN;SET statement_timeout=\'6s\';' + service + abort() + 'COMMIT;')
        pending.stdin.close()
        barrier("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%fn_f06_abort_mixed_unsettled_generation%');", pending, 'Mixed takeover did not enter row wait')
    pending.wait(timeout=8)
    output = pending.stdout.read() + pending.stderr.read()
    (out / 'mixed-takeover-race.log').write_text(output)
    require(pending.returncode != 0 and 'F06_GENERATION_LEASE_CHANGED' in output, output)
    results['cases'].append({'name': 'mixed-takeover-race-refused', 'passed': True})
    run('mixed-refresh-exact-lease-input', "UPDATE fixture_expected_inputs SET expected=fixture_expected_mixed(md5('mt451')::uuid) WHERE i=451;")
    with held(service + abort(), finish='COMMIT'):
        queued = []
        for g in ('mg-old451', 'mg-middle451', 'raced451'):
            p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            p.stdin.write("SELECT granted FROM claim_tournament_lease_v2(md5('mt451')::uuid,'late','old',md5('%s')::uuid);" % g)
            p.stdin.close()
            queued.append((g, p))
        barrier("SELECT count(*)>=3 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%claim_tournament_lease_v2%';", queued[0][1], 'Real stale claimers did not wait')
    for g, p in queued:
        p.wait(timeout=8)
        output = p.stdout.read() + p.stderr.read()
        (out / ('mixed-late-claimer-' + g + '.log')).write_text(output)
        require(p.returncode == 0 and output.strip() == 'f', output)
        results['cases'].append({'name': 'mixed-late-generation-fenced-' + g, 'passed': True})
    require(run('mixed-committed-money-unchanged', money) == before, 'Mixed disposition changed money')
    require(run('mixed-accepted-and-other-park-unchanged', witness) == accepted, 'Mixed disposition changed accepted sibling or unrelated park')
    run('mixed-one-bundle-three-fences-two-originals', "SELECT (SELECT count(*) FROM smarter_private.f06_mixed_aborts)||'|'||(SELECT count(*) FROM smarter_private.f06_mixed_abort_generations)||'|'||(SELECT count(*) FROM smarter_private.f06_mixed_abort_hands)||'|'||(SELECT count(*) FROM smarter_private.f06_hand_permits WHERE tournament_id=md5('mt451')::uuid AND state='aborted_unsettled');", '1|3|2|2')
    run('mixed-missing-snapshot-remains-absent', "SELECT count(*) FROM hand_state_snapshots WHERE table_id=md5('mtab451:1')::uuid;", '0')
    run('mixed-exact-replay', service + abort())
    probe('mixed-changed-replay-refused', service + "UPDATE fixture_expected_inputs SET expected=expected-'accepted' WHERE i=451;" + abort(), error='F06_ABORT_CHANGED_REPLAY')
    for relation in ('f06_mixed_aborts', 'f06_mixed_abort_generations', 'f06_mixed_abort_hands'):
        probe('mixed-immutable-' + relation, 'DELETE FROM smarter_private.' + relation + ';', error='55000')
    for k in (1, 2):
        probe('mixed-late-atomic-refused-' + str(k), "INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id) VALUES(md5('mtab451:%d')::uuid,%d,gen_random_uuid());" % (k, 4045100 + k), error='55000')
        probe('mixed-late-history-refused-' + str(k), "INSERT INTO hand_history(table_id,hand_number) VALUES(md5('mtab451:%d')::uuid,%d);" % (k, 4045100 + k), error='55000')
    run('mixed-new-unfenced-lease-admitted', "SELECT granted FROM claim_tournament_lease_v2(md5('mt451')::uuid,'fresh','fixed',md5('mixed-fresh451')::uuid);", 't')
    probe('mixed-fresh-owner-admits-original-tables', request('mixed-fresh451') + "DO $$BEGIN IF fn_f06_table_state(md5('mt451')::uuid,md5('mixed-fresh451')::uuid,md5('mtab451:1')::uuid)->>'can_reserve' IS DISTINCT FROM 'true' OR fn_f06_table_state(md5('mt451')::uuid,md5('mixed-fresh451')::uuid,md5('mtab451:2')::uuid)->>'can_reserve' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'mixed original tables remain blocked'; END IF; END $$;")
    # Real acceptance trigger wins before abort's lane. No fabricated refund.
    run('mixed-settlement-control', 'SELECT fixture_seed_mixed(452);')
    with held("INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,post_commit_completed_at,post_commit_result) VALUES(md5('mtab452:2')::uuid,4045202,md5('winning452')::uuid,now(),'{\"ok\":true}');", finish='COMMIT'):
        probe('mixed-settlement-wins-concurrent', service + abort(452), error='F06_RETRY_CANONICAL_LANE')
    probe('mixed-settlement-wins-durable', service + abort(452), error='F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED')
    run('mixed-winning-acceptance-preserved', "SELECT state||'|'||(evidence_id=md5('winning452')::uuid)::text FROM smarter_private.f06_hand_permits WHERE permit_id=md5('mp452:2')::uuid;", 'accepted|true')
    results['mixedAbort'] = {'passed': True, 'originalHands': 2, 'generations': 3, 'players': 24, 'affectedStacks': 396000, 'walletCredit': 0}
    # Independently owned post-cutover MTT/Spin fixtures compose through this seam.
    cohort = here / 'mixed_cohort_qualification.py'
    runpy.run_path(str(cohort))['qualify'](root, out, cmd, command, run, probe, require, results, held, money, service)
    require(results.get('mixedCohorts', {}).get('passed') is True, 'Mixed MTT/Spin cohort qualification did not complete')

    run('mixed-hu-prior-committed-seed', 'SELECT fixture_seed_mixed_hu();')
    hu_before = run('mixed-hu-money-before', money)
    hu_abort = service + abort(361)
    # Reproduce the old exact format gate in an isolated rolled-back function
    # definition. The real two-chair input was refused before this subcase.
    probe('mixed-hu-before-explicit-scope-refused', """DO $$DECLARE body text;BEGIN
      body:=pg_get_functiondef('fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)'::regprocedure);
      IF strpos(body,'event.format_contract NOT IN (''mtt-v1'',''mtt-v2'',''spin-v1'',''sng-v1'')')=0 THEN
        RAISE EXCEPTION 'HU format gate not found'; END IF;
      EXECUTE replace(body,'event.format_contract NOT IN (''mtt-v1'',''mtt-v2'',''spin-v1'',''sng-v1'')',
        'event.format_contract NOT IN (''mtt-v1'',''mtt-v2'',''spin-v1'')');
      END $$;""" + hu_abort, error='F06_GENERATION_SCOPE_CHANGED')
    probe('mixed-hu-prior-valid-rollback', hu_abort)
    for name, change, error in [
        ('wrong-format', "UPDATE tournaments SET format_contract='spin-v1' WHERE id=md5('mixed-hu')::uuid;", 'F06_MIXED_BOUNDARIES_REQUIRED'),
        ('wrong-table-size', "UPDATE tournaments SET table_size=3 WHERE id=md5('mixed-hu')::uuid;", 'F06_MIXED_HU_SCOPE_CHANGED'),
        ('wrong-table-capacity', "UPDATE tables SET max_players=3 WHERE id=md5('mixed-hu-table')::uuid;", 'F06_MIXED_HU_SCOPE_CHANGED'),
        ('multiple-open-tables', "INSERT INTO tables(id,tournament_id,status,max_players) VALUES(md5('mixed-hu-second-table')::uuid,md5('mixed-hu')::uuid,'waiting',2);", 'F06_MIXED_HU_SCOPE_CHANGED'),
        ('third-chair', "INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id) VALUES(md5('mixed-hu-third-seat')::uuid,md5('mixed-hu-table')::uuid,md5('mixed-hu-third-user')::uuid,3,1,md5('mixed-hu-third-occupancy')::uuid);INSERT INTO tournament_players VALUES(md5('mixed-hu-third-registration')::uuid,md5('mixed-hu')::uuid,md5('mixed-hu-table')::uuid,md5('mixed-hu-third-user')::uuid,3,1,'playing');", 'F06_MIXED_HU_SCOPE_CHANGED'),
        ('missing-prior-input', "UPDATE fixture_expected_inputs SET expected=expected#-'{hands,0,prior}' WHERE i=361;", 'F06_MIXED_PRIOR_IDENTITY'),
        ('missing-prior-atomic', "DELETE FROM hand_atomic_commits WHERE table_id=md5('mixed-hu-table')::uuid;", 'F06_MIXED_PRIOR_INCOMPLETE'),
        ('started-park', "INSERT INTO smarter_private.f06_operations(break_id,tournament_id,source_table_id,lifecycle,boundary_id,origin_generation,state,manifest) SELECT md5('mixed-hu-park')::uuid,tournament_id,id,f06_lifecycle,md5('mixed-hu-boundary')::uuid,md5('mixed-hu-old')::uuid,'begun','[]'::jsonb FROM tables WHERE id=md5('mixed-hu-table')::uuid;", 'F06_GENERATION_PARK_CHANGED'),
        ('unstarted-park', "INSERT INTO smarter_private.f06_operations(break_id,tournament_id,source_table_id,lifecycle,boundary_id,origin_generation) SELECT md5('mixed-hu-park')::uuid,tournament_id,id,f06_lifecycle,md5('mixed-hu-boundary')::uuid,md5('mixed-hu-old')::uuid FROM tables WHERE id=md5('mixed-hu-table')::uuid;", 'F06_MIXED_BOUNDARIES_REQUIRED'),
    ]:
        probe('mixed-hu-refuses-' + name, service + change + abort(361), error=error)
    require(run('mixed-hu-probes-rolled-back', money) == hu_before, 'HU qualification leaked financial changes')
    run('mixed-hu-one-terminal-bundle', hu_abort)
    run('mixed-hu-exact-replay', hu_abort)
    require(run('mixed-hu-no-credit-or-history', money) == hu_before, 'HU disposition changed financial state')
    run('mixed-hu-truthful-terminal-fences', """SELECT
      (SELECT state FROM smarter_private.f06_hand_permits WHERE permit_id=md5('mixed-hu-permit')::uuid)||'|'||
      (SELECT count(*) FROM smarter_private.f06_mixed_abort_generations WHERE tournament_id=md5('mixed-hu')::uuid)||'|'||
      (SELECT count(*) FROM smarter_private.f06_mixed_abort_hands WHERE tournament_id=md5('mixed-hu')::uuid)||'|'||
      (SELECT count(*) FROM hand_state_snapshots WHERE table_id=md5('mixed-hu-table')::uuid)||'|'||
      (SELECT count(*) FROM engine_tournament_leases WHERE tournament_id=md5('mixed-hu')::uuid);""", 'aborted_unsettled|2|1|0|0')
    for generation in ('mixed-hu-old', 'mixed-hu-current'):
        run('mixed-hu-late-generation-refused-' + generation, "SELECT granted FROM claim_tournament_lease_v2(md5('mixed-hu')::uuid,'late','old',md5('%s')::uuid);" % generation, 'f')
    results['mixedHuPrior'] = {'passed': True, 'hands': 1, 'players': 2, 'stacks': 600, 'credit': 0}

    # Reuse an original abort actually committed by the predecessor's RPC above.
    # It predates joined_at capture and has no atomic hand to impersonate.
    run('mixed-hu-original-abort-successor-seed', """
      UPDATE tables SET max_players=2 WHERE id=md5('tab1')::uuid;
      INSERT INTO smarter_private.f06_hand_permits
        SELECT md5('mixed-hu-abort-permit')::uuid,tournament_id,id,f06_lifecycle,100002,
          md5('mixed-hu-abort-custody')::uuid,md5('new-g1')::uuid,'reserved',NULL
        FROM tables WHERE id=md5('tab1')::uuid;
      UPDATE engine_tournament_leases SET lease_generation=md5('mixed-hu-abort-current')::uuid
        WHERE tournament_id=md5('t1')::uuid;
      INSERT INTO fixture_expected_inputs VALUES(362,fixture_expected_mixed(md5('t1')::uuid));""")
    prior_abort_before = run('mixed-hu-abort-money-before', money)
    old_boundary = """SELECT jsonb_build_object(
      'receipt',(SELECT to_jsonb(a) FROM smarter_private.f06_unsettled_hand_aborts a WHERE receipt_id=md5('receipt1')::uuid),
      'permit',(SELECT to_jsonb(p) FROM smarter_private.f06_hand_permits p WHERE permit_id=md5('permit1')::uuid),
      'park',(SELECT to_jsonb(o) FROM smarter_private.f06_operations o WHERE break_id=md5('park1')::uuid),
      'snapshots',(SELECT jsonb_agg(s ORDER BY id) FROM hand_state_snapshots s WHERE table_id=md5('tab1')::uuid));"""
    boundary_before = run('mixed-hu-abort-original-boundary-before', old_boundary)
    prior_abort = service + abort(362)
    probe('mixed-hu-abort-prior-valid-rollback', prior_abort)
    for name, change, error in [
        ('different-event-receipt', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{hands,0,prior,receipt_id}',to_jsonb(md5('receipt2')::uuid)) WHERE i=362;", 'F06_MIXED_PRIOR_ABORT_BOUNDARY'),
        ('changed-receipt-hash', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{hands,0,prior,receipt_hash}','\"wrong\"') WHERE i=362;", 'F06_MIXED_PRIOR_ABORT_EXPECTED_CHANGED'),
        ('fake-atomic-identity', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{hands,0,prior}',jsonb_build_object('atomic_hand_id',md5('receipt1')::uuid,'hand_number',100001)) WHERE i=362;", 'F06_MIXED_PRIOR_INCOMPLETE'),
        ('registration-replaced', "UPDATE tournament_players SET id=gen_random_uuid() WHERE table_id=md5('tab1')::uuid;UPDATE fixture_expected_inputs SET expected=fixture_expected_mixed(md5('t1')::uuid) WHERE i=362;", 'F06_MIXED_PRIOR_ABORT_ROSTER_CHANGED'),
        ('occupancy-reopened', "UPDATE table_seats SET left_at=now() WHERE table_id=md5('tab1')::uuid;UPDATE table_seats SET left_at=NULL WHERE table_id=md5('tab1')::uuid;UPDATE fixture_expected_inputs SET expected=fixture_expected_mixed(md5('t1')::uuid) WHERE i=362;", 'F06_MIXED_PRIOR_ABORT_ROSTER_CHANGED'),
        ('chip-stack-drift', "UPDATE table_seats SET stack=stack+1 WHERE table_id=md5('tab1')::uuid;UPDATE tournament_players SET chips=chips+1 WHERE table_id=md5('tab1')::uuid;UPDATE fixture_expected_inputs SET expected=fixture_expected_mixed(md5('t1')::uuid) WHERE i=362;", 'F06_MIXED_PRIOR_ABORT_ROSTER_CHANGED'),
        ('new-joined-at', "UPDATE table_seats SET joined_at=joined_at+interval '1 second' WHERE table_id=md5('tab1')::uuid;", 'F06_ABORT_EXPECTED_CHANGED'),
        ('private-after-boundary', "INSERT INTO hand_private_state VALUES(md5('tab1')::uuid,100001);", 'F06_MIXED_PRIOR_ABORT_NOT_LAST_BOUNDARY'),
        ('target-dispatch', "INSERT INTO smarter_private.f06_hand_dispatch VALUES(md5('mixed-hu-abort-permit')::uuid,txid_current());", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('active-snapshot', "INSERT INTO hand_state_snapshots(table_id,hand_number) VALUES(md5('tab1')::uuid,100003);", 'F06_MIXED_PRIOR_ABORT_NOT_LAST_BOUNDARY'),
        ('later-permit', "INSERT INTO smarter_private.f06_hand_permits SELECT md5('mixed-hu-abort-later')::uuid,tournament_id,table_id,lifecycle,100003,gen_random_uuid(),generation,'never_started',NULL FROM smarter_private.f06_hand_permits WHERE permit_id=md5('mixed-hu-abort-permit')::uuid;", 'F06_GENERATION_PERMIT_CHANGED'),
    ]:
        probe('mixed-hu-abort-refuses-' + name, service + change + abort(362), error=error)
    run('mixed-hu-abort-commit', prior_abort)
    run('mixed-hu-abort-exact-replay', prior_abort)
    require(run('mixed-hu-abort-no-credit-or-history', money) == prior_abort_before, 'Prior-abort HU changed financial state')
    require(run('mixed-hu-abort-old-records-unchanged', old_boundary) == boundary_before, 'Prior-abort HU rewrote the original outcome')
    run('mixed-hu-abort-distinct-identity', """SELECT
      (prior_hand_id IS NULL AND snapshot_id IS NULL AND prior_abort_receipt_id=md5('receipt1')::uuid)::text||'|'||
      (SELECT state FROM smarter_private.f06_hand_permits WHERE permit_id=md5('mixed-hu-abort-permit')::uuid)||'|'||
      (SELECT count(*) FROM smarter_private.f06_mixed_abort_generations WHERE tournament_id=md5('t1')::uuid)
      FROM smarter_private.f06_mixed_abort_hands WHERE permit_id=md5('mixed-hu-abort-permit')::uuid;""", 'true|aborted_unsettled|2')
    results['mixedHuPriorAbort'] = {'passed': True, 'hands': 1, 'players': 2, 'stacks': 600, 'credit': 0, 'priorIdentity': 'original-abort-receipt'}

    results['mixedPostimages'] = json.loads(run('mixed-qualified-installed-catalog', """SELECT jsonb_agg(jsonb_build_object(
      'signature',p.oid::regprocedure::text,'definition_md5',md5(pg_get_functiondef(p.oid)),
      'definition_sha256',encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex'),
      'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text) ORDER BY p.oid::regprocedure::text)
      FROM pg_proc p WHERE p.oid IN('smarter_private.f06_generation_aborted(uuid,uuid)'::regprocedure,
      'smarter_private.f06_aborted_hand_guard()'::regprocedure,'smarter_private.f06_immutable_identity()'::regprocedure,
      'smarter_private.f06_prior_committed_stacks(uuid,jsonb,jsonb)'::regprocedure,
      'smarter_private.f06_prior_aborted_stacks(uuid,jsonb,jsonb)'::regprocedure,
      'public.fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)'::regprocedure);"""))
    require(all(p['owner'] == 'postgres' and p['acl'] == ('{postgres=X/postgres}' if p['signature'].startswith('smarter_private.') else '{postgres=X/postgres,service_role=X/postgres}')
                for p in results['mixedPostimages']), 'Mixed installed function owner/ACL changed')
