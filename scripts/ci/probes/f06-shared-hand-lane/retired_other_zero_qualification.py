"""Native accepted-zero classification across the exact stopped owner cohort."""
import hashlib
import json
import re
import runpy


def qualify(root, out, cmd, command, run, probe, require, results):
    build_path = 'scripts/ci/probes/f06-shared-hand-lane/build-retired-other-zero-migration.py'
    build = runpy.run_path(str(root / build_path))
    migration = root / build['MIGRATION']
    require(migration.read_text() == build['render'](root), 'Other-table zero source composition differs')
    service = "SET request.jwt.claims='{\"role\":\"service_role\"}';SET app.smarter_data_actor='service';"
    # The existing retired qualification calls here before either original
    # disposition. Synthetic players reuse its two complete native owner packets.
    fixture = (root / 'scripts/ci/probes/f06-shared-hand-lane/retained-mtt-fixture.sql').read_text()
    atomic = re.search(r'CREATE FUNCTION fixture_retained_atomic\(.*?\$\$;', fixture, re.S)[0]
    atomic = atomic.replace('fixture_retained_atomic', 'fixture_other_zero_atomic')
    atomic = atomic.replace("md5('rm-event'||i)::uuid", 'fixture_origin_t(i)')
    atomic = atomic.replace("md5('rm-table'||i)::uuid", 'fixture_other_zero_table()')
    # Distinct keys avoid conflating this other table with the prior-hand fixture.
    atomic = atomic.replace("'rm-atomic-'", "'rz-atomic-'").replace("'rm-stack-'", "'rz-stack-'")
    run('retired-zero-fixture-functions', "CREATE FUNCTION fixture_other_zero_table() RETURNS uuid LANGUAGE sql AS $$ SELECT 'fcbbd2ea-6fc2-47df-8b61-b9997fcd7b16'::uuid $$;" + atomic + (root / 'scripts/ci/probes/f06-shared-hand-lane/retired-other-zero-fixture.sql').read_text())
    snapshot = "SELECT md5(coalesce(jsonb_agg(v ORDER BY v::text)::text,'')) FROM (SELECT to_jsonb(x) v FROM tournament_players x UNION ALL SELECT to_jsonb(x) FROM table_seats x UNION ALL SELECT to_jsonb(x) FROM hand_atomic_commits x UNION ALL SELECT to_jsonb(x) FROM hand_history x UNION ALL SELECT to_jsonb(x) FROM settlement_idempotency_keys x UNION ALL SELECT to_jsonb(x) FROM ca_settlements x UNION ALL SELECT to_jsonb(x) FROM smarter_private.f06_operations x UNION ALL SELECT to_jsonb(x) FROM smarter_private.f06_members x UNION ALL SELECT to_jsonb(x) FROM smarter_private.f06_attempts x UNION ALL SELECT to_jsonb(x) FROM tournament_seat_move_receipts x) q;"
    original_generic = run('retired-zero-generic-before', "SELECT md5(pg_get_functiondef('smarter_private.f06_retained_mtt_abort_snapshot(jsonb)'::regprocedure));")
    seed = "SELECT fixture_seed_other_zero();"
    observe = "SELECT (fn_f06_attest_retired_manager_origin((fixture_origin_c(1401)->>'receipt_id')::uuid,(SELECT input FROM fixture_origin_inputs WHERE i=1401),NULL))->'canonical';"
    probe('retired-zero-red-other-original-rejected', service + seed + observe, error='F06_RETAINED_ZERO_PROOF_CHANGED')
    run('retired-zero-forward-install', migration.read_text())
    run('retired-zero-generic-body-unchanged', "SELECT md5(pg_get_functiondef('smarter_private.f06_retained_mtt_abort_snapshot(jsonb)'::regprocedure));", original_generic)
    for label, change, error in [
        ('missing-stack-key', "DELETE FROM settlement_idempotency_keys WHERE hand_id=md5('rz-stack-zero1401')::uuid;", 'F06_RETAINED_ZERO_FINANCIAL_PROOF_CHANGED'),
        ('pending-stack-key', "UPDATE settlement_idempotency_keys SET status='in_flight' WHERE hand_id=md5('rz-stack-zero1401')::uuid;", 'F06_RETAINED_ZERO_FINANCIAL_PROOF_CHANGED'),
        ('changed-stack-key', "UPDATE settlement_idempotency_keys SET result='{}' WHERE hand_id=md5('rz-stack-zero1401')::uuid;", 'F06_RETAINED_ZERO_FINANCIAL_PROOF_CHANGED'),
        ('errored-stack-key', "UPDATE settlement_idempotency_keys SET error='native failure' WHERE hand_id=md5('rz-stack-zero1401')::uuid;", 'F06_RETAINED_ZERO_FINANCIAL_PROOF_CHANGED'),
        ('incomplete-stack-key', "UPDATE settlement_idempotency_keys SET completed_at=NULL WHERE hand_id=md5('rz-stack-zero1401')::uuid;", 'F06_RETAINED_ZERO_FINANCIAL_PROOF_CHANGED'),
        ('missing-final-settlement', "DELETE FROM ca_settlements WHERE hand_id=md5('rz-stack-zero1401')::uuid;", 'F06_RETAINED_ZERO_FINANCIAL_PROOF_CHANGED'),
        ('nonfinal-settlement', "WITH old AS (DELETE FROM ca_settlements WHERE hand_id=md5('rz-stack-zero1401')::uuid RETURNING *) INSERT INTO ca_settlements(settlement_type,external_ref,state,table_id,hand_id,idempotency_key,totals) SELECT settlement_type,external_ref,'open',table_id,hand_id,idempotency_key,totals FROM old;", 'F06_RETAINED_ZERO_FINANCIAL_PROOF_CHANGED'),
        ('other-settlement-type', "UPDATE ca_settlements SET settlement_type='other' WHERE hand_id=md5('rz-stack-zero1401')::uuid;", 'F06_RETAINED_ZERO_FINANCIAL_PROOF_CHANGED'),
        ('errored-settlement', "UPDATE ca_settlements SET error_detail='native failure' WHERE hand_id=md5('rz-stack-zero1401')::uuid;", 'F06_RETAINED_ZERO_FINANCIAL_PROOF_CHANGED'),
        ('duplicate-final-settlement', "INSERT INTO ca_settlements(settlement_type,external_ref,state,table_id,hand_id,idempotency_key,totals) SELECT settlement_type,external_ref||':duplicate',state,table_id,hand_id,idempotency_key||':duplicate',totals FROM ca_settlements WHERE hand_id=md5('rz-stack-zero1401')::uuid;", 'F06_RETAINED_ZERO_FINANCIAL_PROOF_CHANGED'),
        ('later-user-write', "UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,ARRAY['written',md5('rz-user3')::uuid::text],'0') WHERE hand_id=md5('rz-atomic-later1401')::uuid;", 'F06_RETAINED_ZERO_PROOF_CHANGED'),
        ('later-user-write-other-table', "UPDATE hand_atomic_commits SET table_id=fixture_origin_source(1401,4),stack_result=jsonb_set(stack_result,ARRAY['written',md5('rz-user3')::uuid::text],'0') WHERE hand_id=md5('rz-atomic-later1401')::uuid;", 'F06_RETAINED_ZERO_PROOF_CHANGED'),
        ('seat-generation-changed', "UPDATE table_seats SET joined_at=joined_at-interval '1 second' WHERE id=md5('rz-seat3')::uuid;", 'F06_RETAINED_ZERO_PROOF_CHANGED'),
        ('owner-table-unproved', "UPDATE fixture_origin_inputs SET input=jsonb_set(input,'{physical,engines}',(SELECT jsonb_agg(e) FROM jsonb_array_elements(input#>'{physical,engines}') e WHERE e->>'table_id'<>fixture_other_zero_table()::text)) WHERE i=1401;", 'F06_RETIRED_WHOLE_OWNER_REQUIRED'),
        ('original-engine-not-stopped', "UPDATE fixture_origin_inputs SET input=jsonb_set(input,'{physical,engines}',(SELECT jsonb_agg(CASE WHEN e->>'table_id'=fixture_other_zero_table()::text THEN e||'{\"running\":true}'::jsonb ELSE e END) FROM jsonb_array_elements(input#>'{physical,engines}') e)) WHERE i=1401;", 'F06_RETIRED_ORIGINAL_NOT_DRAINED'),
    ]:
        probe('retired-zero-refuses-' + label, service + seed + change + observe, error=error)
    # This path has an expired actual lease and only the old selected-table
    # authority. Complete-looking caller JSON must never extend its scope.
    generic = """INSERT INTO engine_tournament_leases VALUES(fixture_origin_t(1401),'1-3846b8bb','8825af51817f379c4261658ca29ecc9d8d81932d',now()-interval '2 hours',now()-interval '1 hour',(fixture_origin_c(1401)->>'generation')::uuid,2);
UPDATE fixture_origin_inputs SET input=jsonb_set(input,'{lease}',(SELECT to_jsonb(l) FROM engine_tournament_leases l WHERE tournament_id=fixture_origin_t(1401))) WHERE i=1401;
SELECT smarter_private.f06_retained_mtt_abort_snapshot(input) FROM fixture_origin_inputs WHERE i=1401;"""
    probe('retired-zero-generic-still-selected-table', service + seed + generic, error='F06_RETAINED_ZERO_PROOF_CHANGED')
    before = run('retired-zero-business-before', snapshot)
    positive = service + seed + """DO $positive$ DECLARE input jsonb; expected jsonb; answer jsonb; prior jsonb; after jsonb; BEGIN
SELECT f.input INTO input FROM fixture_origin_inputs f WHERE i=1401;
expected:=(fn_f06_attest_retired_manager_origin((fixture_origin_c(1401)->>'receipt_id')::uuid,input,NULL))->'canonical';
IF jsonb_array_length(expected->'accepted_zeros')<>1 OR expected#>>'{accepted_zeros,0,stack_key,status}' IS DISTINCT FROM 'succeeded'
 OR expected#>>'{accepted_zeros,0,stack_settlement,state}' IS DISTINCT FROM 'final'
 OR expected#>>'{accepted_zeros,0,registration,table_id}' IS DISTINCT FROM fixture_other_zero_table()::text
 OR NOT EXISTS(SELECT 1 FROM hand_atomic_commits WHERE table_id=fixture_other_zero_table() AND hand_number>(fixture_origin_c(1401)#>>'{permit,hand_number}')::bigint AND NOT stack_result->'written' ? md5('rz-user3')::uuid::text)
THEN RAISE EXCEPTION 'RETIRED_ZERO_POSITIVE_PROOF_WRONG'; END IF;
PERFORM fn_f06_attest_retired_manager_origin((fixture_origin_c(1401)->>'receipt_id')::uuid,input,expected);
prior:=fixture_other_zero_business();
expected:=expected||jsonb_build_object('retired_origin_id',fixture_origin_c(1401)->>'receipt_id');
answer:=fn_f06_abort_retained_mtt_hands((fixture_origin_c(1401)->>'receipt_id')::uuid,expected);
IF answer->'credit' IS DISTINCT FROM '0'::jsonb OR answer->>'outcome' IS DISTINCT FROM 'aborted_unsettled'
 OR answer IS DISTINCT FROM fn_f06_abort_retained_mtt_hands((fixture_origin_c(1401)->>'receipt_id')::uuid,expected)
 OR EXISTS(SELECT 1 FROM engine_tournament_leases WHERE tournament_id=fixture_origin_t(1401))
THEN RAISE EXCEPTION 'RETIRED_ZERO_DISPOSITION_WRONG'; END IF;
IF prior IS DISTINCT FROM fixture_other_zero_business() THEN RAISE EXCEPTION 'RETIRED_ZERO_FINANCIAL_OR_MIXED_CHANGED'; END IF;
IF expected->'registrations' IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM tournament_players p WHERE tournament_id=fixture_origin_t(1401))
 OR expected->'seats' IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s WHERE table_id IN(SELECT id FROM tables WHERE tournament_id=fixture_origin_t(1401)))
 OR expected->'operations' IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(o) ORDER BY break_id) FROM smarter_private.f06_operations o WHERE tournament_id=fixture_origin_t(1401))
THEN RAISE EXCEPTION 'RETIRED_ZERO_BUSINESS_CHANGED'; END IF;
END $positive$;"""
    probe('retired-zero-positive-later-other-players-zero-credit-replay', positive)
    run('retired-zero-all-business-rollback', snapshot, before)
    row = run('retired-zero-qualified-definition', "SELECT jsonb_build_object('signature','smarter_private.f06_retired_origin_snapshot(jsonb)','definition_md5',md5(pg_get_functiondef(oid)),'body_md5',md5(prosrc)) FROM pg_proc WHERE oid='smarter_private.f06_retired_origin_snapshot(jsonb)'::regprocedure;")
    (out / 'retired-zero-qualified-definition.json').write_text(row + '\n')
    results['retiredOtherZero'] = {'passed': True, 'genericBodyUnchanged': True, 'zeroCredit': True,
        'laterOtherPlayersAccepted': True, 'laterUserWriteRefused': True,
        'source_sha256': {p: hashlib.sha256((root / p).read_bytes()).hexdigest() for p in
            [build_path, build['MIGRATION'], build['PROOF'], 'scripts/ci/probes/f06-shared-hand-lane/retired-other-zero-fixture.sql',
             'scripts/ci/probes/f06-shared-hand-lane/retired_other_zero_qualification.py']}}
