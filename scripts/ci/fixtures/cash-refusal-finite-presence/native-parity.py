from pathlib import Path
import ast,json,os,hashlib,subprocess,tempfile,shutil,socket
import argparse
p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--scratch',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();FIX=Path(__file__).parent;D=Path(tempfile.mkdtemp(prefix='presence-parity-',dir=a.scratch));R=a.repo;PG=a.pg_bin;W=Path(tempfile.mkdtemp(prefix='native-',dir=D));data=W/'data';env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env.update(LC_ALL='C',LANG='C');started=False
with socket.socket()as sk:sk.bind(('127.0.0.1',0));port=str(sk.getsockname()[1])
def cmd(args,s=None):
 with tempfile.TemporaryFile(mode='w+',dir=W)as f:
  if s is not None:f.write(s);f.seek(0)
  p=subprocess.run(list(map(str,args)),stdin=f if s is not None else None,text=True,capture_output=True,env=env,timeout=90)
 return p
def q(s,error=None):
 p=cmd([PG/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres'],s)
 assert (p.returncode and error in p.stderr)if error else not p.returncode,(p.stdout,p.stderr)
 return p.stdout.strip()
setup=next(n.args[0].value for n in ast.walk(ast.parse((R/'scripts/ci/test-weekly-refusal-cover-postgres.py').read_text()))if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='sql'and n.args and isinstance(n.args[0],ast.Constant)and isinstance(n.args[0].value,str)and'CREATE ROLE anon;'in n.args[0].value)
old=(FIX/'before.sql').read_text();new=(FIX/'candidate.sql').read_text();delivery=json.loads((FIX/'delivery-source.json').read_text());migration=R/'supabase/migrations'/(delivery['version']+'_'+delivery['name']+'.sql');protected=migration.read_text();assert hashlib.sha256(protected.encode()).hexdigest()==delivery['protected_source_sha256'];assert new.strip().rstrip(';')in protected;assert hashlib.sha256(new.encode()).hexdigest()==delivery['source_function_sha256'];sig='fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz)';meta="SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE oid='"+sig+"'::regprocedure";cases=[]
try:
 for args in [[PG/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale'],[PG/'pg_ctl','-D',data,'-l',W/'pg.log','-w','start','-o',f"-k '' -p {port} -h 127.0.0.1 -c fsync=off"]]:
  p=cmd(args);assert not p.returncode,p.stderr
 started=True;q(setup);q((R/'scripts/ci/fixtures/cash-refusal-scope-time/index-canonical.sql').read_text().strip().rstrip(';')+';')
 q("INSERT INTO accounting_cash_source_work VALUES(md5('missing')::uuid,md5('absent')::uuid,'blocked',1,now()),(md5('nullpointer')::uuid,NULL,'blocked',1,now());")
 q(old+';REVOKE ALL ON FUNCTION '+sig+'FROM PUBLIC,anon,authenticated,service_role;');assert q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")=='b5ed851614df500cedbfa017e9e21b9a';metadata=q(meta);raw=q("SELECT md5(string_agg(to_jsonb(r)::text,''ORDER BY id))FROM accounting_cash_source_receipts r");work=q("SELECT md5(string_agg(to_jsonb(w)::text,''ORDER BY rake_record_id))FROM accounting_cash_source_work w")
 calls=[]
 for union,club in [("md5('union')::uuid",'NULL'),('NULL',"md5('club')::uuid"),('NULL',"md5('absent')::uuid")]:
  for lo,hi in [("'2026-10-19 07:00Z'","'2026-10-26 07:00Z'"),("'2026-10-26 07:00Z'","'2026-10-27 07:00Z'")]:calls.append((union,club,lo,hi,''))
 calls+=[("md5('union')::uuid",'NULL',"'2026-10-19 07:00Z'","'2026-10-26 07:00Z'",'DELETE FROM accounting_cash_source_work;'),('NULL',"md5('club')::uuid","'2026-10-19 07:00Z'","'2026-10-26 07:00Z'","UPDATE accounting_cash_source_receipts SET scope=jsonb_build_object('kind','club','id',repeat('x',100000));")]
 def answers(body):
  q(body+';');out=[]
  for mode in ['force_generic_plan','force_custom_plan']:
   for union,club,lo,hi,change in calls:out.append(json.loads(q('BEGIN;SET LOCAL plan_cache_mode='+mode+';'+change+'SELECT fn_cash_source_refusals_for_period('+','.join([union,club,lo,hi])+');ROLLBACK;')))
  return out
 expected=answers(old);observed=answers(new);assert expected==observed and len(observed)==16
 for i,v in enumerate(observed):assert v['count']==len(v['sources']);cases.append({'case':'retained_scope_bag_'+str(i),'passed':True})
 assert q(meta)==metadata and q("SELECT md5(string_agg(to_jsonb(r)::text,''ORDER BY id))FROM accounting_cash_source_receipts r")==raw and q("SELECT md5(string_agg(to_jsonb(w)::text,''ORDER BY rake_record_id))FROM accounting_cash_source_work w")==work
 for arg in ['NULL,NULL,now()-interval\'1 day\',now()',"md5('union')::uuid,md5('club')::uuid,now()-interval'1 day',now()","md5('union')::uuid,NULL,'-infinity',now()","md5('union')::uuid,NULL,now(),now()"]:q('SELECT fn_cash_source_refusals_for_period('+arg+');','invalid_cash_refusal_scope')
 canonical=json.loads(q("SELECT jsonb_build_object('definition',pg_get_functiondef(p.oid),'metadata',to_jsonb(p),'full_md5',md5(pg_get_functiondef(p.oid)),'prosrc_md5',md5(p.prosrc))FROM pg_proc p WHERE oid='"+sig+"'::regprocedure"));(D/'native-candidate-canonical.json').write_text(json.dumps(canonical,indent=2)+'\n')
 # Exact compact finite materialization: minority and dominant native plans.
 for label,change,union,club in [('minority',"UPDATE accounting_cash_source_receipts SET scope=jsonb_build_object('kind','union','id',md5('other')::uuid);UPDATE accounting_cash_source_receipts SET scope=jsonb_build_object('kind','club','id',md5('club')::uuid)WHERE id=(SELECT min(id::text)::uuid FROM accounting_cash_source_receipts);",'NULL::uuid',"md5('club')::uuid"),('dominant',"UPDATE accounting_cash_source_receipts SET scope=jsonb_build_object('kind','union','id',md5('union')::uuid);","md5('union')::uuid",'NULL::uuid')]:
  q(change);q('VACUUM ANALYZE accounting_cash_source_receipts;');kernel=new[new.index(' WITH blocked_work'):new.index(' RETURN jsonb_build_object')].replace(' INTO problems','')
  for key,val in [('p_union_id',union),('p_club_id',club),('p_from',"'2026-10-19 07:00Z'::timestamptz"),('p_to',"'2026-10-26 07:00Z'::timestamptz")]:kernel=kernel.replace(key,val)
  plan=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,VERBOSE,FORMAT JSON)'+kernel))[0];nodes=[]
  def walk(n):
   nodes.append(n)
   for c in n.get('Plans',[]):walk(c)
  walk(plan['Plan']);finite=[n for n in nodes if n.get('Subplan Name')=='CTE finite_scope_presence'];assert len(finite)==1 and finite[0]['Node Type']=='Limit',finite
  assert finite[0].get('Plan Rows')==1,finite
  assert any(n.get('Index Name')=='accounting_cash_receipts_scope_time_keys'for n in nodes),nodes
  (D/('native-'+label+'-plan.json')).write_text(json.dumps(plan,indent=2)+'\n')
 from installer_controls import qualify
 installer=qualify(q,protected,old,new,sig)
 out={'same_existing6000row_fixture':True,'sixteen_native_scope_mode_bags_equal':True,'duplicate_missing_NULL_pointers_scopes_dates_infinity_status_mismatch_preserved':True,'four_invalid_scope_errors_preserved':True,'full_metadata_except_prosrc_and_allrawrows_unchanged':True,'finite_presence_LIMIT1_id_plus_orderkeys':True,'minority_natural_existing_CASE_index':True,'no_forced_GUC_in_plan_checks':True,'candidate_full_md5':canonical['full_md5'],'production_or_installer_qualification_NOT_claimed':True,'portable_installer_controls':installer,'cases':cases};(D/'native-result.json').write_text(json.dumps(out,indent=2)+'\n');a.output.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
finally:
 if started:cmd([PG/'pg_ctl','-D',data,'-m','immediate','stop'])
 shutil.rmtree(D)
