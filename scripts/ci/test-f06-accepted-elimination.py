"""Real accepted-elimination/F06 composition in the maintained private PG17 owner."""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import re
import signal
import sys
from collections import Counter

sys.dont_write_bytecode=True
from satellite_qualifier_fixture import compose, module, sha, function_sql

MIGRATION='supabase/migrations/20260918082449_accepted_elimination_preserves_f06_source_custody.sql'
CAPTURE='scripts/ci/fixtures/f06-accepted-elimination/current-authorities-20260918.json'
PROBE='scripts/ci/probes/f06-accepted-elimination.sql'
SPEC='scripts/ci/probes/f06-accepted-elimination.spec'
RESULT_TEST='tests/operations/f06-elimination-results.test.py'

def lit(s): return "'"+s.replace("'","''")+"'"

def private_snapshot(e,db,label):
    query="""CREATE FUNCTION pg_temp.private_elimination_snapshot() RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE r record;v jsonb;data jsonb:='{}'; BEGIN
    FOR r IN SELECT c.relname FROM pg_class c WHERE c.relnamespace='smarter_private'::regnamespace AND c.relkind IN ('r','p') ORDER BY c.relname LOOP
     EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM smarter_private.%I t',r.relname) INTO v;
     data:=data||jsonb_build_object(r.relname,v);
    END LOOP;
    RETURN jsonb_build_object('data',data,
    'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.proacl) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE pronamespace='smarter_private'::regnamespace AND prokind='f'),
    'relations',(SELECT jsonb_agg(jsonb_build_array(relname,relkind,pg_get_userbyid(relowner),relacl,relrowsecurity,relforcerowsecurity) ORDER BY relname) FROM pg_class WHERE relnamespace='smarter_private'::regnamespace),
    'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,a.atttypid::regtype::text,a.attnotnull,a.attacl,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum) FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE c.relnamespace='smarter_private'::regnamespace AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(conrelid::regclass::text,conname,pg_get_constraintdef(oid),convalidated) ORDER BY conrelid::regclass::text,conname) FROM pg_constraint WHERE connamespace='smarter_private'::regnamespace),
    'indexes',(SELECT jsonb_agg(jsonb_build_array(i.indexrelid::regclass::text,pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY i.indexrelid::regclass::text) FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='smarter_private'::regnamespace),
    'triggers',(SELECT jsonb_agg(jsonb_build_array(tgrelid::regclass::text,tgname,pg_get_triggerdef(t.oid),tgenabled) ORDER BY tgrelid::regclass::text,tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='smarter_private'::regnamespace),
    'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p WHERE schemaname='smarter_private'));
    END $$; SELECT pg_temp.private_elimination_snapshot();"""
    _,out,_=e.sql(db,query,label=label)
    return json.loads(out.strip())

def validate_race(code,out,err,mode):
    if mode not in ('commit','rollback'):raise ValueError('unknown claim release mode')
    errors=re.findall(r'^(?:[a-z_]+: )?(ERROR|FATAL|PANIC|WARNING):.*$',out+'\n'+err,re.M)
    notices=re.findall(r'^(?:[a-z_]+: )?NOTICE:\s*(ELIMINATION_[A-Z_]+)\s*$',out+'\n'+err,re.M)
    step='b_claim_'+mode
    steps=Counter(re.findall(r'^step ([a-z_]+):',out,re.M))
    expected=Counter({'a_begin':1,'a_claim':1,step:2,'observed_wait':1,'a_'+mode:1,'final_state':1})
    permutation=f'a_begin a_claim {step} observed_wait a_{mode} final_state'
    if (code or err.strip() or errors or steps!=expected
        or out.count('Parsed test spec with 3 sessions')!=1
        or re.findall(r'^starting permutation: (.*)$',out,re.M)!=[permutation]
        or out.count('<waiting ...>')!=1 or out.count('<... completed>')!=1
        or not re.search(r'^step '+step+r': <\.\.\. completed>\nclaim\n-----\n *\n\(1 row\)',out,re.M)
        or notices!=['ELIMINATION_RACE_CLAIM_PROVEN','ELIMINATION_RACE_WAIT_PROVEN','ELIMINATION_RACE_CLAIM_PROVEN','ELIMINATION_RACE_EFFECTS_PROVEN']):
        raise RuntimeError('exact current public claim concurrency proof failed')
    return {'actual_wait':True,'exact_final_effects':True}

def qualify_races(e,root,native,db):
    spec=(root/SPEC).read_text()
    permutations=re.findall(r'^permutation .+$',spec,re.M)
    if len(permutations)!=2:raise ValueError('two exact permutations required')
    body=re.sub(r'^permutation .+$','',spec,flags=re.M)
    binary=native.stock_isolationtester(e.pg)
    e.report['isolationtester']={'path':str(binary),'sha256':sha(binary)}
    for n in (2,4):
      for permutation in permutations:
        mode='rollback' if 'a_rollback' in permutation else 'commit'
        label=f'claim-{n}-{mode}'
        case=e.database(db)
        unused='rollback' if mode=='commit' else 'commit'
        rendered=re.sub(r'^step "(?:a_'+unused+'|b_claim_'+unused+r')" .*\n','',body,flags=re.M)
        code,out,err=e.run(label,[binary,f'host={e.socket} port={e.port} dbname={case} user=postgres'],text=rendered.replace('CASE_NUMBER',str(n))+'\n'+permutation+'\n',seconds=40,check=False)
        proof=validate_race(code,out,err,mode)
        e.discard(case)
        e.report['races'].append({'case':label,**proof,'database_removed':True})

def prepare(root, output):
    manifest=compose(root)
    (output/'foundation.sql').write_text(manifest.pop('sql'))
    manifest.pop('entry_sql')
    builder=module(root/'scripts/ci/build-f06-elimination-migration.py','elimination_builder')
    if builder.render()!=(root/MIGRATION).read_text():
        raise ValueError('maintained migration differs from exact generator')
    captures=json.loads((root/CAPTURE).read_text())['rows']
    # The retained full financial catalog contains the old F06 source guard.
    # Only its independently captured exact successor is composed; the five
    # financial/lane authorities must already match the current capture.
    current=[]
    for r in captures:
        sig=builder.identity(r)
        if sig=='smarter_private.f06_source_guard()':
            current.append("DO $$ BEGIN IF md5(pg_get_functiondef('smarter_private.f06_source_guard()'::regprocedure))<>'d89dc77965f1abea47e366ad6f6a426f' THEN RAISE EXCEPTION 'F06 fixture predecessor drift'; END IF; END $$;"+r['definition'].rstrip()+';')
        current.append("DO $$ BEGIN IF md5(pg_get_functiondef("+lit(sig)+"::regprocedure))<>"+lit(r['definition_md5'])+" THEN RAISE EXCEPTION 'current elimination fixture differs: %',"+lit(sig)+"; END IF; END $$;")
    (output/'current-authorities.sql').write_text('\n'.join(current))
    # Reuse the actual existing synthetic accepted-hand/financial opening.
    # No business function, trigger or financial result is mocked.
    seed=(root/'scripts/ci/probes/bounty-rebuy-generation-atomicity.sql').read_text()
    if seed.count('SET LOCAL session_replication_role=origin;')!=1:
        raise ValueError('exact existing opening boundary differs')
    seed=seed.split('SET LOCAL session_replication_role=origin;')[0]
    seed+='''
-- The fourth retained scene exercises the ordinary elimination authority.
UPDATE public.tournaments SET is_bounty=false,is_pko=false,is_mystery_bounty=false,bounty_amount=0
 WHERE id='b7200000-0000-4000-8000-000000000004';
UPDATE public.tournaments SET is_rebuy=false,is_reentry=false,rebuy_levels=0,late_reg_levels=0,
 late_reg_mins=0,current_level=6 WHERE id::text LIKE 'b7200000-%';
UPDATE public.tournament_players SET rebuy_prompt_until=NULL WHERE tournament_id::text LIKE 'b7200000-%';
UPDATE public.tournament_knockout_candidates SET rebuy_prompt_until=NULL WHERE tournament_id::text LIKE 'b7200000-%';
-- Coherent chronological stages of a synthetic accepted hand. Modern causal
-- proof compares the whole written roster and separately named settlement ID.
UPDATE public.hand_atomic_commits SET committed_at=clock_timestamp()-interval '10 seconds'
 WHERE hand_number BETWEEN 9720001 AND 9720004;
UPDATE public.hand_atomic_commits a SET stack_result=jsonb_set(a.stack_result,'{written}',
 (SELECT jsonb_object_agg(p->>'userId',p->'stack') FROM jsonb_array_elements(h.players) p))
 FROM public.hand_history h WHERE h.id=a.hand_id AND a.hand_number BETWEEN 9720001 AND 9720004;
UPDATE public.settlement_idempotency_keys k SET completed_at=a.committed_at-interval '3 milliseconds',
 result=jsonb_set(k.result,'{written}',a.stack_result->'written')
 FROM public.hand_atomic_commits a WHERE a.hand_number BETWEEN 9720001 AND 9720004
 AND k.table_id=a.table_id AND k.hand_id=(a.stack_result->>'hand_id')::uuid;
UPDATE public.hand_history h SET created_at=a.committed_at-interval '2 milliseconds'
 FROM public.hand_atomic_commits a WHERE h.id=a.hand_id AND a.hand_number BETWEEN 9720001 AND 9720004;
UPDATE public.tournament_knockout_candidates c SET created_at=a.committed_at-interval '1 millisecond'
 FROM public.hand_atomic_commits a WHERE c.hand_id=a.hand_id AND a.hand_number BETWEEN 9720001 AND 9720004;
INSERT INTO smarter_private.f06_operations(break_id,tournament_id,source_table_id,lifecycle,boundary_id,origin_generation,state,revision)
 SELECT gen_random_uuid(),tournament_id,id,f06_lifecycle,gen_random_uuid(),gen_random_uuid(),'park_requested',0
 FROM public.tables WHERE id::text LIKE 'b7300000-%';
SET LOCAL session_replication_role=origin;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
'''
    (output/'opening.sql').write_text(seed+'COMMIT;\n')
    paths=[CAPTURE,MIGRATION,PROBE,SPEC,RESULT_TEST,'scripts/ci/build-f06-elimination-migration.py',
      'scripts/ci/test-f06-accepted-elimination.py','scripts/ci/test-mtt-unlimited.py',
      'scripts/ci/mtt_isolation_results.py','scripts/ci/mtt_format_qualification.py',
      'scripts/ci/mtt_historical_freebuy_proof.py',
      'scripts/ci/probes/bounty-rebuy-generation-atomicity.sql',
      'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql',
      'scripts/ci/fixtures/satellite-qualifiers/current-money-ddl-guard-20260917.json']
    manifest['source_sha256'].update({p:sha(root/p) for p in paths})
    (output/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    return manifest

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[2])
    p.add_argument('--evidence',type=Path,required=True)
    p.add_argument('--pg-bin',type=Path,required=True)
    a=p.parse_args();root=a.root.resolve();out=a.evidence.resolve();out.mkdir(exist_ok=False,parents=True)
    if sha(Path(__file__))!=sha(root/'scripts/ci/test-f06-accepted-elimination.py'):
        raise ValueError('executed elimination owner differs from source binding')
    manifest=prepare(root,out)
    native=module(root/'scripts/ci/test-mtt-unlimited.py','elimination_execution')
    e=native.Execution(root,out,a.pg_bin.resolve(),out,600)
    e.report.update(source_sha256=manifest['source_sha256'],fixture_identity='current-accepted-elimination-with-premanifest-source')
    for s in native.CANCELLATION_SIGNALS:signal.signal(s,native.interrupted)
    try:
        e.start();db=e.database()
        e.sql(db,file=out/'foundation.sql',label='real-current-financial-foundation',seconds=180)
        e.sql(db,file=out/'current-authorities.sql',label='exact-current-elimination-authorities')
        guard=root/'scripts/ci/fixtures/satellite-qualifiers/current-money-ddl-guard-20260917.json'
        if sha(guard)!='8884f9471acd933072afc05ef3f2427cc63a28de9744785d1bc10611f730ef5b':
            raise ValueError('current production money-DDL capture differs')
        captured=json.loads(guard.read_text())
        if captured['event_triggers']!=[{'name':'ab_ca_money_rpc_registered','tags':['CREATE FUNCTION'],'event':'ddl_command_end','owner':'postgres','enabled':'O','function':'fn_ca_money_rpc_registry_guard()'}]:
            raise ValueError('current production money-DDL event differs')
        for row in captured['functions']:
            e.sql(db,function_sql(row),label='real-money-ddl-guard')
        e.sql(db,"CREATE EVENT TRIGGER ab_ca_money_rpc_registered ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION public.fn_ca_money_rpc_registry_guard();",label='real-money-ddl-event')
        e.sql(db,file=root/'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql',label='structural-opening')
        e.sql(db,file=out/'opening.sql',label='synthetic-accepted-hand-opening')
        before=e.snapshot(db,'before-red-data');catalog=e.catalog_snapshot(db,'before-red-catalog')
        # Same actual public caller, no fake dispatch, with the installed guard.
        helper=(root/PROBE).read_text().split('CREATE TEMP TABLE park_before')[0]
        for n in range(1,5):
            code,stdout,stderr=e.sql(db,helper+f'SELECT pg_temp.claim_elimination({n}); ROLLBACK;',label=f'original-public-elimination-{n}-red',check=False)
            if code!=3 or 'F06_SOURCE_EXCLUDED' not in stderr:
                raise RuntimeError('original public elimination did not reproduce exact source refusal: '+stderr+stdout)
        if e.snapshot(db,'after-red-data')!=before or e.catalog_snapshot(db,'after-red-catalog')!=catalog:
            raise RuntimeError('original refused caller changed state')
        e.report['original_source_red']={'exact_refusal':'F06_SOURCE_EXCLUDED','cases':4,'data_catalog_rollback':True}
        for kind,mutation in [
          ('core_body',"DO $$ DECLARE d text; BEGIN SELECT pg_get_functiondef('public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'::regprocedure) INTO d; EXECUTE replace(d,'DECLARE',E'DECLARE\\n-- isolated drift'); END $$;"),
          ('guard_acl','GRANT EXECUTE ON FUNCTION smarter_private.f06_source_guard() TO service_role;'),
          ('source_trigger','ALTER TABLE public.tournament_players DISABLE TRIGGER a00_f06_source_roster;')]:
            altered=e.database(db)
            e.sql(altered,mutation,label='inject-'+kind)
            rows=e.snapshot(altered,'before-'+kind);cat=e.catalog_snapshot(altered,'before-'+kind+'-catalog');priv=private_snapshot(e,altered,'before-'+kind+'-private')
            code,stdout,stderr=e.sql(altered,file=root/MIGRATION,label='refuse-'+kind,check=False)
            expected={'core_body':'F06_ELIMINATION_AUTHORITY_DRIFT','guard_acl':'F06_ELIMINATION_ACL_DRIFT','source_trigger':'F06_ELIMINATION_TRIGGER_DRIFT'}[kind]
            if code!=3 or expected not in stderr:raise RuntimeError('exact drift refusal missing: '+kind)
            if rows!=e.snapshot(altered,'after-'+kind) or cat!=e.catalog_snapshot(altered,'after-'+kind+'-catalog') or priv!=private_snapshot(e,altered,'after-'+kind+'-private'):
                raise RuntimeError('drift refusal left partial state: '+kind)
            e.discard(altered)
            e.report['migration_refusals'].append({'kind':kind,'data_catalog_rollback':True,'database_removed':True})
        e.sql(db,file=root/MIGRATION,label='candidate-install')
        before=e.snapshot(db,'before-green-data');catalog=e.catalog_snapshot(db,'before-green-catalog')
        private_before=private_snapshot(e,db,'before-green-private')
        code,stdout,stderr=e.sql(db,file=root/PROBE,label='actual-public-elimination-green',check=False,seconds=120)
        e.report['case_output']=stdout;e.report['case_errors']=stderr
        if code or any(x in stderr for x in ['ERROR:','FATAL:','PANIC:','WARNING:']):
            raise RuntimeError('actual elimination probe failed; inspect recorded SQL output')
        if stdout.splitlines().count('F06_ACCEPTED_ELIMINATION_PASS')!=1:
            raise RuntimeError('exact completion marker absent')
        if e.snapshot(db,'after-green-data')!=before or e.catalog_snapshot(db,'after-green-catalog')!=catalog or private_snapshot(e,db,'after-green-private')!=private_before:
            raise RuntimeError('probe did not fully roll back data/catalog')
        e.report['assertions']=stderr.count('ELIMINATION PASS:')
        if e.report['assertions']!=98:raise RuntimeError('exact 98 native assertions required')
        e.report['data_rollback']=True;e.report['catalog_rollback']=True
        qualify_races(e,root,native,db)
        for path,digest in manifest['source_sha256'].items():
            if sha(root/path)!=digest:raise RuntimeError('input changed: '+path)
        e.report['status']='passed';e.report['failure']=None;e.discard(db)
    except BaseException as exc:e.report['failure']=repr(exc)
    finally:
        for s in native.CANCELLATION_SIGNALS:signal.signal(s,signal.SIG_IGN)
        try:e.close()
        except BaseException as exc:e.report['cleanup_failure']=repr(exc);e.report['status']='failed'
        e.report['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
        (out/'result.json').write_text(json.dumps(e.report,indent=2)+'\n')
        print(json.dumps({k:e.report.get(k) for k in ['status','failure','assertions','cleanup']}),flush=True)
    return 0 if e.report['status']=='passed' else 1

if __name__=='__main__':sys.exit(main())
