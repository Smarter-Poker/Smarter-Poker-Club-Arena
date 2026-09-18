"""Current public PKO caller and real financial catalog, in owned PostgreSQL 17."""
from pathlib import Path
import argparse
import datetime
import json
import re
import signal
import sys
from collections import Counter
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'scripts/ci'))
from satellite_qualifier_fixture import compose,module,sha
MIGRATION='supabase/migrations/20260918083150_pko_independent_head_watermark_admission.sql'
FIX=Path('scripts/dev/fixtures/causal-pko-predecessors')
SIGNATURE='public.fn_pko_watermark_admission_status_v1(uuid,uuid,uuid,uuid,bigint,timestamp with time zone,jsonb)'

def validate_race(code,out,err,mode):
 step='b_claim_'+mode
 expected=Counter({'a_begin':1,'a_claim':1,step:2,'observed_wait':1,'a_'+mode:1,'final_state':1})
 notices=re.findall(r'^(?:[a-z_]+: )?NOTICE:\s*(WATERMARK_[A-Z_]+)\s*$',out+'\n'+err,re.M)
 if (code or err.strip() or re.search(r'\b(?:ERROR|FATAL|PANIC|WARNING):',out)
     or Counter(re.findall(r'^step ([a-z_]+):',out,re.M))!=expected
     or out.count('Parsed test spec with 3 sessions')!=1
     or re.findall(r'^starting permutation: (.*)$',out,re.M)!=[f'a_begin a_claim {step} observed_wait a_{mode} final_state']
     or out.count('<waiting ...>')!=1 or out.count('<... completed>')!=1
     or not re.search(r'^step '+step+r': <\.\.\. completed>\nclaim\n-----\n *\n\(1 row\)',out,re.M)
     or notices!=['WATERMARK_RACE_CLAIM_PROVEN','WATERMARK_RACE_WAIT_PROVEN','WATERMARK_RACE_CLAIM_PROVEN','WATERMARK_RACE_EFFECTS_PROVEN']):
  raise RuntimeError('exact public watermark concurrency proof failed')
 return {'actual_wait':True,'exact_final_effects':True}

def qualify_races(e,root,native,scene):
 spec=(root/FIX/'full-race.spec').read_text();permutations=re.findall(r'^permutation .+$',spec,re.M)
 if len(permutations)!=2:raise ValueError('two exact permutations required')
 body=re.sub(r'^permutation .+$','',spec,flags=re.M);binary=native.stock_isolationtester(e.pg)
 e.report['isolationtester']={'path':str(binary),'sha256':sha(binary)}
 for permutation in permutations:
  mode='rollback' if 'a_rollback' in permutation else 'commit';unused='commit' if mode=='rollback' else 'rollback';case=e.database(scene)
  rendered=re.sub(r'^step "(?:a_'+unused+'|b_claim_'+unused+r')" .*\n','',body,flags=re.M)
  code,out,err=e.run('race-'+mode,[binary,f'host={e.socket} port={e.port} dbname={case} user=postgres'],text=rendered+'\n'+permutation+'\n',seconds=40,check=False)
  proof=validate_race(code,out,err,mode)
  controls=[(1,out,err),(0,'',err),(0,out,'transport failed'),(0,out.replace('<waiting ...>',''),err),(0,out.replace('observer: NOTICE:  WATERMARK_RACE_EFFECTS_PROVEN',''),err),(0,out+'\nERROR: injected failure',err)]
  for badcode,badout,baderr in controls:
   try:validate_race(badcode,badout,baderr,mode)
   except RuntimeError:pass
   else:raise RuntimeError('race verdict accepted missing/false evidence')
  proof['false_evidence_refused']=len(controls);e.discard(case)
  e.report['races'].append({'case':mode,**proof,'database_removed':True})

def qualify_installation(e,root,db):
 for kind,sql in [('body',"DO $$ BEGIN EXECUTE replace(pg_get_functiondef('"+SIGNATURE+"'::regprocedure),'AS $function$','AS $function$'||chr(10)||'-- Native unreviewed drift'||chr(10)); END $$;"),('acl','GRANT EXECUTE ON FUNCTION '+SIGNATURE+' TO service_role;')]:
  case=e.database(db);e.sql(case,sql,label='drift-'+kind)
  before=e.snapshot(case,'drift-data');catalog=e.catalog_snapshot(case,'drift-catalog')
  code,out,err=e.sql(case,file=root/MIGRATION,label='refused-'+kind,check=False)
  if code==0 or 'PKO independent watermark preimage differs' not in err:raise RuntimeError('migration drift accepted: '+kind)
  if e.snapshot(case,'drift-after-data')!=before or e.catalog_snapshot(case,'drift-after-catalog')!=catalog:raise RuntimeError('refused migration changed state')
  e.discard(case);e.report['migration_refusals'].append(kind)
 case=e.database(db);before=e.snapshot(case,'install-data');catalog=e.catalog_snapshot(case,'install-catalog')
 e.sql(case,file=root/MIGRATION,label='installation')
 after=e.catalog_snapshot(case,'install-after-catalog')
 changed=[(x,y) for x,y in zip(catalog['functions'],after['functions']) if x!=y]
 if len(changed)!=1 or changed[0][0][1]!=SIGNATURE.removeprefix('public.') or changed[0][0][:2]!=changed[0][1][:2] or changed[0][0][3:]!=changed[0][1][3:]:raise RuntimeError('installation changed unexpected function or metadata')
 if any(catalog[k]!=after[k] for k in catalog if k!='functions') or e.snapshot(case,'install-after-data')!=before:raise RuntimeError('installation changed business data or unrelated schema')
 e.sql(case,file=root/MIGRATION,label='exact-replay')
 if e.snapshot(case,'replay-data')!=before or e.catalog_snapshot(case,'replay-catalog')!=after:raise RuntimeError('exact migration replay differs')
 for role in ['anon','authenticated','service_role']:
  code,out,err=e.sql(case,'SET ROLE '+role+'; SELECT public.fn_pko_watermark_admission_status_v1(NULL,NULL,NULL,NULL,NULL,NULL,NULL);',label='private-'+role,check=False)
  if code==0 or 'permission denied for function fn_pko_watermark_admission_status_v1' not in err:raise RuntimeError('private helper grants broadened')
 e.discard(case);e.report['installation']={'only_helper_definition_changed':True,'data_unchanged':True,'exact_replay':True,'private_roles_refused':3}
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,default=ROOT);p.add_argument('--evidence',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);a=p.parse_args()
 root=a.root.resolve();out=a.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
 if sha(Path(__file__))!=sha(root/FIX/'full-native.py'):raise ValueError('executed source differs')
 manifest=compose(root);(out/'foundation.sql').write_text(manifest.pop('sql'));manifest.pop('entry_sql')
 paths=[MIGRATION,*[str(FIX/f) for f in ['full-native.py','full-opening.sql','full-cases.sql','full-race.spec','watermark-commuting.sql','watermark-refusals.sql']],'scripts/dev/probe-causal-pko-predecessors-pg17.sh','tests/unit/fixtureNativeCi.test.ts','scripts/qualification/cash-native-hosted.manifest.json','scripts/ci/probes/bounty-rebuy-generation-atomicity.sql','scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql','scripts/ci/test-mtt-unlimited.py','scripts/ci/mtt_isolation_results.py','scripts/ci/mtt_format_qualification.py','scripts/ci/mtt_historical_freebuy_proof.py']
 manifest['source_sha256'].update({s:sha(root/s) for s in paths})
 (out/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 seed=(root/'scripts/ci/probes/bounty-rebuy-generation-atomicity.sql').read_text()
 if seed.count('SET LOCAL session_replication_role=origin;')!=1:raise ValueError('opening seam differs')
 seed=seed.split('SET LOCAL session_replication_role=origin;')[0]+(root/FIX/'full-opening.sql').read_text()
 (out/'opening.sql').write_text(seed)
 native=module(root/'scripts/ci/test-mtt-unlimited.py','watermark_execution');e=native.Execution(root,out,a.pg_bin.resolve(),out,600)
 e.report.update(source_sha256=manifest['source_sha256'],fixture_identity='real-financial-catalog-public-pko-watermark',public_cases=[])
 for s in native.CANCELLATION_SIGNALS:signal.signal(s,native.interrupted)
 try:
  e.start();db=e.database();e.sql(db,file=out/'foundation.sql',label='real-financial-foundation',seconds=180)
  e.sql(db,file=root/'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql',label='structural-opening')
  qualify_installation(e,root,db)
  for shared in [False,True]:
   scene=e.database(db)
   e.sql(scene,"SET fixture.watermark_shared='"+str(shared).lower()+"';\n"+seed,label='opening-'+str(shared))
   for repaired in [False,True]:
    if repaired:e.sql(scene,file=root/MIGRATION,label='guarded-migration')
    before=e.snapshot(scene,'before-data');catalog=e.catalog_snapshot(scene,'before-catalog')
    code,stdout,stderr=e.sql(scene,"SET fixture.watermark_shared='"+str(shared).lower()+"'; SET fixture.watermark_repaired='"+str(repaired).lower()+"';\n"+(root/FIX/'full-cases.sql').read_text(),label=f'public-shared-{shared}-repaired-{repaired}',seconds=120,check=False)
    if code or any(x in stderr for x in ['ERROR:','FATAL:','PANIC:','WARNING:']) or stdout.splitlines().count('PKO_WATERMARK_PUBLIC_CASES_PASS')!=1:
     raise RuntimeError('actual public case failed: '+stderr+stdout)
    if e.snapshot(scene,'after-data')!=before or e.catalog_snapshot(scene,'after-catalog')!=catalog:raise RuntimeError('public probe failed complete rollback')
    e.report['public_cases'].append({'shared_collector':shared,'repaired':repaired,'assertions':stderr.count('WATERMARK PASS:'),'data_catalog_rollback':True})
   if shared:qualify_races(e,root,native,scene)
   e.discard(scene)
  for s,d in manifest['source_sha256'].items():
   if sha(root/s)!=d:raise RuntimeError('input changed: '+s)
  e.discard(db);e.report['status']='passed';e.report['failure']=None
 except BaseException as exc:e.report['failure']=repr(exc)
 finally:
  for s in native.CANCELLATION_SIGNALS:signal.signal(s,signal.SIG_IGN)
  try:e.close()
  except BaseException as exc:e.report['cleanup_failure']=repr(exc);e.report['status']='failed'
  e.report['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(out/'result.json').write_text(json.dumps(e.report,indent=2)+'\n');print(json.dumps({k:e.report.get(k) for k in ['status','failure','public_cases','races','installation','migration_refusals','cleanup']}),flush=True)
 return 0 if e.report['status']=='passed' else 1
if __name__=='__main__':sys.exit(main())
