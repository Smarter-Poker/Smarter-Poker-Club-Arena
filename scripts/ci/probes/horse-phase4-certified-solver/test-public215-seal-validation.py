#!/usr/bin/env python3
"""Real maintained reader before/after migration in isolated native PostgreSQL 17."""
import argparse
import json
import copy
import hashlib
import time
import os
from pathlib import Path
import platform
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[4]
HERE=Path(__file__).resolve().parent
PG = Path(os.environ.get('PG17_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
SOURCE = ROOT/'supabase/migrations/20261029070812_public_hist215_models_bind_independent_exact_public_state.sql'
MIGRATION = ROOT/'supabase/migrations/20261031215525_v31_model_validation_serializes_the_same_forest_once.sql'
SIG = 'public.fn_gto_v31_seal_build(uuid)'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--private-model-index');parser.add_argument('--private-model-index-sha256')
args=parser.parse_args()
assert bool(args.private_model_index)==bool(args.private_model_index_sha256)
clean = {k:v for k,v in os.environ.items() if not k.startswith('PG')}
base = os.environ.get('RUNNER_TEMP') or os.environ.get('TMPDIR')
if platform.system() == 'Darwin':
    assert base and Path(base).resolve().is_relative_to('/Volumes/SmarterWork/agent-work')
    socket_base = '/Volumes/SmarterWork/agent-work/shared-capacity'
else:
    base = base or tempfile.gettempdir()
    socket_base = base

private_mode=False

def command(args):
    result = subprocess.run(args, env=clean, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr
    return result.stdout

with tempfile.TemporaryDirectory(prefix='seal-validators-', dir=base) as folder, tempfile.TemporaryDirectory(prefix='sv215-', dir=socket_base) as socket:
    task = Path(folder)
    data = task/'data'
    env = {**clean,'PGHOST':socket,'PGPORT':'55478','PGDATABASE':'postgres','PGUSER':'fixture_owner',
           'PGPASSFILE':str(task/'absent'), 'PGSERVICEFILE':str(task/'absent-service')}
    command([str(PG/'initdb'),'-D',str(data),'-U','fixture_owner','-A','trust','--no-locale','--encoding=UTF8'])
    command([str(PG/'pg_ctl'),'-D',str(data),'-l',str(task/'postgres.log'),'-o',f"-F -k {socket} -p 55478 -c listen_addresses=''",'-w','start'])
    try:
        def sql(text, role='fixture_owner', error=None):
            result = subprocess.run([str(PG/'psql'),'-XAt','-v','ON_ERROR_STOP=1'], input=text,
                env={**env,'PGUSER':role,'PGOPTIONS':'-c statement_timeout=10000 -c fixture.jwt_role='+role},
                text=True,capture_output=True,timeout=120)
            if error:
                assert result.returncode and error in result.stderr, result.stderr
            else:
                assert result.returncode == 0, ('SQL_FAILURE_PRIVATE_MODEL_REDACTED' if private_mode else result.stderr)
            return result.stdout.strip()

        source=SOURCE.read_text()
        def definition(name):
            return re.search(r'CREATE(?: OR REPLACE)? FUNCTION public\.'+name+r'\(.*?\$fn\$;',source,re.S).group()
        sql("CREATE ROLE anon LOGIN;CREATE ROLE authenticated LOGIN;CREATE ROLE service_role LOGIN;CREATE SCHEMA auth;CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT 'service_role'::text$$;CREATE SCHEMA extensions;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;")
        # Controlled unchanged dependency fixtures only: this is pure-validator,
        # not physics or legacy matrix qualification. Real hash owner is retained.
        oldbase=(ROOT/'supabase/migrations/20260908181657_the_horse_reads_only_a_certified_solver_dataset.sql').read_text()
        checksum=re.search(r'CREATE OR REPLACE FUNCTION public.fn_gto_v31_json_checksum\(.*?\$fn\$;',oldbase,re.S).group()
        sql(checksum)
        sql("CREATE FUNCTION public.fn_gto_v31_cell_payload_checksum_matrix_v2(jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$SELECT 'matrix_delegation_preserved'::text$$;")
        sql("CREATE FUNCTION public.fn_gto_v31_public215_physics_implementation() RETURNS text LANGUAGE sql STABLE AS $$SELECT '66f413bc9179d5b10df7c5a73547931c47a3e90fd7895c4de596c7287e98e733'::text$$;CREATE FUNCTION public.fn_gto_v31_public215_encoding_implementation() RETURNS text LANGUAGE sql STABLE AS $$SELECT '1121d3ff6873757d8560e55f397e29df8978cc8b845259bbaa2c529f40950f6d'::text$$;")
        sql("CREATE TABLE public.gto_v31_datasets(dataset_id uuid PRIMARY KEY,state text,policy_representation text);CREATE TABLE public.gto_v31_runtime_cells(cell_id uuid PRIMARY KEY,dataset_id uuid NOT NULL REFERENCES public.gto_v31_datasets(dataset_id));")
        names=['fn_gto_v31_public215_f64','fn_gto_v31_public215_canonical','fn_gto_v31_public215_model_valid','fn_gto_v31_cell_payload_checksum']
        originals={name:definition(name) for name in names}
        for text in originals.values():sql(text)
        sql(originals['fn_gto_v31_public215_canonical'].replace('public.fn_gto_v31_public215_canonical','public.baseline_canonical'))
        sql(originals['fn_gto_v31_public215_model_valid'].replace('public.fn_gto_v31_public215_model_valid','public.baseline_model_valid').replace('public.fn_gto_v31_public215_canonical','public.baseline_canonical'))
        sql(originals['fn_gto_v31_cell_payload_checksum'].replace('public.fn_gto_v31_cell_payload_checksum(','public.baseline_payload_checksum('))
        seal=HERE/'public215-seal-before.sql';assert hashlib.sha256(seal.read_bytes()).hexdigest()=='b5a9f4c1f679bbdc80c52127296a55b2b36be855112f62d905cb5d6b8a6f0f1b'
        sql(seal.read_text().rstrip().rstrip(';')+';')
        for name in names:
            sql('REVOKE ALL ON FUNCTION public.'+name+'('+('text' if name.endswith('_f64') else 'jsonb')+') FROM PUBLIC,anon,authenticated,service_role')
        sql('REVOKE ALL ON FUNCTION public.fn_gto_v31_seal_build(uuid) FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION public.fn_gto_v31_seal_build(uuid) TO service_role;')
        sigs=[name+'('+('text' if name.endswith('_f64') else 'jsonb')+')' for name in names]+['fn_gto_v31_seal_build(uuid)']+['fn_gto_v31_source_node_v3_valid(jsonb)','fn_gto_v31_source_node_v4_valid(jsonb)']
        metadata=lambda:"SELECT jsonb_object_agg(oid::regprocedure::text,to_jsonb(p)-'prosrc') FROM pg_proc p WHERE oid IN("+','.join("'public."+sig+"'::regprocedure" for sig in sigs)+")"
        before_metadata=sql(metadata());before_f64=sql("SELECT pg_get_functiondef('public.fn_gto_v31_public215_f64(text)'::regprocedure)")
        sql(MIGRATION.read_text())
        assert sql(metadata())==before_metadata,'existing function identity/owner/ACL/settings changed'
        assert sql("SELECT pg_get_functiondef('public.fn_gto_v31_public215_f64(text)'::regprocedure)")==before_f64,'numeric f64 owner changed'
        for proof in re.findall(r'^-- @live-proof: (.+)$',MIGRATION.read_text(),re.M):assert sql('SELECT '+proof)=='t'
        # Every additive helper must remain inaccessible to caller roles.
        assert sql("SELECT bool_and(NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') AND NOT has_function_privilege('service_role',oid,'EXECUTE')) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'fn_gto_v31_%' AND oid NOT IN("+','.join("'public."+sig+"'::regprocedure" for sig in sigs)+",'public.fn_gto_v31_source_node_v3_fields_valid(jsonb)'::regprocedure,'public.fn_gto_v31_json_checksum(jsonb)'::regprocedure,'public.fn_gto_v31_cell_payload_checksum_matrix_v2(jsonb)'::regprocedure,'public.fn_gto_v31_public215_physics_implementation()'::regprocedure,'public.fn_gto_v31_public215_encoding_implementation()'::regprocedure)")=='t'
        assert sql("SELECT NOT prosecdef AND has_function_privilege('service_role',oid,'EXECUTE') AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='public.fn_gto_v31_source_node_v3_fields_valid(jsonb)'::regprocedure")== 't'
        for function in ['fn_gto_v31_source_node_v3_fields_valid','fn_gto_v31_source_node_v3_valid','fn_gto_v31_source_node_v4_valid']:
            assert sql("SELECT public."+function+"('{}'::jsonb)",role='service_role')=='f'
            for denied in ['anon','authenticated']:
                sql("SELECT public."+function+"('{}'::jsonb)",role=denied,error='permission denied')
        def lit(value):return "'"+json.dumps(value,ensure_ascii=True,separators=(',',':')).replace("'","''")+"'::jsonb"
        def equal_canonical(value):
            text=lit(value);assert sql('SELECT public.baseline_canonical('+text+')=public.fn_gto_v31_public215_canonical('+text+')')=='t'
        valid_json=[None,True,False,{},[],[{},[]],{'z':1,'aa':2,'a':3,'A':4},{'quote':'"','slash':'\\','empty':'','punctuation':' !~<>:/[]{}'},[9007199254740991,-9007199254740991,0],{'a':{'b':[1,2,{'k':'v'}]}}]
        for value in valid_json:equal_canonical(value)
        bad_json=[({'x':'é'},'public215 canonical ASCII'),({'é':1},'public215 canonical ASCII key'),({'a':'\n'},'public215 canonical ASCII'),(1.5,'public215 canonical safeinteger'),(9007199254740992,'public215 canonical safeinteger'),(-9007199254740992,'public215 canonical safeinteger'),({'a':['é'],'é':1},'public215 canonical ASCII'),({'a':1.1,'é':'é'},'public215 canonical safeinteger')]
        for value,error in bad_json:
            for func in ['public.baseline_canonical','public.fn_gto_v31_public215_canonical']:sql('SELECT '+func+'('+lit(value)+')',error=error)
        for raw in ['1.0','1e-1','-0.0','9007199254740991.0']:
            for func in ['public.baseline_canonical','public.fn_gto_v31_public215_canonical']:sql("SELECT "+func+"('"+raw+"'::jsonb)",error='public215 canonical safeinteger')
        leaf={'value_f64':'0000000000000000'}
        valid={'format':'public_hist215_v1','variant':'direct','feature_count':215,'action_ids':['check','bet'],'heads':[{'baseline_f64':'0000000000000000','trees':[[leaf]for _ in range(100)]}for _ in range(5)],'template_sha256':'a'*64,'feature_schema_sha256':'b'*64,'provenance_sha256':'c'*64}
        def compare(value,expected):
            assert sql('SELECT public.baseline_model_valid('+lit(value)+') IS NOT DISTINCT FROM public.fn_gto_v31_public215_model_valid('+lit(value)+'),public.fn_gto_v31_public215_model_valid('+lit(value)+')')=='t|'+expected
        compare(valid,'t');coherent=copy.deepcopy(valid);coherent['variant']='coherent';compare(coherent,'t')
        malformed=[]
        for key,value in [('extra',1),('feature_count',214),('action_ids',['check','check']),('action_ids',['__proto__','bet']),('template_sha256','bad')]:
            x=copy.deepcopy(valid);x[key]=value;malformed.append(x)
        x=copy.deepcopy(valid);del x['format'];malformed.append(x)
        x=copy.deepcopy(valid);x['heads'][0]['extra']=0;malformed.append(x)
        x=copy.deepcopy(valid);del x['heads'][0]['baseline_f64'];malformed.append(x)
        x=copy.deepcopy(valid);x['heads'][0]['trees'].pop();malformed.append(x)
        for node in [{'value_f64':'0000000000000000','extra':0},{'value_f64':'7ff0000000000000'},{'value_f64':'7ff8000000000000'},{'value_f64':'000000000000000A'},{'value_f64':0},{}]:
            x=copy.deepcopy(valid);x['heads'][0]['trees'][0]=[node];malformed.append(x)
        node={'feature':214,'threshold_f64':'0000000000000000','left':1,'right':2,'missing_left':False};tree=[node,leaf,leaf]
        x=copy.deepcopy(valid);x['heads'][0]['trees'][0]=tree;compare(x,'t')
        for key,value in [('feature',215),('feature',1.0),('left',0),('right',1),('left',3),('left',None),('missing_left',0),('extra',False),('threshold_f64','7ff0000000000000')]:
            x=copy.deepcopy(valid);t=copy.deepcopy(tree);t[0][key]=value;x['heads'][0]['trees'][0]=t;malformed.append(x)
        x=copy.deepcopy(valid);x['heads'][0]['trees'][0]=[node,leaf,leaf,leaf];malformed.append(x)
        for value in malformed:compare(value,'f')
        for value in [None,{},[],1,'bad']:
            assert sql('SELECT public.baseline_model_valid('+lit(value)+') IS NOT DISTINCT FROM public.fn_gto_v31_public215_model_valid('+lit(value)+')')=='t'
        fields=re.findall("'([^']+)'",re.search(r'FOREACH k IN ARRAY ARRAY\[(.*?)\]',originals['fn_gto_v31_cell_payload_checksum'],re.S).group(1));assert len(fields)==32
        for n in range(33):
            payload={'policy_representation':'public_hist215_v1',**{key:({'model':valid} if key=='public_model' else None if i%3==0 else i)for i,key in enumerate(fields[:n])}};payload['policy_representation']='public_hist215_v1'
            assert sql('SELECT public.baseline_payload_checksum('+lit(payload)+')=public.fn_gto_v31_cell_payload_checksum('+lit(payload)+')')=='t'
        assert sql("SELECT public.baseline_payload_checksum('{}')=public.fn_gto_v31_cell_payload_checksum('{}')")=='t'
        tree=[{'feature':i%215,'threshold_f64':'0000000000000000','left':i*2+1,'right':i*2+2,'missing_left':False}if i<14 else leaf for i in range(29)]
        large=copy.deepcopy(valid)
        for head in large['heads']:head['trees']=[tree for _ in range(100)]
        compare(large,'t');equal_canonical(large)
        bad=copy.deepcopy(large);bad['heads'][0]['trees'][0]=[leaf for _ in range(30)];compare(bad,'f')
        variants=[copy.deepcopy(large) for _ in range(5)];variants[0]['variant']='coherent';variants[1]['action_ids']=['check','raise:big','fold'];variants[2]['heads'][0]['baseline_f64']='quote"slash\\';variants[3]['feature_count']=1;variants[4]['heads'][0]['trees'][0][0]['feature']=-1
        for value in variants:equal_canonical(value)
        outside=[]
        for key,value in [('feature_count','notnumeric'),('feature_count',1.5),('feature_count',9007199254740992),('variant','é'),('heads',True),('action_ids',[1]),('action_ids',['é'])]:
            x=copy.deepcopy(large);x[key]=value;outside.append(x)
        x=copy.deepcopy(large);x['extra']=1;outside.append(x)
        x=copy.deepcopy(large);x['heads'][0]['extra']=1;outside.append(x)
        x=copy.deepcopy(large);x['heads'][0]['trees'][0][0]['left']='0';outside.append(x)
        x=copy.deepcopy(large);x['heads'][0]['trees'][0][0]['extra']=1;outside.append(x)
        # Compare full public fallback outcomes, including exact P0001 messages.
        def outcome(func,value):
            statement='SELECT '+func+'('+lit(value)+')'
            result=subprocess.run([str(PG/'psql'),'-XAt','-v','ON_ERROR_STOP=1'],input=statement,env=env,text=True,capture_output=True,timeout=120)
            return (result.returncode,result.stdout.strip(),result.stderr.splitlines()[0] if result.stderr else '')
        for value in outside:assert outcome('public.baseline_canonical',value)==outcome('public.fn_gto_v31_public215_canonical',value)
        if args.private_model_index:
            private=Path(args.private_model_index)
            assert private.is_absolute() and private.resolve(strict=True)==private and not private.is_symlink()
            raw=private.read_bytes();assert hashlib.sha256(raw).hexdigest()==args.private_model_index_sha256
            index=json.loads(raw);assert index['format']=='public_hist215_build_index_v1' and len(index['models'])==107
            private_mode=True
            for entry in index['models']:
                compare(entry['public_model'],'t');equal_canonical(entry['public_model'])
            print('OPTIONAL_PRIVATE_107_MODEL_BYTES_AND_VERDICTS_EQUAL_NO_DATA_OUTPUT')
        print(json.dumps({'full_migration_native_pass':True,'generic_valid_cases':10,'generic_error_cases':12,'shape_variants':5,'fallback_cases':11,'model_malformed_cases':len(malformed)+6,'payload_checksum_cases':34,'metadata_acl_settings_f64_preserved':True,'seal_called':False,'physics_stub_scope':'unchanged fingerprint only; no mathematical qualification'},sort_keys=True))
    finally:
        command([str(PG/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'])
