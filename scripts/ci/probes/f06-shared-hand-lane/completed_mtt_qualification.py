"""Completed, unaccepted original MTT snapshot in the existing mixed owner."""
from contextlib import contextmanager
import hashlib
import json
import runpy
import subprocess
import time


def qualify(root, out, cmd, command, run, probe, require, results):
    here = root / 'scripts/ci/probes/f06-shared-hand-lane'
    builder = runpy.run_path(str(here / 'build-completed-mtt-migration.py'))
    migration = root / builder['MIGRATION']
    require(migration.read_text() == builder['render'](), 'Completed MTT migration/source differ')
    inputs = [migration, root / builder['PREDECESSOR'], root / 'scripts/ci/test-f06-shared-hand-lane.py']
    inputs += [here / n for n in ('build-completed-mtt-migration.py', 'completed-mtt-boundary.sql',
        'completed-mtt-paid-preimages.json', 'completed-mtt-paid-dependency.sql',
        'completed-mtt-fixture.sql', 'completed-mtt-index-contract.sql', 'completed_mtt_qualification.py')]
    results['completedMttInputs'] = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
    run('completed-mtt-exact-predecessor', "SELECT md5(pg_get_functiondef('fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)'::regprocedure));", '9a655cf82edac7513824335a4091e3b8')
    run('completed-mtt-required-index-fixture', 'CREATE INDEX idx_hand_state_snapshots_table_hand ON hand_state_snapshots(table_id,hand_number);')
    run('completed-mtt-original-paid-schema', (here / 'completed-mtt-paid-dependency.sql').read_text())
    run('completed-mtt-original-fixtures', (here / 'completed-mtt-fixture.sql').read_text())
    service = "SET request.jwt.claims='{\"role\":\"service_role\"}';SET app.smarter_data_actor='service';"

    def seed(i):
        return f'SELECT fixture_seed_completed_mtt({i});INSERT INTO fixture_expected_inputs VALUES({i},fixture_completed_mtt_expected({i}));'

    def abort(i=901, receipt=None):
        return "SELECT fn_f06_abort_mixed_unsettled_generation(md5('cm-receipt%d')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=%d));" % (receipt or i, i)

    def refresh(i=901):
        return f'UPDATE fixture_expected_inputs SET expected=fixture_completed_mtt_expected({i}) WHERE i={i};'

    def retain(i):
        return """SELECT fn_ca_retain_hand_submission(jsonb_build_object(
        'p_table_id',md5('cm-tableI')::uuid,'p_hand_number',12636137,
        'p_hand_row',jsonb_build_object('id',md5('cm-attemptI')::uuid,'table_id',md5('cm-tableI')::uuid,'hand_number',12636137),
        'p_stacks',(SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,
        'stack',stack,'stack_before',stack) ORDER BY user_id) FROM table_seats WHERE table_id=md5('cm-tableI')::uuid),
        'p_rake',0,'p_bbj',0,'p_ref','exact-synthetic-original-request','p_inflow',0,'p_units','[]'::jsonb,
        'p_post_commit_obligations',jsonb_build_object('version',1),
        'p_instance_id','cm-current','p_lease_generation',md5('cm-originalI')::uuid));""".replace('I', str(i))

    money = """SELECT jsonb_build_object(
    'seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s),
    'roster',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM tournament_players p),
    'snapshot',(SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('xmin',xmin::text) ORDER BY id) FROM hand_state_snapshots s),
    'cards',(SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('xmin',xmin::text) ORDER BY id) FROM table_hole_cards c),
    'paid',(SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('xmin',xmin::text) ORDER BY id) FROM tournament_paid_stack_custody_receipts p),
    'atomic',(SELECT jsonb_agg(to_jsonb(a) ORDER BY table_id,hand_number) FROM hand_atomic_commits a),
    'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY table_id,hand_number) FROM hand_history h),
    'ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM fixture_ledger l),
    'settlements',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM ca_settlements c),
    'keys',(SELECT jsonb_agg(to_jsonb(k) ORDER BY table_id,hand_id) FROM settlement_idempotency_keys k),
    'outbox',(SELECT jsonb_agg(to_jsonb(o) ORDER BY hand_id) FROM hand_projection_outbox o));"""
    control = """SELECT jsonb_build_object(
    'leases',(SELECT jsonb_agg(to_jsonb(l) ORDER BY tournament_id) FROM engine_tournament_leases l),
    'permits',(SELECT jsonb_agg(to_jsonb(p) ORDER BY permit_id) FROM smarter_private.f06_hand_permits p),
    'parks',(SELECT jsonb_agg(to_jsonb(o) ORDER BY break_id) FROM smarter_private.f06_operations o),
    'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY receipt_id) FROM smarter_private.f06_mixed_aborts r),
    'fences',(SELECT jsonb_agg(to_jsonb(f) ORDER BY tournament_id,generation) FROM smarter_private.f06_mixed_abort_generations f),
    'hands',(SELECT jsonb_agg(to_jsonb(h) ORDER BY permit_id) FROM smarter_private.f06_mixed_abort_hands h),
    'dispositions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY table_id,hand_number) FROM smarter_private.hand_submission_dispositions d));"""
    run('completed-mtt-retained-legacy-opening', seed(901))
    run('completed-mtt-existing-active-opening', 'SELECT fixture_seed_mixed(911);')
    active_abort = "SELECT fn_f06_abort_mixed_unsettled_generation(md5('cm-active-receipt')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=911));"
    probe('completed-mtt-existing-active-before', service + active_abort)
    before = run('completed-mtt-money-before', money)
    control_before = run('completed-mtt-control-before', control)
    probe('completed-mtt-old-owner-refuses-real-boundary', service + abort(), error='F06_MIXED_PRIOR_IDENTITY')
    for label, change, error in [
        ('missing-index', 'DROP INDEX idx_hand_state_snapshots_table_hand;', 'HAND_SNAPSHOT_INDEX_MISSING_BUILD_ONLINE'),
        ('wrong-index', 'DROP INDEX idx_hand_state_snapshots_table_hand;CREATE INDEX idx_hand_state_snapshots_table_hand ON hand_state_snapshots(hand_number,table_id);', 'HAND_SNAPSHOT_INDEX_CONTRACT_CHANGED'),
        ('predecessor', 'ALTER FUNCTION fn_f06_abort_mixed_unsettled_generation(uuid,jsonb) SET search_path=pg_catalog;', 'F06_SPIN_PRIOR_AUTHORITY_CHANGED'),
        ('paid-acl', 'GRANT SELECT ON tournament_paid_stack_custody_receipts TO authenticated;', 'F06_COMPLETED_MTT_PAID_SCHEMA_CHANGED'),
        ('paid-guard', 'ALTER FUNCTION fn_ca_guard_original_paid_stack_receipt() SET search_path=public;', 'F06_COMPLETED_MTT_PAID_AUTHORITY_CHANGED'),
        ('paid-truncate', 'ALTER TABLE tournament_paid_stack_custody_receipts DISABLE TRIGGER original_paid_custody_no_truncate;', 'F06_COMPLETED_MTT_PAID_BINDING_CHANGED'),
    ]:
        run('completed-mtt-install-refuses-' + label, 'BEGIN;' + change + migration.read_text(), error=error)
    run('completed-mtt-install', migration.read_text())
    require(run('completed-mtt-install-no-money', money) == before, 'Install changed money/evidence')
    require(run('completed-mtt-install-no-control', control) == control_before, 'Install changed custody')
    probe('completed-mtt-new-owner-accepts-exact-rollback', service + abort())
    probe('completed-mtt-existing-active-after', service + active_abort)
    for label, change, error in [
        ('browser', 'SET ROLE authenticated;', '42501'),
        ('wrong-actor', "SET app.smarter_data_actor='browser';", 'F06_ABORT_SERVICE_REQUIRED'),
        ('no-current-owner', "DELETE FROM engine_tournament_leases WHERE tournament_id=md5('cm-event901')::uuid;", 'F06_GENERATION_LEASE_CHANGED'),
        ('wrong-current-generation', "UPDATE engine_tournament_leases SET lease_generation=gen_random_uuid() WHERE tournament_id=md5('cm-event901')::uuid;", 'F06_GENERATION_LEASE_CHANGED'),
        ('snapshot-missing', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{hands,0,snapshot_id}',to_jsonb(gen_random_uuid())) WHERE i=901;", 'F06_COMPLETED_MTT_SNAPSHOT_CHANGED'),
        ('snapshot-hash', "UPDATE hand_state_snapshots SET updated_at=now() WHERE id=md5('cm-snapshot901')::uuid;", 'F06_ABORT_EXPECTED_CHANGED'),
        ('snapshot-stage', "UPDATE hand_state_snapshots SET stage='flop' WHERE id=md5('cm-snapshot901')::uuid;", 'F06_ABORT_SNAPSHOT_CHANGED'),
        ('snapshot-investment', "UPDATE hand_state_snapshots SET state_json=jsonb_set(state_json,'{players,1,totalInvested}','23813') WHERE id=md5('cm-snapshot901')::uuid;", 'F06_ABORT_SAVED_STACKS_CHANGED'),
        ('snapshot-actions', "UPDATE hand_state_snapshots SET state_json=jsonb_set(state_json,'{actionHistory}','[{\"action\":\"fold\"}]') WHERE id=md5('cm-snapshot901')::uuid;", 'F06_COMPLETED_MTT_SCOPE_CHANGED'),
        ('card-missing', "DELETE FROM table_hole_cards WHERE id=md5('cm-card901:1')::uuid;", 'F06_COMPLETED_MTT_CARDS_CHANGED'),
        ('card-changed', "UPDATE table_hole_cards SET cards='[\"Qh\",\"Jd\"]' WHERE id=md5('cm-card901:1')::uuid;", 'F06_ABORT_EXPECTED_CHANGED'),
        ('paid-wrong', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{hands,0,interruption,paid_receipt_id}',to_jsonb(gen_random_uuid())) WHERE i=901;", 'F06_COMPLETED_MTT_PAID_CUSTODY_CHANGED'),
        ('registration-changed', "UPDATE tournament_players SET id=gen_random_uuid() WHERE id=md5('cm-registration901:1')::uuid;", 'F06_ABORT_EXPECTED_CHANGED'),
        ('paid-seat-changed', "UPDATE table_seats SET stack=stack+1 WHERE table_id=md5('cm-table901')::uuid AND seat_number=1;UPDATE tournament_players SET chips=chips+1 WHERE tournament_id=md5('cm-event901')::uuid AND seat_number=1;", 'F06_ABORT_SAVED_STACKS_CHANGED'),
        ('private', "INSERT INTO hand_private_state VALUES(md5('cm-table901')::uuid,12636137);", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('dispatch', "INSERT INTO smarter_private.f06_hand_dispatch VALUES(md5('cm-permit901')::uuid,txid_current());", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('later-history', "INSERT INTO hand_history(table_id,hand_number) VALUES(md5('cm-table901')::uuid,12636138);", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('later-snapshot', "INSERT INTO hand_state_snapshots(table_id,hand_number,is_complete) VALUES(md5('cm-table901')::uuid,12636138,false);", 'F06_COMPLETED_MTT_LATER_CUSTODY'),
        ('outbox', "INSERT INTO hand_projection_outbox VALUES(gen_random_uuid(),md5('cm-table901')::uuid,12636137,now());", 'F06_COMPLETED_MTT_LATER_CUSTODY'),
        ('orphan-money', "INSERT INTO ca_settlements(settlement_type,external_ref,state,table_id,hand_id) VALUES('hand_stacks','cm-orphan','final',md5('cm-table901')::uuid,gen_random_uuid());", 'F06_COMPLETED_MTT_FINANCIAL_BOUNDARY_CHANGED'),
    ]:
        probe('completed-mtt-refuses-' + label, service + change + abort(), error=error)
    for statement in ('DELETE FROM tournament_paid_stack_custody_receipts;', 'TRUNCATE tournament_paid_stack_custody_receipts;', "UPDATE tournament_paid_stack_custody_receipts SET grant_chips=grant_chips+1;"):
        probe('completed-mtt-paid-immutable-' + statement.split()[0].lower(), statement, error='ORIGINAL_PAID_CUSTODY_IMMUTABLE')
    require(run('completed-mtt-refusals-no-money', money) == before, 'Refusal changed original evidence')
    require(run('completed-mtt-refusals-no-control', control) == control_before, 'Refusal leaked custody')

    @contextmanager
    def held(sql, finish='ROLLBACK'):
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            p.stdin.write('BEGIN;' + sql + 'SELECT pg_advisory_lock(18130733);\n'); p.stdin.flush()
            deadline = time.monotonic() + 5
            while command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=18130733 AND granted);").stdout.strip() != 't':
                require(p.poll() is None and time.monotonic() < deadline, 'Completed MTT holder missed actual barrier')
                time.sleep(.01)
            yield
        finally:
            if p.poll() is None:
                p.stdin.write(finish + ';\n'); p.stdin.close(); p.wait(timeout=6)
            require(p.returncode == 0, p.stderr.read())

    def request(generation):
        return "SET request.jwt.claims='{\"role\":\"service_role\"}';SELECT set_config('request.headers',jsonb_build_object('x-smarter-data-actor','tournament-manager','x-smarter-data-protocol','2','x-smarter-tournament-id',md5('cm-event901')::uuid,'x-smarter-tournament-lease-generation',md5('cm-%s901')::uuid)::text,true);SET request.method='POST';SELECT smarter_private.fn_smarter_data_api_pre_request();" % generation

    with held(request('current')):
        probe('completed-mtt-drains-real-owner', "SET LOCAL lock_timeout='150ms';" + service + abort(), error='55P03')
    atomic = "INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,post_commit_completed_at,post_commit_result) VALUES(md5('cm-table901')::uuid,12636137,md5('cm-atomic901')::uuid,now(),'{\"ok\":true}');"
    with held(service + abort(), finish='COMMIT'):
        probe('completed-mtt-disposition-first-blocks-atomic', atomic, error='F06_RETRY_CANONICAL_LANE')
        probe('completed-mtt-same-operation-waits', "SET LOCAL lock_timeout='150ms';" + service + abort(), error='55P03')
        probe('completed-mtt-different-operation-waits', "SET LOCAL lock_timeout='150ms';" + service + abort(receipt=999), error='55P03')
    run('completed-mtt-identical-replay', service + abort())
    probe('completed-mtt-changed-replay', service + "UPDATE fixture_expected_inputs SET expected=expected #- '{hands,0,interruption}' WHERE i=901;" + abort(), error='F06_ABORT_CHANGED_REPLAY')
    probe('completed-mtt-different-operation-refused', service + abort(receipt=999), error='F06_GENERATION_LEASE_CHANGED')
    probe('completed-mtt-late-atomic-refused', atomic, error='F06_ABORTED_HAND_FENCED')
    require(run('completed-mtt-committed-evidence-byte-identical', money) == before, 'Disposition changed original money/snapshot/cards/paid receipt')
    run('completed-mtt-truthful-disposition', "SELECT state||'|'||(SELECT count(*) FROM smarter_private.f06_mixed_abort_generations WHERE tournament_id=md5('cm-event901')::uuid)||'|'||(SELECT count(*) FROM engine_tournament_leases WHERE tournament_id=md5('cm-event901')::uuid) FROM smarter_private.f06_hand_permits WHERE permit_id=md5('cm-permit901')::uuid;", 'aborted_unsettled|2|0')
    for generation in ('original', 'current'):
        probe('completed-mtt-old-request-fenced-' + generation, request(generation), error='42501')
        run('completed-mtt-permanent-generation-' + generation, "SELECT granted FROM claim_tournament_lease_v2(md5('cm-event901')::uuid,'late','qualified',md5('cm-%s901')::uuid);" % generation, 'f')
    run('completed-mtt-accepted-first-opening', seed(902))
    with held(atomic.replace('901', '902'), finish='COMMIT'):
        probe('completed-mtt-accepted-first-refuses', service + abort(902), error='F06_RETRY_CANONICAL_LANE')
    probe('completed-mtt-accepted-remains-authoritative', service + abort(902), error='F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED')
    run('completed-mtt-retention-first-opening', seed(903))
    run('completed-mtt-original-current-retention-identity', "UPDATE engine_tournament_leases SET lease_generation=md5('cm-original903')::uuid WHERE tournament_id=md5('cm-event903')::uuid;" + refresh(903))
    with held(service + retain(903), finish='COMMIT'):
        probe('completed-mtt-retention-first-drained', "SET LOCAL lock_timeout='150ms';" + service + abort(903), error='55P03')
    probe('completed-mtt-retained-request-refuses-disposition', service + abort(903), error='F06_COMPLETED_MTT_LATER_CUSTODY')
    probe('completed-mtt-disposed-original-request-refused', service + retain(901), error='HAND_SUBMISSION_PERMIT_FENCED')
    results['completedMttPostimage'] = json.loads(run('completed-mtt-postimage', "SELECT jsonb_build_object('signature',oid::regprocedure::text,'definition',pg_get_functiondef(oid),'definition_md5',md5(pg_get_functiondef(oid)),'source_md5',md5(prosrc),'owner',pg_get_userbyid(proowner),'acl',proacl,'config',proconfig) FROM pg_proc WHERE oid='fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)'::regprocedure;"))
    results['completedMtt'] = {'passed': True, 'credit': 0, 'chips': 322500, 'privateCardsPreserved': True,
        'completedSnapshotUnchanged': True, 'paidReceiptUnchanged': True, 'acceptedAndRetainedOutcomesExcluded': True}
