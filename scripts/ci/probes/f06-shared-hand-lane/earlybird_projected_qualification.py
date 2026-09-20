"""One source-bound historical projection in the existing native F06 fixture."""
from contextlib import contextmanager
import hashlib
import json
import runpy
import subprocess
import time


def qualify(root, out, cmd, command, run, probe, require, results):
    here = root / 'scripts/ci/probes/f06-shared-hand-lane'
    builder = runpy.run_path(str(here / 'build-earlybird-projected-migration.py'))
    migration = root / builder['MIGRATION']
    require(migration.read_text() == builder['render'](), 'Original projected migration/source differ')
    require(results.get('snapshotRetention', {}).get('passed') is True, 'Retention prevention did not qualify')
    witness = json.loads((here / builder['WITNESS']).read_text())
    inputs = [migration, root / builder['PREDECESSOR'], root / 'scripts/ci/test-f06-shared-hand-lane.py']
    inputs += [here / n for n in ('build-earlybird-projected-migration.py', builder['WITNESS'],
                                  'earlybird-projected-fixture.sql', 'earlybird_projected_qualification.py')]
    results['earlybirdProjectedInputs'] = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
    run('earlybird-projected-exact-predecessor', "SELECT md5(pg_get_functiondef('fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)'::regprocedure));", '483b508311d233d3da73e55db17499ce')
    run('earlybird-projected-fixture', (here / 'earlybird-projected-fixture.sql').read_text().replace('__WITNESS_JSON__', json.dumps(witness)))
    earlier = (here / 'completed-mtt-earlier-receipts-fixture.sql').read_text()
    earlier = earlier.replace('fixture_seed_completed_mtt_earlier_receipts', 'fixture_seed_pruned_earlybird_earlier')
    earlier = earlier.replace("tab uuid:=md5('cm-table'||i)::uuid", "tab uuid:='f2ad5d92-6640-4e14-acd0-555222be14fe'")
    run('earlybird-projected-earlier-fixture', earlier)
    run('earlybird-projected-original-opening', 'SELECT fixture_seed_pruned_earlybird();SELECT fixture_seed_pruned_earlybird_earlier(1401);INSERT INTO fixture_expected_inputs VALUES(1401,fixture_pruned_earlybird_expected());')
    service = "SET request.jwt.claims='{\"role\":\"service_role\"}';SET app.smarter_data_actor='service';"
    event = "'a5aa6984-6c1c-4b59-aeb7-9e7878853bdd'::uuid"
    table = "'f2ad5d92-6640-4e14-acd0-555222be14fe'::uuid"
    permit = "'332ef667-03f4-40cf-bd0a-15503ef80a47'::uuid"
    original_generation = "'b16bba80-2454-46d6-a80b-372bdcd93b0f'::uuid"

    def abort(receipt='earlybird-projected-receipt'):
        return f"SELECT fn_f06_abort_mixed_unsettled_generation(md5('{receipt}')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=1401));"

    def change(path, value):
        return "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{" + path + "}','" + value.replace("'", "''") + "'::jsonb) WHERE i=1401;"

    money = "SELECT jsonb_build_object(" + ','.join("'%s',(SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('row_xmin',xmin::text) ORDER BY %s) FROM %s x)" % (name, order, relation) for name, relation, order in (
        ('seats','table_seats','id'),('roster','tournament_players','id'),('cards','table_hole_cards','id'),
        ('paid','tournament_paid_stack_custody_receipts','id'),('snapshots','hand_state_snapshots','id'),
        ('atomic','hand_atomic_commits','hand_id'),('history','hand_history','id'),
        ('settlements','ca_settlements','id'),('keys','settlement_idempotency_keys','table_id,hand_id'),
        ('outbox','hand_projection_outbox','hand_id'),('submissions','smarter_private.hand_submissions','submission_id'),
        ('ledger','fixture_ledger','id'))) + ');'
    controls = "SELECT jsonb_build_object(" + ','.join("'%s',(SELECT jsonb_agg(to_jsonb(x) ORDER BY %s) FROM %s x)" % (name, order, relation) for name, relation, order in (
        ('leases','engine_tournament_leases','tournament_id'),('permits','smarter_private.f06_hand_permits','permit_id'),
        ('receipts','smarter_private.f06_mixed_aborts','receipt_id'),('fences','smarter_private.f06_mixed_abort_generations','tournament_id,generation'),
        ('hands','smarter_private.f06_mixed_abort_hands','permit_id'),('dispositions','smarter_private.hand_submission_dispositions','table_id,hand_number'))) + ');'
    before = run('earlybird-projected-originals-before', money)
    custody = run('earlybird-projected-controls-before', controls)
    probe('earlybird-projected-before-original-kind-refused', service + change('hands,0,interruption,kind', '"completed_unaccepted_mtt"') + abort(), error='F06_COMPLETED_MTT_SNAPSHOT_CHANGED')
    probe('earlybird-projected-before-new-kind-refused', service + abort(), error='F06_MIXED_PRIOR_IDENTITY')
    for label, drift, error in (
        ('predecessor', 'ALTER FUNCTION fn_f06_abort_mixed_unsettled_generation(uuid,jsonb) SET search_path=pg_catalog;', 'F06_SPIN_PRIOR_AUTHORITY_CHANGED'),
        ('paid-guard', 'ALTER FUNCTION fn_ca_guard_original_paid_stack_receipt() SET search_path=public;', 'F06_COMPLETED_MTT_PAID_AUTHORITY_CHANGED'),
        ('submission-fence', 'ALTER TABLE smarter_private.hand_submission_dispositions DISABLE TRIGGER hand_submission_disposition_immutable;', 'F06_SPIN_RETENTION_BINDING_CHANGED')):
        run('earlybird-projected-install-refuses-' + label, 'BEGIN;' + drift + migration.read_text(), error=error)
    run('earlybird-projected-install', migration.read_text())
    require(run('earlybird-projected-install-no-money', money) == before, 'Install changed original records')
    require(run('earlybird-projected-install-no-custody', controls) == custody, 'Install changed custody')
    probe('earlybird-projected-after-exact-zero-credit', service + abort())
    expected_literal = run('earlybird-projected-service-input', 'SELECT expected FROM fixture_expected_inputs WHERE i=1401;').replace("'", "''")
    probe('earlybird-projected-real-service-role', service + "SET ROLE service_role;SELECT fn_f06_abort_mixed_unsettled_generation(md5('earlybird-role')::uuid,'" + expected_literal + "'::jsonb);")
    for label, path, value in (
        ('source-hash','source_raw_sha256','"altered"'),
        ('capture-time','observed_at','"2026-09-18T23:00:00Z"'),
        ('full-row-claim','full_snapshot_row_available','true'),
        ('historical-row-hash','snapshot,row_hash','"altered"'),
        ('stage','snapshot,stage','"flop"'),
        ('state-stage','snapshot,state_stage','"flop"'),
        ('action-count','snapshot,action_count','1'),
        ('pot','snapshot,pot','26313'),
        ('players','snapshot,players','[]'),
        ('investment','snapshot,players,1,totalInvested','23813'),
        ('permit','original_permit,hand_number','12636138')):
        probe('earlybird-projected-refuses-' + label, service + change('hands,0,interruption,snapshot_witness,' + path, value) + abort(), error='F06_EARLYBIRD_ORIGINAL_WITNESS_CHANGED')
    for label, sql, error in (
        ('browser','SET ROLE authenticated;', '42501'),
        ('anon','SET ROLE anon;', '42501'),
        ('actor',"SET app.smarter_data_actor='browser';", 'F06_ABORT_SERVICE_REQUIRED'),
        ('platform-freeze',"INSERT INTO engine_maintenance_break VALUES(true,now()-interval '3 minutes','last_hand',NULL,NULL);",'PLATFORM_FROZEN'),
        ('whole-reserved-set',change('hands','[]'),'F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED'),
        ('generation',f'UPDATE engine_tournament_leases SET lease_generation=gen_random_uuid() WHERE tournament_id={event};','F06_GENERATION_LEASE_CHANGED'),
        ('permit-custody',f'UPDATE smarter_private.f06_hand_permits SET custody_id=gen_random_uuid() WHERE permit_id={permit};','F06_HAND_IDENTITY_IMMUTABLE'),
        ('cards-missing',f'DELETE FROM table_hole_cards WHERE table_id={table} AND seat_number=1;','F06_COMPLETED_MTT_CARDS_CHANGED'),
        ('cards-changed',f"UPDATE table_hole_cards SET cards='[\"Qh\",\"Jd\"]' WHERE table_id={table} AND seat_number=1;",'F06_ABORT_EXPECTED_CHANGED'),
        ('registration-hash',f'UPDATE tournament_players SET id=gen_random_uuid() WHERE tournament_id={event} AND seat_number=1;','F06_ABORT_EXPECTED_CHANGED'),
        ('saved-stack',f'UPDATE table_seats SET stack=stack+1 WHERE table_id={table} AND seat_number=1;UPDATE tournament_players SET chips=chips+1 WHERE tournament_id={event} AND seat_number=1;','F06_ABORT_SAVED_STACKS_CHANGED'),
        ('paid-identity',change('hands,0,interruption,paid_receipt_id','"00000000-0000-4000-8000-000000000001"'),'F06_EARLYBIRD_ORIGINAL_WITNESS_CHANGED'),
        ('paid-hash',change('hands,0,interruption,paid_receipt_hash','"changed"'),'F06_ABORT_EXPECTED_CHANGED'),
        ('snapshot-present',f'INSERT INTO hand_state_snapshots(table_id,hand_number,is_complete) VALUES({table},12636137,false);','F06_EARLYBIRD_ORIGINAL_WITNESS_CHANGED'),
        ('later-snapshot',f'INSERT INTO hand_state_snapshots(table_id,hand_number,is_complete) VALUES({table},12636138,false);','F06_EARLYBIRD_ORIGINAL_WITNESS_CHANGED'),
        ('private',f'INSERT INTO hand_private_state VALUES({table},12636137);','F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('dispatch',f'INSERT INTO smarter_private.f06_hand_dispatch VALUES({permit},txid_current());','F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('history',f'INSERT INTO hand_history(table_id,hand_number) VALUES({table},12636138);','F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('outbox',f'INSERT INTO hand_projection_outbox VALUES(gen_random_uuid(),{table},12636137,now());','F06_COMPLETED_MTT_LATER_CUSTODY'),
        ('later-card',f'INSERT INTO table_hole_cards(table_id,hand_number,user_id,seat_number) VALUES({table},12636138,gen_random_uuid(),1);','F06_COMPLETED_MTT_LATER_CUSTODY'),
        ('orphan-money',f"INSERT INTO ca_settlements(settlement_type,external_ref,state,table_id,hand_id) VALUES('hand_stacks','eb-orphan','final',{table},gen_random_uuid());",'F06_COMPLETED_MTT_FINANCIAL_BOUNDARY_CHANGED'),
        ('earlier-key-result',f"UPDATE settlement_idempotency_keys SET result=jsonb_set(result,'{{hand_number}}','12636137') WHERE table_id={table};",'F06_COMPLETED_MTT_FINANCIAL_BOUNDARY_CHANGED'),
        ('earlier-key-hash',f'UPDATE settlement_idempotency_keys SET attempt_count=attempt_count+1 WHERE table_id={table};','F06_ABORT_EXPECTED_CHANGED'),
        ('earlier-settlement-hash',f'UPDATE ca_settlements SET correlation_id=gen_random_uuid() WHERE table_id={table};','F06_ABORT_EXPECTED_CHANGED'),
    ):
        probe('earlybird-projected-refuses-' + label, service + sql + abort(), error=error)
    require(run('earlybird-projected-refusals-no-money', money) == before, 'Refusal changed original records')
    require(run('earlybird-projected-refusals-no-custody', controls) == custody, 'Refusal leaked custody')
    # The ordinary active and completed paths still consume their real rows.
    run('earlybird-projected-existing-completed-opening', 'SELECT fixture_seed_completed_mtt(1501);SELECT fixture_seed_completed_mtt_earlier_receipts(1501);INSERT INTO fixture_expected_inputs VALUES(1501,fixture_completed_mtt_expected(1501));')
    normal = "SELECT fn_f06_abort_mixed_unsettled_generation(md5('eb-existing-completed')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=1501));"
    probe('earlybird-projected-existing-completed-preserved', service + normal)
    probe('earlybird-projected-no-generic-missing-fallback', service + "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{hands,0,interruption,kind}','\"pruned_completed_unaccepted_mtt\"') WHERE i=1501;" + normal, error='F06_EARLYBIRD_ORIGINAL_WITNESS_CHANGED')
    probe('earlybird-projected-existing-active-preserved', service + "SELECT fn_f06_abort_mixed_unsettled_generation(md5('eb-existing-active')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=1119));")

    @contextmanager
    def held(sql, finish='ROLLBACK'):
        process = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            process.stdin.write('BEGIN;' + sql + 'SELECT pg_advisory_lock(18232101);\n'); process.stdin.flush()
            deadline = time.monotonic() + 5
            while command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=18232101 AND granted);").stdout.strip() != 't':
                require(process.poll() is None and time.monotonic() < deadline, 'Projected witness holder missed actual barrier')
                time.sleep(.01)
            yield
        finally:
            if process.poll() is None:
                process.stdin.write(finish + ';\n'); process.stdin.close(); process.wait(timeout=6)
            require(process.returncode == 0, process.stderr.read())

    atomic = f"INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,post_commit_completed_at,post_commit_result) VALUES({table},12636137,md5('eb-atomic')::uuid,now(),'{{\"ok\":true}}');"
    retain = f"""SELECT fn_ca_retain_hand_submission(jsonb_build_object(
        'p_table_id',{table},'p_hand_number',12636137,
        'p_hand_row',jsonb_build_object('id',md5('eb-attempt')::uuid,'table_id',{table},'hand_number',12636137),
        'p_stacks',(SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,
        'stack',stack,'stack_before',stack) ORDER BY user_id) FROM table_seats WHERE table_id={table}),
        'p_rake',0,'p_bbj',0,'p_ref','synthetic-original-request','p_inflow',0,'p_units','[]'::jsonb,
        'p_post_commit_obligations',jsonb_build_object('version',1),
        'p_instance_id','cm-current','p_lease_generation',{original_generation}));"""
    # Each alternate order uses a clone of this same qualified native database,
    # retaining identical production constants without weakening the authority.
    source_database = cmd[-1]
    for order in ('accepted', 'retained'):
        database = 'earlybird_' + order
        administration = cmd[:-1] + ['template1']
        copied = command(administration, f'CREATE DATABASE {database} TEMPLATE "' + source_database.replace('"', '""') + '";')
        require(copied.returncode == 0, copied.stderr)
        cmd[-1] = database
        try:
            if order == 'accepted':
                with held(atomic, finish='COMMIT'):
                    probe('earlybird-projected-accepted-first-drains', service + abort(), error='F06_RETRY_CANONICAL_LANE')
                probe('earlybird-projected-accepted-remains-authoritative', service + abort(), error='F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED')
            else:
                run('earlybird-projected-retention-identity', f'UPDATE engine_tournament_leases SET lease_generation={original_generation} WHERE tournament_id={event};UPDATE fixture_expected_inputs SET expected=fixture_pruned_earlybird_expected() WHERE i=1401;')
                with held(service + retain, finish='COMMIT'):
                    probe('earlybird-projected-retained-first-drains', "SET LOCAL lock_timeout='150ms';" + service + abort(), error='55P03')
                probe('earlybird-projected-retained-remains-authoritative', service + abort(), error='F06_COMPLETED_MTT_LATER_CUSTODY')
        finally:
            cmd[-1] = source_database
            dropped = command(administration, f'DROP DATABASE {database};')
            require(dropped.returncode == 0, dropped.stderr)
    with held(f'UPDATE settlement_idempotency_keys SET attempt_count=attempt_count+1 WHERE table_id={table};'):
        probe('earlybird-projected-drains-financial-writer', "SET LOCAL lock_timeout='150ms';" + service + abort(), error='55P03')
    final_before = run('earlybird-projected-final-originals-before', money)
    with held(service + abort(), finish='COMMIT'):
        probe('earlybird-projected-disposition-first-blocks-atomic', atomic, error='F06_RETRY_CANONICAL_LANE')
        probe('earlybird-projected-disposition-first-blocks-submission', "SET LOCAL lock_timeout='150ms';" + service + retain, error='55P03')
        probe('earlybird-projected-same-operation-waits', "SET LOCAL lock_timeout='150ms';" + service + abort(), error='55P03')
        probe('earlybird-projected-other-operation-waits', "SET LOCAL lock_timeout='150ms';" + service + abort('earlybird-other'), error='55P03')
    # Simulate a lost response: first read the durable receipt, then repeat the
    # same operation identity. The original payment/records must remain exact.
    run('earlybird-projected-unknown-outcome-readback', "SELECT outcome FROM smarter_private.f06_mixed_aborts WHERE receipt_id=md5('earlybird-projected-receipt')::uuid;", 'aborted_unsettled')
    run('earlybird-projected-identical-replay', service + abort())
    probe('earlybird-projected-changed-replay-refused', service + change('hands,0,snapshot_hash','"altered"') + abort(), error='F06_ABORT_CHANGED_REPLAY')
    probe('earlybird-projected-other-operation-refused', service + abort('earlybird-other'), error='F06_GENERATION_LEASE_CHANGED')
    probe('earlybird-projected-late-atomic-refused', atomic, error='F06_ABORTED_HAND_FENCED')
    probe('earlybird-projected-late-submission-refused', service + retain, error='HAND_SUBMISSION_PERMIT_FENCED')
    require(run('earlybird-projected-originals-byte-identical', money) == final_before, 'Disposition changed original payment or records')
    run('earlybird-projected-truthful-receipt', f"SELECT snapshot_id::text||'|'||(expected#>>'{{interruption,kind}}')||'|'||(SELECT count(*) FROM hand_state_snapshots WHERE table_id={table})||'|'||(SELECT count(*) FROM ca_settlements WHERE table_id={table})||'|'||(SELECT count(*) FROM settlement_idempotency_keys WHERE table_id={table}) FROM smarter_private.f06_mixed_abort_hands WHERE permit_id={permit};", 'e7cf319f-2911-40e5-9544-a434f5bf8982|pruned_completed_unaccepted_mtt|0|53|53')
    run('earlybird-projected-terminal-custody', f"SELECT state||'|'||(SELECT count(*) FROM smarter_private.f06_mixed_abort_generations WHERE tournament_id={event})||'|'||(SELECT count(*) FROM engine_tournament_leases WHERE tournament_id={event}) FROM smarter_private.f06_hand_permits WHERE permit_id={permit};", 'aborted_unsettled|2|0')
    for label, generation in (('original', original_generation), ('current', "md5('eb-current')::uuid")):
        run('earlybird-projected-old-generation-fenced-' + label, f"SELECT granted FROM claim_tournament_lease_v2({event},'late','qualified',{generation});", 'f')
    run('earlybird-projected-new-owner-admitted', f"SELECT granted FROM claim_tournament_lease_v2({event},'new-natural-owner','qualified',md5('eb-fresh')::uuid);", 't')
    results['earlybirdProjectedPostimage'] = json.loads(run('earlybird-projected-final-postimage', "SELECT jsonb_build_object('definition',pg_get_functiondef(p.oid),'definition_md5',md5(pg_get_functiondef(p.oid)),'source_md5',md5(p.prosrc),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl,'config',p.proconfig) FROM pg_proc p WHERE oid='fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)'::regprocedure;"))
    results['earlybirdProjected'] = {'passed': True, 'credit': 0, 'snapshotReconstructed': False,
        'sourceBoundOriginalProjection': True, 'originalPaidCustodyAnd53ReceiptsUnchanged': True,
        'bothRaceOrders': ['atomic acceptance', 'retained submission'],
        'scope': 'Isolated synthetic dependencies; original provenance and physical retirement require separate production-owner proof'}
