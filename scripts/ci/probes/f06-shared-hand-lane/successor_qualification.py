"""Actual PostgreSQL qualification for the two-original successor-lease extension."""
import hashlib
import json
import subprocess
import time


def qualify(root, out, cmd, command, run, probe, require, results, seed, held, money, service):
    path = root / 'supabase/migrations/20260918061004_interrupted_original_hands_fence_their_successor_lease.sql'
    results['successorInputs'] = {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in [path, root / 'scripts/ci/probes/f06-shared-hand-lane/successor_qualification.py']
    }
    # Existing original native authorities are already installed. These two
    # synthetic objects independently reproduce the 4000-chip G8 cohort, with
    # their ORIGINAL permit/park/snapshot identities retained across takeover.
    two = seed.split('CREATE FUNCTION public.fixture_expected')[0].replace('1..8', '11..12')
    two = two.replace("st:=CASE WHEN i=2 THEN 1000 WHEN i=5 AND j=1 THEN 238 WHEN i=5 THEN 362 ELSE 300 END;", 'st:=1000;')
    run('successor-two-originals', two)
    for i in (11, 12):
        run('successor-native-takeover-' + str(i),
            "SELECT release_tournament_leases_v2('original',jsonb_build_array(jsonb_build_object('tournament_id',md5('t%d')::uuid,'lease_generation',md5('g%d')::uuid)));" % (i, i)
            + "SELECT granted FROM claim_tournament_lease_v2(md5('t%d')::uuid,'successor','2bbc5d5c',md5('successor-g%d')::uuid);" % (i, i), '1\nt')
    run('successor-expected-original-identity', """
    CREATE FUNCTION fixture_successor_expected(i integer) RETURNS jsonb LANGUAGE sql AS $$
    SELECT fixture_expected(i) || jsonb_build_object('generation',h.generation,'lease_generation',l.lease_generation)
    FROM smarter_private.f06_hand_permits h JOIN engine_tournament_leases l USING(tournament_id)
    WHERE h.table_id=md5('tab'||i)::uuid $$;
    INSERT INTO fixture_expected_inputs SELECT i,fixture_successor_expected(i) FROM generate_series(11,12) i;
    """)
    before = run('successor-financial-before', money)
    run('successor-original-4000', "SELECT sum(stack) FROM table_seats WHERE table_id IN(md5('tab11')::uuid,md5('tab12')::uuid);", '4000')

    def abort(i=11):
        return "SELECT fn_f06_abort_successor_unsettled_hand(md5('successor-receipt%d')::uuid,(SELECT expected FROM fixture_expected_inputs WHERE i=%d));" % (i, i)

    probe('successor-baseline-missing-door', service + abort(), error='42883')
    probe('successor-baseline-original-door-refuses', service + "SELECT fn_f06_abort_unsettled_hand(md5('unusable')::uuid,(SELECT expected-'lease_generation' FROM fixture_expected_inputs WHERE i=11));", error='F06_ABORT_ORIGINAL_LEASE_CHANGED')
    installer = path.read_text()
    run('successor-disabled-fence-refused', 'BEGIN; ALTER TABLE engine_tournament_leases DISABLE TRIGGER f06_aborted_generation;' + installer, error='F06_SUCCESSOR_ABORT_BINDING_CHANGED')
    with held("SELECT 1 FROM engine_tournament_leases WHERE tournament_id=md5('t11')::uuid FOR KEY SHARE;"):
        run('successor-installer-refuses-busy-lease-without-wait', installer, error='55P03')
    run('successor-refused-install-leaves-no-column', "SELECT count(*) FROM pg_attribute WHERE attrelid='smarter_private.f06_unsettled_hand_aborts'::regclass AND attname='retired_lease_generation' AND NOT attisdropped;", '0')
    run('successor-install', installer)
    require(run('successor-ddl-preserves-money', money) == before, 'Successor DDL changed financial state')
    probe('successor-browser-refused', 'SET ROLE authenticated;' + service + abort(), error='42501')
    probe('successor-wrong-service-actor', "SET request.jwt.claims='{\"role\":\"service_role\"}';SET app.smarter_data_actor='tournament-manager';" + abort(), error='F06_ABORT_SERVICE_REQUIRED')
    for name, change, error in [
        ('missing-current-generation', "UPDATE fixture_expected_inputs SET expected=expected-'lease_generation' WHERE i=11;", 'F06_ABORT_IDENTITY_REQUIRED'),
        ('same-generation', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{lease_generation}',expected->'generation') WHERE i=11;", 'F06_ABORT_IDENTITY_REQUIRED'),
        ('changed-current-generation', "UPDATE engine_tournament_leases SET lease_generation=md5('third-g11')::uuid WHERE tournament_id=md5('t11')::uuid;", 'F06_ABORT_CURRENT_LEASE_CHANGED'),
        ('changed-current-instance', "UPDATE engine_tournament_leases SET instance_id='another' WHERE tournament_id=md5('t11')::uuid;", 'F06_ABORT_CURRENT_LEASE_CHANGED'),
        ('changed-original-generation', "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{generation}',to_jsonb(md5('wrong-original')::uuid)) WHERE i=11;", 'F06_ABORT_ORIGINAL_PERMIT_CHANGED'),
        ('changed-occupancy', "UPDATE table_seats SET occupancy_id=gen_random_uuid() WHERE id=md5('seat11:1')::uuid;", 'F06_ABORT_EXPECTED_CHANGED'),
        ('changed-stack', "UPDATE table_seats SET stack=999 WHERE id=md5('seat11:1')::uuid;", 'F06_ABORT_SAVED_STACKS_CHANGED'),
        ('dispatch', "INSERT INTO smarter_private.f06_hand_dispatch VALUES(md5('permit11')::uuid,txid_current());", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
        ('freeze', "INSERT INTO engine_maintenance_break VALUES(true,now()-interval '3 minutes','last_hand',NULL,NULL);", 'PLATFORM_FROZEN'),
    ]:
        probe('successor-refuses-' + name, service + change + abort(), error=error)

    def manager(generation):
        return """SET request.jwt.claims='{"role":"service_role"}';
        SELECT set_config('request.headers',jsonb_build_object('x-smarter-data-actor','tournament-manager','x-smarter-data-protocol','2',
        'x-smarter-tournament-id',md5('t11')::uuid,'x-smarter-tournament-lease-generation',md5('%s')::uuid)::text,true);
        SET request.method='POST';SELECT smarter_private.fn_smarter_data_api_pre_request();""" % generation

    with held(manager('successor-g11')):
        probe('successor-drains-actual-current-writer', "SET LOCAL lock_timeout='150ms';" + service + abort(), error='55P03')
    for name, lane in [('global', 'ca:tournament-terminal-settlement:v1'),
                       ('event', 'ca:tournament-terminal-settlement:v1:' + str(__import__('uuid').UUID(hashlib.md5(b't11').hexdigest())))]:
        with held("SELECT pg_advisory_xact_lock(hashtextextended('%s',0));" % lane):
            probe('successor-' + name + '-lane-wins', service + abort(), error='F06_RETRY_CANONICAL_LANE')
    with held("SELECT pg_advisory_xact_lock(hashtextextended('f06:hand:'||md5('permit11')::uuid::text,0));"):
        probe('successor-original-dispatch-lane-wins', service + abort(), error='F06_HAND_DISPATCH_BUSY')

    # A takeover committed while abort waits must be observed through the locked
    # lease row; the earlier expected generation must never retire the new one.
    with held("UPDATE engine_tournament_leases SET lease_generation=md5('raced-g11')::uuid WHERE tournament_id=md5('t11')::uuid;", finish='COMMIT'):
        pending = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        pending.stdin.write("BEGIN; SET statement_timeout='6s';" + service + abort() + 'COMMIT;')
        pending.stdin.close()
        deadline = time.monotonic() + 4
        while command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%fn_f06_abort_successor_unsettled_hand%');").stdout.strip() != 't':
            require(pending.poll() is None and time.monotonic() < deadline, 'Successor takeover did not block actual abort')
            time.sleep(.02)
    pending.wait(timeout=8)
    output = pending.stdout.read() + pending.stderr.read()
    (out / 'successor-takeover-race.log').write_text(output)
    require(pending.returncode != 0 and 'F06_ABORT_CURRENT_LEASE_CHANGED' in output, output)
    results['cases'].append({'name': 'successor-takeover-race-refused', 'passed': True})
    run('successor-retain-new-current-identity', "UPDATE fixture_expected_inputs SET expected=fixture_successor_expected(11) WHERE i=11;")

    # Abort commits while both generations attempt to resurrect. Actual lease
    # row/unique-index waiters must read the committed immutable fence afterward.
    with held(service + abort(), finish='COMMIT'):
        queued = []
        for generation in ('g11', 'raced-g11'):
            for kind in ('claim', 'insert'):
                sql = ("SELECT granted FROM claim_tournament_lease_v2(md5('t11')::uuid,'late','2bbc5d5c',md5('%s')::uuid);" % generation
                       if kind == 'claim' else "INSERT INTO engine_tournament_leases VALUES(md5('t11')::uuid,'late','2bbc5d5c',now(),now(),md5('%s')::uuid,2);" % generation)
                p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                p.stdin.write("BEGIN; SET statement_timeout='6s';" + sql + 'COMMIT;')
                p.stdin.close()
                queued.append((generation + '-' + kind, kind, p))
        time.sleep(.15)
        require(all(p.poll() is None for _, _, p in queued), 'Both generation contenders must wait behind actual abort')
    for name, kind, p in queued:
        p.wait(timeout=8)
        stdout, stderr = p.stdout.read(), p.stderr.read()
        (out / ('successor-' + name + '.log')).write_text(stdout + stderr)
        ok = p.returncode == 0 and stdout.strip() == 'f' if kind == 'claim' else p.returncode != 0 and 'F06_ABORTED_GENERATION_FENCED' in stderr
        results['cases'].append({'name': 'successor-' + name + '-fenced', 'passed': ok})
        require(ok, stdout + stderr)
    for generation in ('g11', 'raced-g11'):
        probe('successor-' + generation + '-late-manager-fenced', manager(generation) + "UPDATE table_seats SET stack=0 WHERE id=md5('seat11:1')::uuid;", error='TOURNAMENT_MANAGER_FENCED')
    for name, sql, error in [
        ('late-atomic', "INSERT INTO hand_atomic_commits VALUES(md5('tab11')::uuid,100011,gen_random_uuid(),NULL);", 'F06_ABORTED_HAND_FENCED'),
        ('late-history', "INSERT INTO hand_history(table_id,hand_number) VALUES(md5('tab11')::uuid,100011);", 'F06_ABORTED_HAND_FENCED'),
        ('late-dispatch', "SELECT smarter_private.f06_hand_dispatch_guard(md5('tab11')::uuid,100011);", 'F06_HAND_PERMIT_FENCED'),
        ('receipt-current-generation-mutation', "UPDATE smarter_private.f06_unsettled_hand_aborts SET retired_lease_generation=gen_random_uuid() WHERE permit_id=md5('permit11')::uuid;", 'F06_ABORT_RECEIPT_IMMUTABLE'),
    ]:
        probe('successor-' + name, sql, error=error)
    run('successor-exact-replay', service + abort())
    probe('successor-changed-replay', service + "UPDATE fixture_expected_inputs SET expected=jsonb_set(expected,'{lease_generation}',to_jsonb(md5('other')::uuid)) WHERE i=11;" + abort(), error='F06_ABORT_CHANGED_REPLAY')
    run('successor-second-original', service + abort(12))
    run('successor-original-and-current-identity-preserved', """SELECT bool_and(
      a.generation=h.generation AND a.generation=o.origin_generation
      AND a.generation=o.custody_generation AND a.generation<>a.retired_lease_generation
      AND a.retired_lease_generation=(a.expected->>'lease_generation')::uuid
      AND a.permit_id=h.permit_id AND a.break_id=o.break_id
      AND a.receipt_id=h.evidence_id AND a.receipt_id=o.abort_receipt_id)
      FROM smarter_private.f06_unsettled_hand_aborts a
      JOIN smarter_private.f06_hand_permits h USING(permit_id)
      JOIN smarter_private.f06_operations o USING(break_id)
      WHERE a.table_id IN(md5('tab11')::uuid,md5('tab12')::uuid);""", 't')
    run('successor-exact-two-terminal', """SELECT
      (SELECT count(*) FROM smarter_private.f06_unsettled_hand_aborts WHERE retired_lease_generation IS NOT NULL)||'|'||
      (SELECT count(*) FROM smarter_private.f06_hand_permits WHERE table_id IN(md5('tab11')::uuid,md5('tab12')::uuid) AND state='aborted_unsettled')||'|'||
      (SELECT count(*) FROM smarter_private.f06_operations WHERE source_table_id IN(md5('tab11')::uuid,md5('tab12')::uuid) AND state='withdrawn_before_manifest')||'|'||
      (SELECT count(*) FROM hand_state_snapshots WHERE table_id IN(md5('tab11')::uuid,md5('tab12')::uuid) AND is_complete);""", '2|2|2|2')
    require(run('successor-financial-after', money) == before, 'Successor abort changed stacks, registrations, ledger or prior hands')
    run('successor-new-unfenced-generation-admitted', "SELECT granted FROM claim_tournament_lease_v2(md5('t11')::uuid,'next','fixed',md5('fresh-g11')::uuid);", 't')
    probe('successor-new-generation-can-reserve', manager('fresh-g11') + """DO $$DECLARE v jsonb;BEGIN
      v:=fn_f06_table_state(md5('t11')::uuid,md5('fresh-g11')::uuid,md5('tab11')::uuid);
      IF v->>'can_reserve' IS DISTINCT FROM 'true' OR v->>'excluded' IS DISTINCT FROM 'false'
      OR v->'unresolved_permits' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'successor fresh admission failed'; END IF;
      END $$;""")

    # Settlement wins on a third isolated control, outside the unchanged-money
    # pair. The canonical accepted-hand trigger keeps its real winning outcome.
    run('successor-settlement-control', two.replace('11..12', '13..13') + """
      SELECT release_tournament_leases_v2('original',jsonb_build_array(jsonb_build_object('tournament_id',md5('t13')::uuid,'lease_generation',md5('g13')::uuid)));
      SELECT granted FROM claim_tournament_lease_v2(md5('t13')::uuid,'successor','2bbc5d5c',md5('successor-g13')::uuid);
      INSERT INTO fixture_expected_inputs VALUES(13,fixture_successor_expected(13));""")
    with held("INSERT INTO hand_atomic_commits VALUES(md5('tab13')::uuid,100013,md5('accepted13')::uuid,now());", finish='COMMIT'):
        probe('successor-settlement-in-flight-wins', service + abort(13), error='F06_RETRY_CANONICAL_LANE')
    probe('successor-accepted-outcome-refused', service + abort(13), error='F06_ABORT_ORIGINAL_PERMIT_CHANGED')
    run('successor-accepted-outcome-preserved', "SELECT state||'|'||(evidence_id=md5('accepted13')::uuid)::text FROM smarter_private.f06_hand_permits WHERE permit_id=md5('permit13')::uuid;", 'accepted|true')
    results['successorAbort'] = {'passed': True, 'originals': 2, 'persistedStacks': 4000,
                                 'snapshotStacks': 3940, 'uncommittedInvestment': 60, 'walletCredit': 0}
