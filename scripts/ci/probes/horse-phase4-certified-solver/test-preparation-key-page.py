#!/usr/bin/env python3
"""Real maintained reader before/after migration in isolated native PostgreSQL 17."""
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[4]
PG = Path(os.environ.get('PG17_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
SOURCE = ROOT/'supabase/migrations/20261029070812_public_hist215_models_bind_independent_exact_public_state.sql'
MIGRATION = ROOT/'supabase/migrations/20261031080001_public215_preparation_page_keys_before_program_projection.sql'
SIG = 'public.fn_gto_v31_model_preparations(uuid,integer,integer)'
DATASET = '11111111-1111-4111-8111-111111111111'
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

with tempfile.TemporaryDirectory(prefix='preparation-page-', dir=base) as folder, tempfile.TemporaryDirectory(prefix='p215-', dir=socket_base) as socket:
    task = Path(folder)
    data = task/'data'
    env = {**clean,'PGHOST':socket,'PGPORT':'55471','PGDATABASE':'postgres','PGUSER':'fixture_owner',
           'PGPASSFILE':str(task/'absent'), 'PGSERVICEFILE':str(task/'absent-service')}
    command([str(PG/'initdb'),'-D',str(data),'-U','fixture_owner','-A','trust','--no-locale'])
    command([str(PG/'pg_ctl'),'-D',str(data),'-l',str(task/'postgres.log'),'-o',f"-F -k {socket} -p 55471 -c listen_addresses=''",'-w','start'])
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
        original = re.search(r'CREATE FUNCTION public.fn_gto_v31_model_preparations\(.*?END \$fn\$;',source,re.S).group()
        canonical = re.search(r'CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_canonical\(.*?END \$fn\$;',source,re.S).group()
        sql('''CREATE ROLE service_role LOGIN; CREATE ROLE anon LOGIN; CREATE ROLE authenticated LOGIN;
CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('fixture.jwt_role',true)$$;
CREATE TABLE public.gto_v31_datasets(dataset_id uuid PRIMARY KEY,state text,input_bundle_id uuid,input_bundle_checksum text);
CREATE TABLE public.gto_v31_input_bundles(input_bundle_id uuid PRIMARY KEY,bundle_checksum text,approval_status text,bundle_manifest jsonb);
CREATE TABLE public.gto_v31_model_preparations(dataset_id uuid,cell_key_checksum text,context jsonb,program jsonb,preparation_checksum text,PRIMARY KEY(dataset_id,cell_key_checksum));
CREATE TABLE public.gto_v31_model_freezes(dataset_id uuid,cell_key_checksum text,public_model_build_receipt jsonb,model_build_receipt_checksum text,PRIMARY KEY(dataset_id,cell_key_checksum));
INSERT INTO public.gto_v31_datasets VALUES('''+"'"+DATASET+"','building','22222222-2222-4222-8222-222222222222','bundle');"+'''
INSERT INTO public.gto_v31_input_bundles VALUES('22222222-2222-4222-8222-222222222222','bundle','approved','{"public215_protocols":{"runtime_parity_protocol":{"cases":[1,2]},"training_recipe":{"encoder_descriptor":{"version":1}}}}');
INSERT INTO public.gto_v31_model_preparations SELECT '''+"'"+DATASET+"',md5(i::text),jsonb_build_object('ordinal',lpad(i::text,3,'0')),"+'''jsonb_build_object('public_model',jsonb_build_object('payload',repeat(md5(i::text),1000)),'public_template',jsonb_build_object('n',i),'public_training_provenance',jsonb_build_object('n',i),'model_checksum',md5(i::text),'template_checksum',md5((i+1)::text),'feature_schema_checksum','feature','training_provenance_checksum','training'),md5((i+2)::text) FROM generate_series(0,106)i;
INSERT INTO public.gto_v31_model_freezes SELECT dataset_id,cell_key_checksum,'{"receipt":true}',repeat('f',64) FROM public.gto_v31_model_preparations WHERE context->>'ordinal'='079';
'''+canonical+original+f"REVOKE ALL ON FUNCTION {SIG} FROM PUBLIC; GRANT EXECUTE ON FUNCTION {SIG} TO service_role;")
        call = lambda suffix: f"SELECT COALESCE(jsonb_agg(to_jsonb(x)),'[]') FROM public.fn_gto_v31_model_preparations('{DATASET}'{suffix})x"
        cases = ['',',0,1',',79,1',',106,1',',107,1',',-1,1',',NULL,NULL',',79,99',',79,0']
        baseline = {c:sql(call(c),'service_role') for c in cases}
        assert len(json.loads(baseline[',79,1'])[0]) == 17
        assert json.loads(baseline[',79,1'])[0]['status'] == 'frozen'
        assert baseline[',107,1'] == '[]'
        metadata = f"SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid='{SIG}'::regprocedure"
        before = sql(metadata)
        def plan_query(definition):
            query = definition.split('RETURN QUERY ',1)[1].split(';\nEND',1)[0]
            return query.replace('p_dataset_id',"'"+DATASET+"'::uuid").replace('p_offset','79')
        def narrow(plan):
            nodes=[]
            def walk(n):
                nodes.append(n)
                for c in n.get('Plans',[]): walk(c)
            walk(plan[0]['Plan'])
            pages=[n for n in nodes if n.get('Subplan Name')=='CTE selected_preparation']
            assert len(pages)==1, 'missing materialized key page'
            page=pages[0]
            assert page['Node Type']=='Limit'
            def check(n):
                output=' '.join(n.get('Output',[]))
                # Raw table scans may list physical columns; materialized tuples and
                # sort/join projections must carry only page keys, never wide JSON.
                if n['Node Type'] in {'Limit','Sort','Incremental Sort','Nested Loop','Hash Join','Merge Join'}:
                    assert 'program' not in output and 'bundle_manifest' not in output, output
                for c in n.get('Plans',[]): check(c)
            check(page)
            assert any(n['Node Type']=='CTE Scan' and n.get('CTE Name')=='selected_preparation' for n in nodes)
        oldplan=json.loads(sql('EXPLAIN(FORMAT JSON,VERBOSE TRUE) '+plan_query(original)))
        try: narrow(oldplan)
        except AssertionError as failure: print('BEFORE: narrow-page assertion fails:',str(failure))
        else: raise AssertionError('original unexpectedly passed narrow-page regression')
        sql(MIGRATION.read_text())
        proof = re.search(r'^-- @live-proof: (.+)$', MIGRATION.read_text(), re.M).group(1)
        assert sql('SELECT '+proof) == 't', 'declared maintained live proof rejected installed candidate'
        assert sql(metadata)==before, 'OID/signature/defaults/owner/ACL/settings drift'
        for c in cases: assert sql(call(c),'service_role')==baseline[c], c
        for role in ['anon','authenticated']: sql(call(''),role,error='permission denied')
        sql(call(''),error='service_role required')
        for change,restore in [("UPDATE public.gto_v31_datasets SET state='evaluating'","UPDATE public.gto_v31_datasets SET state='building'"),("UPDATE public.gto_v31_input_bundles SET approval_status='revoked'","UPDATE public.gto_v31_input_bundles SET approval_status='approved'"),("UPDATE public.gto_v31_datasets SET input_bundle_checksum='wrong'","UPDATE public.gto_v31_datasets SET input_bundle_checksum='bundle'")]:
            sql(change); assert sql(call(''),'service_role')=='[]'; sql(restore)
        newdef=sql(f"SELECT pg_get_functiondef('{SIG}'::regprocedure)")
        narrow(json.loads(sql('EXPLAIN(FORMAT JSON,VERBOSE TRUE) '+plan_query(newdef))))
        print('AFTER: real PG17 key-page plan, 17-field outputs, boundary/default offsets, state/approval bindings, auth and complete pg_proc metadata PASS')
    finally:
        command([str(PG/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'])
