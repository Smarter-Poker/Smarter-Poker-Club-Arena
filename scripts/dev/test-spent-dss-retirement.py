#!/usr/bin/env python3
"""Qualify exact spent-operation retirement without invoking any money body."""
import json, os, pathlib, shutil, socket, subprocess, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
PG = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
if not PG.exists():
    PG = pathlib.Path(subprocess.check_output(['pg_config', '--bindir'], text=True).strip())
assert subprocess.check_output([str(PG/'postgres'), '--version'], text=True).split()[2].startswith('17.')
scratch = pathlib.Path(os.environ['TMPDIR'])
cluster = pathlib.Path(tempfile.mkdtemp(prefix='dss-retire-', dir=scratch))
sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
catalog = json.loads((ROOT/'scripts/dev/spent-dss-operations/catalog.json').read_text())
migration = (ROOT/'supabase/migrations/20261013120756_spent_dss_one_off_wallet_operations_are_retired.sql').read_text()
def sql(body, ok=True):
    r = subprocess.run([str(PG/'psql'), '-X', '-h', '127.0.0.1', '-p', str(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], input=body, text=True, capture_output=True)
    if ok: assert r.returncode == 0, r.stderr
    else: assert r.returncode != 0, 'expected refusal'
    return r
def present():
    return sql("SELECT count(*) FROM pg_proc WHERE oid IN (to_regprocedure('public.ops_dss_midway_sweep(text)'),to_regprocedure('public.ops_dss_midway_go_live()'),to_regprocedure('public.ops_ledger_reset_declarations()'));").stdout.strip() == '3'
started = False
try:
    subprocess.run([str(PG/'initdb'), '-D', str(cluster/'data'), '-U', 'postgres', '-A', 'trust'], check=True, stdout=subprocess.DEVNULL)
    subprocess.run([str(PG/'pg_ctl'), '-D', str(cluster/'data'), '-l', str(cluster/'postgres.log'), '-o', f'-h 127.0.0.1 -p {port} -k ""', '-w', 'start'], check=True, stdout=subprocess.DEVNULL)
    started = True
    sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA cron; CREATE TABLE cron.job(jobid bigint,jobname text,command text); CREATE TABLE public.ca_money_rpc_registry(proname text PRIMARY KEY,status text,notes text,added_at timestamptz DEFAULT now());')
    sql((ROOT/'scripts/dev/spent-dss-operations/installed.sql').read_text())
    sql('GRANT EXECUTE ON FUNCTION public.ops_dss_midway_sweep(text), public.ops_dss_midway_go_live(), public.ops_ledger_reset_declarations() TO service_role;')
    for entry in catalog['definitions']:
        assert sql("SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE proname='"+entry['name']+"';").stdout.strip() == entry['md5']
    assert present()
    # Exact body restores after deliberately aborted successful retirement.
    sql(migration.replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'qualification_abort'; END $$;"), False)
    assert present()
    sql("CREATE FUNCTION public.ops_dss_midway_sweep(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM public.ops_ledger_reset_declarations(); END $$;")
    # The former name-only guard wrongly admits a same-name overload caller.
    old_guard = migration.replace("AND oid NOT IN ('public.ops_dss_midway_sweep(text)'::regprocedure,\n   'public.ops_dss_midway_go_live()'::regprocedure,\n   'public.ops_ledger_reset_declarations()'::regprocedure)", "AND proname NOT IN('ops_dss_midway_sweep','ops_dss_midway_go_live','ops_ledger_reset_declarations')")
    assert old_guard != migration
    assert 'qualification_abort' in sql(old_guard.replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'qualification_abort'; END $$;"), False).stderr
    assert 'spent_dss_operation_has_caller' in sql(migration, False).stderr
    assert present(); sql('DROP FUNCTION public.ops_dss_midway_sweep(uuid);')
    sql("CREATE PROCEDURE public.dss_test_caller() LANGUAGE plpgsql AS $$ BEGIN PERFORM public.ops_dss_midway_go_live(); END $$;")
    assert 'spent_dss_operation_has_caller' in sql(migration, False).stderr
    assert present(); sql('DROP PROCEDURE public.dss_test_caller();')
    sql("CREATE FUNCTION public.dss_test_caller() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM public.ops_ledger_reset_declarations(); END $$;")
    assert 'spent_dss_operation_has_caller' in sql(migration, False).stderr
    sql('DROP FUNCTION public.dss_test_caller();')
    sql("INSERT INTO cron.job VALUES(1,'unrelated','select public.ops_dss_midway_go_live()');")
    assert 'spent_dss_operation_still_scheduled' in sql(migration, False).stderr
    sql('DELETE FROM cron.job;')
    sql("UPDATE public.ca_money_rpc_registry SET status='retired' WHERE proname='ops_dss_midway_sweep';")
    assert 'spent_dss_registry_preimage_changed' in sql(migration, False).stderr
    sql("UPDATE public.ca_money_rpc_registry SET status='approved';")
    sql('GRANT EXECUTE ON FUNCTION public.ops_dss_midway_go_live() TO authenticated;')
    assert 'spent_dss_operation_preimage_changed' in sql(migration, False).stderr
    sql('REVOKE EXECUTE ON FUNCTION public.ops_dss_midway_go_live() FROM authenticated;')
    sql("CREATE VIEW public.dss_test_dependency AS SELECT public.ops_dss_midway_go_live();")
    assert 'depend' in sql(migration, False).stderr
    assert present(); sql('DROP VIEW public.dss_test_dependency;')
    sql(migration)
    assert not present()
    assert sql("SELECT count(*) FROM pg_proc WHERE proname IN ('ops_dss_midway_sweep','ops_dss_midway_go_live','ops_ledger_reset_declarations');").stdout.strip() == '0'
    assert sql("SELECT count(*) FROM public.ca_money_rpc_registry WHERE status='retired';").stdout.strip() == '2'
    assert 'spent_dss_operation_preimage_changed' in sql(migration, False).stderr
    assert sql("SET ROLE service_role; SELECT public.ops_dss_midway_go_live();", False).returncode != 0
    print('PASS: exact 3 preimages; rollback; function/procedure callers; schedule; registry; ACL drift; retirement; replay refusal; no callable operation. No money bodies invoked.')
finally:
    if started: subprocess.run([str(PG/'pg_ctl'), '-D', str(cluster/'data'), '-m', 'immediate', '-w', 'stop'], check=True, stdout=subprocess.DEVNULL)
    shutil.rmtree(cluster)
