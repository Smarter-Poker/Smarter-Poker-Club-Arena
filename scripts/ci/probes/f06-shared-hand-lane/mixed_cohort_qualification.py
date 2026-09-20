"""Current/old MTT and Spin cohorts in the existing F06 gate."""
import hashlib
import subprocess
import time


def qualify(root, out, cmd, command, run, probe, require, results, held, money, service):
    here = root / 'scripts/ci/probes/f06-shared-hand-lane'
    paths = [here / 'mixed-cohort-fixtures.sql', here / 'mixed_cohort_qualification.py']
    results['mixedCohortInputs'] = {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths
    }
    run('mixed-cohort-seed', paths[0].read_text())

    def abort(i=201, receipt='mc-receipt'):
        return ("SELECT fn_f06_abort_mixed_unsettled_generation(md5('%s%d')::uuid,"
                "(SELECT expected FROM fixture_expected_inputs WHERE i=%d));") % (receipt, i, i)

    def refresh(i=201):
        return ("UPDATE fixture_expected_inputs SET expected=fixture_expected_mixed(md5('mct%d')::uuid)"
                " WHERE i=%d;") % (i, i)

    def request(g='mc-current201'):
        return """SET request.jwt.claims='{"role":"service_role"}';
        SELECT set_config('request.headers',jsonb_build_object('x-smarter-data-actor','tournament-manager',
          'x-smarter-data-protocol','2','x-smarter-tournament-id',md5('mct201')::uuid,
          'x-smarter-tournament-lease-generation',md5('%s')::uuid)::text,true);
        SET request.method='POST';SELECT smarter_private.fn_smarter_data_api_pre_request();""" % g

    before = run('mixed-cohort-money-before', money)
    accepted = """SELECT jsonb_build_object(
      'accepted',(SELECT jsonb_agg(p ORDER BY permit_id) FROM smarter_private.f06_hand_permits p
        WHERE tournament_id=md5('mct201')::uuid AND state='accepted'),
      'atomic',(SELECT jsonb_agg(c ORDER BY table_id,hand_number) FROM hand_atomic_commits c),
      'park',(SELECT to_jsonb(o) FROM smarter_private.f06_operations o WHERE break_id=md5('mcpark201')::uuid));"""
    accepted_before = run('mixed-cohort-accepted-before', accepted)
    probe('mixed-cohort-homogeneous-refuses-current-old', service + """SELECT fn_f06_abort_unsettled_generation(
      md5('counterfactual-mc')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=201));""",
      error='F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED')
    probe('mixed-cohort-browser-refused', 'SET ROLE authenticated;' + service + abort(), error='42501')
    current_snapshot = 'SELECT fixture_mixed_cohort_current_snapshot();'
    changes = [
        ('missing-old-hand', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{hands}',(expected->'hands')-0) WHERE i=201;", 'F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED'),
        ('duplicate-hand', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{hands}',(expected->'hands')||jsonb_build_array(expected->'hands'->0)) WHERE i=201;", 'F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED'),
        ('invented-generation', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{generations}',(expected->'generations')||jsonb_build_array(gen_random_uuid())) WHERE i=201;", 'F06_ABORT_EXPECTED_CHANGED'),
        ('missing-generation', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{generations}',(expected->'generations')-0) WHERE i=201;", 'F06_ABORT_EXPECTED_CHANGED'),
        ('new-lease-changed', "UPDATE engine_tournament_leases SET lease_generation=md5('mc-later')::uuid WHERE tournament_id=md5('mct201')::uuid;", 'F06_GENERATION_LEASE_CHANGED'),
        ('new-hand-stage', current_snapshot + "UPDATE hand_state_snapshots SET stage='flop' WHERE table_id=md5('mctab201:31')::uuid;", 'F06_ABORT_SNAPSHOT_CHANGED'),
        ('new-hand-json-stage', current_snapshot + "UPDATE hand_state_snapshots SET state_json=jsonb_set(state_json,'{stage}','\"flop\"') WHERE table_id=md5('mctab201:31')::uuid;", 'F06_ABORT_SNAPSHOT_CHANGED'),
        ('new-hand-private', "INSERT INTO hand_private_state(table_id,hand_number) VALUES(md5('mctab201:31')::uuid,3020131);", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('new-hand-dispatch', "INSERT INTO smarter_private.f06_hand_dispatch(permit_id,xid) VALUES(md5('mcp201:31')::uuid,txid_current());", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('new-hand-arithmetic', current_snapshot + "UPDATE hand_state_snapshots SET state_json=jsonb_set(state_json,'{players,1,stack}','779') WHERE table_id=md5('mctab201:31')::uuid;", 'F06_ABORT_SAVED_STACKS_CHANGED'),
        ('new-hand-bba-double-credit', current_snapshot + "UPDATE hand_state_snapshots SET state_json=jsonb_set(state_json,'{players,1,totalInvested}','340') WHERE table_id=md5('mctab201:31')::uuid;", 'F06_ABORT_SAVED_STACKS_CHANGED'),
        ('new-hand-ante', current_snapshot + "UPDATE hand_state_snapshots SET state_json=jsonb_set(state_json,'{players,1,individualAnteInvested}','1') WHERE table_id=md5('mctab201:31')::uuid;", 'F06_ABORT_SAVED_STACKS_CHANGED'),
        ('new-hand-returned-uncalled', current_snapshot + "UPDATE hand_state_snapshots SET state_json=jsonb_set(state_json,'{players,1,returnedUncalled}','1') WHERE table_id=md5('mctab201:31')::uuid;", 'F06_ABORT_SAVED_STACKS_CHANGED'),
        ('missing-current-prior', "DELETE FROM hand_atomic_commits WHERE table_id=md5('mctab201:31')::uuid;", 'F06_MIXED_PRIOR_INCOMPLETE'),
        ('current-seat-mismatch', "UPDATE table_seats SET stack=999 WHERE id=md5('mcs201:31:1')::uuid;", 'F06_GENERATION_ROSTER_CHANGED'),
        ('quiet-table-roster-mismatch', "UPDATE tournament_players SET chips=999 WHERE id=md5('mcr201:33:1')::uuid;", 'F06_GENERATION_ROSTER_CHANGED'),
        ('seat-lifetime-changed', "UPDATE table_seats SET joined_at=joined_at+interval '1 second' WHERE id=md5('mcs201:1:1')::uuid;", 'F06_ABORT_EXPECTED_CHANGED'),
        ('accepted-postcommit-failed', "UPDATE hand_atomic_commits SET post_commit_result='{\"ok\":false}' WHERE table_id=md5('mctab201:34')::uuid;" + refresh(), 'F06_GENERATION_ACCEPTED_PROOF_INCOMPLETE'),
        ('accepted-postcommit-unknown', "UPDATE hand_atomic_commits SET post_commit_result=NULL WHERE table_id=md5('mctab201:34')::uuid;" + refresh(), 'F06_GENERATION_ACCEPTED_PROOF_INCOMPLETE'),
        ('accepted-park-started', "UPDATE smarter_private.f06_operations SET state='begun',manifest='[]' WHERE break_id=md5('mcpark201')::uuid;", 'F06_GENERATION_PARK_CHANGED'),
    ]
    for name, change, error in changes:
        probe('mixed-cohort-' + name, service + change + abort(), error=error)
    probe('mixed-cohort-current-actually-started', current_snapshot + refresh() + service + abort())
    with held(request()):
        probe('mixed-cohort-current-writer-drains', "SET LOCAL lock_timeout='150ms';" + service + abort(), error='55P03')

    # A third current generation can own the lease while the exact two original
    # permit generations remain. All three must become permanently fenced.
    probe('mixed-cohort-third-current-generation', """UPDATE engine_tournament_leases
      SET lease_generation=md5('mc-third201')::uuid WHERE tournament_id=md5('mct201')::uuid;""" + refresh() + service + abort() + """
      DO $$BEGIN IF (SELECT count(*) FROM smarter_private.f06_mixed_abort_generations
        WHERE tournament_id=md5('mct201')::uuid)<>3 THEN RAISE EXCEPTION 'third current fence missing'; END IF; END $$;""")
    state = """SELECT jsonb_build_object('leases',(SELECT jsonb_agg(l ORDER BY tournament_id) FROM engine_tournament_leases l),
      'permits',(SELECT jsonb_agg(p ORDER BY permit_id) FROM smarter_private.f06_hand_permits p),
      'parks',(SELECT jsonb_agg(o ORDER BY break_id) FROM smarter_private.f06_operations o),
      'snapshots',(SELECT jsonb_agg(s ORDER BY id) FROM hand_state_snapshots s),
      'headers',(SELECT jsonb_agg(a ORDER BY receipt_id) FROM smarter_private.f06_mixed_aborts a),
      'generations',(SELECT jsonb_agg(a ORDER BY tournament_id,generation) FROM smarter_private.f06_mixed_abort_generations a),
      'children',(SELECT jsonb_agg(a ORDER BY permit_id) FROM smarter_private.f06_mixed_abort_hands a));"""
    state_before = run('mixed-cohort-state-before-rollback', state)
    probe('mixed-cohort-full-rollback', service + abort())
    require(run('mixed-cohort-state-after-rollback', state) == state_before, 'Mixed cohort rollback leaked state')
    require(run('mixed-cohort-refusals-money', money) == before, 'Mixed cohort refusal changed money')
    require(run('mixed-cohort-refusals-accepted', accepted) == accepted_before, 'Mixed cohort refusal changed accepted outcome')

    with held(service + abort(), finish='COMMIT'):
        queued = []
        for name, sql in [
            ('old-claim', "SELECT granted FROM claim_tournament_lease_v2(md5('mct201')::uuid,'late','old',md5('mc-old201')::uuid);"),
            ('current-claim', "SELECT granted FROM claim_tournament_lease_v2(md5('mct201')::uuid,'late','old',md5('mc-current201')::uuid);"),
            ('late-current-snapshot', request() + "UPDATE hand_state_snapshots SET is_complete=false WHERE table_id=md5('mctab201:31')::uuid;"),
            ('duplicate', service + abort()),
            ('different-receipt', service + abort(receipt='mc-other-receipt')),
        ]:
            p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            p.stdin.write("BEGIN;SET application_name='mixed-cohort-" + name + "';SET statement_timeout='6s';" + sql + 'COMMIT;\n')
            p.stdin.close()
            queued.append((name, p))
        deadline = time.monotonic() + 4
        while command(cmd, "SELECT count(*)=5 FROM pg_stat_activity WHERE application_name IN ('mixed-cohort-old-claim','mixed-cohort-current-claim','mixed-cohort-late-current-snapshot','mixed-cohort-duplicate','mixed-cohort-different-receipt') AND wait_event_type='Lock';").stdout.strip() != 't':
            require(all(p.poll() is None for _, p in queued) and time.monotonic() < deadline,
                    'Mixed cohort contenders did not all enter actual owning-lock waits')
            time.sleep(.02)
    for name, p in queued:
        p.wait(timeout=8)
        stdout, stderr = p.stdout.read(), p.stderr.read()
        (out / ('mixed-cohort-race-' + name + '.log')).write_text(stdout + stderr)
        ok = p.returncode == 0 and stdout.strip() == 'f' if name.endswith('-claim') else (
            p.returncode == 0 and 'aborted_unsettled' in stdout if name == 'duplicate' else
            p.returncode != 0 and ('F06_GENERATION_LEASE_CHANGED' if name == 'different-receipt' else 'TOURNAMENT_MANAGER_FENCED') in stderr)
        require(ok, 'Mixed cohort race ' + name + ': ' + stdout + stderr)
        results['cases'].append({'name': 'mixed-cohort-race-' + name, 'passed': True})
    run('mixed-cohort-exact-replay', service + abort())
    probe('mixed-cohort-changed-replay', service + "UPDATE fixture_expected_inputs SET expected=expected||'{\"changed\":true}' WHERE i=201;" + abort(), error='F06_ABORT_CHANGED_REPLAY')
    for i in (202, 203):
        run('mixed-cohort-spin-' + str(i), service + abort(i))
    run('mixed-cohort-exact-cardinality', """SELECT
      (SELECT count(*) FROM smarter_private.f06_mixed_aborts WHERE tournament_id IN(SELECT md5('mct'||i)::uuid FROM generate_series(201,203) i))||'|'||
      (SELECT count(*) FROM smarter_private.f06_mixed_abort_generations WHERE tournament_id IN(SELECT md5('mct'||i)::uuid FROM generate_series(201,203) i))||'|'||
      (SELECT count(*) FROM smarter_private.f06_mixed_abort_hands WHERE tournament_id IN(SELECT md5('mct'||i)::uuid FROM generate_series(201,203) i))||'|'||
      (SELECT count(*) FROM smarter_private.f06_operations WHERE break_id IN(md5('mcpark202')::uuid,md5('mcpark203')::uuid) AND state='withdrawn_before_manifest');""", '3|6|33|2')
    require(run('mixed-cohort-money-after', money) == before, 'Mixed cohort disposition changed committed balances')
    require(run('mixed-cohort-accepted-after', accepted) == accepted_before, 'Mixed cohort disposition changed accepted siblings or accepted park')
    probe('mixed-cohort-late-new-atomic', "INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id) VALUES(md5('mctab201:31')::uuid,3020131,gen_random_uuid());", error='F06_ABORTED_HAND_FENCED')
    probe('mixed-cohort-late-old-atomic', "INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id) VALUES(md5('mctab201:1')::uuid,3020101,gen_random_uuid());", error='F06_ABORTED_HAND_FENCED')
    for i in (201, 202, 203):
        run('mixed-cohort-all-writers-fenced-' + str(i), "SELECT smarter_private.f06_generation_aborted(md5('mct%d')::uuid,md5('mc-old%d')::uuid) AND smarter_private.f06_generation_aborted(md5('mct%d')::uuid,md5('mc-current%d')::uuid);" % (i, i, i, i), 't')
    run('mixed-cohort-fresh-owner', "SELECT granted FROM claim_tournament_lease_v2(md5('mct201')::uuid,'next','fixed',md5('mc-fresh201')::uuid);", 't')
    probe('mixed-cohort-real-accepted-source-adoption', """SET request.jwt.claims='{"role":"service_role"}';
      SET app.smarter_data_actor='tournament-manager';
      SELECT set_config('app.smarter_tournament_id',md5('mct201')::uuid::text,false);
      SELECT set_config('app.smarter_tournament_lease_generation',md5('mc-fresh201')::uuid::text,false);
      DO $$DECLARE v jsonb;members jsonb;BEGIN
        v:=fn_f06_claim_custody(md5('mct201')::uuid,md5('mc-fresh201')::uuid,md5('mcpark201')::uuid,md5('mc-adopt')::uuid,0);
        IF v->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'accepted park adoption failed'; END IF;
        SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'source_seat_id',id,'source_seat_number',seat_number,
          'occupancy_id',occupancy_id,'request_id',md5('mc-move'||user_id)::uuid,
          'destination_table_id',md5('mctab201:1')::uuid,'destination_seat_number',seat_number+7) ORDER BY user_id)
          INTO members FROM table_seats WHERE table_id=md5('mctab201:34')::uuid AND left_at IS NULL;
        v:=fn_f06_begin_break(md5('mct201')::uuid,md5('mc-fresh201')::uuid,md5('mcpark201')::uuid,members);
        IF v->>'ok' IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations
          WHERE break_id=md5('mcpark201')::uuid AND state='begun' AND manifest=members
          AND origin_generation=md5('mc-old201')::uuid AND custody_generation=md5('mc-fresh201')::uuid AND abort_receipt_id IS NULL)
          OR (SELECT count(*) FROM smarter_private.f06_members WHERE break_id=md5('mcpark201')::uuid)<>2
          OR (SELECT count(*) FROM smarter_private.f06_attempts WHERE break_id=md5('mcpark201')::uuid AND generation=md5('mc-fresh201')::uuid)<>2
          THEN RAISE EXCEPTION 'accepted park original identity or genuine manifest changed'; END IF;
      END $$;""")
    results['mixedCohorts'] = {'passed': True, 'events': 3, 'hands': 33, 'acceptedSiblings': 2,
                              'fencedGenerations': 6, 'occupants': 268, 'priorBackedHands': 1, 'walletCredit': 0}
