"""Original stopped custody remains authoritative after native lease-row loss."""
from contextlib import contextmanager
import hashlib
import json
import re
import runpy
import subprocess
import time


def qualify(root, out, cmd, command, run, probe, require, results):
    # Retain the exact native predecessor for fault diagnosis without rerunning
    # unrelated predecessor cases; required final qualification still runs all.
    dump=command([__import__('pathlib').Path(cmd[0]).with_name('pg_dump'),'-h',cmd[cmd.index('-h')+1],'-p',cmd[cmd.index('-p')+1],'-U','postgres','-d',cmd[-1]])
    require(dump.returncode==0,dump.stderr)
    (out/'retired-origin-native-predecessor.sql').write_text(dump.stdout)
    build = runpy.run_path(str(root / 'scripts/ci/build-f06-retired-origin.py'))
    migration = root / build['MIGRATION']
    require(migration.read_text() == build['render'](), 'Retired-origin source composition differs')
    service = "SET request.jwt.claims='{\"role\":\"service_role\"}';SET app.smarter_data_actor='service';"
    source = (root / build['MIXED']).read_text()
    # Load the same predecessor bodies, receipt relations and native parked schema.
    # This harness proves hand/claim authority, not financial payout execution.
    run('retired-origin-mixed-predecessor', source)
    movement=(root/'supabase/migrations/20260918095135_parked_tournament_movement_requires_canonical_custody.sql').read_text()
    run('retired-origin-original-movement',movement[movement.index('CREATE TABLE smarter_private.f06_movement_admissions'):movement.rindex('COMMIT;')])
    movement_build=runpy.run_path(str(root/'scripts/ci/build-f06-mixed-custody.py'))
    run('retired-origin-composed-movement',movement_build['movement'](root))
    run('retired-origin-presence-schema', (root / 'supabase/migrations/20260904230754_engine_presence_survives_the_restart.sql').read_text())
    run('retired-origin-bank-schema', (root / 'supabase/migrations/20260917120432_parked_time_banks_retain_their_seat_occupancy.sql').read_text())
    leader = (root / 'supabase/migrations/20260823_engine_leadership.sql').read_text()
    run('retired-origin-leader-schema', leader[leader.index('CREATE TABLE IF NOT EXISTS public.engine_leader'):leader.index('CREATE OR REPLACE FUNCTION public.claim_engine_leadership')])
    run('retired-origin-maintenance-shape', "ALTER TABLE engine_maintenance_break ADD COLUMN id boolean DEFAULT true,ADD COLUMN ownership_token uuid,ADD COLUMN declared_by text,ADD COLUMN reason text;")
    old_body = run('retired-origin-generic-preimage', "SELECT md5(pg_get_functiondef('fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)'::regprocedure));")
    run('retired-origin-install', migration.read_text())
    close=(root/'supabase/migrations/20260908043300_tournament_table_break_close_is_atomic.sql').read_text()
    run('retired-origin-close-columns',"ALTER TABLE tables ADD COLUMN current_players integer DEFAULT 0,ADD COLUMN updated_at timestamptz DEFAULT now();")
    run('retired-origin-native-close',close[close.index('CREATE OR REPLACE FUNCTION'):close.index('DO $assert_tournament_table_break_close_contract$')])
    cohorts = json.loads((root / build['COHORTS']).read_text())
    events = list(cohorts)
    fixture = (root / 'scripts/ci/probes/f06-shared-hand-lane/retained-mtt-fixture.sql').read_text()
    def extract(name):
        return re.search(r'CREATE FUNCTION ' + name + r'\(.*?\$\$;', fixture, re.S)[0]
    lookup = "CREATE FUNCTION fixture_origin_t(i integer) RETURNS uuid LANGUAGE sql AS $$ SELECT CASE i WHEN 1401 THEN '%s'::uuid WHEN 1402 THEN '%s'::uuid END $$;" % tuple(events)
    lookup += "CREATE FUNCTION fixture_origin_c(i integer) RETURNS jsonb LANGUAGE sql AS $$ SELECT smarter_private.f06_retired_origin_cohort(fixture_origin_t(i)) $$;"
    lookup += "CREATE FUNCTION fixture_origin_table(i integer) RETURNS uuid LANGUAGE sql AS $$ SELECT (fixture_origin_c(i)#>>'{permit,table_id}')::uuid $$;"
    lookup += "CREATE FUNCTION fixture_origin_source(i integer,j integer) RETURNS uuid LANGUAGE sql AS $$ SELECT key::uuid FROM jsonb_object_keys(fixture_origin_c(i)->'engines') a(key) WHERE key<>fixture_origin_table(i)::text ORDER BY key OFFSET j-1 LIMIT 1 $$;"
    def remap(text):
        return text.replace("md5('rm-event'||i)::uuid", 'fixture_origin_t(i)').replace("md5('rm-table'||i)::uuid", 'fixture_origin_table(i)').replace("md5('rm-generation'||i)::uuid", "(fixture_origin_c(i)->>'generation')::uuid")
    atomic = remap(extract('fixture_retained_atomic')).replace('fixture_retained_atomic', 'fixture_origin_atomic')
    seed = remap(extract('fixture_seed_retained_mtt')).replace('fixture_seed_retained_mtt', 'fixture_seed_retired_origin').replace('fixture_retained_atomic', 'fixture_origin_atomic')
    seed = seed.replace("md5('rm-source'||i||':'||j)::uuid", 'fixture_origin_source(i,j)')
    seed = seed.replace("md5('rm-permit'||i)::uuid", "(fixture_origin_c(i)#>>'{permit,permit_id}')::uuid")
    seed = seed.replace("md5('rm-hand-custody'||i)::uuid", "(fixture_origin_c(i)#>>'{permit,custody_id}')::uuid")
    seed = seed.replace('10003', "(fixture_origin_c(i)#>>'{permit,hand_number}')::bigint")
    seed = seed.replace("INSERT INTO tables(id,tournament_id,status) VALUES(tab,t,'running');", "PERFORM setval('smarter_private.f06_lifecycle_seq',(fixture_origin_c(i)#>>'{permit,lifecycle}')::bigint-1,true);INSERT INTO tables(id,tournament_id,status,f06_lifecycle) VALUES(tab,t,'running',(fixture_origin_c(i)#>>'{permit,lifecycle}')::bigint);")
    seed = seed.replace(" INSERT INTO smarter_private.f06_hand_permits SELECT", " INSERT INTO tables(id,tournament_id,status) SELECT key::uuid,t,'waiting' FROM jsonb_object_keys(fixture_origin_c(i)->'engines') a(key) WHERE NOT EXISTS(SELECT 1 FROM tables WHERE id=key::uuid);\n INSERT INTO smarter_private.f06_hand_permits SELECT")
    input_sql = remap(extract('fixture_retained_input')).replace('fixture_retained_input', 'fixture_origin_input')
    run('retired-origin-synthetic-fixtures', lookup + atomic + seed + input_sql)
    run('retired-origin-two-originals', 'SELECT fixture_seed_retired_origin(1401,true);SELECT fixture_seed_retired_origin(1402,false);')
    run('retired-origin-input-store', 'CREATE TABLE fixture_origin_inputs(i integer PRIMARY KEY,input jsonb,expected jsonb);')
    for i, event in zip((1401, 1402), events):
        c = cohorts[event]
        physical = dict(source='8825af51817f379c4261658ca29ecc9d8d81932d', instance_id='1-3846b8bb',
            process_id='1231816', application_pid=1,
            container_id='c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66',
            image='sha256:7973b0cd170e7ea00a948f6376b17a201485c3e03ae47c06f0248b17a4bfae1c',
            manager_id=c['manager_id'], generation=c['generation'], evidence_sha256='e' * 64,
            table_id=c['permit']['table_id'], permit_id=c['permit']['permit_id'],
            engine_id=c['engines'][c['permit']['table_id']], all_processes_accounted=True,
            all_owned_work_joined=True, original_stop_completed=True, owner_index_complete=True,
            scheduler_pending=0, lifecycle_pending=0,
            engines=[dict(table_id=t,engine_id=e,generation=c['generation'],terminal=True,running=False,
                last_event='stop_completed',owned_work_joined=True,diagnostic_write_failures=0,dropped_records=0,
                dealing_loop=False,settlements=0,post_hand_tasks=False,tournament_moves=0,
                read_continuation_proof='8825_stop_completed_joins_fixed_point') for t,e in c['engines'].items()])
        run('retired-origin-capture-input-' + str(i), f"INSERT INTO fixture_origin_inputs SELECT {i},jsonb_set(jsonb_set(fixture_origin_input({i},{str(i==1401).lower()}),'{{lease}}','null'),'{{physical}}',$json${json.dumps(physical)}$json$::jsonb||jsonb_build_object('observed_at',clock_timestamp())),NULL;")
    run('retired-origin-input-identity-proof',"SELECT i,input#>'{hands,0,permit}',fixture_origin_c(i)->'permit' FROM fixture_origin_inputs ORDER BY i;")
    run('retired-origin-native-row-loss', "DELETE FROM engine_tournament_leases WHERE tournament_id IN(fixture_origin_t(1401),fixture_origin_t(1402));INSERT INTO engine_leader(id,instance_id,engine_version,heartbeat_at) VALUES(true,'1-3846b8bb','8825af51',clock_timestamp());")
    def attest(i=1401, expected='NULL'):
        return f"SELECT fn_f06_attest_retired_manager_origin((fixture_origin_c({i})->>'receipt_id')::uuid,(SELECT input FROM fixture_origin_inputs WHERE i={i}),{expected});"
    def claim(i=1401,g="md5('new-retired-owner')::uuid",process="'new-process'"):
        return f"SELECT granted FROM claim_tournament_lease_v2(fixture_origin_t({i}),{process},'qualified',{g});"
    probe('retired-origin-before-original-refuses-absence', service + "SELECT smarter_private.f06_retained_mtt_abort_snapshot(input) FROM fixture_origin_inputs WHERE i=1401;", error='F06_RETAINED_LEASE_CHANGED')
    probe('retired-origin-before-no-witness-no-disposition', service + "SELECT smarter_private.f06_retained_mtt_abort_snapshot(input||jsonb_build_object('retired_origin_id',fixture_origin_c(i)->>'receipt_id')) FROM fixture_origin_inputs WHERE i=1401;", error='F06_RETIRED_RECEIPT_REQUIRED')
    for label, change, reason in [
        ('browser', 'SET ROLE authenticated;', '42501'),
        ('actor', "SET app.smarter_data_actor='browser';", 'F06_ABORT_SERVICE_REQUIRED'),
        ('wrong-manager', "UPDATE fixture_origin_inputs SET input=jsonb_set(input,'{physical,manager_id}',to_jsonb(gen_random_uuid())) WHERE i=1401;", 'F06_RETIRED_PHYSICAL_PROOF_REQUIRED'),
        ('missing-original', "UPDATE fixture_origin_inputs SET input=input#-'{physical,engines,0}' WHERE i=1401;", 'F06_RETIRED_WHOLE_OWNER_REQUIRED'),
        ('unknown-drain', "UPDATE fixture_origin_inputs SET input=jsonb_set(input,'{physical,engines,0,owned_work_joined}','null') WHERE i=1401;", 'F06_RETIRED_ORIGINAL_NOT_DRAINED'),
        ('unavailable-continuation', "UPDATE fixture_origin_inputs SET input=jsonb_set(input,'{physical,engines,0,read_continuation_proof}','null') WHERE i=1401;", 'F06_RETIRED_ORIGINAL_NOT_DRAINED'),
        ('missing-leader', 'DELETE FROM engine_leader;', 'F06_RETIRED_PROCESS_CHANGED'),
        ('foreign-process', "UPDATE engine_leader SET instance_id='replacement';", 'F06_RETIRED_PROCESS_CHANGED'),
        ('stale-physical', "UPDATE fixture_origin_inputs SET input=jsonb_set(input,'{physical,observed_at}',to_jsonb(clock_timestamp()-interval '61 seconds')) WHERE i=1401;", 'F06_RETIRED_PHYSICAL_PROOF_STALE'),
        ('competing-lease', claim(), 'F06_RETIRED_COMPETING_LEASE'),
        ('freeze', "INSERT INTO engine_maintenance_break(enforce_freeze,announced_at,phase,break_started_at,break_ends_at) VALUES(true,now()-interval '3 minutes','counting_down',now(),now()+interval '5 minutes');", 'PLATFORM_FROZEN'),
        ('unknown-submission', "INSERT INTO smarter_private.f06_hand_dispatch VALUES((fixture_origin_c(1401)#>>'{permit,permit_id}')::uuid,txid_current());", 'F06_RETAINED_LATER_OR_UNKNOWN_CUSTODY'),
    ]:
        probe('retired-origin-refuses-' + label, service + change + attest(), error=reason)
    # The native INSERT trigger and retirement share an absent-row lock. Neither
    # a rowless SELECT nor an attestation can let an in-flight claim slip through.
    @contextmanager
    def held(sql, finish='ROLLBACK'):
        p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
        try:
            p.stdin.write('BEGIN;'+sql+'SELECT pg_advisory_lock(19024642);\n');p.stdin.flush()
            deadline=time.monotonic()+5
            while command(cmd,"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=19024642 AND granted);").stdout.strip()!='t':
                require(p.poll() is None and time.monotonic()<deadline,'Retired origin native barrier missing');time.sleep(.01)
            yield
        finally:
            if p.poll() is None:p.stdin.write(finish+';\n');p.stdin.close();p.wait(timeout=6)
            require(p.returncode==0,p.stderr.read())
    with held(claim()):
        probe('retired-origin-claim-first',service+attest(),error='F06_RETIRED_CLAIM_BUSY')
    with held(service+attest()):
        probe('retired-origin-observe-first',claim(),error='F06_RETIRED_CLAIM_BUSY')
    for i in (1401,1402):
        run('retired-origin-observe-' + str(i),service+f"UPDATE fixture_origin_inputs SET expected=(fn_f06_attest_retired_manager_origin((fixture_origin_c(i)->>'receipt_id')::uuid,input,NULL))->'canonical' WHERE i={i};")
        run('retired-origin-commit-reply-lost-' + str(i),service+attest(i,f'(SELECT expected FROM fixture_origin_inputs WHERE i={i})'))
    run('retired-origin-replay-same-receipt',service+attest(1401,'(SELECT expected FROM fixture_origin_inputs WHERE i=1401)'))
    run('retired-origin-no-lease-restored',"SELECT count(*) FROM engine_tournament_leases WHERE tournament_id IN(fixture_origin_t(1401),fixture_origin_t(1402));",'0')
    probe('retired-origin-old-generation-fenced',claim(g="(fixture_origin_c(1401)->>'generation')::uuid"),error='F06_RETIRED_ORIGINAL_GENERATION_FENCED')
    probe('retired-origin-no-transfer-no-claim',claim(),error='F06_RETIRED_TRANSFER_REQUIRED')
    def abort(i=1401):
        return f"SELECT fn_f06_abort_retained_mtt_hands((fixture_origin_c({i})->>'receipt_id')::uuid,(SELECT expected||jsonb_build_object('retired_origin_id',fixture_origin_c({i})->>'receipt_id') FROM fixture_origin_inputs WHERE i={i}));"
    old_snapshot=build['definition']((root/build['RETAINED']).read_text(),'smarter_private.f06_retained_mtt_abort_snapshot','$function$').replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)
    probe('retired-origin-red-original-owner-cannot-use-absent-lease',old_snapshot+service+abort(),error='F06_RETAINED_LEASE_CHANGED')
    probe('retired-origin-late-changed-move',service+"UPDATE smarter_private.f06_operations SET revision=revision+1 WHERE tournament_id=fixture_origin_t(1401);"+abort(),error='F06_RETIRED_CANONICAL_CHANGED')
    for i in (1401,1402):run('retired-origin-original-zero-credit-'+str(i),service+abort(i))
    run('retired-origin-no-business-rewrite',"""SELECT bool_and(
 expected->'seats'=(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM table_seats s WHERE table_id IN(SELECT id FROM tables WHERE tournament_id=fixture_origin_t(i)))
 AND expected->'registrations'=(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM tournament_players p WHERE tournament_id=fixture_origin_t(i))
 AND expected->'operations'=(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY break_id),'[]') FROM smarter_private.f06_operations o WHERE tournament_id=fixture_origin_t(i))
 AND expected->'attempts'=(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY request_id),'[]') FROM smarter_private.f06_attempts a JOIN smarter_private.f06_operations o USING(break_id) WHERE o.tournament_id=fixture_origin_t(i))
 AND expected->'move_receipts'=(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY request_id),'[]') FROM tournament_seat_move_receipts r WHERE tournament_id=fixture_origin_t(i))) FROM fixture_origin_inputs;""",'t')
    run('retired-origin-disposition-lost-reply',service+abort())
    run('retired-origin-witness-lost-reply-after-disposition',service+attest(1401,'(SELECT expected FROM fixture_origin_inputs WHERE i=1401)'))
    run('retired-origin-local-capture-shape',(root/'scripts/ci/probes/f06-shared-hand-lane/retired-origin-fixture.sql').read_text())
    run('retired-origin-owning-freeze',"INSERT INTO engine_maintenance_break(id,enforce_freeze,announced_at,phase,break_started_at,break_ends_at,ownership_token,declared_by,reason) VALUES(true,true,now()-interval '2 minutes','counting_down',now(),now()+interval '5 minutes',md5('origin-freeze')::uuid,'8825af51','native qualification');UPDATE engine_leader SET heartbeat_at=now();")
    run('retired-origin-local-proof-store','ALTER TABLE fixture_origin_inputs ADD COLUMN local_proof jsonb,ADD COLUMN transfer_expected jsonb,ADD COLUMN transfer_receipt jsonb;UPDATE fixture_origin_inputs SET local_proof=fixture_origin_local(i);')
    def prepare(i=1401,expected='NULL'):
        return f"SELECT fn_f06_prepare_mixed_manager_custody(md5('origin-transfer{i}')::uuid,fixture_origin_t({i}),(fixture_origin_c({i})->>'generation')::uuid,md5('origin-successor{i}')::uuid,(SELECT local_proof FROM fixture_origin_inputs WHERE i={i}),{expected});"
    old_prepare=build['definition']((root/build['MIXED']).read_text(),'public.fn_f06_prepare_mixed_manager_custody','$$').replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)
    probe('retired-origin-red-original-prepare-cannot-use-absent-lease',old_prepare+service+prepare(),error='F06_MIXED_OLD_LEASE_CHANGED')
    probe('retired-origin-prepare-wrong-owner',service+"UPDATE fixture_origin_inputs SET local_proof=jsonb_set(local_proof,'{manager_id}',to_jsonb(gen_random_uuid())) WHERE i=1401;"+prepare(),error='F06_RETIRED_TRANSFER_OWNER_CHANGED')
    probe('retired-origin-prepare-missing-bank-proof',service+"UPDATE fixture_origin_inputs SET local_proof=local_proof#-'{engines,0,bank_custody}' WHERE i=1401;"+prepare(),error='F06_MIXED_BANK_CUSTODY_UNAVAILABLE')
    for i in (1401,1402):
        run('retired-origin-mixed-observe-'+str(i),service+f"UPDATE fixture_origin_inputs SET transfer_expected=(fn_f06_prepare_mixed_manager_custody(md5('origin-transfer{i}')::uuid,fixture_origin_t(i),(fixture_origin_c(i)->>'generation')::uuid,md5('origin-successor{i}')::uuid,local_proof,NULL))->'canonical' WHERE i={i};")
        run('retired-origin-mixed-commit-reply-lost-'+str(i),service+prepare(i,f'(SELECT transfer_expected FROM fixture_origin_inputs WHERE i={i})'))
        run('retired-origin-mixed-reply-readback-'+str(i),service+f"UPDATE fixture_origin_inputs SET transfer_receipt=(fn_f06_prepare_mixed_manager_custody(md5('origin-transfer{i}')::uuid,fixture_origin_t(i),(fixture_origin_c(i)->>'generation')::uuid,md5('origin-successor{i}')::uuid,local_proof,transfer_expected))->'receipt' WHERE i={i};")
    run('retired-origin-still-no-restored-leases',"SELECT count(*) FROM engine_tournament_leases WHERE tournament_id IN(fixture_origin_t(1401),fixture_origin_t(1402));",'0')
    run('retired-origin-native-thaw-fixture',"DELETE FROM engine_maintenance_break WHERE ownership_token=md5('origin-freeze')::uuid;")
    probe('retired-origin-unselected-generation',claim(),error='F06_RETIRED_SUCCESSOR_FENCED')
    def manager(i):
        return service+f"SET app.smarter_data_actor='tournament-manager';SET app.smarter_tournament_id='{events[i-1401]}';SET app.smarter_tournament_lease_generation='"+__import__('uuid').UUID(hashlib.md5(f'origin-successor{i}'.encode()).hexdigest()).__str__()+"';"
    def admit(i):
        return f"SELECT fn_f06_admit_mixed_manager_custody(fixture_origin_t({i}),md5('origin-successor{i}')::uuid,md5('origin-transfer{i}')::uuid,(SELECT transfer_receipt FROM fixture_origin_inputs WHERE i={i}));"
    def complete(i):
        return f"SELECT fn_f06_complete_mixed_manager_custody(fixture_origin_t({i}),md5('origin-successor{i}')::uuid,md5('origin-transfer{i}')::uuid,(SELECT transfer_receipt FROM fixture_origin_inputs WHERE i={i}));"
    for i in (1401,1402):
        run('retired-origin-selected-real-claim-'+str(i),claim(i,g=f"md5('origin-successor{i}')::uuid"),'t')
        run('retired-origin-admit-reply-lost-'+str(i),manager(i)+admit(i))
        run('retired-origin-admit-exact-replay-'+str(i),manager(i)+admit(i))
        probe('retired-origin-partial-different-process-'+str(i),claim(i,g=f"md5('origin-successor{i}')::uuid",process="'other-process'"),error='F06_RETIRED_PARTIAL_PROCESS_CHANGED')
        probe('retired-origin-partial-absent-row-'+str(i),f"DELETE FROM engine_tournament_leases WHERE tournament_id=fixture_origin_t({i});"+claim(i,g=f"md5('origin-successor{i}')::uuid"),error='F06_RETIRED_PARTIAL_PROCESS_CHANGED')
        probe('retired-origin-partial-acquisition-changed-'+str(i),f"UPDATE engine_tournament_leases SET acquired_at=now()+interval '1 second' WHERE tournament_id=fixture_origin_t({i});",error='F06_RETIRED_PARTIAL_PROCESS_CHANGED')
        probe('retired-origin-partial-expired-row-'+str(i),f"UPDATE engine_tournament_leases SET heartbeat_at=now()-interval '31 seconds' WHERE tournament_id=fixture_origin_t({i});"+claim(i,g=f"md5('origin-successor{i}')::uuid"),error='F06_RETIRED_PARTIAL_PROCESS_CHANGED')
        probe('retired-origin-completion-before-canonical-close-'+str(i),manager(i)+complete(i),error='F06_MIXED_RECOVERY_INCOMPLETE')
        # The first real continuation closes the same original break after its
        # original winning moves. Separate transactions model a lost response.
        close=f"SELECT fn_f06_close_break(fixture_origin_t({i}),md5('origin-successor{i}')::uuid,md5('rm-break{i}:2')::uuid)->>'state';"
        run('retired-origin-first-original-rpc-reply-lost-'+str(i),manager(i)+close,'close_confirmed')
        durable_close=f"SELECT jsonb_build_object('operation',to_jsonb(o),'source',to_jsonb(t)) FROM smarter_private.f06_operations o JOIN tables t ON t.id=o.source_table_id WHERE o.break_id=md5('rm-break{i}:2')::uuid;"
        original_outcome=run('retired-origin-committed-close-readback-'+str(i),durable_close)
        run('retired-origin-first-original-rpc-exact-replay-'+str(i),manager(i)+close,'close_confirmed')
        run('retired-origin-close-one-effect-'+str(i),durable_close,original_outcome)
        run('retired-origin-canonical-custody-'+str(i),manager(i)+f"SELECT fn_f06_claim_custody(fixture_origin_t({i}),md5('origin-successor{i}')::uuid,md5('rm-break{i}:2')::uuid,md5('origin-final-custody{i}')::uuid,1);")
        run('retired-origin-canonical-ack-'+str(i),manager(i)+f"SELECT fn_f06_ack_cleanup(fixture_origin_t({i}),md5('origin-successor{i}')::uuid,md5('rm-break{i}:2')::uuid,md5('origin-final-custody{i}')::uuid,2,'retired')->>'state';",'acknowledged')
        run('retired-origin-completion-reply-lost-'+str(i),manager(i)+complete(i))
        run('retired-origin-completion-replay-'+str(i),manager(i)+complete(i))
        run('retired-origin-original-requests-preserved-'+str(i),f"SELECT expected->'attempts'=(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY request_id),'[]') FROM smarter_private.f06_attempts a JOIN smarter_private.f06_operations o USING(break_id) WHERE o.tournament_id=fixture_origin_t({i})) FROM fixture_origin_inputs WHERE i={i};",'t')
        run('retired-origin-later-ordinary-restart-'+str(i),f"DELETE FROM engine_tournament_leases WHERE tournament_id=fixture_origin_t({i});"+claim(i,g=f"md5('origin-later{i}')::uuid",process="'later-process'"),'t')
    probe('retired-origin-immutable',"UPDATE smarter_private.f06_retired_manager_origins SET physical_proof='{}';",error='F06_ABORT_RECEIPT_IMMUTABLE')
    run('retired-origin-generic-unchanged',"SELECT md5(pg_get_functiondef('fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)'::regprocedure));",old_body)
    catalog=json.loads(run('retired-origin-service-readonly-catalog',"BEGIN READ ONLY;SET ROLE service_role;"+service+"SELECT fn_f06_mixed_custody_contract();COMMIT;"))
    require(len(catalog['functions'])==24 and all(x['definition_md5'] and x['body_md5'] and x['owner']=='postgres' for x in catalog['functions']),'Retired origin catalogue incomplete')
    (out/'qualified-service-contract.json').write_text(json.dumps(catalog,indent=2)+'\n')
    results['retiredOrigin']={'passed':True,'leaseRestored':False,'originalOperationIdsPreserved':True,'committedLostReply':['witness','disposition','transfer','admission','original close','completion'],'laterOrdinaryRestart':True,
        'positivePhysicalProof':'Synthetic native packet; actual production packet remains separately required',
        'claimRaceOrders':['claim-first','observe-first'],'source_sha256':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [migration,root/build['AUTHORITY'],root/build['COHORTS'],root/'scripts/ci/build-f06-retired-origin.py',__import__('pathlib').Path(__file__),root/'scripts/ci/probes/f06-shared-hand-lane/retired-origin-fixture.sql',root/'scripts/ci/test-f06-shared-hand-lane.py',root/'scripts/ci/classify-ci-changes.mjs',root/'tests/unit/fixtureNativeCi.test.ts',root/'scripts/ci/schema-manifest.d/f06-retired-origin.json']}}
