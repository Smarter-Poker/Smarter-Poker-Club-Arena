#!/usr/bin/env python3
"""Exact ingress transition: one authority-read pair, unchanged replay/security boundaries."""
import os
from pathlib import Path
import platform
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[4]
PG = Path(os.environ.get('PG17_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
SOURCE = ROOT/'supabase/migrations/20260908181724_both_solver_hosts_and_the_compactor_leave_receipts.sql'
MIGRATION = ROOT/'supabase/migrations/20261031135616_v31_compactor_may_read_frozen_model_authority.sql'
SIG = 'public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text)'
clean = {k:v for k,v in os.environ.items() if not k.startswith('PG')}
base = os.environ.get('RUNNER_TEMP') or os.environ.get('TMPDIR')
if platform.system() == 'Darwin':
    assert base and Path(base).resolve().is_relative_to('/Volumes/SmarterWork/agent-work')
    socket_base = '/Volumes/SmarterWork/agent-work/shared-capacity'
else:
    base = base or tempfile.gettempdir()
    socket_base = base

def command(args):
    result = subprocess.run(args, env=clean, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr
    return result.stdout

with tempfile.TemporaryDirectory(prefix='ingress-authority-', dir=base) as folder, tempfile.TemporaryDirectory(prefix='i215-', dir=socket_base) as socket:
    task = Path(folder)
    data = task/'data'
    env = {**clean,'PGHOST':socket,'PGPORT':'55473','PGDATABASE':'postgres','PGUSER':'fixture_owner',
           'PGPASSFILE':str(task/'absent'), 'PGSERVICEFILE':str(task/'absent-service')}
    command([str(PG/'initdb'),'-D',str(data),'-U','fixture_owner','-A','trust','--no-locale'])
    command([str(PG/'pg_ctl'),'-D',str(data),'-l',str(task/'postgres.log'),'-o',f"-F -k {socket} -p 55473 -c listen_addresses=''",'-w','start'])
    try:
        def sql(text, role='fixture_owner', error=None):
            result = subprocess.run([str(PG/'psql'),'-XAt','-v','ON_ERROR_STOP=1'], input=text,
                env={**env,'PGUSER':role,'PGOPTIONS':'-c statement_timeout=10000 -c fixture.jwt_role='+role},
                text=True,capture_output=True,timeout=15)
            if error:
                assert result.returncode and error in result.stderr, result.stderr
            else:
                assert result.returncode == 0, result.stderr
            return result.stdout.strip()
        source = SOURCE.read_text()
        table = source[source.index('CREATE TABLE IF NOT EXISTS public.solver_ingress_nonces'):source.index('ALTER TABLE public.solver_worker_heartbeats')]
        function = source[source.index('CREATE OR REPLACE FUNCTION public.fn_solver_ingress_claim'):source.index('  TO service_role;',source.index('CREATE OR REPLACE FUNCTION public.fn_solver_ingress_claim'))+len('  TO service_role;')]
        sql("CREATE ROLE service_role LOGIN; CREATE ROLE anon LOGIN; CREATE ROLE authenticated LOGIN; CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('fixture.jwt_role',true)$$;"+table+function)
        sql((ROOT/'supabase/migrations/20261030023627_v31_model_operations_enter_the_scoped_replay_gate.sql').read_text())
        sql('ALTER TABLE public.solver_ingress_nonces ENABLE ROW LEVEL SECURITY; REVOKE ALL ON public.solver_ingress_nonces FROM PUBLIC,anon,authenticated,service_role;')
        operations = ['dataset_contract','worker_heartbeat','ingest_artifact','register_dataset','build_cell','seal_dataset','compact_heartbeat','certification_status','prepare_model','freeze_model','model_freeze_authority']
        actors = ['M1','M2','COMPACTOR']
        def allowed(actor,op,new=False):
            return op in operations[:8] or (op in ['prepare_model','freeze_model'] and actor=='COMPACTOR') or (op=='model_freeze_authority' and actor in (['M2','COMPACTOR'] if new else ['M2']))
        def claim(actor,op,nonce='gen_random_uuid()',at='clock_timestamp()',digest="repeat('a',64)",role='service_role',error=None):
            return sql(f"SELECT public.fn_solver_ingress_claim('{actor}',{nonce},'{op}',{at},{digest})",role,error)
        def matrix(new):
            for actor in actors:
                for op in operations:
                    yes=allowed(actor,op,new)
                    if yes: assert claim(actor,op)=='t'
                    else: claim(actor,op,error='solver ingress identity is invalid or stale')
                    statement=f"INSERT INTO public.solver_ingress_nonces(principal,nonce,operation,signed_at,body_sha256) VALUES('{actor}',gen_random_uuid(),'{op}',clock_timestamp(),repeat('b',64))"
                    sql(statement,error=None if yes else 'solver_ingress_nonces_operation_check')
        claim('COMPACTOR','model_freeze_authority',error='solver ingress identity is invalid or stale')
        sql("INSERT INTO public.solver_ingress_nonces VALUES('COMPACTOR',gen_random_uuid(),'model_freeze_authority',clock_timestamp(),repeat('a',64),clock_timestamp())",error='solver_ingress_nonces_operation_check')
        matrix(False)
        print('BEFORE: actual maintained function and nonce CHECK reject COMPACTOR authority; all33 old pairs verified')
        metadata=f"SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid='{SIG}'::regprocedure"
        tablemeta="SELECT relowner,relacl,relrowsecurity FROM pg_class WHERE oid='public.solver_ingress_nonces'::regclass"
        before=sql(metadata);beforetable=sql(tablemeta)
        retained=sql("SELECT md5(string_agg(to_jsonb(n)::text,'' ORDER BY principal,nonce)) FROM public.solver_ingress_nonces n")
        sql(MIGRATION.read_text())
        assert sql(metadata)==before, 'function metadata changed'
        assert sql(tablemeta)==beforetable, 'table owner/ACL/RLS changed'
        assert sql("SELECT md5(string_agg(to_jsonb(n)::text,'' ORDER BY principal,nonce)) FROM public.solver_ingress_nonces n")==retained, 'retained nonce rows changed'
        assert [(a,o) for a in actors for o in operations if allowed(a,o,True)!=allowed(a,o)]==[('COMPACTOR','model_freeze_authority')]
        matrix(True)
        nonce="'11111111-1111-4111-8111-111111111111'::uuid"
        assert claim('COMPACTOR','model_freeze_authority',nonce)=='t'
        for op in ['model_freeze_authority','dataset_contract']:
            claim('COMPACTOR',op,nonce,error='solver ingress nonce was replayed')
        for at in ["clock_timestamp()-interval '301 seconds'","clock_timestamp()+interval '301 seconds'",'NULL']:
            claim('COMPACTOR','model_freeze_authority',at=at,error='solver ingress identity is invalid or stale')
        for digest in ["repeat('0',64)","repeat('B',64)","'short'",'NULL']:
            claim('COMPACTOR','model_freeze_authority',digest=digest,error='solver ingress identity is invalid or stale')
        claim('UNKNOWN','model_freeze_authority',error='solver ingress identity is invalid or stale')
        claim('COMPACTOR','unknown_operation',error='solver ingress identity is invalid or stale')
        claim('COMPACTOR','model_freeze_authority',nonce='NULL',error='solver ingress identity is invalid or stale')
        for actor in ['M1','M2']:
            for op in ['prepare_model','freeze_model']: claim(actor,op,error='solver ingress identity is invalid or stale')
        for role in ['anon','authenticated']:
            claim('COMPACTOR','model_freeze_authority',role=role,error='permission denied')
        claim('COMPACTOR','model_freeze_authority',role='fixture_owner',error='service_role required')
        sql('SELECT count(*) FROM public.solver_ingress_nonces','service_role',error='permission denied')
        assert sql("SELECT convalidated FROM pg_constraint WHERE conrelid='public.solver_ingress_nonces'::regclass AND conname='solver_ingress_nonces_operation_check'")=='t'
        print('POST_CONSTRAINT_MD5='+sql("SELECT md5(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid='public.solver_ingress_nonces'::regclass AND conname='solver_ingress_nonces_operation_check'"))
        for proof in re.findall(r'^-- @live-proof: (.+)$',MIGRATION.read_text(),re.M): assert sql('SELECT '+proof)=='t'
        print('AFTER: only COMPACTOR authority pair added; all33 function/CHECK pairs, nonce replay/freshness/bodyhash, service-only ACL and retained security metadata PASS')
    finally:
        command([str(PG/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'])
