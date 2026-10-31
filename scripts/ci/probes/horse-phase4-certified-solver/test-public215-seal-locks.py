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

with tempfile.TemporaryDirectory(prefix='seal-once-draft-', dir=base) as folder, tempfile.TemporaryDirectory(prefix='so215-', dir=socket_base) as socket:
    task = Path(folder)
    data = task/'data'
    env = {**clean,'PGHOST':socket,'PGPORT':'55477','PGDATABASE':'postgres','PGUSER':'fixture_owner',
           'PGPASSFILE':str(task/'absent'), 'PGSERVICEFILE':str(task/'absent-service')}
    command([str(PG/'initdb'),'-D',str(data),'-U','fixture_owner','-A','trust','--no-locale','--encoding=UTF8'])
    command([str(PG/'pg_ctl'),'-D',str(data),'-l',str(task/'postgres.log'),'-o',f"-F -k {socket} -p 55477 -c listen_addresses=''",'-w','start'])
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


        import hashlib
        old=re.search(r'CREATE OR REPLACE FUNCTION public.fn_gto_v31_seal_build\(.*?AS \$function\$.*?\$function\$',(HERE/'public215-seal-before.sql').read_text(),re.S).group()+'\n';new=re.search(r'CREATE OR REPLACE FUNCTION public.fn_gto_v31_seal_build\(.*?AS \$function\$.*?\$function\$', (ROOT/'supabase/migrations/20261031215525_v31_model_validation_serializes_the_same_forest_once.sql').read_text(),re.S).group()+'\n'
        anchor="  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not building'; END IF;"
        lock="\n  IF v_dataset.policy_representation='public_hist215_v1' THEN\n    PERFORM c.cell_id FROM public.gto_v31_runtime_cells c\n      WHERE c.dataset_id=p_dataset_id ORDER BY c.cell_key_checksum FOR SHARE;\n  END IF;"
        needle="OR CASE WHEN v_dataset.policy_representation='public_hist215_v1' THEN false\n                 ELSE NOT public.fn_gto_v31_cell_payload_valid(to_jsonb(c)) END)"
        assert new.replace(anchor+lock,anchor).replace(needle,'OR NOT public.fn_gto_v31_cell_payload_valid(to_jsonb(c)))')==old
        sql("""CREATE ROLE service_role LOGIN;CREATE TABLE public.gto_v31_datasets(dataset_id uuid PRIMARY KEY,state text,policy_representation text);
CREATE TABLE public.gto_v31_runtime_cells(cell_id uuid PRIMARY KEY,dataset_id uuid NOT NULL REFERENCES public.gto_v31_datasets(dataset_id),cell_key_checksum text NOT NULL,cell_payload_checksum text NOT NULL,source_rows int,train_source_rows int,holdout_source_rows int,payload_valid boolean NOT NULL);
ALTER TABLE public.gto_v31_datasets ENABLE ROW LEVEL SECURITY;ALTER TABLE public.gto_v31_runtime_cells ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.fixture_immutable()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF OLD.payload_valid IS DISTINCT FROM NEW.payload_valid OR TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable';END IF;RETURN NEW;END$$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.gto_v31_runtime_cells FOR EACH ROW EXECUTE FUNCTION public.fixture_immutable();
CREATE TABLE public.calls(kind text);
CREATE FUNCTION public.fn_gto_v31_cell_key_checksum(jsonb)RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT $1->>'cell_key_checksum'$$;
CREATE FUNCTION public.fn_gto_v31_cell_payload_checksum(jsonb)RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT 'payload-checksum'$$;
CREATE FUNCTION public.fn_gto_v31_cell_payload_valid(jsonb)RETURNS boolean LANGUAGE plpgsql AS $$BEGIN INSERT INTO calls VALUES('payload');RETURN ($1->>'payload_valid')::boolean;END$$;
CREATE FUNCTION public.fn_gto_v31_public215_dataset_models_valid(public.gto_v31_datasets)RETURNS boolean LANGUAGE plpgsql AS $$BEGIN INSERT INTO calls VALUES('full-first');IF $1.policy_representation IS DISTINCT FROM 'public_hist215_v1' THEN RETURN true;END IF;RETURN NOT EXISTS(SELECT 1 FROM gto_v31_runtime_cells c WHERE c.dataset_id=$1.dataset_id AND public.fn_gto_v31_cell_payload_valid(to_jsonb(c))IS NOT TRUE);END$$;
INSERT INTO public.gto_v31_datasets VALUES('11111111-1111-4111-8111-111111111111','building','public_hist215_v1');
INSERT INTO public.gto_v31_runtime_cells VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','key-a','payload-checksum',65,57,8,true);
REVOKE ALL ON public.gto_v31_datasets,public.gto_v31_runtime_cells FROM PUBLIC,service_role;""")
        assert sql("SELECT bool_and(convalidated) FROM pg_constraint WHERE conrelid='public.gto_v31_runtime_cells'::regclass AND contype='f'")=='t'
        assert sql("SELECT bool_and(tgenabled='O') FROM pg_trigger WHERE tgrelid='public.gto_v31_runtime_cells'::regclass")=='t'
        assert sql("SELECT NOT has_table_privilege('service_role','public.gto_v31_runtime_cells','INSERT,UPDATE,DELETE')")=='t'
        predicate_old=old[old.index('  IF EXISTS (\n    SELECT 1 FROM public.gto_v31_runtime_cells c\n     WHERE c.dataset_id=p_dataset_id\n       AND (c.cell_key_checksum'):]
        predicate_old=predicate_old[:predicate_old.index(" END IF;")+8]
        predicate_new=new[new.index('  IF EXISTS (\n    SELECT 1 FROM public.gto_v31_runtime_cells c\n     WHERE c.dataset_id=p_dataset_id\n       AND (c.cell_key_checksum'):]
        predicate_new=predicate_new[:predicate_new.index(" END IF;")+8]
        for name,pred,locking in [('old',predicate_old,''),('new',predicate_new,lock)]:
            sql("CREATE FUNCTION public.fixture_seal_"+name+"(p_dataset_id uuid)RETURNS text LANGUAGE plpgsql AS $$DECLARE v_dataset public.gto_v31_datasets;v text;BEGIN SELECT * INTO v_dataset FROM public.gto_v31_datasets WHERE dataset_id=p_dataset_id AND state='building'FOR UPDATE;"+anchor+locking+"IF public.fn_gto_v31_public215_dataset_models_valid(v_dataset)IS NOT TRUE THEN RAISE EXCEPTION 'first payload invalid';END IF;"+pred+"SELECT md5(string_agg(cell_key_checksum||':'||cell_payload_checksum||':'||source_rows::text,''ORDER BY cell_key_checksum))INTO v FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;RETURN v;END$$;")
        ident="'11111111-1111-4111-8111-111111111111'::uuid"
        checks=[]
        for rep in ["'public_hist215_v1'","'matrix_v2'",'NULL']:
            sql('UPDATE public.gto_v31_datasets SET policy_representation='+rep)
            result=[]
            for name in ['old','new']:
                sql('TRUNCATE calls');value=sql('SELECT fixture_seal_'+name+'('+ident+')');counts=sql("SELECT count(*)FILTER(WHERE kind='full-first'),count(*)FILTER(WHERE kind='payload')FROM calls");result.append((value,counts))
            assert result[0][0]==result[1][0]
            assert result[0][1]==('1|2'if rep=="'public_hist215_v1'"else'1|1'),result
            assert result[1][1]=='1|1',result;checks.append(rep)
        sql("UPDATE public.gto_v31_datasets SET policy_representation='public_hist215_v1'")
        # Validated false payload is a controlled corruption fixture, no production state.
        sql('ALTER TABLE gto_v31_runtime_cells DISABLE TRIGGER immutable;UPDATE gto_v31_runtime_cells SET payload_valid=false;ALTER TABLE gto_v31_runtime_cells ENABLE TRIGGER immutable;')
        for name in ['old','new']:sql('SELECT fixture_seal_'+name+'('+ident+')',error='first payload invalid')
        sql('ALTER TABLE gto_v31_runtime_cells DISABLE TRIGGER immutable;UPDATE gto_v31_runtime_cells SET payload_valid=true;ALTER TABLE gto_v31_runtime_cells ENABLE TRIGGER immutable;')
        sql("UPDATE gto_v31_runtime_cells SET cell_payload_checksum='changed'")
        for name in ['old','new']:sql('SELECT fixture_seal_'+name+'('+ident+')',error='a compact cell seal or payload no longer validates')
        sql("UPDATE gto_v31_runtime_cells SET cell_payload_checksum='payload-checksum'")
        args=[str(PG/'psql'),'-qXAt','-v','ON_ERROR_STOP=1']
        def session():return subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**env,'PGOPTIONS':'-c statement_timeout=10000'})
        def line(p,s):p.stdin.write(s+'\n');p.stdin.flush();return p.stdout.readline().strip()
        owner=session();assert line(owner,"BEGIN;SELECT pg_backend_pid();").isdigit()
        # Dataset ownership and actual FOR SHARE lock establish the identical row set.
        owner.stdin.write("SELECT dataset_id FROM gto_v31_datasets WHERE dataset_id="+ident+" FOR UPDATE;\n");owner.stdin.flush();assert owner.stdout.readline().strip()=='11111111-1111-4111-8111-111111111111'
        assert line(owner,"SELECT cell_id FROM gto_v31_runtime_cells WHERE dataset_id="+ident+" ORDER BY cell_key_checksum FOR SHARE;")=='22222222-2222-4222-8222-222222222222'
        assert line(owner,'SELECT fn_gto_v31_public215_dataset_models_valid(d)FROM gto_v31_datasets d WHERE dataset_id='+ident+';')=='t'
        for statement in ["UPDATE gto_v31_runtime_cells SET cell_payload_checksum='changed'",'DELETE FROM gto_v31_runtime_cells',"INSERT INTO gto_v31_runtime_cells VALUES('33333333-3333-4333-8333-333333333333',"+ident+",'key-b','payload-checksum',65,57,8,true)"]:
            sql("SET lock_timeout='150ms';"+statement,error='lock timeout')
        assert line(owner,'SELECT fixture_seal_new('+ident+');')
        line(owner,'COMMIT;SELECT 1;');owner.stdin.close();owner.wait(timeout=10);assert owner.returncode==0
        # Writer already owns FK key-share: seal waits, then includes committed new row.
        writer=session();assert line(writer,"BEGIN;INSERT INTO gto_v31_runtime_cells VALUES('33333333-3333-4333-8333-333333333333',"+ident+",'key-b','payload-checksum',65,57,8,true);SELECT pg_backend_pid();").isdigit()
        waiting=session();waiting.stdin.write('SELECT fixture_seal_new('+ident+');\n');waiting.stdin.close();waiting.stdin=None
        observed=False
        for _ in range(50):
            if sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='psql'AND wait_event_type='Lock'AND pid<>pg_backend_pid())")=='t':observed=True;break
            time.sleep(.01)
        assert observed,'preceding writer did not block parent lock'
        line(writer,'COMMIT;SELECT 1;');writer.stdin.close();writer.wait(timeout=10)
        value,error=waiting.communicate(timeout=10);assert waiting.returncode==0,error
        assert sql('SELECT fixture_seal_old('+ident+')')==value.strip()
        assert sql('SELECT count(*)FROM gto_v31_runtime_cells')=='2'
        print(json.dumps({'exact_two_anchor_body_delta':True,'validated_fk_enabled_triggers_service_denied':True,'public_payload_calls_old':2,'public_payload_calls_new':1,'full_first_validator_calls':1,'legacy_null_unchanged':True,'bad_payload_and_checksum_both_refuse':True,'concurrent_insert_update_delete_blocked':True,'preceding_writer_waited_and_included':True,'checksum_equal':True}))
    finally:
        command([str(PG/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'])
