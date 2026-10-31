#!/usr/bin/env python3
"""Real maintained reader before/after migration in isolated native PostgreSQL 17."""
import json
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

with tempfile.TemporaryDirectory(prefix='seal-once-draft-', dir=base) as folder, tempfile.TemporaryDirectory(prefix='sv3215-', dir=socket_base) as socket:
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
                assert result.returncode == 0, result.stderr
            return result.stdout.strip()


        import copy,hashlib
        # Extract the maintained scalar dependency closure; no corpus fixture.
        funcs={}
        for file in sorted((ROOT/'supabase/migrations').glob('*.sql')):
            if file.name>'20261007043945z':continue
            text=file.read_text()
            for match in re.finditer(r'CREATE(?: OR REPLACE)? FUNCTION public\.(\w+)\s*\(',text,re.I):
                tail=text[match.start():];delim=re.search(r'\bAS\s+(\$\w*\$)',tail,re.I)
                if not delim:continue
                end=tail.find(delim.group(1),delim.end())
                if end>=0:funcs[match.group(1)]=tail[:end+len(delim.group(1))]+';\n'
        deps=[];seen=set()
        def add(name):
            if name in seen:return
            seen.add(name);text=funcs[name]
            for dep in set(re.findall(r'public\.(fn_\w+)\s*\(',text))-{name}:add(dep)
            deps.append(text)
        for name in ['fn_gto_v31_node_checksum','fn_gto_v31_source_node_scalar_types_valid','fn_gto_v31_action_specs_valid','fn_gto_v31_node_line_proof','fn_gto_v31_physical_positions_valid','fn_gto_texture_class_any','fn_gto_v31_combo_cards','fn_gto_v31_complete_public_state']:add(name)
        sql('CREATE SCHEMA extensions;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;'+'\n'.join(deps))
        baseline=funcs['fn_gto_v31_source_node_valid'].replace('fn_gto_v31_source_node_valid(', 'fn_gto_v31_source_node_v3_valid(').replace('OR NOT public.fn_gto_v31_source_node_scalar_types_valid(p_node)','OR NOT public.fn_gto_v31_source_node_scalar_types_valid(p_node)\n     OR NOT public.fn_gto_v31_physical_positions_valid(p_node)')
        # Dispatcher was defined later; recover original complete V3 body.
        historical=(ROOT/'supabase/migrations/20260909171644_v31_policy_json_is_canonical.sql').read_text()
        baseline=historical[historical.index('CREATE OR REPLACE FUNCTION public.fn_gto_v31_source_node_valid('):];baseline=baseline[:baseline.index('$fn$;',baseline.index('AS $fn$'))+6].replace('fn_gto_v31_source_node_valid(', 'fn_gto_v31_source_node_v3_valid(').replace('OR NOT public.fn_gto_v31_source_node_scalar_types_valid(p_node)','OR NOT public.fn_gto_v31_source_node_scalar_types_valid(p_node)\n     OR NOT public.fn_gto_v31_physical_positions_valid(p_node)')
        assert hashlib.md5(baseline.split('$fn$')[1].encode()).hexdigest()=='fd185af67a480d8262109575a25ac51e'
        migration=(ROOT/'supabase/migrations/20261031215525_v31_model_validation_serializes_the_same_forest_once.sql').read_text()
        def candidate_function(name):
            tail=migration[migration.index('CREATE OR REPLACE FUNCTION public.'+name+'('):]
            d=re.search(r'\bAS\s+(\$\w*\$)',tail,re.I);end=tail.index(d.group(1),d.end())
            return tail[:end+len(d.group(1))]+';'
        candidate=candidate_function('fn_gto_v31_source_node_v3_fields_valid')+'\n'+candidate_function('fn_gto_v31_source_node_v3_valid')
        candidate=candidate.replace('fn_gto_v31_source_node_v3_fields_valid(', 'fixture_fields_new(')
        for suffix,text in [('old',baseline),('new',candidate)]:sql(text.replace('fn_gto_v31_source_node_v3_valid(', 'fixture_v3_'+suffix+'('))
        assert hashlib.md5(funcs['fn_gto_v31_source_node_v4_valid'].split('$fn$')[1].encode()).hexdigest()=='4af1170638a0145b286b4b687d998fc3'
        for suffix,text in [('old',funcs['fn_gto_v31_source_node_v4_valid']),('new',candidate_function('fn_gto_v31_source_node_v4_valid'))]:
            sql(text.replace('fn_gto_v31_source_node_v3_fields_valid(', 'fixture_fields_new(').replace('fn_gto_v31_source_node_v4_valid(', 'fixture_v4_'+suffix+'(').replace('fn_gto_v31_source_node_v3_valid(', 'fixture_v3_'+suffix+'('))
        gen=(ROOT/'scripts/ci/probes/horse-phase4-certified-solver/public215-admission.sql').read_text();sql(gen[:gen.index('CREATE TEMP TABLE')])
        ctx={'street':'flop','game_family':'cash','objective':'cash_ev','utility_context':'cash_ev','table_size':2,'pot_type':'limped','hero_position':'BB','opponent_position':'SB','depth_bucket':80,'texture_class':'Brud','node_role':'open','facing_kind':'none','facing_size_bucket':'none'}
        board='Qc9d2h';ctx['texture_class']=sql("SELECT fn_gto_texture_class_any('"+board+"')")
        def lit(n):return '$node$'+json.dumps(n,separators=(',',':'))+'$node$::jsonb'
        n=json.loads(sql("SELECT public215_fixture_node('"+board+"',"+lit(ctx)+")"))
        def seal(n):
            return json.loads(sql('SELECT '+lit(n)+"||jsonb_build_object('node_checksum',fn_gto_v31_node_checksum("+lit(n)+'))'))
        v4=seal(n);v3={k:v for k,v in n.items() if k not in ['complete_public_state','solver_ranges']};v3['schema']='smarter-poker.pio-policy.v3';v3=seal(v3)
        def pair(n,version,expected=None):
            n=seal(n);v=sql('SELECT fixture_'+version+'_old('+lit(n)+'),fixture_'+version+'_new('+lit(n)+')');assert v in ['t|t','f|f'],(version,v)
            if expected is not None:assert v==('t|t' if expected else 'f|f'),(version,v)
            return v
        pair(v3,'v3',True);pair(v4,'v4',True)
        # Type-equivalence boundary only: make the checksum all numeric so a
        # JSON-number input can reach the V4 text-comparison guard. This is
        # not real hash qualification; restore the actual dependency at once.
        checksum_definition=sql("SELECT pg_get_functiondef('public.fn_gto_v31_node_checksum(jsonb)'::regprocedure)")
        try:
            sql("CREATE OR REPLACE FUNCTION public.fn_gto_v31_node_checksum(p_node jsonb)RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=public,extensions AS $control$SELECT repeat('1',64)$control$;")
            boundary=copy.deepcopy(v4);boundary['node_checksum']=int('1'*64)
            assert sql('SELECT fixture_v4_old('+lit(boundary)+'),fixture_v4_new('+lit(boundary)+')')=='t|t'
        finally:
            sql(checksum_definition)

        sql("CREATE ROLE service_role LOGIN;CREATE ROLE anon LOGIN;CREATE ROLE authenticated LOGIN;GRANT USAGE ON SCHEMA extensions TO service_role;")
        for fn in ['fixture_v3_old','fixture_v3_new','fixture_v4_old','fixture_v4_new','fixture_fields_new']:
            sql('REVOKE ALL ON FUNCTION public.'+fn+'(jsonb)FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION public.'+fn+'(jsonb)TO service_role;')
        for role in ['anon','authenticated']:
            for fn in ['fixture_v3_new','fixture_v4_new','fixture_fields_new']:
                sql('SELECT '+fn+'('+lit(v3)+')',role=role,error='permission denied')
        for ver,base in [('v3',v3),('v4',v4)]:
            assert sql('SELECT fixture_'+ver+'_new('+lit(base)+')',role='service_role')=='t'
            for value in [None,'x','0'*64,123,{},[],False]:
                z=copy.deepcopy(base);z['node_checksum']=value
                assert sql('SELECT fixture_'+ver+'_old('+lit(z)+'),fixture_'+ver+'_new('+lit(z)+')')=='f|f'
            z=copy.deepcopy(base);z.pop('node_checksum');assert sql('SELECT fixture_'+ver+'_old('+lit(z)+'),fixture_'+ver+'_new('+lit(z)+')')=='f|f'
            assert sql('SELECT fixture_'+ver+'_old(NULL),fixture_'+ver+'_new(NULL)')=='f|f'

        live=next(i for i,x in enumerate(v3['matchups']) if x>0);blocked=next(i for i,x in enumerate(v3['matchups']) if x==0)
        count=2
        def change(base,path,value,version,expected=False):
            global count
            z=copy.deepcopy(base);parent=z
            for k in path[:-1]:parent=parent[k]
            parent[path[-1]]=value;pair(z,version,expected);count+=1
        for base,ver in [(v3,'v3'),(v4,'v4')]:
            for value in [None,'1',True,{},[]]:
                for path in [['matchups',live],['frequencies','b75',live],['action_evs_bb','b75',live],['policy_evs_bb',live]]:change(base,path,value,ver)
            for path in [['action_evs_bb','b75',blocked],['policy_evs_bb',blocked]]:
                for value in [0,'0',False,{},[]]:change(base,path,value,ver)
            change(base,['frequencies','b75',blocked],1,ver)
            change(base,['matchups',blocked],1,ver)
            change(base,['matchups',live],2,ver,True)
            change(base,['matchups',live],-1,ver)
            change(base,['frequencies','b75',live],1.00001,ver)
            # Exact decimal tolerance boundaries, no floating point in SQL arithmetic.
            change(base,['frequencies','b75',live],0.99998,ver,True)
            change(base,['frequencies','b75',live],0.999979,ver)
            change(base,['policy_evs_bb',live],1.02,ver,True)
            change(base,['policy_evs_bb',live],1.020001,ver)
            change(base,['node_context','hero_position'],'SB',ver)
            change(base,['frequencies','b75'],base['frequencies']['b75'][:-1],ver)
        for side in ['OOP','IP']:
            for value in [None,'1',False,{},[], -1,1.00001]:change(v4,['solver_ranges',side,live],value,'v4')
            change(v4,['solver_ranges',side,blocked],1,'v4')
            change(v4,['solver_ranges',side],v4['solver_ranges'][side][:-1],'v4')
            change(v4,['solver_ranges',side],v4['solver_ranges'][side]+[0],'v4')
        change(v4,['solver_ranges','OOP',live],0,'v4')
        change(v4,['solver_ranges','IP',live],0,'v4',True)
        # Actual opposite actor / physical-role positive path from unchanged helpers.
        ip=copy.deepcopy(v4);ip['node']='r:0:c';ip['node_context']['hero_position']='SB';ip['node_context']['opponent_position']='BB';ip['line_proof']['hero_solver_player']=1
        ip['complete_public_state']=json.loads(sql('SELECT fn_gto_v31_complete_public_state('+lit(ip)+')'))
        pair(ip,'v4',True);count+=1
        change(ip,['solver_ranges','IP',live],0,'v4')
        change(ip,['solver_ranges','OOP',live],0,'v4',True)
        ip3={k:v for k,v in ip.items() if k not in ['complete_public_state','solver_ranges']};ip3['schema']='smarter-poker.pio-policy.v3';pair(ip3,'v3',True);count+=1

        # One representative synthetic full1326-vector observation; no actual captures.
        assert sql("SELECT bool_and(fn_gto_v31_combo_cards(b*(b-1)/2+a)=ARRAY[substr('23456789TJQKA',a/4+1,1)||substr('cdhs',a%4+1,1),substr('23456789TJQKA',b/4+1,1)||substr('cdhs',b%4+1,1)]) FROM generate_series(1,51)b CROSS JOIN generate_series(0,50)a WHERE a<b")=='t'
        times={}
        for version,base in [('v3',v3),('v4',v4)]:
            for suffix in ['old','new']:
                query='SELECT fixture_'+version+'_'+suffix+'('+lit(base)+')'
                start=time.perf_counter();assert sql(query)=='t';times[version+'_'+suffix]=time.perf_counter()-start
        server_times={}
        for version,base in [('v3',v3),('v4',v4)]:
            for suffix in ['old','new']:
                server_times[version+'_'+suffix]=float(sql("DO $timing$DECLARE n jsonb:="+lit(base)+";started timestamptz;elapsed numeric;result boolean;BEGIN started:=clock_timestamp();FOR i IN 1..10 LOOP result:=fixture_"+version+"_"+suffix+"(n);IF result IS NOT TRUE THEN RAISE EXCEPTION 'invalid';END IF;END LOOP;elapsed:=extract(epoch from clock_timestamp()-started)/10;PERFORM set_config('fixture.elapsed',elapsed::text,false);END $timing$;SELECT current_setting('fixture.elapsed');").splitlines()[-1])
        print(json.dumps({'native_exit':0,'differential_cases':count,'v3_actual_preimage':'fd185af67a480d8262109575a25ac51e','synthetic_full_vector_seconds_including_client':times,'all_verdicts_equal':True,'server_seconds_per_node_mean10':server_times}))
    finally:
        command([str(PG/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'])
