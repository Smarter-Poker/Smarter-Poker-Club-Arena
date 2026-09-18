"""Stock PostgreSQL isolation schedules for one finite Breakfast operation."""
from breakfast_qualification import OPERATION
from breakfast_original_witness import js


def qualify(e, template, expected, binary, verify_sql):
    # Stock isolationtester braces delimit SQL blocks even inside JSON strings.
    # Load exact fixture values separately; the scheduled calls still invoke
    # the real application owner with its original input and full verifier.
    expression = "public.fn_complete_breakfast_original_witness('"+OPERATION+"',breakfast_race_fixture.expected())"
    other = "public.fn_complete_breakfast_original_witness('b0000000-0000-4000-8000-000000000002',breakfast_race_fixture.expected())"
    if not verify_sql.startswith('DO $closed$') or not verify_sql.endswith('END $closed$;\n'):
        raise ValueError('exact closure verifier boundary changed')
    fixtures = 'CREATE SCHEMA breakfast_race_fixture; CREATE FUNCTION breakfast_race_fixture.expected() RETURNS jsonb LANGUAGE sql AS $input$ SELECT '+js(expected)+' $input$;\n'
    fixtures += 'CREATE FUNCTION breakfast_race_fixture.verify() RETURNS void LANGUAGE plpgsql AS $oracle$'+verify_sql[len('DO $closed$'):-len('$closed$;\n')]+'$oracle$;\n'
    success = "DO $case$ DECLARE r jsonb; BEGIN r:="+expression+"; IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'BREAKFAST_RACE_BAD_RECEIPT: %',r; END IF; RAISE NOTICE 'BREAKFAST_RACE_OPERATION_OK'; END $case$;"
    mismatch = "DO $case$ DECLARE msg text; BEGIN BEGIN PERFORM "+other+"; RAISE EXCEPTION 'EXPECTED_MISMATCH_ABSENT'; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT; IF msg<>'BREAKFAST_REPLAY_MISMATCH' THEN RAISE; END IF; END; RAISE NOTICE 'BREAKFAST_RACE_OTHER_OPERATION_REFUSED'; END $case$;"
    spec = '''session "original"
setup { SET application_name='breakfast-original'; SELECT set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,false); }
step "original_begin" { BEGIN; }
step "original_finish" { '''+success+''' }
step "wait_proven" {
 DO $proof$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.application_name='breakfast-contender'
 AND a.wait_event_type='Lock' AND a.wait_event='advisory'
 AND pg_backend_pid()=ANY(pg_blocking_pids(a.pid))) THEN
 RAISE EXCEPTION 'BREAKFAST_REAL_LANE_WAIT_NOT_PROVEN'; END IF;
 RAISE NOTICE 'BREAKFAST_REAL_LANE_WAIT_PROVEN'; END $proof$;
}
step "original_commit" { COMMIT; }
step "original_rollback" { ROLLBACK; }
session "contender"
setup { SET application_name='breakfast-contender'; SELECT set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,false); }
step "same_operation" { '''+success+''' }
step "different_operation" { '''+mismatch+''' }
step "verify_final" { SELECT breakfast_race_fixture.verify(); }
'''
    permutations = {
        'same-operation-after-commit': '"original_begin" "original_finish" "same_operation" "wait_proven" "original_commit" "verify_final"',
        'same-operation-after-rollback': '"original_begin" "original_finish" "same_operation" "wait_proven" "original_rollback" "verify_final"',
        'different-operation-after-commit': '"original_begin" "original_finish" "different_operation" "wait_proven" "original_commit" "verify_final"',
    }
    for label, schedule in permutations.items():
        db = e.database(template)
        e.sql(db,fixtures,label='race-inputs-'+label)
        text = spec + '\npermutation ' + schedule + '\n'
        (e.output / ('race-'+label+'.spec')).write_text(text)
        code, stdout, stderr = e.run('race-'+label,
            [binary, f'host={e.socket} port={e.port} dbname={db} user=postgres'],
            text=text, seconds=45, check=False)
        combined=stdout+'\n'+stderr
        if code or 'ERROR:' in combined or '<waiting ...>' not in combined or \
                'BREAKFAST_REAL_LANE_WAIT_PROVEN' not in combined or \
                'BREAKFAST_FULL_CLOSURE_PASS' not in combined:
            raise AssertionError('exact native race failed: '+label)
        if label.startswith('different-') and 'BREAKFAST_RACE_OTHER_OPERATION_REFUSED' not in combined:
            raise AssertionError('other operation did not refuse after owner committed')
        e.discard(db)
        e.report['races'].append({'case': label, 'passed': True,
            'actual_advisory_wait_observed': True, 'committed_in_private_database': True,
            'database_removed': True})
