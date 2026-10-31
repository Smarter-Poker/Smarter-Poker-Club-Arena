#!/usr/bin/env python3
"""Private PG17 proof of the current five-owner transition, never a DB installer."""
from pathlib import Path
import argparse,hashlib,json,os,re,shutil,subprocess,tempfile,uuid
p=argparse.ArgumentParser();p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--scratch',type=Path,required=True);p.add_argument('--socket-root',type=Path);p.add_argument('--output',type=Path,required=True);p.add_argument('--template-review',action='store_true');args=p.parse_args()
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/weekly-linked-window-proof';binding=json.loads((F/'source-binding.json').read_text());candidate=R/binding['candidate'];assert hashlib.sha256(candidate.read_bytes()).hexdigest()==binding['candidate_sha256']
for name,digest in binding['fixtures_sha256'].items():assert hashlib.sha256((F/name).read_bytes()).hexdigest()==digest,('fixture changed',name)
S=candidate.read_text();assert args.scratch.is_dir()and not args.output.exists()
if binding['reserved_version']is None:assert args.template_review,'Unreserved template cannot qualify CI delivery'
else:assert re.fullmatch(r'\d{14}',binding['reserved_version'])and'__RESERVED_VERSION__'not in S and binding['source_only_pending_actual_capacity']is False and binding['actual_kernel_proof']['elapsed_ms']<180000
O=Path(tempfile.mkdtemp(prefix='linked5-',dir=args.scratch));PG=args.pg_bin;data=O/'data';sockroot=args.socket_root or args.scratch;sock=sockroot/('l5s-'+uuid.uuid4().hex[:6]);assert len(str(sock/('.s.PGSQL.55523')))<100,'Pass a shorter owned --socket-root';sock.mkdir();port='55523';started=False
norm=lambda x:x.removeprefix('public.').replace('timestamp with time zone','timestamptz');lit=lambda x:"'"+x.replace("'","''")+"'";md5=lambda x:hashlib.md5(x.encode()).hexdigest()
before=json.loads((F/'admission-before.json').read_text());after=json.loads((F/'admission-after.json').read_text());old={norm(x['signature']):x for x in before};target={norm(x['signature']):x for x in after};assert len(old)==len(target)
find=lambda n:next(k for k in old if n+'('in k);LK,WI,RP,AD,SM,GN=[find(n)for n in ['fn_union_pnl_linked_cash_outcomes','weekly_hand_parts_witness','fn_union_pnl_evidence_report','fn_accounting_union_earned_plan_advance','original_inventory_proof_sources_match','original_inventory_basis_generation']];order=[LK,WI,RP,AD,SM];assert {k:md5(target[k]['definition'])for k in order}=={norm(k):v for k,v in binding['postimages'].items()};helpers=[find(n)for n in ['fn_union_pnl_touched_registrations','fn_union_pnl_tournament_entry_club_of','fn_union_pnl_week_shaped_hands']];process=find('fn_process_weekly_accounting_scope');controller=find('weekly_payout_execute')
def call(sql):return subprocess.run([str(PG/'psql'),'-XqAt','-h',str(sock),'-p',port,'-U','postgres','-v','ON_ERROR_STOP=1'],input=sql,capture_output=True,text=True,timeout=30)
def q(sql):
 r=call(sql);assert r.returncode==0,r.stderr+'\n'+r.stdout;return r.stdout
meta="SELECT jsonb_object_agg(p.oid::regprocedure::text,to_jsonb(p))FROM pg_proc p WHERE p.oid=ANY(ARRAY["+','.join(lit(k)+'::regprocedure'for k in old)+']);'
def state():return json.loads(q(meta))
def guard(rows,tag):return 'DO $native_guard$DECLARE e jsonb;p pg_proc;BEGIN FOR e IN SELECT value FROM jsonb_array_elements($context_rows$'+json.dumps(rows,separators=(',',':'))+"$context_rows$::jsonb)LOOP SELECT*INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(e->>'signature');IF to_jsonb(p)IS DISTINCT FROM e->'metadata'OR pg_get_functiondef(p.oid)IS DISTINCT FROM e->>'definition'THEN RAISE EXCEPTION 'native_five_"+tag+"_metadata_or_body_drift';END IF;END LOOP;END $native_guard$;"
try:
 with(O/'initdb.log').open('w')as log:subprocess.run([str(PG/'initdb'),'-D',str(data),'--no-locale','-E','UTF8','-A','trust','-U','postgres'],stdout=log,stderr=subprocess.STDOUT,check=True)
 subprocess.run([str(PG/'pg_ctl'),'-D',str(data),'-l',str(O/'postgres.log'),'-o',f"-k {sock} -p {port} -c listen_addresses='' -c fsync=off -c shared_buffers=16MB",'-w','start'],stdout=subprocess.DEVNULL,check=True);started=True
 setup='SET check_function_bodies=off;CREATE SCHEMA smarter_private;CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE TABLE public.union_pnl_cash_outcomes(dummy integer);'
 for k,row in old.items():
  setup+=row['definition']+';REVOKE ALL ON FUNCTION '+k+' FROM PUBLIC,anon,authenticated,service_role;'
  for acl in row['metadata']['proacl']or[]:
   role,rights=acl.split('=',1);assert rights=='X/postgres';setup+='GRANT EXECUTE ON FUNCTION '+k+' TO '+(role or'PUBLIC')+';'
  # Native fixture import retains ACL ordering; never emitted into production SQL.
  if row['metadata']['proacl']is not None:setup+='UPDATE pg_proc SET proacl=ARRAY['+','.join(lit(x)for x in row['metadata']['proacl'])+']::aclitem[]WHERE oid='+lit(k)+'::regprocedure;'
 inputs=json.loads((F/'generation-inputs.json').read_text())
 setup+=''.join(row['definition']+';'for row in inputs['source_definitions']if norm(row['signature'])not in old)
 q(setup);baseline=state();localbefore=[];localafter=[];oid_fields=('oid','proowner','pronamespace','prolang','prorettype');adaptations={}
 for k,row in old.items():
  key=next(a for a in baseline if norm(a)==k);local=json.loads(json.dumps(row));native=baseline[key]
  actual_definition=q('SELECT pg_get_functiondef('+lit(k)+'::regprocedure);').rstrip('\n')+'\n';assert actual_definition==row['definition'],k
  for field in oid_fields:local['metadata'][field]=native[field]
  assert local['metadata']==native,('non-context metadata mismatch',k)
  adaptations[k]={field:{'captured':row['metadata'][field],'native':native[field]}for field in oid_fields if row['metadata'][field]!=native[field]};localbefore.append(local)
  post=json.loads(json.dumps(target[k]));
  for field in oid_fields:post['metadata'][field]=native[field]
  if k==LK:post['metadata']['prolang']=str(json.loads(q("SELECT to_jsonb(oid)FROM pg_language WHERE lanname='plpgsql';")))
  localafter.append(post)
 pre=guard(localbefore,'pre');post=guard(localafter,'post');ddl='\n'.join(target[k]['definition']+';'for k in order)
 block=S.split('-- BEGIN EXACT FIVE OWNERS\n',1)[1].split('\n-- END EXACT FIVE OWNERS',1)[0];assert block.rstrip()==ddl.rstrip()
 assert all(old[k]==target[k]for k in old if k not in order)
 # Report/advance now implement admitted original-window proof, not a pin-only delta.
 prosrc=lambda s:re.search(r'AS (\$\w*\$)([\s\S]*?)\1',s).group(2)
 retained=json.loads((F/'retained-logical-proof.json').read_text());assert retained['bag']=={'new':17801,'old':17801,'diff':0};assert prosrc(target[LK]['definition'])==prosrc((F/'linked-semantic-baseline.sql').read_text());assert ' SET enable_nestloop TO \'off\'\n'in target[LK]['definition']
 cases=[('positive',pre+ddl+post,True),('config_missing',pre+ddl.replace(" SET enable_nestloop TO 'off'\n",'')+post,False),('installed_helper_ACL_drift','GRANT EXECUTE ON FUNCTION '+helpers[0]+' TO PUBLIC;'+pre+ddl+post,False),('mixed_pre',target[LK]['definition']+';'+pre+ddl+post,False),('replay',pre+ddl+post+pre+ddl+post,False),('wrong_witness_pin',pre+ddl.replace(md5(target[LK]['definition']),md5(old[LK]['definition']))+post,False),('wrong_source65_pin',pre+''.join(target[k]['definition']+';'for k in order[:-1])+target[SM]['definition'].replace(md5(target[WI]['definition']),md5(old[WI]['definition']))+';'+post,False),('forced_post_failure',pre+ddl+post+"DO $$BEGIN RAISE EXCEPTION 'forced';END $$;",False),('current_credit_owner_drift','GRANT EXECUTE ON FUNCTION '+process+' TO PUBLIC;'+pre+ddl+post,False),('controller_metadata_drift','ALTER FUNCTION '+controller+" SET work_mem='1MB';"+pre+ddl+post,False)]
 verdicts=[]
 for name,sql,expected in cases:
  r=call('BEGIN;SET LOCAL check_function_bodies=off;'+sql+'ROLLBACK;');(O/(name+'.log')).write_text(r.stdout+r.stderr);assert(r.returncode==0)==expected,(name,r.stderr[-1500:]);assert state()==baseline,name;verdicts.append(name)
 # Parse production and reader source without executing production admission,
 # GEN, maintenance or financial guards. No production test switch is added.
 grammar=[]
 for name,source in [('installer',S)]+[(mode,(F/f'strict-{mode}-READONLY15-ROLLBACK180.sql.in').read_text())for mode in ['pre','post']]:
  driver=source.split('BEGIN;',1)[1].rsplit('COMMIT;'if name=='installer'else'ROLLBACK;',1)[0];tag='$grammar_five$';assert tag not in driver
  q('BEGIN;CREATE FUNCTION pg_temp.parse_five()RETURNS void LANGUAGE plpgsql AS '+tag+'BEGIN IF false THEN '+driver+' END IF;END;'+tag+';ROLLBACK;');grammar.append(name)
 sourcehash="SELECT md5(string_agg(signature||':'||md5(pg_get_functiondef(to_regprocedure(signature))),'|'ORDER BY signature))FROM(VALUES "+','.join('('+lit(x['signature'])+')'for x in inputs['source_definitions'])+')s(signature);'
 oldhash=q(sourcehash).strip();derive=lambda h:'original-inventory-245-v1:'+md5(h+'|'+inputs['proofs']+'|'+inputs['discharges_text']+'|'+inputs['treasury']);assert oldhash==inputs['source_hash']and derive(oldhash)==binding['old_generation']
 newhash=q('BEGIN;SET LOCAL check_function_bodies=off;'+pre+ddl+post+sourcehash+'ROLLBACK;').strip();assert derive(newhash)==binding['new_generation']
 focused=[]
 for i,name in enumerate(['validator-cases.sql','producer-control-cases.sql','assembler-cases.sql','linked84-boundary-bag-cases.sql','kind-extension-cases.sql']):
  db='focused'+str(i);q('CREATE DATABASE '+db+';')
  r=subprocess.run([str(PG/'psql'),'-XqAt','-h',str(sock),'-p',port,'-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],input=(F/name).read_text(),capture_output=True,text=True,timeout=30);assert r.returncode==0,(name,r.stderr);focused.append({'file':name,'notice':r.stderr.strip()})
 result={'passed':True,'source_only':True,'template_review':args.template_review,'candidate_sha256':binding['candidate_sha256'],'native_cases':verdicts,'focused_cases':focused,'all_current_metadata_and_bodies_rollback_exact':True,'context_only_oid_adaptations':adaptations,'production_SQL_has_no_native_bypass':True,'grammar_compiled':grammar,'retained_17801_logical_body_byte_equal_no_bag_rerun':True,'old_generation_reproduced':derive(oldhash),'new_generation_derived':derive(newhash),'actual_live_generation_and_financial_postread_still_required':True,'production_capacity_claimed':False};args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'passed':True,'cases':len(verdicts),'grammar':grammar,'template_review':args.template_review}))
finally:
 if started:subprocess.run([str(PG/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'],stdout=subprocess.DEVNULL,check=True)
 if data.exists():shutil.rmtree(data)
 if sock.exists():sock.rmdir()
 shutil.rmtree(O)
