"""Original unresolved snapshots survive the existing retention owner."""
from contextlib import contextmanager
import hashlib
import json
import subprocess
import time


def qualify(root, out, cmd, command, run, probe, require, results):
    here = root / 'scripts/ci/probes/f06-shared-hand-lane'
    migration = root / 'supabase/migrations/20260918230713_unresolved_hand_permits_retain_their_original_snapshots.sql'
    captured = json.loads((here / 'snapshot-retention-preimage.json').read_text())
    require(results.get('interruptedCustody', {}).get('passed') is True,
            'Original interrupted custody predecessor did not qualify')
    results['snapshotRetentionInputs'] = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in (migration, here / 'snapshot-retention-preimage.json',
                  here / 'snapshot_retention_qualification.py', root / 'scripts/ci/test-f06-shared-hand-lane.py')}
    service = "SET request.jwt.claims='{\"role\":\"service_role\"}';SET app.smarter_data_actor='service';"
    run('snapshot-retention-original-pruner', captured['pruner'] +
        ";REVOKE ALL ON FUNCTION public.sp_prune_hand_state_snapshots(integer) FROM PUBLIC,anon,authenticated;"
        "GRANT EXECUTE ON FUNCTION public.sp_prune_hand_state_snapshots(integer) TO service_role;")
    run('snapshot-retention-exact-preimage',
        "SELECT md5(pg_get_functiondef('public.sp_prune_hand_state_snapshots(integer)'::regprocedure));",
        '098d76207f7f8fbcea3cc30ea06f36fd')

    def seed(i):
        run('snapshot-retention-original-' + str(i),
            f"SELECT fixture_seed_completed_mtt({i});"
            f"UPDATE hand_state_snapshots SET created_at=now()-interval '7 hours' WHERE id=md5('cm-snapshot{i}')::uuid;"
            f"INSERT INTO fixture_expected_inputs VALUES({i},fixture_completed_mtt_expected({i}));")

    def abort(i=1301):
        return (f"SELECT fn_f06_abort_mixed_unsettled_generation(md5('retention-receipt{i}')::uuid,"
                f"(SELECT expected FROM fixture_expected_inputs WHERE i={i}));")

    def exists(i=1301):
        return f"SELECT EXISTS(SELECT 1 FROM hand_state_snapshots WHERE id=md5('cm-snapshot{i}')::uuid);"

    seed(1301)
    # This expectation asserts the real defect before installing the correction:
    # the old pruner removes the witness even though its permit remains reserved.
    probe('snapshot-retention-old-deletes-unresolved',
        "SELECT sp_prune_hand_state_snapshots(1) >= 0;" + exists(), 't\nf')
    probe('snapshot-retention-original-disposition-valid', service + abort())
    for name, sql in (
        ('acl', 'GRANT EXECUTE ON FUNCTION public.sp_prune_hand_state_snapshots(integer) TO authenticated;'),
        ('config', 'ALTER FUNCTION public.sp_prune_hand_state_snapshots(integer) SET search_path=pg_catalog;')):
        run('snapshot-retention-refuses-' + name, 'BEGIN;' + sql + migration.read_text(),
            error='F06_SNAPSHOT_RETENTION_PREIMAGE_CHANGED')
    original = run('snapshot-retention-original-before',
        "SELECT md5(to_jsonb(s)::text) FROM hand_state_snapshots s WHERE id=md5('cm-snapshot1301')::uuid;")
    money = """SELECT jsonb_build_object(
        'seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s),
        'roster',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM tournament_players s),
        'paid',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM tournament_paid_stack_custody_receipts s),
        'financial',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM ca_settlements s),
        'ledger',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM fixture_ledger s));"""
    before = run('snapshot-retention-money-before', money)
    run('snapshot-retention-install', migration.read_text())
    run('snapshot-retention-exact-postimage',
        "SELECT md5(pg_get_functiondef('public.sp_prune_hand_state_snapshots(integer)'::regprocedure));",
        'ee1166d02463fdec606f82eb5f27534d')
    run('snapshot-retention-prune-unresolved', "SELECT sp_prune_hand_state_snapshots(1) >= 0;" + exists(), 't\nt')
    require(run('snapshot-retention-original-after',
        "SELECT md5(to_jsonb(s)::text) FROM hand_state_snapshots s WHERE id=md5('cm-snapshot1301')::uuid;") == original,
        'Pruning changed the original witness')
    require(run('snapshot-retention-money-after', money) == before, 'Retention changed player or financial state')
    probe('snapshot-retention-still-disposable-by-original-owner', service + abort())
    probe('snapshot-retention-browser-execution-refused', 'SET ROLE authenticated;SELECT sp_prune_hand_state_snapshots(1);', error='42501')
    probe('snapshot-retention-anon-execution-refused', 'SET ROLE anon;SELECT sp_prune_hand_state_snapshots(1);', error='42501')

    seed(1302)
    run('snapshot-retention-old-incomplete-seed',
        "UPDATE hand_state_snapshots SET is_complete=false,created_at=now()-interval '31 days' WHERE id=md5('cm-snapshot1302')::uuid;")
    run('snapshot-retention-old-incomplete-retained',
        "SELECT sp_prune_hand_state_snapshots(1) >= 0;" + exists(1302), 't\nt')
    # Ordinary retention keeps the original age boundaries. A matching table
    # alone must not protect a different hand, nor a resolved permit.
    seed(1303)
    run('snapshot-retention-accepted-control',
        "UPDATE smarter_private.f06_hand_permits SET state='accepted' WHERE permit_id=md5('cm-permit1303')::uuid;")
    run('snapshot-retention-age-controls', """
        INSERT INTO hand_state_snapshots(id,table_id,hand_number,is_complete,created_at) VALUES
        (md5('retention-expired')::uuid,md5('cm-table1301')::uuid,12636136,true,now()-interval '7 hours'),
        (md5('retention-fresh')::uuid,md5('retention-fresh-table')::uuid,1,true,now()-interval '5 hours'),
        (md5('retention-expired-incomplete')::uuid,md5('retention-expired-incomplete-table')::uuid,1,false,now()-interval '31 days'),
        (md5('retention-fresh-incomplete')::uuid,md5('retention-fresh-incomplete-table')::uuid,1,false,now()-interval '29 days');
    """)
    run('snapshot-retention-normal-prune', 'SELECT sp_prune_hand_state_snapshots(1) >= 0;', 't')
    run('snapshot-retention-normal-outcomes', """
        SELECT EXISTS(SELECT 1 FROM hand_state_snapshots WHERE id=md5('retention-expired')::uuid)::text||'|'||
        EXISTS(SELECT 1 FROM hand_state_snapshots WHERE id=md5('retention-fresh')::uuid)::text||'|'||
        EXISTS(SELECT 1 FROM hand_state_snapshots WHERE id=md5('retention-expired-incomplete')::uuid)::text||'|'||
        EXISTS(SELECT 1 FROM hand_state_snapshots WHERE id=md5('retention-fresh-incomplete')::uuid)::text||'|'||
        EXISTS(SELECT 1 FROM hand_state_snapshots WHERE id=md5('cm-snapshot1303')::uuid)::text;
    """, 'false|true|false|true|false')

    @contextmanager
    def held(sql, finish='ROLLBACK'):
        process = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            process.stdin.write('BEGIN;' + sql + 'SELECT pg_advisory_lock(18230713);\n')
            process.stdin.flush()
            deadline = time.monotonic() + 5
            while command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=18230713 AND granted);").stdout.strip() != 't':
                require(process.poll() is None and time.monotonic() < deadline, 'Retention holder missed real barrier')
                time.sleep(.01)
            yield
        finally:
            if process.poll() is None:
                process.stdin.write(finish + ';\n')
                process.stdin.close()
                process.wait(timeout=6)
            require(process.returncode == 0, process.stderr.read())

    # The uncommitted terminal permit is still reserved for the pruner. It
    # keeps the original without waiting on, or obstructing, the disposition.
    with held(service + abort(), finish='ROLLBACK'):
        probe('snapshot-retention-concurrent-disposition-retains',
            "SET LOCAL statement_timeout='1s';SELECT sp_prune_hand_state_snapshots(1) >= 0;" + exists(), 't\nt')
    run('snapshot-retention-aborted-disposition-retains', exists(), 't')
    final_before = run('snapshot-retention-final-money-before', money)
    with held(service + abort(), finish='COMMIT'):
        probe('snapshot-retention-before-disposition-commit-retains',
            "SET LOCAL statement_timeout='1s';SELECT sp_prune_hand_state_snapshots(1) >= 0;" + exists(), 't\nt')
    run('snapshot-retention-resolved-permit',
        "SELECT state FROM smarter_private.f06_hand_permits WHERE permit_id=md5('cm-permit1301')::uuid;", 'aborted_unsettled')
    run('snapshot-retention-after-disposition-prunes',
        "SELECT sp_prune_hand_state_snapshots(1) >= 0;" + exists(), 't\nf')
    require(run('snapshot-retention-final-money-after', money) == final_before,
        'Disposition/pruning changed original paid custody or financial records')
    results['snapshotRetention'] = {'passed': True, 'oldPrunerDeletedUnresolvedWitness': True,
        'reservedCompletedRetained': True, 'reservedIncompleteRetained': True,
        'ordinaryAgeBoundariesPreserved': True, 'concurrentDispositionRetainedUntilCommit': True,
        'originalPaidCustodyUnchanged': True, 'postimageMd5': 'ee1166d02463fdec606f82eb5f27534d',
        'productionMutation': False}
