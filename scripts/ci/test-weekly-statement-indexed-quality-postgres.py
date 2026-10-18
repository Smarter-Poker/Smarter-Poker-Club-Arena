#!/usr/bin/env python3
"""Focused PG17 whole-quality parity and actual bank join plan regression.
Private local cluster only. No database URL or production connection. External
helper boundaries and accessed-column projections are explicit in fixtures.
"""
import argparse,hashlib,json,os,select,shutil,subprocess,tempfile,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
FX=HERE/'fixtures/weekly-statement-indexed-quality'
SIG='public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'
OLD='a3835ceb0138f097a2130970e3eab34a'
def need(v,message):
 if not v:raise AssertionError(message)
def lit(s):return "'"+s.replace("'","''")+"'"
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--candidate',type=Path,default=REPO/'supabase/migrations/20261018172204_weekly_statement_quality_validates_events_through_indexed_ow.sql');ap.add_argument('--followup-candidate',type=Path);ap.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin')));ap.add_argument('--scratch',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);a=ap.parse_args()
 need(__debug__,'optimized assertions refused');need(a.scratch.is_dir(),'existing owned scratch required');need(not a.output.exists(),'new output required')
 source_fx=HERE/'fixtures/weekly-statement-bulk-quality' if a.followup_candidate else FX
 before=(source_fx/'quality-before.sql').read_text();after=(source_fx/'quality-after.sql').read_text();receipt=json.loads((source_fx/'source-receipt.json').read_text())
 old_hash=receipt['before_full_md5'] if a.followup_candidate else OLD
 candidate=a.followup_candidate or a.candidate
 need(hashlib.md5(before.encode()).hexdigest()==old_hash,'actual full preimage changed');need(before.replace(receipt['replacement']['old'],receipt['replacement']['new'],1)==after,'only the reviewed exact FOR query may change')
 root=Path(tempfile.mkdtemp(prefix='qbj-',dir=a.scratch.resolve()));need(len(str(root).encode())<90,'owned UNIX socket path too long');data=root/'d';started=False;cases=[];plans={};env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env.update(TMPDIR=str(root),TMP=str(root),TEMP=str(root),LC_ALL='C')
 cmd=[a.pg_bin/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-h',root,'-U','postgres','-d','postgres']
 def run(argv,sql=None,error=None,timeout=45):
  r=subprocess.run([str(x)for x in argv],input=sql,text=True,capture_output=True,env=env,timeout=timeout)
  need((r.returncode!=0 and error in r.stderr)if error else r.returncode==0,r.stdout+r.stderr)
  return r.stdout.strip()
 def q(sql,error=None):return run(cmd,sql,error)
 def rec(name):cases.append(name)
 def definition_hash():return q('SELECT md5(pg_get_functiondef('+lit(SIG)+'::regprocedure))')
 def state():return q("SELECT jsonb_build_array(md5(pg_get_functiondef('"+SIG+"'::regprocedure)),p.proowner,p.prosecdef,p.provolatile,p.proacl,p.proconfig)FROM pg_proc p WHERE p.oid='"+SIG+"'::regprocedure")
 def parity(name,setup='',expect=None,args=''):
  q('SELECT fixture.reset();'+setup)
  old=json.loads(q("SELECT fixture.verdict('fixture.quality_before'"+args+")"));new=json.loads(q("SELECT fixture.verdict('public.fn_accounting_tournament_week_quality'"+args+")"))
  need(old==new,name+': entire old/new response differs '+str((old,new)))
  if expect:
   for k,v in expect.items():need(new.get(k)==v,name+': independent expected '+k+' '+str(new))
  rec(name);return new
 try:
  need(' 17.'in run([a.pg_bin/'postgres','--version']),'PG17 required')
  run([a.pg_bin/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
  with(data/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(root)+"'\nshared_buffers='16MB'\nwork_mem='8MB'\nmaintenance_work_mem='16MB'\ntemp_file_limit='128MB'\n")
  run([a.pg_bin/'pg_ctl','-D',data,'-l',root/'server.log','-w','start']);started=True
  q((FX/'schema.sql').read_text());q((FX/'installer-authorities.sql').read_text());q(before);need(definition_hash()==old_hash,'PG17 actual preimage full hash mismatch')
  q('REVOKE ALL ON FUNCTION '+SIG+' FROM PUBLIC,anon,authenticated,service_role;')
  q(before.replace('FUNCTION public.fn_accounting_tournament_week_quality(','FUNCTION fixture.quality_before(',1));q((FX/'cases.sql').read_text())
  qualify_installer(candidate,q,definition_hash,state,rec,cmd,env,root,before,after,receipt.get('native_installer') if a.followup_candidate else None)
  need(q('SELECT proowner=\'postgres\'::regrole AND prosecdef AND provolatile=\'s\' AND proconfig=ARRAY[\'search_path=public\'] FROM pg_proc WHERE oid='+lit(SIG)+'::regprocedure')=='t','quality authority changed')
  seed='SELECT fixture.event(100);'
  parity('empty_week',expect={'status':'ready','checked':0})
  parity('recognized_full_receipts',seed,{'status':'ready','checked':1})
  parity('recognized_null_bank',seed+'DELETE FROM public.tournament_rake_settlements;',{'status':'ready','checked':1})
  parity('bank_disagrees',seed+'UPDATE public.tournament_rake_settlements SET amount=101;',{'reason':'tournament_recognition_bank_disagrees'})
  parity('missing_recognition_known_scope',seed+'DELETE FROM public.accounting_tournament_fee_recognitions;',{'reason':'tournament_terminal_recognition_missing','unknown_scope':False})
  parity('deferred_known_scope',seed+"UPDATE public.accounting_tournament_fee_recognitions SET status='banked_accrual_deferred';",{'reason':'tournament_recognition_deferred','unknown_scope':False})
  unknown=seed+'DELETE FROM public.accounting_tournament_fee_recognitions;TRUNCATE public.accounting_tournament_fee_sources;UPDATE public.tournament_rake_settlements SET union_id=NULL,club_id=fixture.u(2);'
  parity('missing_unknown_scope',unknown,{'reason':'tournament_terminal_recognition_missing','unknown_scope':True})
  parity('deferred_unknown_scope',unknown+"INSERT INTO public.accounting_tournament_fee_recognitions VALUES(fixture.u(100),'2026-10-06 12:00Z','banked_accrual_deferred',100,NULL,fixture.u(2),md5(''));",{'reason':'tournament_recognition_deferred','unknown_scope':True})
  parity('foreign_union_excluded',seed+"UPDATE public.accounting_tournament_fee_sources SET union_id=fixture.u(20),coordinator_union_id=fixture.u(20),club_id=fixture.u(2);UPDATE public.accounting_tournament_fee_recognitions SET union_id=fixture.u(20),bank_club_id=fixture.u(2);UPDATE public.tournament_rake_settlements SET union_id=fixture.u(20),club_id=fixture.u(2);",{'status':'ready','checked':0})
  parity('diamond_excluded',seed+'UPDATE public.tournaments SET club_id=fixture.u(3),union_id=NULL;',{'status':'ready','checked':0})
  parity('outside_fee_week_terminal_inside',seed+"UPDATE public.accounting_tournament_fee_recognitions SET recognized_at='2026-09-28';UPDATE public.tournament_rake_settlements SET settled_at='2026-09-28';INSERT INTO public.tournament_terminal_settlements VALUES(fixture.u(100),'2026-10-06',NULL);",{'status':'ready','checked':0})
  parity('recognized_inside_bank_outside',seed+"UPDATE public.tournament_rake_settlements SET settled_at='2026-10-13';",{'reason':'tournament_recognition_bank_disagrees'})
  parity('net_source_mismatch',seed+'UPDATE public.accounting_tournament_fee_recognitions SET net_rake=101;UPDATE public.tournament_rake_settlements SET amount=101;',{'reason':'tournament_recognition_disagrees_with_sources'})
  parity('missing_recognized_source',seed+'TRUNCATE public.accounting_tournament_recognized_sources;',{'reason':'tournament_recognized_source_receipts_incomplete'})
  parity('orphan_recognized_source',seed+"INSERT INTO public.accounting_tournament_recognized_sources VALUES(fixture.u(999),fixture.u(100),'2026-10-06 12:00Z','earned',0);",{'reason':'tournament_recognized_source_receipts_incomplete'})
  parity('contract_receipt_disagreement',seed+"UPDATE public.accounting_tournament_fee_sources SET contract=jsonb_set(contract,'{player_id}',to_jsonb(fixture.u(51)));",{'reason':'tournament_recognized_source_receipts_incomplete'})
  parity('charged_after_recognized',seed+"UPDATE public.accounting_tournament_fee_sources SET charged_at='2026-10-07';",{'reason':'tournament_recognized_source_receipts_incomplete'})
  cancelled="INSERT INTO public.tournaments VALUES(fixture.u(100),fixture.u(1),NULL);INSERT INTO public.accounting_tournament_fee_recognitions VALUES(fixture.u(100),'2026-10-06','cancelled',0,NULL,fixture.u(1),md5(''));INSERT INTO public.tournament_rake_settlements VALUES(fixture.u(100),'2026-10-06',0,NULL,fixture.u(1));"
  parity('cancelled_zero_fee',cancelled,{'status':'ready','checked':1})
  slow=seed+"INSERT INTO public.rake_records(id,tournament_id,is_tournament,rake_amount,rake_method)VALUES(fixture.u(900),fixture.u(100),true,-10,'fixture');INSERT INTO public.accounting_tournament_fee_sources SELECT fixture.u(901),tournament_id,rake_record_id,10,union_id,coordinator_union_id,club_id,player_id,jsonb_set(contract,'{rake_credit}','10'),charged_at FROM public.accounting_tournament_fee_sources;INSERT INTO public.accounting_tournament_recognized_sources VALUES(fixture.u(901),fixture.u(100),'2026-10-06 12:00Z','refunded',0);INSERT INTO fixture.net_plans SELECT tournament_id,jsonb_build_object('status','proven','source_fingerprint',source_fingerprint,'net_fee',net_rake,'union_id',union_id,'active_source_ids',jsonb_build_array(fixture.u(200100)),'refunded_source_ids',jsonb_build_array(fixture.u(901))),NULL FROM public.accounting_tournament_fee_recognitions;"
  parity('refunded_slow_path_actual_loop',slow,{'status':'ready','checked':1})
  parity('slow_external_23514_refusal',slow+"UPDATE fixture.net_plans SET error_code='23514';",{'reason':'tournament_net_source_evidence_invalid','detail':'fixture external net-plan refusal'})
  parity('null_argument_refused',args=',NULL',expect={'sqlstate':'22023'})
  parity('reversed_period_refused',args=",fixture.u(1),'2026-10-12','2026-10-05'",expect={'sqlstate':'22023'})
  parity('unknown_club_refused',args=',fixture.u(999)',expect={'sqlstate':'22023'})
  plans=qualify_plan(q,before,after,rec,bank_changed=not bool(a.followup_candidate))
  if a.followup_candidate:
   q('SELECT fixture.reset();SELECT fixture.event(1000+n) FROM generate_series(1,5000)n;ANALYZE;')
   for i in range(7):
    for fn in ['fixture.quality_before','public.fn_accounting_tournament_week_quality']:
     need(json.loads(q("SELECT "+fn+"(fixture.u(1),'2026-09-01','2026-09-02')"))=={'status':'ready','checked':0},'cached sparse input changed')
   for fn in ['fixture.quality_before','public.fn_accounting_tournament_week_quality']:
    need(json.loads(q("SELECT "+fn+"(fixture.u(1),'2026-10-05 07:00Z','2026-10-12 07:00Z')"))=={'status':'ready','checked':5000},'cached dense input changed')
   rec('cached_sparse_then_dense_actual_whole_function')
  result={'qualification':'passed','case_count':len(cases),'cases':cases,'before_full_md5':old_hash,'actual_after_full_md5':definition_hash(),'actual_whole_quality_body':True,'bank_primary_key':q("SELECT pg_get_constraintdef(oid)FROM pg_constraint WHERE conrelid='public.tournament_rake_settlements'::regclass AND contype='p'"),'migration_sha256':hashlib.sha256(candidate.read_bytes()).hexdigest(),'plans':plans,'limits':'Controlled accessed-column schemas and external net-plan/terms/mixed-cutover boundaries; no full producer qualification or production latency claim.'}
  a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='plans'}))
 finally:
  if started:run([a.pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','stop'],timeout=20)
  shutil.rmtree(root)

# Installer and plan helpers are defined below; no work runs on import.
def qualify_installer(path,q,definition_hash,state,rec,cmd,env,root,before,after,config=None):
 raw=path.read_bytes();migration=raw.decode();repo=path.resolve().parents[2]
 target_version=config['version'] if config else '20261018172204'
 before_hash=hashlib.md5(before.encode()).hexdigest()
 prerequisites=config['prerequisites'] if config else [('20261017223358',28291,'88e709123e442ba60696eabbc9522666'),('20261018142435',4243,'997086f386079fc582e0565e38f2918c')]
 need(target_version in path.name,'exact assigned migration filename required')
 for version,size,md5 in prerequisites:
  files=list((repo/'supabase/migrations').glob(version+'_*.sql'));need(len(files)==1,'exact prerequisite source file required');source=files[0].read_bytes();need(len(source)==size and hashlib.md5(source).hexdigest()==md5,'prerequisite actual installed bytes changed')
  q("INSERT INTO supabase_migrations.schema_migrations VALUES("+lit(version)+",'fixture_actual',ARRAY["+lit(source.decode())+"])")
 def refused(prefix,error):
  old=state();q(prefix+migration,error);need(definition_hash()==json.loads(old)[0] and state()==old,'refusal did not preserve actual quality authority')
 refused("SET request.jwt.claims='{}';",'weekly_statement_indexed_quality_operator_refused')
 refused("SET native.auth_uid='00000000-0000-0000-0000-000000000001';",'weekly_statement_indexed_quality_operator_refused')
 refused('SET ROLE service_role;','weekly_statement_indexed_quality_operator_refused');rec('installer_actor_jwt_role_refused')
 for prefix in ["SET native.frozen='on';","SET native.window_refusal='fixture';","SET native.boundary='2026-10-18 16:00Z';"]:refused(prefix,'weekly_statement_indexed_quality_window_refused')
 rec('installer_freeze_break_boundary_refused')
 q("INSERT INTO supabase_migrations.schema_migrations VALUES("+lit(target_version)+",'existing',ARRAY['installed'])");refused('','weekly_statement_indexed_quality_history_replay');q("DELETE FROM supabase_migrations.schema_migrations WHERE version="+lit(target_version));rec('installer_history_replay_refused')
 old7329=json.loads(q("SELECT to_jsonb(statements[1]) FROM supabase_migrations.schema_migrations WHERE version='20261017223358'"))
 q("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['wrong'] WHERE version='20261017223358'");refused('','weekly_statement_indexed_quality_installed_producers_required');q("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY["+lit(old7329)+"] WHERE version='20261017223358'");rec('installer_exact_prerequisite_source_refused')
 q('ALTER TABLE public.tournament_rake_settlements DROP CONSTRAINT tournament_rake_settlements_pkey');refused('','weekly_statement_indexed_quality_unique_bank_key_required');q('ALTER TABLE public.tournament_rake_settlements ADD PRIMARY KEY(tournament_id)');rec('installer_bank_unique_pk_required')
 if config:
  q('ALTER TABLE public.rake_records DROP CONSTRAINT rake_records_pkey');refused('','weekly_statement_indexed_quality_unique_rake_key_required');q('ALTER TABLE public.rake_records ADD PRIMARY KEY(id)');rec('installer_rake_pk_required_for_exact_semijoin')
  q("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['wrong'] WHERE version='20261018172204'");refused('','weekly_statement_indexed_quality_installed_producers_required')
  source=(repo/'supabase/migrations/20261018172204_weekly_statement_quality_validates_events_through_indexed_ow.sql').read_text()
  q("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY["+lit(source)+"] WHERE version='20261018172204'");rec('installer_exact_indexed_prerequisite_required')
 q('ALTER FUNCTION '+SIG+' STABLE SECURITY INVOKER');refused('','weekly_statement_indexed_quality_exact_preimage_required');q('ALTER FUNCTION '+SIG+' STABLE SECURITY DEFINER');rec('installer_exact_source_metadata_refused')
 q('ALTER FUNCTION '+SIG+' OWNER TO service_role');refused('','weekly_statement_indexed_quality_exact_preimage_required');q('ALTER FUNCTION '+SIG+' OWNER TO postgres');q('REVOKE ALL ON FUNCTION '+SIG+' FROM PUBLIC,anon,authenticated,service_role;');rec('installer_target_owner_drift_refused')
 refused("SET native.sources_match='off';",'weekly_statement_indexed_quality_current_seal_required');rec('installer_current_source40_guard_refused')
 holder=subprocess.Popen([str(x)for x in cmd],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,bufsize=1)
 try:
  holder.stdin.write("SELECT pg_advisory_lock(hashtextextended('union-accounting-scheduler',0));\n\\echo LOCKED\n");holder.stdin.flush();deadline=time.monotonic()+5;received=b''
  while time.monotonic()<deadline:
   if select.select([holder.stdout],[],[],.2)[0]:
    received+=os.read(holder.stdout.fileno(),4096)
    if b'LOCKED'in received:break
  need(b'LOCKED'in received,'fixture scheduler lock not acknowledged');refused('','weekly_statement_indexed_quality_scheduler_owned');rec('installer_real_competing_scheduler_lock_refused')
 finally:
  try:holder.stdin.write("SELECT pg_advisory_unlock(hashtextextended('union-accounting-scheduler',0));\n\\q\n");holder.stdin.flush();holder.communicate(timeout=5)
  except(subprocess.TimeoutExpired,BrokenPipeError):holder.kill();holder.communicate(timeout=3)
 post=config['post_full_md5'] if config else '446549add594a547005b78935e0895bf';body=config['post_body_md5'] if config else 'c965fce88f13accb33b5af3f532edea9';i=migration.rfind(post);need(i>=0,'exact post guard required');fault=migration[:i]+'0'*32+migration[i+32:];snap=state();q(fault,'weekly_statement_indexed_quality_postimage_required');need(state()==snap and definition_hash()==before_hash,'whole function replacement did not roll back');rec('installer_postcondition_failure_rolls_back_full_function')
 # Real migration body and every admission/metadata check execute unchanged.
 q(migration);need(definition_hash()==post,'actual PG17 whole candidate posthash mismatch');need(q("SELECT md5(prosrc)FROM pg_proc WHERE oid="+lit(SIG)+"::regprocedure")==body,'actual body posthash mismatch');rec('exact_whole_migration_installs_actual_full_and_body_hash')
 need(q('SELECT pg_get_functiondef('+lit(SIG)+'::regprocedure)')==after.rstrip(),'actual installed source differs from exact indexed-query fixture')
 q("INSERT INTO supabase_migrations.schema_migrations VALUES("+lit(target_version)+",'installed',ARRAY["+lit(raw.decode())+"])");snap=state();q(migration,'weekly_statement_indexed_quality_history_replay');need(state()==snap,'installed replay changed candidate');rec('installed_history_replay_preserves_postimage')
 q('SET ROLE authenticated;SELECT public.fn_accounting_tournament_week_quality(NULL,NULL,NULL);','permission denied');rec('existing_private_quality_acl_preserved')

def qualify_plan(q,before,after,rec,bank_changed=True):
 q("SELECT fixture.reset();INSERT INTO public.accounting_tournament_fee_recognitions SELECT fixture.u(1000+n),'2026-10-06','cancelled',0,NULL,fixture.u(1),md5('')FROM generate_series(1,5000)n;INSERT INTO public.tournament_rake_settlements SELECT fixture.u(1000+n),'2026-10-06',0,NULL,fixture.u(1)FROM generate_series(1,5000)n;ANALYZE;")
 def query(source):
  start=source.index('  WITH candidates_all AS (');end=source.index('\n LOOP',start);sql=source[start:end]
  import re
  for old,new in [('p_from',"'2026-10-05 07:00Z'::timestamptz"),('p_to',"'2026-10-12 07:00Z'::timestamptz"),('p_club_id','fixture.u(1)'),('scope_union','fixture.u(10)')]:sql=re.sub(r'\b'+old+r'\b',new,sql)
  return sql
 def nodes(n):
  yield n
  for c in n.get('Plans',[]):yield from nodes(c)
 plans={}
 for label,source in [('before',before),('after',after)]:
  sql=query(source);plan=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF)'+sql))[0];plans[label]=plan
  rows=json.loads(q('SELECT jsonb_agg(to_jsonb(z)ORDER BY tournament_id)FROM('+sql+')z'))
  if label=='before':oldrows=rows
  else:need(rows==oldrows and len(rows)==5000,'large authentic FOR rows differ')
 # Positive-fee events exercise every preserved source/batch/receipt field.
 q('SELECT fixture.reset();SELECT fixture.event(1000+n) FROM generate_series(1,5000)n;ANALYZE;')
 positive_before=json.loads(q('SELECT jsonb_agg(to_jsonb(z)ORDER BY tournament_id)FROM('+query(before)+')z'))
 positive_after=json.loads(q('SELECT jsonb_agg(to_jsonb(z)ORDER BY tournament_id)FROM('+query(after)+')z'))
 need(positive_before==positive_after and len(positive_after)==5000,'positive authentic FOR rows differ')
 need(all(r['invalid_rows']==0 and r['negative_rows']==0 and r['raw_total']==100 and r['batch_bad']==0 and r['scope_bad']==0 and r['receipt_bad']==0 and r['orphan_bad']==0 and r['earned_sum']==100 for r in positive_after),'independent positive receipt facts differ')
 rec('authentic_positive_for_query_5000_all_fields_equal')
 old=json.loads(q("SELECT fixture.quality_before(fixture.u(1),'2026-10-05 07:00Z','2026-10-12 07:00Z')"));new=json.loads(q("SELECT public.fn_accounting_tournament_week_quality(fixture.u(1),'2026-10-05 07:00Z','2026-10-12 07:00Z')"))
 need(old==new=={'status':'ready','checked':5000},'large positive full-body result differs');rec('large_positive_real_quality_full_result_equal')
 q("SELECT fixture.reset();INSERT INTO public.accounting_tournament_fee_recognitions SELECT fixture.u(1000+n),'2026-10-06','cancelled',0,NULL,fixture.u(1),md5('')FROM generate_series(1,5000)n;INSERT INTO public.tournament_rake_settlements SELECT fixture.u(1000+n),'2026-10-06',0,NULL,fixture.u(1)FROM generate_series(1,5000)n;ANALYZE;")
 oldbank=[n for n in nodes(plans['before']['Plan'])if n.get('Relation Name')=='tournament_rake_settlements'];newbank=[n for n in nodes(plans['after']['Plan'])if n.get('Relation Name')=='tournament_rake_settlements']
 if bank_changed:need(any(n.get('Actual Loops',0)>=5000 for n in oldbank),'old forced bank loop was not reproduced')
 else:need(oldbank and all(n.get('Actual Loops',0)==1 for n in oldbank),'installed direct bank owner changed')
 need(newbank and all(n.get('Actual Loops',0)==1 for n in newbank),'direct bank bulk access was not proven')
 need(any(n['Node Type']in('Hash Join','Merge Join')for n in nodes(plans['after']['Plan'])),'direct bank query has no bulk join')
 rec('authentic_for_query_5000_full_rows_equal_bank_loops_5000_to_1' if bank_changed else 'authentic_for_query_5000_full_rows_equal_direct_bank_retained')
 # Real full bodies answer the same independently known large cancelled book.
 old=json.loads(q("SELECT fixture.quality_before(fixture.u(1),'2026-10-05 07:00Z','2026-10-12 07:00Z')"));new=json.loads(q("SELECT public.fn_accounting_tournament_week_quality(fixture.u(1),'2026-10-05 07:00Z','2026-10-12 07:00Z')"));need(old==new=={'status':'ready','checked':5000},'large full-body output differs');rec('large_real_quality_full_result_equal')
 return plans
if __name__=='__main__':main()
