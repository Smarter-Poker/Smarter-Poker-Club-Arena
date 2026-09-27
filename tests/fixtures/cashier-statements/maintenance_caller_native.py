"""Actual maintenance caller graph, executed only in the owned native fixture."""
import json


def qualify(q, run, argv, fixture, root, online, index_migration):
    capture = json.loads((fixture / 'maintenance-caller-capture.json').read_text())
    guards = json.loads((fixture / 'ddl-guard-capture.json').read_text())
    for table in ('engine_maintenance_break', 'engine_maintenance_thaws'):
        columns = [c['name'] + ' ' + c['type'] for c in capture['columns'] if c['table'] == table]
        q('CREATE TABLE public.' + table + '(' + ','.join(columns) + ')')
    q(capture['auth_role'])
    for fn in capture['functions']:
        q(fn['definition'])
        q('REVOKE ALL ON FUNCTION public.' + fn['proname'] + '() FROM PUBLIC,anon,authenticated,service_role')
        recipients = ['postgres']
        if fn['proname'] != 'fn_entry_purchases_frozen':
            recipients.append('anon')
        recipients.extend(['authenticated', 'service_role'])
        q('GRANT EXECUTE ON FUNCTION public.' + fn['proname'] + '() TO ' + ','.join(recipients))
        assert q("SELECT md5(pg_get_functiondef('public." + fn['proname'] + "()'::regprocedure))") == fn['definition_md5']
    q("CREATE FUNCTION public.fn_ca_stage_b_ledger_bootstrap_allowed(text,text,text) RETURNS boolean LANGUAGE sql AS $$SELECT false$$")
    for fn in guards['functions']:
        q(fn['definition'])
        assert q("SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='" + fn['proname'] + "'") == fn['md5']
    q('CREATE ROLE cli_cashier_fixture LOGIN NOSUPERUSER; GRANT postgres TO cli_cashier_fixture')
    q('CREATE ROLE cli_login_postgres_impostor LOGIN NOSUPERUSER')
    q('CREATE ROLE cashier_no_set LOGIN NOSUPERUSER; GRANT postgres TO cashier_no_set WITH INHERIT FALSE, SET FALSE')
    q('ALTER ROLE authenticated LOGIN; ALTER ROLE anon LOGIN; ALTER ROLE service_role LOGIN')

    def role_query(role, sql, expected=None):
        args = list(argv())
        args[args.index('-U') + 1] = role
        return run(args, sql, expected)

    prefix = 'SET SESSION ROLE postgres; '
    # Exact original graph reproduces production: no substitute freeze function
    # and no JWT role supplied to a native administrator session.
    role_query('cli_cashier_fixture', prefix + 'SELECT public.fn_entry_purchases_frozen()',
               'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REQUIRED')
    original = q("SELECT jsonb_build_object('oid',oid,'acl',proacl,'config',proconfig,'owner',proowner,'definer',prosecdef) FROM pg_proc WHERE oid='fn_active_maintenance_release_boundary()'::regprocedure")
    original_definition = q("SELECT pg_get_functiondef('fn_active_maintenance_release_boundary()'::regprocedure)")
    dependency_catalog = q("SELECT jsonb_agg(jsonb_build_object('oid',oid,'def',pg_get_functiondef(oid),'acl',proacl,'config',proconfig)) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('fn_entry_purchases_frozen','fn_platform_frozen','fn_ca_break_window_refuses_migrations','fn_ca_break_window_ddl_guard')")
    migration = (root / 'supabase/migrations/20260927001258_maintenance_release_boundary_trusts_supported_database_role_.sql').read_text()
    q(migration.replace('COMMIT;', 'ROLLBACK;'))
    assert q("SELECT pg_get_functiondef('fn_active_maintenance_release_boundary()'::regprocedure)") == original_definition
    q("UPDATE pg_proc SET prosrc=prosrc||E'\n-- local source drift' WHERE oid='fn_active_maintenance_release_boundary()'::regprocedure")
    q(migration, 'MAINTENANCE_CLI_CALLER_PREIMAGE_DRIFT')
    q(original_definition)
    q(migration)
    q(migration, 'MAINTENANCE_CLI_CALLER_PREIMAGE_DRIFT')
    assert q("SELECT jsonb_build_object('oid',oid,'acl',proacl,'config',proconfig,'owner',proowner,'definer',prosecdef) FROM pg_proc WHERE oid='fn_active_maintenance_release_boundary()'::regprocedure") == original
    assert q("SELECT jsonb_agg(jsonb_build_object('oid',oid,'def',pg_get_functiondef(oid),'acl',proacl,'config',proconfig)) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('fn_entry_purchases_frozen','fn_platform_frozen','fn_ca_break_window_refuses_migrations','fn_ca_break_window_ddl_guard')") == dependency_catalog
    assert role_query('cli_cashier_fixture', prefix + 'SELECT public.fn_entry_purchases_frozen()').endswith('f')
    # A lookalike login name and membership without SET privilege remain denied.
    q('GRANT EXECUTE ON FUNCTION public.fn_active_maintenance_release_boundary() TO cli_login_postgres_impostor,cashier_no_set')
    for role in ('cli_login_postgres_impostor', 'cashier_no_set', 'anon', 'authenticated'):
        role_query(role, 'SELECT public.fn_active_maintenance_release_boundary()',
                   'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REQUIRED')
    for role in ('anon', 'authenticated', 'service_role'):
        assert role_query(role, "SET request.jwt.claim.role='" + role + "'; SELECT public.fn_active_maintenance_release_boundary() IS NULL").endswith('t')
    role_query('cli_cashier_fixture', prefix + "SET request.jwt.claim.role='invalid'; SELECT public.fn_active_maintenance_release_boundary()",
               'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REFUSED')
    q('REVOKE EXECUTE ON FUNCTION public.fn_active_maintenance_release_boundary() FROM cli_login_postgres_impostor,cashier_no_set')
    assert q("SELECT jsonb_build_object('oid',oid,'acl',proacl,'config',proconfig,'owner',proowner,'definer',prosecdef) FROM pg_proc WHERE oid='fn_active_maintenance_release_boundary()'::regprocedure") == original
    q('REVOKE postgres FROM cli_cashier_fixture; GRANT EXECUTE ON FUNCTION public.fn_active_maintenance_release_boundary() TO cli_cashier_fixture')
    role_query('cli_cashier_fixture', 'SELECT public.fn_active_maintenance_release_boundary()', 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REQUIRED')
    q('REVOKE EXECUTE ON FUNCTION public.fn_active_maintenance_release_boundary() FROM cli_cashier_fixture; GRANT postgres TO cli_cashier_fixture')

    # Native data is disposable. The production source's own required key list
    # is asserted independently below, including incomplete and expired proofs.
    steps = ['sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
             'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
             'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
             'cluster_break_eligible_since','cluster_move_expires_at',
             'reconnect_presence','reconnect_snapshots']
    complete = json.dumps(dict(complete=True, **{s: True for s in steps}))
    q("INSERT INTO engine_maintenance_thaws(contract_version,release_target_at,shifted) VALUES(3,clock_timestamp()+interval '10 minutes','" + complete + "'::jsonb)")
    assert role_query('cli_cashier_fixture', prefix + 'SELECT public.fn_entry_purchases_frozen() AND public.fn_platform_frozen()').endswith('t')
    for step in steps:
        q("UPDATE engine_maintenance_thaws SET shifted=shifted-'" + step + "'")
        assert role_query('cli_cashier_fixture', prefix + 'SELECT public.fn_active_maintenance_release_boundary() IS NULL').endswith('t')
        q("UPDATE engine_maintenance_thaws SET shifted='" + complete + "'::jsonb")
    for change in ["contract_version=2", "release_target_at=clock_timestamp()-interval '1 minute'", "shifted=jsonb_set(shifted,'{complete}','false')"]:
        q('BEGIN; UPDATE engine_maintenance_thaws SET ' + change + '; SELECT assert_true(fn_active_maintenance_release_boundary() IS NULL,\'invalid certificate refused\'); ROLLBACK;')
    q('TRUNCATE engine_maintenance_thaws')
    q("SELECT assert_true(fn_ca_break_window_refuses_migrations('2026-09-26T12:03:00Z') IS NULL,'normal admission'); SELECT assert_true(fn_ca_break_window_refuses_migrations('2026-09-26T12:49:59Z') IS NULL,'pre-break admission'); SELECT assert_true(fn_ca_break_window_refuses_migrations('2026-09-26T12:50:00Z') IS NOT NULL AND fn_ca_break_window_refuses_migrations('2026-09-26T13:02:59Z') IS NOT NULL,'hourly refusal')")
    q("INSERT INTO engine_maintenance_break(phase,enforce_freeze,announced_at) VALUES('last_hand',true,clock_timestamp())")
    assert role_query('cli_cashier_fixture', prefix + "SELECT fn_ca_break_window_refuses_migrations('2026-09-26T12:20:00Z') IS NOT NULL").endswith('t')
    q('CREATE EVENT TRIGGER ca_break_window_refuses_ddl ON ddl_command_end EXECUTE FUNCTION public.fn_ca_break_window_ddl_guard(); CREATE EVENT TRIGGER ca_break_window_refuses_drops ON sql_drop EXECUTE FUNCTION public.fn_ca_break_window_ddl_guard()')
    role_query('cli_cashier_fixture', prefix + online, 'migration refused:')
    artifact = q("SELECT coalesce((SELECT json_build_object('valid',indisvalid,'ready',indisready,'live',indislive)::text FROM pg_index WHERE indexrelid=to_regclass('idx_chip_tx_club_time_totals')),'absent')")
    print('PASS: exact native CLI caller still refused during real frozen entry; durable index=' + artifact, flush=True)
    if artifact != 'absent':
        q('DROP INDEX CONCURRENTLY idx_chip_tx_club_time_totals')
    q(online)
    role_query('cli_cashier_fixture', prefix + index_migration, 'migration refused:')
    print(q("SELECT json_build_object('boundary_definition_md5',md5(pg_get_functiondef('fn_active_maintenance_release_boundary()'::regprocedure)),'boundary_source_md5',(SELECT md5(prosrc) FROM pg_proc WHERE oid='fn_active_maintenance_release_boundary()'::regprocedure))"), flush=True)
    print('PASS: actual maintenance caller graph; exact preimage/rollback, SET privilege only, browser/JWT parity, complete thaw proof and freeze refusal', flush=True)
