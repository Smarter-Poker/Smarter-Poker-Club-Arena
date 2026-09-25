"""Native original interrupted custody through the unchanged owning F06 RPC."""
from contextlib import contextmanager
import hashlib
import json
import runpy
import subprocess
import time


def qualify(root, out, cmd, command, run, probe, require, results):
    here = root / 'scripts/ci/probes/f06-shared-hand-lane'
    builder = runpy.run_path(str(here / 'build-interrupted-custody-migration.py'))
    migration = root / builder['MIGRATION']
    require(migration.read_text() == builder['render'](), 'Interrupted custody source composition changed')
    require(results.get('completedMtt', {}).get('passed') is True, 'Exact completed MTT predecessor required')
    inputs = [migration, root / builder['PREDECESSOR'], root / 'scripts/ci/test-f06-shared-hand-lane.py']
    inputs += [here / n for n in ('build-interrupted-custody-migration.py', 'snapshot-absent-spin-cards.sql',
                                 'snapshot-absent-spin-fixture.sql', 'completed-mtt-earlier-receipts.sql',
                                 'completed-mtt-earlier-receipts-fixture.sql', 'interrupted_custody_qualification.py')]
    results['interruptedCustodyInputs'] = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
    run('interrupted-custody-exact-predecessor', "SELECT md5(pg_get_functiondef('fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)'::regprocedure));", '4415d0e65aec71ecff0e0db366364ecb')
    run('absent-spin-fixture', (here / 'snapshot-absent-spin-fixture.sql').read_text())
    service = "SET request.jwt.claims='{\"role\":\"service_role\"}';SET app.smarter_data_actor='service';"

    def refresh(i=1101):
        return f'UPDATE fixture_expected_inputs SET expected=fixture_absent_spin_expected({i}) WHERE i={i};'

    def seed(i):
        run('absent-spin-seed-' + str(i), f'SELECT fixture_seed_absent_spin({i});')
        run('absent-spin-capture-' + str(i), refresh(i))

    def abort(i=1101, receipt=None):
        return "SELECT fn_f06_abort_mixed_unsettled_generation(md5('absent-receipt%d')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=%d));" % (receipt or i, i)

    money = "SELECT jsonb_build_object(" + ','.join("'%s',(SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('row_xmin',xmin::text) ORDER BY %s) FROM %s x)" % (name, order, table) for name, table, order in (
        ('seats','table_seats','id'),('roster','tournament_players','id'),('cards','table_hole_cards','id'),
        ('snapshots','hand_state_snapshots','id'),('atomic','hand_atomic_commits','hand_id'),('history','hand_history','id'),
        ('alerts','financial_alerts','id'),('dispatch','smarter_private.f06_hand_dispatch','permit_id'),
        ('settlements','ca_settlements','id'),('keys','settlement_idempotency_keys','table_id,hand_id'),
        ('outbox','hand_projection_outbox','hand_id'),('submissions','smarter_private.hand_submissions','submission_id'),
        ('ledger','fixture_ledger','id'))) + ');'
    control = "SELECT jsonb_build_object(" + ','.join("'%s',(SELECT jsonb_agg(to_jsonb(x) ORDER BY %s) FROM %s x)" % (name, order, table) for name, table, order in (
        ('leases','engine_tournament_leases','tournament_id'),('permits','smarter_private.f06_hand_permits','permit_id'),
        ('receipts','smarter_private.f06_mixed_aborts','receipt_id'),('fences','smarter_private.f06_mixed_abort_generations','tournament_id,generation'),
        ('hands','smarter_private.f06_mixed_abort_hands','permit_id'),('parks','smarter_private.f06_operations','break_id'))) + ');'
    seed(1101)
    run('earlier-mtt-fixture', (here / 'completed-mtt-earlier-receipts-fixture.sql').read_text())
    run('earlier-mtt-53-originals', 'SELECT fixture_seed_completed_mtt(1201);SELECT fixture_seed_completed_mtt_earlier_receipts(1201);INSERT INTO fixture_expected_inputs VALUES(1201,fixture_completed_mtt_expected(1201));')
    def mtt_abort(i=1201):
        return "SELECT fn_f06_abort_mixed_unsettled_generation(md5('earlier-mtt-receipt%d')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=%d));" % (i, i)
    probe('earlier-mtt-before-53-exact-refusal', service + mtt_abort(), error='F06_COMPLETED_MTT_FINANCIAL_BOUNDARY_CHANGED')
    before = run('absent-spin-originals-before', money)
    controls = run('absent-spin-controls-before', control)
    probe('absent-spin-before-exact-refusal', service + abort(), error='F06_ABORT_COMMITTED_OR_DISPATCHED')
    for label, change, error in (
        ('wrong-predecessor', 'ALTER FUNCTION fn_f06_abort_mixed_unsettled_generation(uuid,jsonb) SET search_path=pg_catalog;', 'F06_SPIN_PRIOR_AUTHORITY_CHANGED'),
        ('source-guard', 'ALTER FUNCTION smarter_private.f06_source_guard() SET search_path=public;', 'F06_SPIN_PRIOR_AUTHORITY_CHANGED')):
        run('interrupted-custody-install-refuses-' + label, 'BEGIN;' + change + migration.read_text(), error=error)
    run('interrupted-custody-install', migration.read_text())
    require(run('absent-spin-install-originals-unchanged', money) == before, 'Install changed original custody')
    require(run('absent-spin-install-controls-unchanged', control) == controls, 'Install changed controls')
    probe('absent-spin-after-exact-rollback', service + abort())
    probe('earlier-mtt-after-53-exact-rollback', service + mtt_abort())
    for label, change, error in (
        ('browser', 'SET ROLE authenticated;', '42501'),
        ('actor', "SET app.smarter_data_actor='browser';", 'F06_ABORT_SERVICE_REQUIRED'),
        ('kind-required', "UPDATE fixture_expected_inputs SET expected=expected #- '{hands,0,interruption,kind}' WHERE i=1101;", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('dispatch-missing', "DELETE FROM smarter_private.f06_hand_dispatch WHERE permit_id=md5('absent-spin1101-permit')::uuid;", 'F06_SPIN_ABSENT_ORIGINAL_DISPATCH_REQUIRED'),
        ('dispatch-live', "UPDATE smarter_private.f06_hand_dispatch SET xid=txid_current() WHERE permit_id=md5('absent-spin1101-permit')::uuid;", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('refusal-missing', "DELETE FROM financial_alerts WHERE id=md5('absent-refusal1101')::uuid;", 'F06_SPIN_ORIGINAL_REFUSAL_CHANGED'),
        ('refusal-identity', "UPDATE financial_alerts SET context=jsonb_set(context,'{hand_request_identity_v1,hand_number}','12429074') WHERE id=md5('absent-refusal1101')::uuid;", 'F06_SPIN_ORIGINAL_REFUSAL_CHANGED'),
        ('refusal-error', "UPDATE financial_alerts SET context=jsonb_set(context,'{error}','\"unrelated\"') WHERE id=md5('absent-refusal1101')::uuid;", 'F06_SPIN_ORIGINAL_REFUSAL_CHANGED'),
        ('card-missing', "DELETE FROM table_hole_cards WHERE id=md5('absent-card1101:1')::uuid;", 'F06_SPIN_ABSENT_CARDS_CHANGED'),
        ('card-duplicate-user', "ALTER TABLE table_hole_cards DROP CONSTRAINT table_hole_cards_table_id_hand_number_user_id_key;UPDATE table_hole_cards SET user_id=md5('absent-spin1101-user2')::uuid WHERE id=md5('absent-card1101:1')::uuid;", 'F06_SPIN_ABSENT_CARDS_CHANGED'),
        ('card-duplicate-seat', "UPDATE table_hole_cards SET seat_number=2 WHERE id=md5('absent-card1101:1')::uuid;", 'F06_SPIN_ABSENT_CARDS_CHANGED'),
        ('card-wrong-user', "UPDATE table_hole_cards SET user_id=gen_random_uuid() WHERE id=md5('absent-card1101:1')::uuid;", 'F06_SPIN_ABSENT_CARDS_CHANGED'),
        ('card-hash', "UPDATE table_hole_cards SET cards='[\"Qh\",\"Jd\"]' WHERE id=md5('absent-card1101:1')::uuid;", 'F06_ABORT_EXPECTED_CHANGED'),
        ('later-card', "INSERT INTO table_hole_cards(table_id,hand_number,user_id,seat_number) VALUES(md5('absent-spin1101-table')::uuid,12429076,md5('absent-spin1101-user1')::uuid,1);", 'F06_SPIN_PRIOR_LATER_CUSTODY'),
        ('snapshot-now-present', "INSERT INTO hand_state_snapshots(table_id,hand_number,is_complete) VALUES(md5('absent-spin1101-table')::uuid,12429075,true);", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('later-snapshot', "INSERT INTO hand_state_snapshots(table_id,hand_number,is_complete) VALUES(md5('absent-spin1101-table')::uuid,12429076,true);", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('later-private', "INSERT INTO hand_private_state VALUES(md5('absent-spin1101-table')::uuid,12429075);", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('later-outbox', "INSERT INTO hand_projection_outbox VALUES(md5('absent-attempt1101')::uuid,md5('absent-spin1101-table')::uuid,12429075,now());", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('orphan-money', "INSERT INTO ca_settlements(settlement_type,external_ref,state,table_id,hand_id) VALUES('hand_stacks','absent-orphan','final',md5('absent-spin1101-table')::uuid,gen_random_uuid());", 'F06_SPIN_FINANCIAL_BOUNDARY_CHANGED'),
        ('financial-result', "UPDATE settlement_idempotency_keys SET result='{}' WHERE table_id=md5('absent-spin1101-table')::uuid;", 'F06_SPIN_FINANCIAL_BOUNDARY_CHANGED'),
        ('prior-unfinished', "UPDATE hand_atomic_commits SET post_commit_completed_at=NULL WHERE table_id=md5('absent-spin1101-table')::uuid;", 'F06_SPIN_FINANCIAL_BOUNDARY_CHANGED'),
        ('wrong-generation', "UPDATE engine_tournament_leases SET lease_generation=gen_random_uuid() WHERE tournament_id=md5('absent-spin1101')::uuid;", 'F06_GENERATION_LEASE_CHANGED')):
        probe('absent-spin-refuses-' + label, service + change + abort(), error=error)
    key = " WHERE table_id=md5('cm-table1201')::uuid AND hand_id=md5('cm-earlier-hand1201:1')::uuid;"
    for label, change in (
        ('nonnumeric-hand', "UPDATE settlement_idempotency_keys SET result=jsonb_set(result,'{hand_number}','\"unknown\"')" + key),
        ('current-hand', "UPDATE settlement_idempotency_keys SET result=jsonb_set(result,'{hand_number}','12636137')" + key),
        ('later-hand', "UPDATE settlement_idempotency_keys SET result=jsonb_set(result,'{hand_number}','12636138')" + key),
        ('wrong-hand', "UPDATE settlement_idempotency_keys SET result=jsonb_set(result,'{hand_id}',to_jsonb(gen_random_uuid()))" + key),
        ('wrong-table', "UPDATE settlement_idempotency_keys SET result=jsonb_set(result,'{table_id}',to_jsonb(gen_random_uuid()))" + key),
        ('not-success', "UPDATE settlement_idempotency_keys SET result=jsonb_set(result,'{success}','false')" + key),
        ('not-conserved', "UPDATE settlement_idempotency_keys SET result=jsonb_set(result,'{conservation_checked}','false')" + key),
        ('rake', "UPDATE settlement_idempotency_keys SET result=jsonb_set(result,'{rake}','1')" + key),
        ('inflow', "UPDATE settlement_idempotency_keys SET result=jsonb_set(result,'{inflow}','1')" + key),
        ('error', "UPDATE settlement_idempotency_keys SET error='failed'" + key),
        ('missing-time', "UPDATE settlement_idempotency_keys SET completed_at=NULL" + key),
        ('reversed-time', "UPDATE settlement_idempotency_keys SET completed_at=first_attempt_at-interval '1 second'" + key),
        ('after-paid', "UPDATE settlement_idempotency_keys SET last_attempt_at='2026-09-18 12:46:56+00'" + key),
        ('infinite-time', "UPDATE settlement_idempotency_keys SET first_attempt_at='-infinity'" + key),
        ('nonfinal', "WITH old AS(DELETE FROM ca_settlements" + key.rstrip(';') + " RETURNING *) INSERT INTO ca_settlements SELECT (jsonb_populate_record(NULL::ca_settlements,to_jsonb(old)||'{\"state\":\"failed\"}'::jsonb)).* FROM old;"),
        ('settlement-error', "UPDATE ca_settlements SET error_detail='failed'" + key),
        ('settlement-reference', "UPDATE ca_settlements SET external_ref='wrong'" + key),
        ('settlement-key', "UPDATE ca_settlements SET idempotency_key='wrong'" + key),
        ('settlement-totals', "UPDATE ca_settlements SET totals=jsonb_set(totals,'{players}','3')" + key),
        ('settlement-time', "UPDATE ca_settlements SET updated_at='2026-09-18 12:46:56+00'" + key),
        ('orphan-key', "DELETE FROM ca_settlements" + key),
        ('orphan-settlement', "DELETE FROM settlement_idempotency_keys" + key),
        ('present-canonical-mismatch', "INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,stack_result) VALUES(md5('cm-table1201')::uuid,8563188,md5('earlier-bad-canonical')::uuid,jsonb_build_object('hand_id',md5('cm-earlier-hand1201:1')::uuid));")):
        probe('earlier-mtt-refuses-' + label, service + change + mtt_abort(), error='F06_COMPLETED_MTT_FINANCIAL_BOUNDARY_CHANGED')
    probe('earlier-mtt-binds-full-key-hash', service + "UPDATE settlement_idempotency_keys SET attempt_count=2" + key + mtt_abort(), error='F06_ABORT_EXPECTED_CHANGED')
    probe('earlier-mtt-binds-full-settlement-hash', service + "UPDATE ca_settlements SET correlation_id=gen_random_uuid()" + key + mtt_abort(), error='F06_ABORT_EXPECTED_CHANGED')
    require(run('absent-spin-refusals-originals-unchanged', money) == before, 'Refusal leaked original changes')
    require(run('absent-spin-refusals-controls-unchanged', control) == controls, 'Refusal leaked disposition')
    run('interrupted-custody-active-fixture', 'SELECT fixture_seed_mixed(1119);')
    probe('interrupted-custody-active-preserved', service + "SELECT fn_f06_abort_mixed_unsettled_generation(md5('absent-active')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=1119));")
    run('interrupted-custody-completed-fixture', 'SELECT fixture_seed_completed_mtt(1118);INSERT INTO fixture_expected_inputs VALUES(1118,fixture_completed_mtt_expected(1118));')
    probe('interrupted-custody-completed-preserved', service + "SELECT fn_f06_abort_mixed_unsettled_generation(md5('absent-completed')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=1118));")
    before = run('absent-spin-final-originals-before', money)

    @contextmanager
    def held(sql, finish='ROLLBACK'):
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            p.stdin.write('BEGIN;' + sql + 'SELECT pg_advisory_lock(18154419);\n'); p.stdin.flush()
            deadline = time.monotonic() + 5
            while command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=18154419 AND granted);").stdout.strip() != 't':
                require(p.poll() is None and time.monotonic() < deadline, 'Original custody holder missed real barrier')
                time.sleep(.01)
            yield
        finally:
            if p.poll() is None:
                p.stdin.write(finish + ';\n'); p.stdin.close(); p.wait(timeout=6)
            require(p.returncode == 0, p.stderr.read())

    atomic = "INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,post_commit_completed_at,post_commit_result) VALUES(md5('absent-spin1101-table')::uuid,12429075,md5('absent-accepted')::uuid,now(),'{\"ok\":true}');"
    with held(service + abort(), finish='COMMIT'):
        probe('absent-spin-disposition-first-blocks-atomic', atomic, error='F06_RETRY_CANONICAL_LANE')
        probe('absent-spin-same-operation-waits', "SET LOCAL lock_timeout='150ms';" + service + abort(), error='55P03')
        probe('absent-spin-different-operation-waits', "SET LOCAL lock_timeout='150ms';" + service + abort(receipt=1199), error='55P03')
    run('absent-spin-identical-replay', service + abort())
    probe('absent-spin-changed-replay', service + "UPDATE fixture_expected_inputs SET expected=expected #- '{hands,0,interruption,cards}' WHERE i=1101;" + abort(), error='F06_ABORT_CHANGED_REPLAY')
    probe('absent-spin-different-operation-refused', service + abort(receipt=1199), error='F06_GENERATION_LEASE_CHANGED')
    probe('absent-spin-late-atomic-refused', atomic, error='F06_ABORTED_HAND_FENCED')
    require(run('absent-spin-originals-byte-identical', money) == before, 'Disposition rewrote original records')
    run('absent-spin-truthful-outcome', "SELECT state||'|'||(SELECT count(*) FROM smarter_private.f06_mixed_abort_generations WHERE tournament_id=md5('absent-spin1101')::uuid)||'|'||(SELECT count(*) FROM engine_tournament_leases WHERE tournament_id=md5('absent-spin1101')::uuid) FROM smarter_private.f06_hand_permits WHERE permit_id=md5('absent-spin1101-permit')::uuid;", 'aborted_unsettled|2|0')
    run('absent-spin-no-fictitious-hand', "SELECT count(*) FROM smarter_private.f06_mixed_abort_hands WHERE permit_id=md5('absent-spin1101-permit')::uuid AND snapshot_id IS NULL AND prior_hand_id=md5('absent-spin1101-atomic')::uuid AND expected#>>'{interruption,kind}'='snapshot_absent_unaccepted_spin' AND jsonb_array_length(expected#>'{interruption,cards}')=3;", '1')
    for g in ('old', 'current'):
        run('absent-spin-permanent-generation-' + g, "SELECT granted FROM claim_tournament_lease_v2(md5('absent-spin1101')::uuid,'late','qualified',md5('absent-spin1101-%s')::uuid);" % g, 'f')
        headers = "SET request.jwt.claims='{\"role\":\"service_role\"}';SELECT set_config('request.headers',jsonb_build_object('x-smarter-data-actor','tournament-manager','x-smarter-data-protocol','2','x-smarter-tournament-id',md5('absent-spin1101')::uuid,'x-smarter-tournament-lease-generation',md5('absent-spin1101-%s')::uuid)::text,true);SET request.method='POST';SELECT smarter_private.fn_smarter_data_api_pre_request();" % g
        probe('absent-spin-late-request-' + g, headers, error='42501')
    # The actual row lock must hold a concurrent mutation out until the owning
    # event can compare its retained whole-row hash. A final state alone is not
    # an immutable-table guarantee.
    with held("UPDATE settlement_idempotency_keys SET attempt_count=2" + key):
        probe('earlier-mtt-drains-key-writer', "SET LOCAL lock_timeout='150ms';" + service + mtt_abort(), error='55P03')
    with held("UPDATE ca_settlements SET correlation_id=gen_random_uuid()" + key):
        probe('earlier-mtt-drains-receipt-writer', "SET LOCAL lock_timeout='150ms';" + service + mtt_abort(), error='55P03')
    earlier_before = run('earlier-mtt-final-originals-before', money)
    run('earlier-mtt-53-truthful-commit', service + mtt_abort())
    run('earlier-mtt-53-identical-replay', service + mtt_abort())
    require(run('earlier-mtt-53-originals-byte-identical', money) == earlier_before, 'Earlier receipt disposition rewrote originals')
    run('earlier-mtt-no-reconstructed-canonical', "SELECT (SELECT count(*) FROM hand_atomic_commits WHERE table_id=md5('cm-table1201')::uuid)||'|'||(SELECT count(*) FROM hand_history WHERE table_id=md5('cm-table1201')::uuid)||'|'||(SELECT count(*) FROM settlement_idempotency_keys WHERE table_id=md5('cm-table1201')::uuid)||'|'||(SELECT count(*) FROM ca_settlements WHERE table_id=md5('cm-table1201')::uuid);", '0|0|53|53')
    seed(1102)
    with held(atomic.replace('1101', '1102'), finish='COMMIT'):
        probe('absent-spin-accepted-first-drains-abort', service + abort(1102), error='F06_RETRY_CANONICAL_LANE')
    probe('absent-spin-accepted-wins-permanently', service + abort(1102), error='F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED')
    results['interruptedCustodyPostimage'] = json.loads(run('interrupted-custody-final-postimage', "SELECT jsonb_build_object('definition',pg_get_functiondef(p.oid),'definition_md5',md5(pg_get_functiondef(p.oid)),'source_md5',md5(p.prosrc),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl,'config',p.proconfig) FROM pg_proc p WHERE oid='fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)'::regprocedure;"))
    results['interruptedCustody'] = {'passed': True, 'credit': 0, 'originalRecordsPreserved': True,
                                   'physicalProcessRetirement': 'Separate production-owner prerequisite; not certified by fixture'}
