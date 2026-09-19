"""Native PostgreSQL qualification for retained original MTT disposition only."""
from contextlib import contextmanager
import hashlib
import json
import runpy
import subprocess
import time


def qualify(root, out, cmd, command, run, probe, require, results):
    here = root / 'scripts/ci/probes/f06-shared-hand-lane'
    build = runpy.run_path(str(here / 'build-retained-mtt-migration.py'))
    migration = root / build['MIGRATION']
    require(migration.read_text() == build['render'](), 'Retained MTT source composition differs')
    require(results.get('interruptedCustody', {}).get('passed') is True, 'Exact installed predecessor required')
    generic_before = run('retained-mtt-generic-preimage', "SELECT md5(pg_get_functiondef('fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)'::regprocedure));")
    # Retain the exact synthetic predecessor for deterministic investigation;
    # this is local qualification data, never a production dump or actuator.
    dump = command([str(__import__('pathlib').Path(cmd[0]).with_name('pg_dump')), '-h', cmd[cmd.index('-h')+1],
                    '-p', cmd[cmd.index('-p')+1], '-U', 'postgres', '--no-owner', '--no-privileges', cmd[-1]])
    require(dump.returncode == 0, dump.stderr)
    (out / 'retained-mtt-predecessor.sql').write_text(dump.stdout)
    results['retainedMttInputs'] = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in [migration, here / 'retained-mtt-authority.sql', here / 'retained-mtt-fixture.sql',
                  here / 'retained_mtt_qualification.py', here / 'build-retained-mtt-migration.py',
                  root / 'scripts/ci/test-f06-shared-hand-lane.py']}
    service = "SET request.jwt.claims='{\"role\":\"service_role\"}';SET app.smarter_data_actor='service';"
    run('retained-mtt-fixture-schema', (here / 'retained-mtt-fixture.sql').read_text())
    run('retained-mtt-two-boundaries', 'SELECT fixture_seed_retained_mtt(1301,true);SELECT fixture_seed_retained_mtt(1302,false);')
    # Reproduce the actual refusals using the unchanged installed generic owner.
    for i, error in [(1301, 'F06_GENERATION_PARK_CHANGED'), (1302, 'F06_GENERATION_ROSTER_CHANGED')]:
        probe('retained-mtt-generic-before-' + str(i), service + f"SELECT fn_f06_abort_mixed_unsettled_generation(md5('rm-receipt{i}')::uuid,fixture_expected_mixed(md5('rm-event{i}')::uuid));", error=error)
    money = "SELECT jsonb_build_object(" + ','.join("'%s',(SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('row_xmin',xmin::text) ORDER BY %s) FROM %s x)" % (name, order, table) for name, table, order in (
        ('seats','table_seats','id'),('roster','tournament_players','id'),('lease','engine_tournament_leases','tournament_id'),
        ('tables','tables','id'),('operations','smarter_private.f06_operations','break_id'),
        ('members','smarter_private.f06_members','break_id,user_id'),('attempts','smarter_private.f06_attempts','request_id'),
        ('moves','tournament_seat_move_receipts','request_id'),('cards','table_hole_cards','id'),
        ('atomic','hand_atomic_commits','table_id,hand_number'),('history','hand_history','id'),
        ('settlements','ca_settlements','id'),('keys','settlement_idempotency_keys','table_id,hand_id'),
        ('submissions','smarter_private.hand_submissions','submission_id'),('ledger','fixture_ledger','id'))) + ');'
    before = run('retained-mtt-install-before', money)
    run('retained-mtt-install-refuses-lease-policy-drift',
        "BEGIN;ALTER FUNCTION public.fn_engine_lease_stale_seconds() SET search_path=pg_catalog;" + migration.read_text(),
        error='F06_RETAINED_AUTHORITY_CHANGED: public.fn_engine_lease_stale_seconds()')
    run('retained-mtt-install', migration.read_text())
    require(run('retained-mtt-install-unchanged', money) == before, 'Installation changed retained state')
    for i, kind in [(1301,'true'),(1302,'false')]:
        run('retained-mtt-capture-' + str(i), service + f'INSERT INTO fixture_expected_inputs VALUES({i},smarter_private.f06_retained_mtt_abort_snapshot(fixture_retained_input({i},{kind})));')

    def abort(i=1302, receipt=None):
        return f"SELECT fn_f06_abort_retained_mtt_hands(md5('rm-receipt{receipt or i}')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i={i}));"

    for i in (1301,1302):
        probe('retained-mtt-qualified-rollback-' + str(i), service + abort(i))
    for name, change, error in [
        ('browser', 'SET ROLE authenticated;', '42501'),
        ('wrong-actor', "SET app.smarter_data_actor='browser';", 'F06_ABORT_SERVICE_REQUIRED'),
        ('physical-unknown', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{physical,all_owned_work_joined}','false') WHERE i=1302;", 'F06_RETAINED_PHYSICAL_PROOF_REQUIRED'),
        ('physical-wrong-original', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{physical,permit_id}',to_jsonb(gen_random_uuid())) WHERE i=1302;", 'F06_RETAINED_PHYSICAL_PROOF_REQUIRED'),
        ('fresh-lease', "UPDATE engine_tournament_leases SET heartbeat_at=now() WHERE tournament_id=md5('rm-event1302')::uuid;", 'F06_RETAINED_LEASE_CHANGED'),
        ('longer-lease-policy', "CREATE OR REPLACE FUNCTION public.fn_engine_lease_stale_seconds() RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'public','pg_temp' AS 'SELECT 120';UPDATE engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '60 seconds' WHERE tournament_id=md5('rm-event1302')::uuid;UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{lease}',(SELECT to_jsonb(l) FROM engine_tournament_leases l WHERE l.tournament_id=md5('rm-event1302')::uuid)) WHERE i=1302;", 'F06_RETAINED_LEASE_CHANGED'),
        ('lease-replaced', "UPDATE engine_tournament_leases SET lease_generation=gen_random_uuid() WHERE tournament_id=md5('rm-event1302')::uuid;", 'F06_RETAINED_LEASE_CHANGED'),
        ('unproven-zero', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{accepted_zeros}','[]') WHERE i=1302;", 'F06_RETAINED_ZERO_SET_CHANGED'),
        ('zero-positive', "UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,ARRAY['written',md5('rm-user1302:3')::uuid::text],'1') WHERE hand_id=md5('rm-atomic-zero1302')::uuid;", 'F06_RETAINED_FINANCIAL_BOUNDARY_CHANGED'),
        ('zero-unsealed', "UPDATE hand_atomic_commits SET post_commit_payload_hash=repeat('b',64) WHERE hand_id=md5('rm-atomic-zero1302')::uuid;", 'F06_RETAINED_ZERO_PROOF_CHANGED'),
        ('prior-unsealed', "UPDATE hand_atomic_commits SET post_commit_payload_hash=repeat('b',64) WHERE hand_id=md5('rm-atomic-prior1302')::uuid;", 'F06_MIXED_PRIOR_POSTCOMMIT_SEAL'),
        ('prior-incomplete', "UPDATE hand_atomic_commits SET post_commit_completed_at=NULL WHERE hand_id=md5('rm-atomic-prior1302')::uuid;", 'F06_RETAINED_FINANCIAL_BOUNDARY_CHANGED'),
        ('arrival-omitted', "UPDATE fixture_expected_inputs SET expected=expected #- '{hands,0,interruption,inbound_requests,0}' WHERE i=1302;", 'F06_RETAINED_INBOUND_SET_CHANGED'),
        ('arrival-duplicated', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{hands,0,interruption,inbound_requests}',jsonb_build_array(expected#>'{hands,0,interruption,inbound_requests,0}',expected#>'{hands,0,interruption,inbound_requests,0}')) WHERE i=1302;", 'F06_RETAINED_INBOUND_SET_CHANGED'),
        ('arrival-stack', "UPDATE tournament_seat_move_receipts SET stack=stack+1 WHERE request_id=md5('rm-move1302:1')::uuid;", 'F06_RETAINED_INBOUND_PROOF_CHANGED'),
        ('arrival-occupancy', "UPDATE smarter_private.f06_members SET occupancy_id=gen_random_uuid() WHERE break_id=md5('rm-break1302:1')::uuid;", 'F06_IDENTITY_IMMUTABLE'),
        ('arrival-destination', "UPDATE tournament_seat_move_receipts SET destination_seat_id=gen_random_uuid() WHERE request_id=md5('rm-move1302:1')::uuid;", 'F06_RETAINED_INBOUND_PROOF_CHANGED'),
        ('arrival-generation', "UPDATE smarter_private.f06_attempts SET generation=gen_random_uuid() WHERE request_id=md5('rm-move1302:1')::uuid;", 'F06_IDENTITY_IMMUTABLE'),
        ('mixed-row-changed', "UPDATE smarter_private.f06_operations SET revision=revision+1 WHERE break_id=md5('rm-break1302:2')::uuid;", 'F06_ABORT_EXPECTED_CHANGED'),
        ('unknown-dispatch', "INSERT INTO smarter_private.f06_hand_dispatch VALUES(md5('rm-permit1302')::uuid,txid_current());", 'F06_RETAINED_LATER_OR_UNKNOWN_CUSTODY'),
    ]:
        probe('retained-mtt-refuses-' + name, service + change + abort(), error=error)
    probe('retained-mtt-freeze-refusal', service + "INSERT INTO engine_maintenance_break VALUES(true,now(),'counting_down',now(),now()+interval '5 minutes');" + abort(), error='PLATFORM_FROZEN')
    for name, change, error in [
        ('snapshot-investment', "UPDATE hand_state_snapshots SET state_json=jsonb_set(state_json,'{players,0,totalInvested}','1') WHERE id=md5('rm-snapshot1301')::uuid;", 'F06_RETAINED_SNAPSHOT_CHANGED'),
        ('snapshot-action', "UPDATE hand_state_snapshots SET state_json=jsonb_set(state_json,'{actionHistory}','[{}]') WHERE id=md5('rm-snapshot1301')::uuid;", 'F06_RETAINED_SNAPSHOT_CHANGED'),
        ('snapshot-card-missing', "DELETE FROM table_hole_cards WHERE table_id=md5('rm-table1301')::uuid AND seat_number=1;", 'F06_RETAINED_CARDS_CHANGED'),
    ]:
        probe('retained-mtt-refuses-' + name, service + change + abort(1301), error=error)
    require(run('retained-mtt-refusals-preserved', money) == before, 'Refusal changed original state')

    @contextmanager
    def held(sql, finish='ROLLBACK'):
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            p.stdin.write('BEGIN;' + sql + 'SELECT pg_advisory_lock(18233825);\n'); p.stdin.flush()
            deadline = time.monotonic() + 5
            while command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=18233825 AND granted);").stdout.strip() != 't':
                require(p.poll() is None and time.monotonic() < deadline, 'Retained holder missed native barrier')
                time.sleep(.01)
            yield
        finally:
            if p.poll() is None:
                p.stdin.write(finish + ';\n'); p.stdin.close(); p.wait(timeout=6)
            require(p.returncode == 0, p.stderr.read())

    with held("SELECT 1 FROM engine_tournament_leases WHERE tournament_id=md5('rm-event1302')::uuid FOR KEY SHARE;"):
        probe('retained-mtt-drains-protocol2-writer', "SET LOCAL lock_timeout='150ms';" + service + abort(), error='55P03')
    with held("SELECT pg_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1:'||md5('rm-event1302')::uuid::text,0));"):
        probe('retained-mtt-lane-refuses-without-inversion', service + abort(), error='F06_RETRY_CANONICAL_LANE')
    with held("SELECT 1 FROM smarter_private.f06_attempts WHERE request_id=md5('rm-move1302:1')::uuid FOR UPDATE;"):
        probe('retained-mtt-drains-mixed-writer', "SET LOCAL lock_timeout='150ms';" + service + abort(), error='55P03')
    atomic = "INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id) VALUES(md5('rm-table1302')::uuid,10003,md5('rm-late-atomic')::uuid);"
    with held(service + abort(), finish='COMMIT'):
        probe('retained-mtt-disposition-excludes-atomic', atomic, error='F06_RETRY_CANONICAL_LANE')
        probe('retained-mtt-same-operation-serialized', "SET LOCAL lock_timeout='150ms';" + service + abort(), error='55P03')
    run('retained-mtt-identical-replay', service + abort())
    probe('retained-mtt-changed-replay', service + "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{physical,evidence_sha256}',to_jsonb(repeat('f',64))) WHERE i=1302;" + abort(), error='F06_ABORT_CHANGED_REPLAY')
    probe('retained-mtt-late-atomic-fenced', atomic, error='F06_ABORTED_HAND_FENCED')
    probe('retained-mtt-different-operation-refused', service + abort(receipt=1399), error='F06_RETAINED_WHOLE_ORIGINAL_REQUIRED')
    run('retained-mtt-snapshot-commit', service + abort(1301))
    require(run('retained-mtt-business-and-mixed-byte-identical', money) == before, 'Disposition modified business state or custody')
    run('retained-mtt-receipt-boundaries', "SELECT count(*) FROM smarter_private.f06_mixed_abort_hands WHERE receipt_id IN(md5('rm-receipt1301')::uuid,md5('rm-receipt1302')::uuid) AND break_id IS NULL;", '2')
    run('retained-mtt-snapshot-terminal', "SELECT is_complete FROM hand_state_snapshots WHERE id=md5('rm-snapshot1301')::uuid;", 't')
    run('retained-mtt-zero-still-owned-by-elimination', "SELECT status||'|'||chips FROM tournament_players WHERE id=md5('rm-reg1302:3')::uuid;", 'playing|0')
    run('retained-mtt-original-generation-refused', "SELECT granted FROM claim_tournament_lease_v2(md5('rm-event1302')::uuid,'late','test',md5('rm-generation1302')::uuid);", 'f')
    probe('retained-mtt-immutable-receipt', "UPDATE smarter_private.f06_mixed_aborts SET expected='{}' WHERE receipt_id=md5('rm-receipt1302')::uuid;", error='F06_ABORT_RECEIPT_IMMUTABLE')
    run('retained-mtt-browser-and-private-closed', "SELECT NOT has_function_privilege('authenticated','fn_f06_abort_retained_mtt_hands(uuid,jsonb)','EXECUTE') AND NOT has_function_privilege('anon','fn_f06_abort_retained_mtt_hands(uuid,jsonb)','EXECUTE') AND NOT has_function_privilege('service_role','smarter_private.f06_retained_mtt_abort_snapshot(jsonb)','EXECUTE');", 't')
    run('retained-mtt-generic-owner-unchanged', "SELECT md5(pg_get_functiondef('fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)'::regprocedure));", generic_before)
    # The accepted original wins permanently. No disposition can reinterpret
    # it after draining a writer that held the canonical lane first.
    run('retained-mtt-race-originals', 'SELECT fixture_seed_retained_mtt(1303,true);SELECT fixture_seed_retained_mtt(1304,true);')
    for i in (1303,1304):
        run('retained-mtt-race-capture-' + str(i), service + f'INSERT INTO fixture_expected_inputs VALUES({i},smarter_private.f06_retained_mtt_abort_snapshot(fixture_retained_input({i},true)));')
    accepted = "INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,post_commit_completed_at,post_commit_result) VALUES(md5('rm-table1303')::uuid,10003,md5('rm-race-accepted')::uuid,now(),'{\"ok\":true}');"
    with held(accepted, finish='COMMIT'):
        probe('retained-mtt-accepted-first-excludes-disposition', service + abort(1303), error='F06_RETRY_CANONICAL_LANE')
    probe('retained-mtt-accepted-wins-permanently', service + abort(1303), error='F06_RETAINED_WHOLE_ORIGINAL_REQUIRED')
    # Retention is the real original RPC under its fresh lease. Its transaction
    # then expires that fixture lease so the contender reaches the submission
    # boundary, without fabricating absence or bypassing the installed guard.
    submission_request = "jsonb_build_object('p_table_id',md5('rm-table1304')::uuid,'p_hand_number',10003,'p_hand_row',jsonb_build_object('id',md5('rm-race-submission')::uuid,'table_id',md5('rm-table1304')::uuid,'hand_number',10003),'p_instance_id','rm-process','p_lease_generation',md5('rm-generation1304')::uuid,'p_stacks','[]'::jsonb,'p_rake',0,'p_bbj',0,'p_inflow',0,'p_ref','fixture','p_units','[]'::jsonb,'p_post_commit_obligations','{}'::jsonb)"
    retain = "UPDATE engine_tournament_leases SET heartbeat_at=clock_timestamp() WHERE tournament_id=md5('rm-event1304')::uuid;SELECT fn_ca_retain_hand_submission(" + submission_request + ");UPDATE engine_tournament_leases SET heartbeat_at='2026-09-18 22:15:00+00' WHERE tournament_id=md5('rm-event1304')::uuid;"
    with held(service + retain, finish='COMMIT'):
        probe('retained-mtt-submission-first-drains-disposition', "SET LOCAL lock_timeout='150ms';" + service + abort(1304), error='55P03')
    probe('retained-mtt-submission-wins-permanently', service + abort(1304), error='F06_RETAINED_LATER_OR_UNKNOWN_CUSTODY')
    late_submission = submission_request.replace('1304', '1301')
    probe('retained-mtt-disposition-fences-late-submission', service + "SELECT fn_ca_retain_hand_submission(" + late_submission + ');', error='HAND_SUBMISSION_PERMIT_FENCED')
    results['retainedMtt'] = {'passed': True, 'credit': 0, 'leasePreserved': True,
        'mixedAndFinancialRowsByteIdentical': True, 'acceptedEliminationPreserved': True,
        'physicalProcessProof': 'Separate exact original-owner prerequisite, not certified by PostgreSQL fixture'}
