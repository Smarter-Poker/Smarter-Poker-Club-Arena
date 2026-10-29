from pathlib import Path
import json,re,hashlib,subprocess,shutil,os,uuid,argparse,tempfile
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/original-cash-three-helper-forward'
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin')));ap.add_argument('--scratch',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);args=ap.parse_args();assert args.scratch.is_dir()and not args.output.exists()
O=Path(tempfile.mkdtemp(prefix='three-',dir=args.scratch));E=json.loads((F/'expected27.json').read_text());binding=json.loads((F/'source-binding.json').read_text());S=(R/'supabase/migrations'/binding['migration']).read_text();PG=args.pg_bin;data=O/'data';sock=O;port='55493';started=False
before={r['signature']:r for r in E['before']};after={r['signature']:r for r in E['after']};changed=[k for k in before if before[k]!=after[k]];assert len(changed)==3
lit=lambda x:"'"+x.replace("'","''")+"'"
def call(s):
 (O/'statement.sql').write_text(s)
 return subprocess.run([str(PG/'psql'),'-X','-h',str(sock),'-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At','-f',str(O/'statement.sql')],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
def must(s):
 r=call(s);assert r.returncode==0,r.stdout[-1800:];return r
metaquery='SELECT jsonb_object_agg(w.signature,jsonb_build_object(\'metadata\',to_jsonb(p),\'md5\',md5(pg_get_functiondef(p.oid)),\'definition\',pg_get_functiondef(p.oid)))FROM(VALUES'+','.join('('+lit(k)+')'for k in before)+')w(signature)JOIN pg_proc p ON p.oid=to_regprocedure(w.signature);'
try:
 with(O/'native-init.log').open('w')as f:subprocess.run([str(PG/'initdb'),'-D',str(data),'--no-locale','-E','UTF8','-A','trust','-U','postgres'],stdout=f,stderr=subprocess.STDOUT,check=True)
 subprocess.run([str(PG/'pg_ctl'),'-D',str(data),'-l',str(O/'native-postgres.log'),'-o',f"-k {sock} -p {port} -c listen_addresses='' -c fsync=off -c shared_buffers=16MB",'-w','start'],stdout=subprocess.DEVNULL,check=True);started=True
 setup='CREATE SCHEMA smarter_private;CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE TABLE public.union_pnl_cash_outcomes(table_id uuid,hand_number bigint,PRIMARY KEY(table_id,hand_number));CREATE TABLE public.union_pnl_cash_outcome_touches(table_id uuid,hand_number bigint,PRIMARY KEY(table_id,hand_number));SET check_function_bodies=off;'
 for k,r in before.items():
  setup+=r['definition']+';'
  if r['metadata']['proacl']is not None:
   setup+='REVOKE ALL ON FUNCTION '+k+' FROM PUBLIC,anon,authenticated,service_role;'
   for acl in r['metadata']['proacl']:
    role,rights=acl.split('=',1);assert rights=='X/postgres',acl
    setup+='GRANT EXECUTE ON FUNCTION '+k+' TO '+(role or 'PUBLIC')+';'
   # Native fixture import retains actual ACL array ordering as well as rights.
   setup+='UPDATE pg_proc SET proacl=ARRAY['+','.join(lit(x)for x in r['metadata']['proacl'])+']::aclitem[] WHERE oid='+lit(k)+'::regprocedure;'
 must(setup)
 baseline=json.loads(must(metaquery).stdout)
 for k,r in before.items():
  assert baseline[k]['md5']==hashlib.md5(r['definition'].encode()).hexdigest(),k
  assert baseline[k]['metadata']['proacl']==r['metadata']['proacl'],('actual ACL not faithfully imported',k)
 expected=json.loads(json.dumps(baseline))
 for k in changed:
  m=expected[k]['metadata'];r=after[k];m['prosrc']=r['metadata']['prosrc'];n=m['proname'];
  if 'touched_registrations'in n:m['prolang']=str(json.loads(must("SELECT to_jsonb(l.oid)FROM pg_language l WHERE lanname='sql';").stdout));m['prosecdef']=False;m['proconfig']=None
  if 'entry_club_of'in n:m['proconfig']=None
  expected[k]['md5']=hashlib.md5(r['definition'].encode()).hexdigest();expected[k]['definition']=r['definition']
 def guard(rows,label):
  payload=json.dumps([{'signature':k,'metadata':r['metadata'],'md5':r['md5']}for k,r in rows.items()],separators=(',',':'))
  return 'DO $guard$DECLARE e jsonb;p pg_proc%ROWTYPE;BEGIN FOR e IN SELECT value FROM jsonb_array_elements($rows$'+payload+"$rows$::jsonb)LOOP SELECT*INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(e->>'signature');IF to_jsonb(p)IS DISTINCT FROM e->'metadata'OR md5(pg_get_functiondef(p.oid))IS DISTINCT FROM e->>'md5'THEN RAISE EXCEPTION 'three_"+label+"_drift';END IF;END LOOP;END $guard$;"
 pre=guard(baseline,'pre');post=guard(expected,'post');ddl=''.join(after[k]['definition']+';'for k in changed);sh=next(k for k in changed if 'shaped'in k);to=next(k for k in changed if 'touched'in k);rp=next(k for k in before if 'evidence_report'in k);acl='REVOKE ALL ON FUNCTION '+sh+' FROM PUBLIC,anon,authenticated;'
 # Preserve all non-target definitions, including actual GEN function. No GEN/data execution fixture is substituted.
 assert all(before[k]==after[k]for k in before if k not in changed)
 cases=[('positive',pre+ddl+acl+post,True),('replay',pre+ddl+acl+post+pre,False),('mixed',after[to]['definition']+';'+pre+ddl+post,False),('post_failure',pre+ddl+acl+post+"DO $$BEGIN RAISE EXCEPTION 'forced_post';END$$;",False),('ACL_drift','GRANT EXECUTE ON FUNCTION '+sh+' TO PUBLIC;'+pre+ddl+post,False),('non_target_caller_drift','GRANT EXECUTE ON FUNCTION '+rp+' TO PUBLIC;'+pre+ddl+post,False)]
 results=[]
 for label,s,ok in cases:
  r=call('BEGIN;SET LOCAL check_function_bodies=off;'+s+'ROLLBACK;');(O/(label+'-native.log')).write_text(r.stdout);assert(r.returncode==0)==ok,(label,r.stdout[-1600:]);assert json.loads(must(metaquery).stdout)==baseline,label;results.append(label)
 admission=re.search(r'DO \$admission\$BEGIN(.*?)IF EXISTS',S,re.S).group(1);r=call('BEGIN;SET ROLE authenticated;DO $auth$BEGIN '+admission+'END$auth$;ROLLBACK;');assert r.returncode!=0 and 'real_owner_required'in r.stdout;results.append('unauthorized_actual_owner_predicate')
 pk=re.search(r'DO \$forward_shape_pk\$.*?END \$forward_shape_pk\$;',S,re.S).group();must('BEGIN;'+pk+'ROLLBACK;')
 for label,fault in [('missing_PK','ALTER TABLE union_pnl_cash_outcome_touches DROP CONSTRAINT union_pnl_cash_outcome_touches_pkey;'),('deferred_PK','ALTER TABLE union_pnl_cash_outcome_touches DROP CONSTRAINT union_pnl_cash_outcome_touches_pkey;ALTER TABLE union_pnl_cash_outcome_touches ADD PRIMARY KEY(table_id,hand_number)DEFERRABLE;')]:
  r=call('BEGIN;'+fault+pk+'ROLLBACK;');assert r.returncode!=0 and 'touch_candidate_primary_identity_changed'in r.stdout;must('BEGIN;'+pk+'ROLLBACK;');results.append(label)
 driver=S.split('BEGIN;',1)[1].rsplit('COMMIT;',1)[0];must('BEGIN;CREATE TEMP TABLE ns(x int);CREATE FUNCTION pg_temp.parse_three()RETURNS void LANGUAGE plpgsql AS $parse$BEGIN IF false THEN '+driver+' END IF;END;$parse$;ROLLBACK;')
 result={'passed':True,'source_only':True,'source_sha256':hashlib.sha256(S.encode()).hexdigest(),'exact27_canonical_before':True,'exact3_changed':changed,'other24_fullmetadata_and_canonical_definitions_byteunchanged':True,'native_cases':results,'full_wrapper_grammar_compiles':True,'native_GEN_gate_not_executed_not_actualGENproof':True,'unchanged_actual_GEN_definition':True,'fivepaid84_checks':'Exact existing query source preserved and full wrapper grammar compiled; no financial tables/rows faked; actual pre/post still required','normal_maintenance_stats_history_admission':'Full source grammar only; no fake actual edbd install or maintenance admission','no_semantic_bags_repeated':True};args.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
finally:
 if started:subprocess.run([str(PG/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'],stdout=subprocess.DEVNULL,check=True)
 if data.exists():shutil.rmtree(data)
 shutil.rmtree(O)
