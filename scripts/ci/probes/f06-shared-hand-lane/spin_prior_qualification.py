"""Prior-backed Spin disposition in the maintained c8fe/0443 native owner."""
from contextlib import contextmanager
import hashlib
import json
import re
import runpy
import subprocess
import time


def qualify(root, out, cmd, command, run, probe, require, results):
    here = root / 'scripts/ci/probes/f06-shared-hand-lane'
    require(results.get('preparedCancellation', {}).get('passed') is True,
            'Spin prior qualification requires current preparation guards')
    builder = runpy.run_path(str(here / 'build-spin-prior-migration.py'))
    migration = root / builder['MIGRATION']
    require(migration.read_text() == builder['render'](), 'Spin migration/source differ')
    inputs = [here / name for name in ('build-spin-prior-migration.py', 'spin-prior-boundary.sql',
              'spin-prior-current-guard.sql', 'spin-prior-fixture.sql', 'spin_prior_qualification.py',
              'spin-prior-ended-dispatch.sql', 'spin-prior-refusal-preimages.json', 'spin-prior-current-journal.sql',
              'spin-prior-continuation-dependency.sql', 'spin-prior-continuation-postimages.json')]
    candidate_source = root / 'supabase/migrations/20260908042100_an_accepted_hand_is_one_commit_and_stats_leave_the_hot_path.sql'
    submission_source = here / 'spin-prior-retention-prefix.sql'
    epochs_source = root / 'supabase/migrations/20260831143501_ca_ledger_hardening.sql'
    settlements_source = root / 'supabase/migrations/20260831145242_ca_quick_reconcile_and_settlements.sql'
    keys_source = root / 'supabase/migrations/20260428000003_settlement_idempotency_keys.sql'
    require(submission_source.is_file(), 'The owning retained-submission source must be integrated before qualification')
    inputs += [migration, candidate_source, submission_source, epochs_source, settlements_source, keys_source, root / 'scripts/ci/test-f06-shared-hand-lane.py']
    results['spinPriorInputs'] = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
    candidate_ddl = candidate_source.read_text()
    candidate_ddl = candidate_ddl[candidate_ddl.index('CREATE TABLE IF NOT EXISTS public.tournament_knockout_candidates'):candidate_ddl.index('-- The optimized three-argument')]
    run('spin-current-elimination-dependent-table', candidate_ddl)
    original_hand = candidate_source.read_text()
    run('spin-original-projection-outbox', original_hand[original_hand.index('CREATE TABLE IF NOT EXISTS public.hand_projection_outbox'):original_hand.index('-- This is the durable proof')])
    epochs = epochs_source.read_text()
    run('spin-original-financial-epoch-default', epochs[epochs.index('CREATE TABLE IF NOT EXISTS public.ca_financial_epochs'):epochs.index('-- ── Maintenance mutation log')])
    settlements = settlements_source.read_text()
    run('spin-original-settlement-receipt-table', settlements[:settlements.index('-- ── 2. Chip-supply')])
    run('spin-original-stack-idempotency-table', keys_source.read_text())
    for row in json.loads((here / 'spin-prior-refusal-preimages.json').read_text()):
        sig = row['identity'] if '.' in row['identity'].split('(')[0] else 'public.' + row['identity']
        if 'fn_ca_commit_hand_settlement_' in sig or 'fn_engine_lease_stale_seconds' in sig:
            run('spin-returned-refusal-core-' + sig.split('(')[0], row['definition'] + ';\nREVOKE ALL ON FUNCTION ' + sig + ' FROM PUBLIC,anon,authenticated,service_role;')
        run('spin-returned-refusal-preimage-' + sig.split('(')[0], "SELECT md5(pg_get_functiondef('%s'::regprocedure));" % sig, row['definition_md5'])
    run('spin-current-elimination-source-guard', (here / 'spin-prior-current-guard.sql').read_text())
    run('spin-current-elimination-guard-postimage', "SELECT md5(pg_get_functiondef('smarter_private.f06_source_guard()'::regprocedure));", 'de1b25f96d2c08bf20213c0e194ae261')
    continuation = json.loads((here / 'spin-prior-continuation-postimages.json').read_text())
    require(hashlib.sha256((here / 'spin-prior-continuation-dependency.sql').read_bytes()).hexdigest() ==
            continuation['source_sha256'], 'Sealed continuation dependency changed')
    if results.get('noStartContinuation', {}).get('passed') is not True:
        # Standalone predecessor qualification still installs its sealed source.
        run('spin-current-continuation-guards', (here / 'spin-prior-continuation-dependency.sql').read_text())
    else:
        # The composed owner already installed and exercised this same authority.
        # Never recreate its private receipt relation or replace tested bindings.
        observed = {r['signature']: r for r in results['noStartContinuationPostimages']}
        require(observed == {r['signature']: r for r in continuation['functions']},
                'Qualified continuation postimages differ from Spin dependencies')
    for row in continuation['functions']:
        actual = json.loads(run('spin-continuation-postimage-' + row['signature'].split('(')[0],
            "SELECT jsonb_build_object('signature',oid::regprocedure::text,'full_md5',md5(pg_get_functiondef(oid)),'body_md5',md5(prosrc),'owner',pg_get_userbyid(proowner),'acl',proacl::text,'security_definer',prosecdef,'config',proconfig) FROM pg_proc WHERE oid='%s'::regprocedure;" % row['signature']))
        require(actual == row, 'Current continuation dependency changed: ' + row['signature'])
    results['spinContinuationComposition'] = {
        'reusedQualifiedOwner': results.get('noStartContinuation', {}).get('passed') is True,
        'verifiedFunctions': len(continuation['functions']),
    }
    # Exact sealed prefix from its owner. Financial acceptance below the original
    # source marker is separately qualified; no substitute adapter is installed.
    submission_prefix = submission_source.read_text()
    require(hashlib.sha256(submission_source.read_bytes()).hexdigest() ==
            '0423ccbfe95f8ef980bc0699ca3ad873648e2dc620b9d1418ab08faf1343af9d',
            'Sealed retained-submission source changed')
    run('spin-evidence-fixture', (here / 'spin-prior-fixture.sql').read_text())

    # Reuse the existing full prior-atomic fixture with synthetic identities.
    # Both the three-chair and two-survivor boundaries retain 3000 chips.
    source = (here / 'mixed-fixture.sql').read_text()
    seed_source = source[source.index('CREATE FUNCTION fixture_seed_mixed_hu()'):]

    def seed(i, snapshot=True, seats=(1, 2, 3), same_generation=False):
        prefix = 'spin-prior' + str(i)
        count = len(seats)
        seat_array = 'ARRAY[' + ','.join(map(str, seats)) + ']'
        sql = seed_source.replace('fixture_seed_mixed_hu()', 'fixture_seed_spin_prior' + str(i) + '()')
        sql = sql.replace('mixed-hu', prefix).replace("'sng-v1',2,2", "'spin-v1',3,3")
        sql = sql.replace("tab,t,'running',2", "tab,t,'running',3").replace('1..2 LOOP', '1..%d LOOP' % count)
        sql = sql.replace('CASE j WHEN 1 THEN 377 ELSE 223 END', '(ARRAY[970,1030,1000])[j]' if count == 3 else '(ARRAY[2248,752])[j]')
        sql = sql.replace('tab,u,j,st', 'tab,u,(' + seat_array + ')[j],st')
        sql = sql.replace("'players',2,'tournament_player_count',2", "'players',%d,'tournament_player_count',%d" % (count, count))
        if count == 2:
            sql = sql.replace(' END LOOP;', " END LOOP;\n INSERT INTO tournament_players VALUES(md5('PREFIX-registration3')::uuid,t,tab,md5('PREFIX-user3')::uuid,%d,0,'eliminated');".replace('PREFIX', prefix) % (6 - sum(seats)))
        sql = sql.replace('VALUES(361,', 'VALUES(' + str(i) + ',')
        if same_generation:
            sql = sql.replace("md5('%s-old')" % prefix, "md5('%s-current')" % prefix)
        sql += '\nSELECT fixture_seed_spin_prior' + str(i) + '();\n'
        if snapshot:
            sql += """INSERT INTO hand_state_snapshots(id,table_id,hand_number,is_complete,state_json,stage)
              SELECT md5('PREFIX-snapshot')::uuid,md5('PREFIX-table')::uuid,12429075,true,
                jsonb_build_object('stage','preflop','pot',30,'players',jsonb_agg(jsonb_build_object(
                  'user_id',user_id,'seat',seat_number,'stack',stack-CASE seat_number WHEN 1 THEN 10 WHEN 2 THEN 20 ELSE 0 END,
                  'totalInvested',CASE seat_number WHEN 1 THEN 10 WHEN 2 THEN 20 ELSE 0 END))), 'preflop'
              FROM table_seats WHERE table_id=md5('PREFIX-table')::uuid;
              INSERT INTO financial_alerts(id,source,context,message,severity)
              VALUES(md5('PREFIX-refusal')::uuid,'ServerTableEngine.authoritative_hand_semantic_refusal',
                jsonb_build_object('table_id',md5('PREFIX-table')::uuid,'hand_number',12429075,
                  'channel','server_rpc','error','atomic hand commit refused (atomic_hand_rolled_back): cannot find parent statement on pldbgapi2 call stack',
                  'hand_request_identity_v1',jsonb_build_object('hand_id',md5('PREFIX-attempt')::uuid,
                    'table_id',md5('PREFIX-table')::uuid,'hand_number',12429075,'version',1,'post_commit_required',true)),
                'The actual atomic attempt refused; no downstream money step ran','critical');
            """.replace('PREFIX', prefix)
        sql += refresh(i)
        return sql

    def refresh(i=701):
        return "UPDATE fixture_expected_inputs SET expected=fixture_spin_prior_expected(md5('spin-prior%d')::uuid) WHERE i=%d;" % (i, i)

    def abort(i=701, legacy=False):
        expression = "expected #- '{hands,0,interruption}'" if legacy else 'expected'
        return "SELECT fn_f06_abort_mixed_unsettled_generation(md5('spin-prior-receipt%d')::uuid,(SELECT %s FROM fixture_expected_inputs WHERE i=%d));" % (i, expression, i)

    def retain(i):
        return """SELECT fn_ca_retain_hand_submission(jsonb_build_object(
          'p_table_id',md5('PREFIX-table')::uuid,'p_hand_number',12429075,
          'p_hand_row',jsonb_build_object('id',md5('PREFIX-attempt')::uuid,
             'table_id',md5('PREFIX-table')::uuid,'hand_number',12429075),
          'p_stacks',(SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,
             'seat_joined_at',joined_at,'stack',stack,'stack_before',stack) ORDER BY user_id)
             FROM table_seats WHERE table_id=md5('PREFIX-table')::uuid AND left_at IS NULL),
          'p_rake',0,'p_bbj',0,'p_ref','original-native-request','p_inflow',0,
          'p_units','[]'::jsonb,'p_post_commit_obligations',jsonb_build_object('version',1),
          'p_instance_id',instance_id,'p_lease_generation',lease_generation))
          FROM engine_tournament_leases WHERE tournament_id=md5('PREFIX')::uuid;""".replace('PREFIX','spin-prior' + str(i))

    service = "SET request.jwt.claims='{\"role\":\"service_role\"}';SET app.smarter_data_actor='service';"
    money = """SELECT jsonb_build_object(
      'seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s),
      'roster',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM tournament_players p),
      'atomic',(SELECT jsonb_agg(to_jsonb(a) ORDER BY table_id,hand_number) FROM hand_atomic_commits a),
      'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY table_id,hand_number) FROM hand_history h),
      'ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM fixture_ledger l),
      'snapshots',(SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('row_xmin',xmin::text) ORDER BY id) FROM hand_state_snapshots s),
      'alerts',(SELECT jsonb_agg(to_jsonb(a)||jsonb_build_object('row_xmin',xmin::text) ORDER BY id) FROM financial_alerts a),
      'dispatch',(SELECT jsonb_agg(to_jsonb(d)||jsonb_build_object('row_xmin',xmin::text) ORDER BY permit_id) FROM smarter_private.f06_hand_dispatch d),
      'submission_dispatch',(SELECT jsonb_agg(to_jsonb(d) ORDER BY transaction_id,submission_id) FROM smarter_private.hand_submission_dispatch d),
      'submissions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY submission_id) FROM smarter_private.hand_submissions s),
      'settlements',(SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('row_xmin',xmin::text) ORDER BY id) FROM ca_settlements s),
      'settlement_keys',(SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('row_xmin',xmin::text) ORDER BY table_id,hand_id) FROM settlement_idempotency_keys s),
      'outbox',(SELECT jsonb_agg(to_jsonb(o) ORDER BY hand_id) FROM hand_projection_outbox o));"""
    control = """SELECT jsonb_build_object(
      'leases',(SELECT jsonb_agg(to_jsonb(l) ORDER BY tournament_id) FROM engine_tournament_leases l),
      'permits',(SELECT jsonb_agg(to_jsonb(p) ORDER BY permit_id) FROM smarter_private.f06_hand_permits p),
      'parks',(SELECT jsonb_agg(to_jsonb(o) ORDER BY break_id) FROM smarter_private.f06_operations o),
      'headers',(SELECT jsonb_agg(to_jsonb(a) ORDER BY receipt_id) FROM smarter_private.f06_mixed_aborts a),
      'fences',(SELECT jsonb_agg(to_jsonb(a) ORDER BY tournament_id,generation) FROM smarter_private.f06_mixed_abort_generations a),
      'continuations',(SELECT jsonb_agg(to_jsonb(a) ORDER BY receipt_id) FROM smarter_private.f06_no_start_continuations a),
      'submission_dispositions',(SELECT jsonb_agg(to_jsonb(a) ORDER BY table_id,hand_number) FROM smarter_private.hand_submission_dispositions a),
      'children',(SELECT jsonb_agg(to_jsonb(a) ORDER BY permit_id) FROM smarter_private.f06_mixed_abort_hands a));"""
    run('spin-prior-three-chair-opening', seed(701))
    # These are retained pre-upgrade completed snapshots. Installing the new
    # snapshot guard must not backdate a submission disposition for either.
    run('spin-prior-legacy-ended-dispatch-opening', seed(704))
    run('spin-actual-original-submission-retention', submission_prefix)
    run('spin-current-journal-successor-overlay', builder['current_journal_overlay']())
    run('spin-current-journal-exact-installed-helper', "SELECT md5(pg_get_functiondef('smarter_private.assert_retained_hand_submission(jsonb)'::regprocedure));", '6a3ab631fdab87ae9bcd353907de80b6')
    # Individual MTT antes are already part of both dead and total investment,
    # as persisted by HandController.postBlinds. Never credit them a second time.
    run('mtt-ante-original-opening', "SELECT fixture_seed_mixed(707);")
    ante_setup = """UPDATE hand_state_snapshots s SET state_json=jsonb_set(jsonb_set(state_json,'{players}',
      (SELECT jsonb_agg(jsonb_set(jsonb_set(jsonb_set(jsonb_set(x,'{stack}',to_jsonb((x->>'stack')::numeric-20)),
        '{totalInvested}',to_jsonb((x->>'totalInvested')::numeric+20)),
        '{deadInvested}',to_jsonb(COALESCE((x->>'deadInvested')::numeric,0)+20)),
        '{individualAnteInvested}','20') ORDER BY x->>'user_id') FROM jsonb_array_elements(state_json->'players') x)),
      '{pot}',to_jsonb((state_json->>'pot')::numeric+20*jsonb_array_length(state_json->'players')))
      WHERE table_id=md5('mtab707:2')::uuid;
      UPDATE fixture_expected_inputs SET expected=fixture_expected_mixed(md5('mt707')::uuid) WHERE i=707;"""
    run('mtt-ante-original-investment', ante_setup)
    ante_abort = "SELECT fn_f06_abort_mixed_unsettled_generation(md5('mtt-ante-receipt707')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=707));"
    probe('mtt-ante-existing-zero-only-refuses', service + ante_abort, error='F06_ABORT_SAVED_STACKS_CHANGED')
    before = run('spin-prior-original-money', money)
    control_before = run('spin-prior-original-control', control)
    probe('spin-prior-baseline-excluded', service + abort(legacy=True), error='F06_MIXED_BOUNDARIES_REQUIRED')
    for label, change, error in [
        ('function', 'ALTER FUNCTION fn_f06_abort_mixed_unsettled_generation(uuid,jsonb) SET search_path=pg_catalog;', 'F06_SPIN_PRIOR_AUTHORITY_CHANGED'),
        ('guard-acl', 'GRANT EXECUTE ON FUNCTION smarter_private.f06_source_guard() TO authenticated;', 'F06_SPIN_PRIOR_AUTHORITY_CHANGED'),
        ('prepared-body', 'ALTER FUNCTION smarter_private.f06_cancelled_preparation_writer_guard() SET search_path=pg_catalog;', 'F06_SPIN_PRIOR_AUTHORITY_CHANGED'),
        ('guard-binding', 'ALTER TABLE table_seats DISABLE TRIGGER a00_f06_source_seat;', 'F06_SPIN_PRIOR_BINDING_CHANGED'),
        ('guard-columns', 'DROP TRIGGER a00_f06_source_seat ON table_seats;CREATE TRIGGER a00_f06_source_seat BEFORE INSERT OR DELETE OR UPDATE OF table_id ON table_seats FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard();', 'F06_SPIN_PRIOR_BINDING_CHANGED'),
        ('occupancy-binding', 'ALTER TABLE table_seats DISABLE TRIGGER zzz_stamp_seat_occupancy;', 'F06_SPIN_PRIOR_OCCUPANCY_CHANGED'),
        ('retention-binding', 'ALTER TABLE smarter_private.f06_hand_permits DISABLE TRIGGER f06_retained_submission_guard;', 'F06_SPIN_RETENTION_BINDING_CHANGED'),
        ('retention-authority', 'ALTER FUNCTION smarter_private.f06_retained_submission_guard() SET search_path=public;', 'F06_SPIN_RETENTION_AUTHORITY_CHANGED'),
        ('retention-legacy-helper', re.search(r'CREATE FUNCTION smarter_private.assert_retained_hand_submission\(.*?\$function\$;', submission_prefix, re.S)[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION', 1), 'F06_SPIN_RETENTION_AUTHORITY_CHANGED'),
        ('retention-dispatch-acl', 'GRANT SELECT ON smarter_private.hand_submission_dispatch TO service_role;', 'F06_SPIN_DEPENDENCY_SCHEMA_CHANGED'),
        ('retention-dispatch-identity', 'ALTER TABLE smarter_private.hand_submission_dispatch DROP CONSTRAINT hand_submission_dispatch_pkey;', 'F06_SPIN_DEPENDENCY_SCHEMA_CHANGED'),
        ('retention-unique-fence', 'ALTER TABLE smarter_private.hand_submission_dispositions DROP CONSTRAINT hand_submission_dispositions_pkey;', 'F06_SPIN_DEPENDENCY_SCHEMA_CHANGED'),
    ]:
        run('spin-prior-install-refuses-' + label, 'BEGIN;' + change + migration.read_text(), error=error)
    run('spin-prior-install', migration.read_text())
    require(run('spin-prior-install-no-money', money) == before, 'Installation changed money/evidence')
    require(run('spin-prior-install-no-control', control) == control_before, 'Installation changed runtime state')
    ante_success = """DO $ante$ DECLARE receipt jsonb; BEGIN
      receipt:=fn_f06_abort_mixed_unsettled_generation(md5('mtt-ante-receipt707')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=707));
      IF receipt->>'credit' IS DISTINCT FROM '0' OR receipt->>'outcome' IS DISTINCT FROM 'aborted_unsettled' THEN
        RAISE EXCEPTION 'Individual ante disposition changed its monetary contract'; END IF;
      END $ante$;
      SELECT count(*) FROM smarter_private.f06_mixed_abort_hands WHERE receipt_id=md5('mtt-ante-receipt707')::uuid;"""
    probe('mtt-ante-truthful-zero-credit-rollback', service + ante_success, '2')
    for label, value in [('negative', '-1'), ('above-dead', '999999'), ('nonfinite', '"NaN"')]:
        change = "UPDATE hand_state_snapshots SET state_json=jsonb_set(state_json,'{players,0,individualAnteInvested}','%s'::jsonb) WHERE table_id=md5('mtab707:2')::uuid;UPDATE fixture_expected_inputs SET expected=fixture_expected_mixed(md5('mt707')::uuid) WHERE i=707;" % value
        probe('mtt-ante-' + label + '-refused', service + change + ante_abort, error='F06_ABORT_SAVED_STACKS_CHANGED')
    require(run('mtt-ante-probes-preserve-money', money) == before, 'Ante disposition credited or rewrote original money')
    require(run('mtt-ante-probes-preserve-control', control) == control_before, 'Ante rollback leaked control changes')
    probe('spin-prior-new-exact-rollback', service + abort())
    probe('spin-prior-old-abi-zero-effect', service + abort(legacy=True), error='F06_ABORT_EXPECTED_CHANGED')
    changes = [
        ('browser', 'SET ROLE authenticated;', '42501'),
        ('wrong-actor', "SET app.smarter_data_actor='tournament-manager';", 'F06_ABORT_SERVICE_REQUIRED'),
        ('wrong-table-size', "UPDATE tournaments SET table_size=2 WHERE id=md5('spin-prior701')::uuid;", 'F06_SPIN_PRIOR_SCOPE_CHANGED'),
        ('wrong-capacity', "UPDATE tables SET max_players=2 WHERE id=md5('spin-prior701-table')::uuid;", 'F06_SPIN_PRIOR_SCOPE_CHANGED'),
        ('prior-incomplete', "UPDATE hand_atomic_commits SET post_commit_completed_at=NULL WHERE table_id=md5('spin-prior701-table')::uuid;", 'F06_MIXED_PRIOR_INCOMPLETE'),
        ('prior-payload-drift', "UPDATE hand_atomic_commits SET post_commit_payload='{}' WHERE table_id=md5('spin-prior701-table')::uuid;", 'F06_MIXED_PRIOR_POSTCOMMIT_SEAL'),
        ('prior-stack-drift', "UPDATE table_seats SET stack=stack+1 WHERE table_id=md5('spin-prior701-table')::uuid;UPDATE tournament_players SET chips=chips+1 WHERE table_id=md5('spin-prior701-table')::uuid;" + refresh(), 'F06_MIXED_PRIOR_ROSTER_CHANGED'),
        ('original-registration-drift', "UPDATE tournament_players SET id=gen_random_uuid() WHERE table_id=md5('spin-prior701-table')::uuid;", 'F06_ABORT_EXPECTED_CHANGED'),
        ('original-snapshot-drift', "UPDATE hand_state_snapshots SET state_json='{}' WHERE id=md5('spin-prior701-snapshot')::uuid;", 'F06_ABORT_EXPECTED_CHANGED'),
        ('original-refusal-drift', "UPDATE financial_alerts SET message='changed' WHERE id=md5('spin-prior701-refusal')::uuid;", 'F06_ABORT_EXPECTED_CHANGED'),
        ('later-private', "INSERT INTO hand_private_state VALUES(md5('spin-prior701-table')::uuid,12429075);", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('dispatch', "INSERT INTO smarter_private.f06_hand_dispatch VALUES(md5('spin-prior701-permit')::uuid,txid_current());", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('later-history', "INSERT INTO hand_history(table_id,hand_number) VALUES(md5('spin-prior701-table')::uuid,12429075);", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('later-snapshot', "INSERT INTO hand_state_snapshots(table_id,hand_number,is_complete) VALUES(md5('spin-prior701-table')::uuid,12429076,true);", 'F06_SPIN_PRIOR_LATER_CUSTODY'),
        ('private-cards', "INSERT INTO table_hole_cards(table_id,hand_number,user_id,seat_number) VALUES(md5('spin-prior701-table')::uuid,12429075,md5('spin-prior701-user1')::uuid,1);", 'F06_SPIN_PRIOR_LATER_CUSTODY'),
        ('active-snapshot', "UPDATE hand_state_snapshots SET is_complete=false WHERE id=md5('spin-prior701-snapshot')::uuid;", 'F06_ABORT_EXPECTED_CHANGED'),
    ]
    for label, change, error in changes:
        probe('spin-prior-refuses-' + label, service + change + abort(), error=error)
    require(run('spin-prior-all-refusals-preserve-money', money) == before, 'Refusal leaked monetary/evidence writes')
    require(run('spin-prior-all-refusals-preserve-control', control) == control_before, 'Refusal leaked control writes')

    @contextmanager
    def held(sql, finish='ROLLBACK'):
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        p.stdin.write('BEGIN;' + sql + 'SELECT pg_advisory_lock(180992117);\n'); p.stdin.flush()
        deadline = time.monotonic() + 5
        while command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=180992117 AND granted);").stdout.strip() != 't':
            require(p.poll() is None and time.monotonic() < deadline, 'Spin holder did not reach actual barrier')
            time.sleep(.01)
        try:
            yield
        finally:
            p.stdin.write(finish + ';\n'); p.stdin.close(); p.wait(timeout=6)
            require(p.returncode == 0, p.stderr.read())

    current_lease = "SELECT 1 FROM engine_tournament_leases WHERE tournament_id=md5('spin-prior701')::uuid FOR KEY SHARE;"
    with held(current_lease):
        probe('spin-prior-drains-current-writer', "SET LOCAL lock_timeout='150ms';" + service + abort(), error='55P03')
    target_atomic = "INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,post_commit_completed_at,post_commit_result) VALUES(md5('spin-prior701-table')::uuid,12429075,md5('spin-accepted')::uuid,now(),'{\"ok\":true}');"
    with held(service + abort(), finish='COMMIT'):
        probe('spin-prior-abort-first-refuses-atomic', target_atomic, error='F06_RETRY_CANONICAL_LANE')
        probe('spin-prior-concurrent-duplicate-waits', "SET LOCAL lock_timeout='150ms';" + service + abort(), error='55P03')
    probe('spin-prior-durable-abort-fences-atomic', target_atomic, error='F06_ABORTED_HAND_FENCED')
    run('spin-prior-exact-replay', service + abort())
    probe('spin-prior-changed-replay', service + "UPDATE fixture_expected_inputs SET expected=expected #- '{hands,0,interruption}';" + abort(), error='F06_ABORT_CHANGED_REPLAY')
    require(run('spin-prior-final-money-and-original-evidence', money) == before, 'Abort rewrote chips, prior hand or historical evidence')
    run('spin-prior-truthful-identity', """SELECT
      (SELECT state FROM smarter_private.f06_hand_permits WHERE permit_id=md5('spin-prior701-permit')::uuid)||'|'||
      (SELECT count(*) FROM smarter_private.f06_mixed_abort_generations WHERE tournament_id=md5('spin-prior701')::uuid)||'|'||
      (SELECT count(*) FROM smarter_private.f06_mixed_abort_hands WHERE permit_id=md5('spin-prior701-permit')::uuid AND snapshot_id IS NULL AND prior_hand_id=md5('spin-prior701-atomic')::uuid)||'|'||
      (SELECT count(*) FROM engine_tournament_leases WHERE tournament_id=md5('spin-prior701')::uuid);""", 'aborted_unsettled|2|1|0')
    for g in ('old', 'current'):
        run('spin-prior-permanent-fence-' + g, "SELECT granted FROM claim_tournament_lease_v2(md5('spin-prior701')::uuid,'late','old',md5('spin-prior701-%s')::uuid);" % g, 'f')
    run('spin-prior-commit-winner-opening', seed(702, snapshot=False, seats=(2, 3)))
    accepted_write = target_atomic.replace('spin-prior701', 'spin-prior702')
    with held(accepted_write, finish='COMMIT'):
        probe('spin-prior-accepted-first-refuses-abort', service + abort(702), error='F06_RETRY_CANONICAL_LANE')
    probe('spin-prior-accepted-durable-refuses-abort', service + abort(702), error='F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED')
    run('spin-prior-accepted-outcome-remains', "SELECT state||'|'||evidence_id::text FROM smarter_private.f06_hand_permits WHERE permit_id=md5('spin-prior702-permit')::uuid;", 'accepted|' + str(__import__('uuid').UUID(hashlib.md5(b'spin-accepted').hexdigest())))
    run('spin-prior-snapshotless-opening', seed(703, snapshot=False, seats=(1, 3)))
    no_snapshot_before = run('spin-prior-snapshotless-money-before', money)
    probe('spin-prior-two-survivors-eliminated-row-drift', service + "UPDATE tournament_players SET id=gen_random_uuid() WHERE id=md5('spin-prior703-registration3')::uuid;" + abort(703), error='F06_ABORT_EXPECTED_CHANGED')
    probe('spin-prior-two-survivors-eliminated-chips-refused', service + "UPDATE tournament_players SET chips=1 WHERE id=md5('spin-prior703-registration3')::uuid;" + refresh(703) + abort(703), error='F06_SPIN_PRIOR_SCOPE_CHANGED')
    run('spin-prior-snapshotless-truthful-abort', service + abort(703))
    require(run('spin-prior-snapshotless-no-fabrication', money) == no_snapshot_before, 'Snapshotless abort manufactured evidence')
    run('spin-prior-ended-original-financial-receipts', """INSERT INTO settlement_idempotency_keys(table_id,hand_id,status,result,completed_at)
      SELECT table_id,(stack_result->>'hand_id')::uuid,'succeeded',stack_result,committed_at FROM hand_atomic_commits WHERE table_id=md5('spin-prior704-table')::uuid;
      INSERT INTO ca_settlements(settlement_type,external_ref,state,table_id,hand_id)
      SELECT 'hand_stacks',table_id::text||':'||(stack_result->>'hand_id'),'final',table_id,(stack_result->>'hand_id')::uuid FROM hand_atomic_commits WHERE table_id=md5('spin-prior704-table')::uuid;""")
    run('spin-prior-commit-original-dispatch', "INSERT INTO smarter_private.f06_hand_dispatch VALUES(md5('spin-prior704-permit')::uuid,txid_current());")
    run('spin-prior-read-independent-original-records', refresh(704))
    ended_money = run('spin-prior-ended-original-rows-before', money)
    ended_control = run('spin-prior-ended-control-before', control)
    probe('spin-prior-in-progress-dispatch-refused', service + "UPDATE smarter_private.f06_hand_dispatch SET xid=txid_current() WHERE permit_id=md5('spin-prior704-permit')::uuid;" + refresh(704) + abort(704), error='F06_ABORT_COMMITTED_OR_DISPATCHED')
    probe('spin-prior-refusal-semantic-contract-refused', service + "UPDATE financial_alerts SET context=jsonb_set(context,'{error}','\"some unrelated diagnostic\"') WHERE id=md5('spin-prior704-refusal')::uuid;" + refresh(704) + abort(704), error='F06_SPIN_ORIGINAL_REFUSAL_CHANGED')
    probe('spin-prior-refusal-request-identity-refused', service + "UPDATE financial_alerts SET context=jsonb_set(context,'{hand_request_identity_v1,hand_number}','12429074') WHERE id=md5('spin-prior704-refusal')::uuid;" + refresh(704) + abort(704), error='F06_SPIN_ORIGINAL_REFUSAL_CHANGED')
    probe('spin-prior-refusal-pending-outbox-refused', service + "INSERT INTO hand_projection_outbox VALUES(md5('spin-prior704-attempt')::uuid,md5('spin-prior704-table')::uuid,12429075,now());" + abort(704), error='F06_ABORT_COMMITTED_OR_DISPATCHED')
    probe('spin-prior-unaccepted-financial-row-refused', service + "INSERT INTO ca_settlements(settlement_type,external_ref,state,table_id,hand_id) VALUES('hand_stacks','unaccepted-original','final',md5('spin-prior704-table')::uuid,gen_random_uuid());" + refresh(704) + abort(704), error='F06_SPIN_FINANCIAL_BOUNDARY_CHANGED')
    probe('spin-prior-financial-result-drift-refused', service + "UPDATE settlement_idempotency_keys SET result='{}' WHERE table_id=md5('spin-prior704-table')::uuid;" + refresh(704) + abort(704), error='F06_SPIN_FINANCIAL_BOUNDARY_CHANGED')
    require(run('spin-prior-ended-refusals-no-money-effect', money) == ended_money, 'Ended-dispatch refusal changed original state')
    require(run('spin-prior-ended-refusals-no-control-effect', control) == ended_control, 'Ended-dispatch refusal leaked fences')
    run('spin-prior-ended-dispatch-truthful-abort', service + abort(704))
    run('spin-prior-ended-dispatch-exact-replay', service + abort(704))
    require(run('spin-prior-ended-dispatch-originals-preserved', money) == ended_money, 'Ended-dispatch abort rewrote original records')
    run('spin-prior-ended-provenance-explicit', "SELECT expected#>>'{interruption,retired_dispatch,transaction_link_asserted}' FROM smarter_private.f06_mixed_abort_hands WHERE permit_id=md5('spin-prior704-permit')::uuid;", 'false')
    run('spin-prior-retention-race-opening', seed(705, snapshot=False, seats=(1, 3), same_generation=True))
    with held(service + retain(705), finish='COMMIT'):
        probe('spin-prior-retaining-writer-drained', "SET LOCAL lock_timeout='150ms';" + service + abort(705), error='55P03')
    run('spin-prior-retained-payload-exact-replay', service + retain(705))
    retained_request = "(SELECT request FROM smarter_private.hand_submissions WHERE table_id=md5('spin-prior705-table')::uuid)"
    successor_request = "(" + retained_request + "||jsonb_build_object('p_instance_id','qualified-successor','p_lease_generation',md5('qualified-successor')::uuid))"
    capability = """INSERT INTO smarter_private.hand_submission_dispatch
      SELECT txid_current(),submission_id,request_hash,'qualified-successor',md5('qualified-successor')::uuid
      FROM smarter_private.hand_submissions WHERE table_id=md5('spin-prior705-table')::uuid;"""
    check_successor = "SELECT smarter_private.assert_retained_hand_submission(" + successor_request + ");"
    probe('spin-journal-original-request-remains-valid', "SELECT smarter_private.assert_retained_hand_submission(" + retained_request + ");")
    probe('spin-journal-successor-without-capability-refused', check_successor, error='HAND_SUBMISSION_ORIGINAL_PAYLOAD_REQUIRED')
    probe('spin-journal-wrong-transaction-capability-refused', capability.replace('txid_current()', 'txid_current()-1') + check_successor, error='HAND_SUBMISSION_ORIGINAL_PAYLOAD_REQUIRED')
    probe('spin-journal-changed-payload-with-capability-refused', capability + "SELECT smarter_private.assert_retained_hand_submission(" + successor_request + "||jsonb_build_object('p_rake',1));", error='HAND_SUBMISSION_ORIGINAL_PAYLOAD_REQUIRED')
    probe('spin-journal-exact-successor-consumes-once', capability + check_successor + "SELECT count(*) FROM smarter_private.hand_submission_dispatch;", '\n0')
    probe('spin-journal-consumed-capability-reuse-refused', capability + check_successor + check_successor, error='HAND_SUBMISSION_ORIGINAL_PAYLOAD_REQUIRED')
    run('spin-journal-capability-probes-rolled-back', 'SELECT count(*) FROM smarter_private.hand_submission_dispatch;', '0')

    run('spin-prior-retained-original-generation-released', "SELECT release_tournament_leases_v2('spin-prior705-current',jsonb_build_array(jsonb_build_object('tournament_id',md5('spin-prior705')::uuid,'lease_generation',md5('spin-prior705-current')::uuid)));")
    run('spin-prior-retained-new-generation-claimed', "SELECT granted FROM claim_tournament_lease_v2(md5('spin-prior705')::uuid,'spin-prior705-successor','fixed',md5('spin-prior705-successor')::uuid);", 't')
    run('spin-prior-retained-new-generation-dto', refresh(705))
    retained_money = run('spin-prior-retained-before-refusal', money)
    retained_control = run('spin-prior-retained-control-before', control)
    probe('spin-prior-retained-original-blocks-successor-abort', service + abort(705), error='F06_SPIN_PRIOR_LATER_CUSTODY')
    require(run('spin-prior-retained-payload-preserved', money) == retained_money, 'Refusal rewrote retained request')
    require(run('spin-prior-retained-refusal-no-fences', control) == retained_control, 'Retained request refusal leaked fences')
    run('spin-prior-disposition-race-opening', seed(706, snapshot=False, seats=(2, 3), same_generation=True))
    with held(service + abort(706), finish='COMMIT'):
        probe('spin-prior-abort-first-drains-retainer', "SET LOCAL lock_timeout='150ms';" + service + retain(706), error='55P03')
    # The actual public retainer refuses a disposed permit before any lease
    # check. Supply the original request identity even after lease withdrawal.
    late = retain(706).replace('instance_id,\'p_lease_generation\',lease_generation', "'spin-prior706-current','p_lease_generation',md5('spin-prior706-current')::uuid")
    late = late.replace("FROM engine_tournament_leases WHERE tournament_id=md5('spin-prior706')::uuid", '')
    probe('spin-prior-abort-first-retained-request-refused', service + late, error='HAND_SUBMISSION_PERMIT_FENCED')
    results['spinRetentionPostimages'] = json.loads(run('spin-retention-final-postimages', "SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'definition_md5',md5(pg_get_functiondef(p.oid)),'source_md5',md5(p.prosrc),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl,'config',p.proconfig) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.oid IN ('smarter_private.hand_submission_immutable()'::regprocedure,'smarter_private.f06_retained_submission_guard()'::regprocedure,'smarter_private.hand_submission_snapshot_guard()'::regprocedure,'smarter_private.assert_retained_hand_submission(jsonb)'::regprocedure,'public.fn_ca_retain_hand_submission(jsonb)'::regprocedure);"))
    results['spinPriorPostimage'] = json.loads(run('spin-prior-final-postimage', "SELECT jsonb_build_object('signature',oid::regprocedure::text,'definition_md5',md5(pg_get_functiondef(oid)),'owner',pg_get_userbyid(proowner),'acl',proacl,'config',proconfig) FROM pg_proc WHERE oid='fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)'::regprocedure;"))
    results['spinPrior'] = {'passed': True, 'players': [2, 3], 'registrations': 3, 'chips': 3000, 'credit': 0,
                            'completedSnapshotUnchanged': True, 'atomicRefusalUnchanged': True,
                            'preparedGuard': 'c8fe5355', 'sourceCustodyGuard': '0443f6c9'}
