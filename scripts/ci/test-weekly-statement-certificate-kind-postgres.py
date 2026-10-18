#!/usr/bin/env python3
"""Finite exact-migration certificate-kind regression on owned PostgreSQL 17.
No production connection. Every cluster/socket/transient is under --scratch.
Actual table, writer, reader and lifetime fixture bytes are retained alongside.
Installer environment predicates are explicit controlled native boundaries;
production source40/generation acceptance still requires installer readback.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
DEFAULT_REPO = Path(__file__).resolve().parents[2]
OLD = '923b63b9f2735497f2fe408c519c1267'
NEW = 'be81406a7d1b6bb24d6330cd60b866a6'
U = 'fade0000-0000-0000-0000-000000000001'
A = '2026-10-05 07:00Z'
B = '2026-10-12 07:00Z'
C1 = 'a0000000-0000-0000-0000-000000000001'
C2 = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
KINDS = ['earned_plan', 'pnl_boundary', 'pnl_flows', 'pnl_touched',
         'pnl_clubs', 'pnl_boundary_problem', 'pnl_flows_problem',
         'pnl_touched_problem', 'pnl_clubs_problem']


def need(ok, message):
    if not ok:
        raise AssertionError(message)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--migrationfile', '--candidate-migration', dest='migration', type=Path,
                   default=DEFAULT_REPO / 'supabase/migrations/20261018142435_weekly_statement_quality_certificate_kind.sql')
    p.add_argument('--fixture-root', type=Path,
                   default=HERE / 'fixtures/weekly-statement-certificate-kind',
                   help='Maintained fixture directory; pass own fixtures explicitly for offline peer execution')
    p.add_argument('--pg-bin', type=Path, default=Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin')))
    p.add_argument('--scratch', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    need(__debug__, 'optimized native driver refused')
    need(args.scratch.is_dir(), 'existing owned scratch required')
    need(not args.output.exists(), 'new output directory required')
    raw = args.migration.read_bytes()
    migration = raw.decode()
    repo = args.migration.resolve().parents[2]
    producer = list((repo / 'supabase/migrations').glob('20261017223358_*.sql'))
    need(len(producer) == 1, 'one actual installed producer source required')
    producer_bytes = producer[0].read_bytes()
    need(len(producer_bytes) == 28291 and hashlib.md5(producer_bytes).hexdigest() == '88e709123e442ba60696eabbc9522666',
         'actual installed producer bytes required')
    authority = json.loads((args.fixture_root / 'actual-authority-1424.json').read_text())[0]['certificate_authority']
    fixture = (args.fixture_root / 'actual-table-writer-reader-lifetime.sql').read_text()
    old_constraint = next(x['definition'] for x in authority['constraints'] if x['name'] == 'accounting_close_certificates_kind_check')
    actual_functions = [x for x in authority['functions'] if x['signature'].startswith(
        ('fn_accounting_close_certificate(', 'fn_accounting_close_certify(', 'fn_accounting_close_proof_lifetime('))]
    root = Path(tempfile.mkdtemp(prefix='ck-', dir=args.scratch.resolve()))
    data = root / 'd'
    started = False
    cases = []
    result = None
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    env.update(TMPDIR=str(root), TEMP=str(root), TMP=str(root), LC_ALL='C')
    cmd = [args.pg_bin / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
           '-v', 'VERBOSITY=verbose', '-h', root, '-U', 'postgres', '-d', 'postgres']
    if len(str(root).encode()) >= 90:
        shutil.rmtree(root)
        raise ValueError('scratch path too long for owned UNIX socket')

    def run(argv, sql=None, error=None):
        r = subprocess.run([str(x) for x in argv], input=sql, text=True,
                           capture_output=True, env=env, timeout=60)
        if error:
            need(r.returncode != 0 and error in r.stderr, r.stdout + r.stderr)
        else:
            need(r.returncode == 0, r.stdout + r.stderr)
        return r.stdout.strip()

    def q(sql, error=None):
        return run(cmd, sql, error)

    def lit(value):
        return "'" + value.replace("'", "''") + "'"

    def record(name):
        cases.append(name)

    def constraint():
        return q("SELECT md5(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid='public.accounting_close_certificates'::regclass AND conname='accounting_close_certificates_kind_check'")

    def protected_state():
        return q("""SELECT jsonb_build_object(
        'rows',(SELECT coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('physical_xmin',c.xmin::text,'physical_ctid',c.ctid::text)ORDER BY kind,union_id,period_start,period_end),'[]')FROM public.accounting_close_certificates c),
        'table',(SELECT jsonb_build_array(relowner,relacl,relrowsecurity,relforcerowsecurity,relpersistence)FROM pg_class WHERE oid='public.accounting_close_certificates'::regclass),
        'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid,md5(pg_get_functiondef(p.oid)),p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig)ORDER BY p.oid)FROM pg_proc p WHERE p.oid IN(
         'public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)'::regprocedure,
         'public.fn_accounting_close_certify(text,uuid,timestamptz,timestamptz,jsonb)'::regprocedure,
         'public.fn_accounting_close_proof_lifetime()'::regprocedure)))""")

    def certify(kind, value='{"status":"ready","fixture":"actual-canonical-writer"}', error=None):
        k = 'NULL::text' if kind is None else lit(kind)
        v = 'NULL::jsonb' if value is None else lit(value) + '::jsonb'
        return q("BEGIN;SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.accounting_close_memo='on';"
                 "SELECT public.fn_accounting_close_certify(" + k + ",'" + U + "','" + A + "','" + B + "'," + v + ");COMMIT;", error)

    def getter(kind):
        return q("BEGIN;SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.accounting_close_memo='on';"
                 "SELECT coalesce(public.fn_accounting_close_certificate(" + lit(kind) + ",'" + U + "','" + A + "','" + B + "')::text,'NULL');ROLLBACK;").splitlines()[-1]

    try:
        need(' 17.' in run([args.pg_bin / 'postgres', '--version']), 'PostgreSQL 17 required')
        run([args.pg_bin / 'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust',
             '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
        with (data / 'postgresql.conf').open('a') as f:
            f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(root).replace("'", "''") +
                    "'\nshared_buffers='16MB'\nwork_mem='4MB'\nmaintenance_work_mem='16MB'\n")
        run([args.pg_bin / 'pg_ctl', '-D', data, '-l', root / 'server.log', '-w', 'start'])
        started = True
        q(fixture)
        q("""ALTER TABLE public.accounting_close_certificates ENABLE ROW LEVEL SECURITY;
        REVOKE ALL ON public.accounting_close_certificates FROM PUBLIC,anon,authenticated;
        GRANT ALL ON public.accounting_close_certificates TO postgres,service_role;
        CREATE SCHEMA auth;
        CREATE FUNCTION auth.uid()RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('native.auth_uid',true),'')::uuid$$;
        CREATE FUNCTION public.fn_ca_break_window_refuses_migrations(timestamptz)RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('native.window_refusal',true),'')$$;
        CREATE FUNCTION public.fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('native.frozen',true)='on',false)$$;
        CREATE FUNCTION public.fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('native.boundary',true),'')::timestamptz$$;
        CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('native.sources_match',true)IS DISTINCT FROM 'off'$$;""")
        q("INSERT INTO supabase_migrations.schema_migrations VALUES('20261017223358','actual_installed_producer',ARRAY[" + lit(producer_bytes.decode()) + "]);")
        for f in actual_functions:
            need(q("SELECT md5(pg_get_functiondef('public." + f['signature'] + "'::regprocedure))") == f['full_md5'],
                 'actual function preimage mismatch ' + f['signature'])
        need(constraint() == OLD, 'actual PG17 original constraint mismatch')
        for kind in KINDS:
            certify(kind)
        before = protected_state()
        certify('club_statement_quality:' + C1, error='23514')
        need(protected_state() == before and constraint() == OLD, 'failed original writer changed fixture')
        record('actual_writer_fails_23514_before_and_preserves_nine_existing_rows')

        def refused(prefix, error):
            snap = protected_state()
            q(prefix + migration, error)
            need(constraint() == OLD and protected_state() == snap, 'refused installer changed table/rows/functions')

        refused("SET request.jwt.claims='{}';", 'weekly_statement_kind_operator_refused')
        refused("SET native.auth_uid='" + C1 + "';", 'weekly_statement_kind_operator_refused')
        record('installer_actor_and_claim_refusals')
        refused("SET native.frozen='on';", 'weekly_statement_kind_window_refused')
        refused("SET native.window_refusal='native break';", 'weekly_statement_kind_window_refused')
        refused("SET native.boundary='2026-10-18 14:00Z';", 'weekly_statement_kind_window_refused')
        record('installer_freeze_window_boundary_refusals')
        q("INSERT INTO supabase_migrations.schema_migrations VALUES('20261018142435','native_existing',ARRAY['already']);")
        refused('', 'weekly_statement_kind_history_replay')
        q("DELETE FROM supabase_migrations.schema_migrations WHERE version='20261018142435';")
        record('installer_existing_history_replay_refused')
        q("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['wrong'] WHERE version='20261017223358';")
        refused('', 'weekly_statement_kind_installed_producer_required')
        q("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY[" + lit(producer_bytes.decode()) + "] WHERE version='20261017223358';")
        record('installer_wrong_producer_bytes_refused')
        q("ALTER TABLE public.accounting_close_certificates DROP CONSTRAINT accounting_close_certificates_kind_check,ADD CONSTRAINT accounting_close_certificates_kind_check CHECK(kind IS NOT NULL);")
        q(migration, 'weekly_statement_kind_exact_preimage_required')
        q("ALTER TABLE public.accounting_close_certificates DROP CONSTRAINT accounting_close_certificates_kind_check,ADD CONSTRAINT accounting_close_certificates_kind_check " + old_constraint + ";")
        need(constraint() == OLD, 'old exact constraint restore failed')
        writer = next(f for f in actual_functions if f['signature'].startswith('fn_accounting_close_certify('))
        writer_header = writer['definition'].split('AS $function$', 1)[0]
        q(writer_header + 'AS $function$BEGIN RETURN;END$function$;')
        refused('', 'weekly_statement_kind_current_authority_required')
        q(writer['definition'].rstrip() + ';')
        need(protected_state() == before, 'exact actual writer restore changed protected state')
        refused("SET native.sources_match='off';", 'weekly_statement_kind_current_authority_required')
        record('installer_preimage_and_source_authority_refusals')

        holder = subprocess.Popen([str(x) for x in cmd], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, env=env, bufsize=1)
        try:
            holder.stdin.write("SELECT pg_advisory_lock(hashtextextended('union-accounting-scheduler',0));\n\\echo LOCKED\n")
            holder.stdin.flush()
            deadline = time.monotonic() + 4
            locked = False
            holder_output = b''
            while time.monotonic() < deadline:
                if select.select([holder.stdout], [], [], 0.2)[0]:
                    holder_output += os.read(holder.stdout.fileno(), 4096)
                    if b'LOCKED' in holder_output:
                        locked = True
                        break
            need(locked, 'fixture scheduler lock was not acquired')
            refused('', 'weekly_statement_kind_scheduler_owned')
            record('installer_actual_competing_scheduler_lock_refused')
        finally:
            try:
                holder.stdin.write("SELECT pg_advisory_unlock(hashtextextended('union-accounting-scheduler',0));\n\\q\n")
                holder.stdin.flush()
                holder.communicate(timeout=8)
            except (subprocess.TimeoutExpired, BrokenPipeError):
                holder.kill()
                holder.communicate(timeout=3)
        # Exact candidate except one intentionally false postimage guard, in this
        # disposable native fixture only: prove ALTER rolls back when it refuses.
        index = migration.rfind(NEW)
        need(index >= 0, 'candidate exact postimage assertion required')
        fault = migration[:index] + '0' * 32 + migration[index + len(NEW):]
        q(fault, 'weekly_statement_kind_postimage_required')
        need(constraint() == OLD and protected_state() == before, 'failed postcondition did not roll back ALTER')
        record('installer_failed_postcondition_rolls_back_exact_constraint_and_rows')
        q(migration)
        need(constraint() == NEW, 'actual PG17 candidate postimage differs from maintained live proof')
        need(protected_state() == before, 'successful DDL changed rows/table/function authority')
        record('actual_candidate_installs_exact_postimage_without_row_or_function_changes')
        certify('club_statement_quality:' + C1)
        certify('club_statement_quality:' + C2)
        for club in [C1, C2]:
            need(json.loads(getter('club_statement_quality:' + club))['status'] == 'ready',
                 'same canonical writer/getter roundtrip not READY')
        record('two_actual_club_uuid_suffixes_writer_getter_roundtrip_ready')
        for kind in KINDS:
            need(json.loads(getter(kind))['status'] == 'ready', 'old kind stopped working')
        invalid = ['club_statement_quality', 'club_statement_quality:', 'club_statement_quality:not-a-uuid',
                   'club_statement_quality:' + C2.upper(), 'Club_statement_quality:' + C1,
                   'club_statement_quality:' + C1 + ':extra', 'club_statement_quality:' + C1 + '\n',
                   'other:' + C1]
        for kind in invalid:
            certify(kind, error='23514')
        certify(None, error='23502')
        record('all_nine_old_kinds_preserved_malformed_case_prefix_uuid_null_refused')
        certify('club_statement_quality:' + C1, '{"status":"ready","marker":"new_payload"}')
        need(json.loads(getter('club_statement_quality:' + C1))['marker'] == 'new_payload', 'UPSERT payload lost')
        need(q("SELECT count(*)FROM public.accounting_close_certificates WHERE kind=" + lit('club_statement_quality:' + C1)) == '1', 'duplicate key created')
        snap = protected_state()
        certify('club_statement_quality:' + C1, None)
        q("BEGIN;SET LOCAL app.weekly_accounting_chunked='off';SET LOCAL app.accounting_close_memo='on';SELECT public.fn_accounting_close_certify('unused','" + U + "','" + A + "','" + B + "','{}');COMMIT;")
        need(protected_state() == snap, 'NULL payload or disabled writer changed rows')
        record('actual_upsert_identity_payload_and_guc_null_noop_contract_preserved')
        q("UPDATE public.accounting_close_certificates SET certified_at=clock_timestamp()-interval '13 hours' WHERE kind=" + lit('club_statement_quality:' + C1))
        need(getter('club_statement_quality:' + C1) == 'NULL', 'actual generic reader 12-hour stale rule changed')
        certify('club_statement_quality:' + C1, '{"status":"blocked","_original_inventory_generation":"wrong-native-generation"}')
        payload = json.loads(getter('club_statement_quality:' + C1))
        need(payload == {'status': 'blocked', '_original_inventory_generation': 'wrong-native-generation'},
             'generic getter invented a status/generation policy')
        need(payload['status'] != 'ready', 'actual caller READY comparison must still refuse blocked')
        need(q("SELECT public.fn_accounting_close_proof_lifetime()=interval '72 hours'") == 't',
             'separate ordinary report proof lifetime changed')
        record('actual_getter_12h_stale_and_payload_only_status_generation_contract_unchanged')
        after_functions = q("SELECT string_agg(md5(pg_get_functiondef(p.oid)),','ORDER BY p.proname)FROM pg_proc p WHERE p.proname IN('fn_accounting_close_certificate','fn_accounting_close_certify','fn_accounting_close_proof_lifetime')")
        expected_functions = ','.join(f['full_md5'] for f in sorted(actual_functions, key=lambda x: x['signature'].split('(')[0]))
        need(after_functions == expected_functions, 'actual canonical functions changed')
        result = {'qualification': 'passed', 'cases': cases, 'case_count': len(cases),
                  'migration_sha256': hashlib.sha256(raw).hexdigest(), 'migration_bytes': len(raw),
                  'old_constraint_md5': OLD, 'actual_post_constraint_md5': constraint(),
                  'actual_writer_reader_fixture': True, 'generic_certificate_lifetime': '12 hours',
                  'separate_report_receipt_lifetime': '72 hours',
                  'source40_and_operator_environment': 'controlled native boundary; production postread mandatory',
                  'production_financial_close_qualified': False, 'cluster_removed': True}
    finally:
        if started:
            run([args.pg_bin / 'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
        shutil.rmtree(root)
    need(result is not None and not root.exists(), 'owned native cleanup must finish')
    args.output.mkdir(parents=True)
    (args.output / 'qualification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
