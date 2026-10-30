#!/usr/bin/env python3
"""Actual new SECDEF admission in disposable PG17; old helpers are controlled fixtures."""
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
PG = Path(os.environ.get('PG17_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
MIGRATION = ROOT / 'supabase/migrations/20261030161813_public215_heldout_audits_require_admitted_m2_boards.sql'
SIG = 'public.fn_gto_v31_prepare_heldout_public_physics(uuid,text,text,text,integer)'
# Never inherit libpq routing, service or password defaults into privileged fixtures.
CLEAN_ENV = {key: os.environ[key] for key in os.environ if not key.startswith('PG')}
CALL = "SELECT public.fn_gto_v31_prepare_heldout_public_physics('11111111-1111-4111-8111-111111111111',repeat('2',64),repeat('3',64),repeat('4',64),%s)"

def run(args, **kwargs):
    r = subprocess.run(args, text=True, capture_output=True, timeout=30, env=CLEAN_ENV, **kwargs)
    if r.returncode:
        raise AssertionError(r.stderr)
    return r.stdout.strip()

base = os.environ.get('RUNNER_TEMP') or os.environ.get('TMPDIR')
if platform.system() == 'Darwin':
    if not base or not Path(base).resolve().is_relative_to('/Volumes/SmarterWork/agent-work'):
        raise RuntimeError('task-owned external TMPDIR required')
    socket_base = '/Volumes/SmarterWork/agent-work/shared-capacity'
else:
    base = base or tempfile.gettempdir()
    socket_base = base
with tempfile.TemporaryDirectory(prefix='heldout-wrapper-', dir=base) as folder, \
     tempfile.TemporaryDirectory(prefix='h215-sock-', dir=socket_base) as sockets:
    task, sock = Path(folder), Path(sockets)
    data = task / 'data'
    env = {**CLEAN_ENV, 'PGPASSFILE':str(task/'absent.pgpass'),
           'PGSERVICEFILE':str(task/'absent.pg_service.conf'), 'PGHOST': str(sock), 'PGPORT':'55469', 'PGDATABASE':'postgres',
           'PGUSER':'fixture_owner', 'PGCONNECT_TIMEOUT':'3'}
    run([str(PG/'initdb'),'-D',str(data),'-U','fixture_owner','-A','trust','--no-locale'])
    started = False
    try:
        run([str(PG/'pg_ctl'),'-D',str(data),'-l',str(task/'postgres.log'),
             '-o',f"-F -k {sock} -p 55469 -c listen_addresses=''",'-w','start'])
        started = True
        def sql(text, role='fixture_owner', error=None):
            r = subprocess.run([str(PG/'psql'),'-XAt','-v','ON_ERROR_STOP=1'],input=text,
                text=True,capture_output=True,timeout=15,
                env={**env,'PGUSER':role,'PGOPTIONS':'-c statement_timeout=10000 -c fixture.jwt_role='+role})
            if error:
                assert r.returncode and error in r.stderr, r.stderr
            else:
                assert r.returncode == 0, r.stderr
            return r.stdout.strip()
        sql((HERE/'heldout-physics-wrapper-fixture.sql').read_text())
        assert sql("SELECT to_regprocedure('"+SIG+"') IS NULL") == 't'
        fingerprint = "SELECT md5(string_agg(pg_get_functiondef(oid),E'\\n' ORDER BY oid)) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname<>'fn_gto_v31_prepare_heldout_public_physics'"
        before = sql(fingerprint)
        sql(MIGRATION.read_text())
        assert sql(fingerprint) == before, 'existing fixture helpers changed'
        assert sql("SELECT prosecdef AND proconfig @> ARRAY['search_path=public','statement_timeout=240s','lock_timeout=1s'] FROM pg_proc WHERE oid='"+SIG+"'::regprocedure") == 't'
        assert sql("SELECT has_function_privilege('service_role','"+SIG+"','EXECUTE') AND NOT has_function_privilege('anon','"+SIG+"','EXECUTE') AND NOT has_function_privilege('authenticated','"+SIG+"','EXECUTE')") == 't'
        for role in ['anon','authenticated']:
            sql(CALL%'0',role=role,error='permission denied')
        sql(CALL%'0',error='service_role required')
        sql('SELECT * FROM public.gto_v31_public_source_journal',role='service_role',error='permission denied')
        sql("SELECT public.fn_gto_v31_prepare_public_physics(null,null,null)",role='service_role',error='permission denied')
        expected = sorted(['KsQd7c','AcKd2h','QcJh3d','Tc9d4s','8c7d5h','6c5d2s','4c3d2h','JcTd8s'])
        fields = {'format','dataset_id','context','cell_key_checksum','model_checksum','template_checksum',
            'model_build_receipt_checksum','board','board_offset','selection_receipt_checksum',
            'capture_receipt_checksum','node_checksum','artifact_checksum','audit_key'}
        for offset, board in enumerate(expected):
            value = json.loads(sql(CALL%offset,role='service_role'))
            assert set(value) == fields and value['board'] == board and value['board_offset'] == offset
            assert value['format'] == 'public215_heldout_physics_v1'
            assert value['capture_receipt_checksum'] == '7'*64
            assert value['selection_receipt_checksum'] == '8'*64 and value['audit_key'] == '9'*64
            assert value['model_checksum'] == '3'*64 and value['model_build_receipt_checksum'] == '4'*64
        assert sql('SELECT count(*) FROM public.fixture_audit_calls') == '8'
        assert json.loads(sql('SELECT array_to_json(board) FROM public.fixture_audit_calls LIMIT 1')) == [expected[0][i:i+2] for i in range(0,6,2)]
        for offset in ['-1','8','NULL']:
            sql(CALL%offset,role='service_role',error='bounded heldout board ordinal')
        for old,new in [("repeat('2',64)","repeat('0',64)"),("repeat('3',64)","repeat('a',64)"),("repeat('4',64)","repeat('b',64)")]:
            sql((CALL%'0').replace(old,new),role='service_role',error='ERROR:')
        changes = [
            "UPDATE public.gto_v31_datasets SET state='evaluating'",
            "UPDATE public.gto_v31_datasets SET policy_representation='matrix_v2'",
            "UPDATE public.gto_v31_datasets SET declared_coverage='[]'",
            "UPDATE public.gto_v31_datasets SET declared_coverage=null",
            "UPDATE public.gto_v31_datasets SET declared_coverage='{}'",
            "UPDATE public.gto_v31_input_bundles SET approval_status='revoked'",
            "UPDATE public.gto_v31_model_freezes SET model_build_receipt_checksum=repeat('f',64)",
            "UPDATE public.gto_v31_model_preparations SET identity='{}'",
            "UPDATE public.fixture_gates SET selection=false",
            "UPDATE public.fixture_gates SET selection=null",
            "UPDATE public.fixture_gates SET headers=false",
            "UPDATE public.fixture_gates SET frozen=false",
            "UPDATE public.fixture_gates SET map=false",
            "UPDATE public.gto_v31_public_selections SET selected=selected-0",
            "UPDATE public.gto_v31_public_selections SET selected='[]'",
            "UPDATE public.gto_v31_public_selections SET selected=null",
            "UPDATE public.gto_v31_public_selections SET selected='{}'",
            "UPDATE public.gto_v31_public_selections SET capture_checksum=repeat('c',64)",
            "UPDATE public.gto_v31_public_selections SET receipt_checksum=repeat('0',64)",
            "DELETE FROM public.gto_v31_public_source_journal WHERE board='AcKd2h'",
            "UPDATE public.gto_v31_public_source_journal SET board='AcKd2h' WHERE board='KsQd7c'",
            "UPDATE public.gto_v31_public_source_journal SET node_checksum=repeat('0',64)",
            "UPDATE public.gto_v31_public_source_journal SET artifact_checksum=null",
            "UPDATE public.fixture_gates SET audit=repeat('0',64)",
            "UPDATE public.fixture_gates SET quarantine_on_audit=true",
        ]
        for change in changes:
            # Each failed transaction rolls back both fixture mutation and any delegate effect.
            sql("BEGIN; "+change+"; SET LOCAL ROLE service_role; SET LOCAL fixture.jwt_role='service_role'; "+CALL%'0',error='ERROR:')
            assert sql('SELECT count(*) FROM public.fixture_audit_calls') == '8'
        assert sql(fingerprint) == before
        print('PUBLIC215_HELDOUT_PHYSICS_WRAPPER_NATIVE_OK authorization bounds exact-selection frozen-model chronological-routing delegation metadata rollback; existing helper fixtures unchanged; no actual physics or M2 data qualification')
    finally:
        if started:
            run([str(PG/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'])
