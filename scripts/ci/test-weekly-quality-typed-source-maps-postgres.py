#!/usr/bin/env python3
"""PG17 current full weekly-quality source-bag parity, installer and snapshot regression.
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
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--keyed-event-candidate',type=Path);ap.add_argument('--candidate',type=Path,default=REPO/'supabase/migrations/20261028000434_weekly_statement_quality_reads_original_receipt_bags_once.sql');ap.add_argument('--followup-candidate',type=Path);ap.add_argument('--rr-membership-candidate',type=Path);ap.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin')));ap.add_argument('--scratch',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);a=ap.parse_args()
 need(__debug__,'optimized assertions refused');need(a.scratch.is_dir(),'existing owned scratch required');need(not a.output.exists(),'new output required')
 source_fx=HERE/'fixtures/weekly-quality-typed-source-maps'
 body_fx=(HERE/'fixtures/weekly-quality-keyed-event-joins')if a.keyed_event_candidate else source_fx
 before=(body_fx/'quality-before.sql').read_text().rstrip().rstrip(';')+'\n';after=(body_fx/'quality-after.sql').read_text().rstrip().rstrip(';')+'\n';receipt=json.loads((body_fx/'source-receipt.json').read_text())
 old_hash=receipt['before_full_md5']
 candidate=a.keyed_event_candidate or a.rr_membership_candidate or a.followup_candidate or a.candidate
 need(hashlib.md5(before.rstrip().rstrip(';').encode()+b'\n').hexdigest()==old_hash,'actual full preimage changed');need(before.replace(receipt['replacement']['old'],receipt['replacement']['new'],1)==after,'only the reviewed complete quality function may change')
 root=Path(tempfile.mkdtemp(prefix='qbj-',dir=a.scratch.resolve()));need(len(str(root).encode())<90,'owned UNIX socket path too long');data=root/'d';started=False;cases=[];plans={};env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env.update(TMPDIR=str(root),TMP=str(root),TEMP=str(root),LC_ALL='C')
 cmd=[a.pg_bin/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-h',root,'-U','postgres','-d','postgres']
 def run(argv,sql=None,error=None,timeout=45):
  r=subprocess.run([str(x)for x in argv],input=sql,text=True,capture_output=True,env=env,timeout=timeout)
  need((r.returncode!=0 and error in r.stderr)if error else r.returncode==0,r.stdout+r.stderr)
  return r.stdout.strip()
 query_number=0
 def q(sql,error=None):
  nonlocal query_number
  query_number+=1;file=root/('statement-'+str(query_number)+'.sql');file.write_text(sql)
  return run(cmd+['-f',file],error=error)
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
  q((FX/'schema.sql').read_text());q((FX/'installer-authorities.sql').read_text());q((source_fx/'current-boundaries.sql').read_text());q(before+';');need(definition_hash()==old_hash,'PG17 actual preimage full hash mismatch')
  q('REVOKE ALL ON FUNCTION '+SIG+' FROM PUBLIC,anon,authenticated,service_role;')
  q(before.replace('FUNCTION public.fn_accounting_tournament_week_quality(','FUNCTION fixture.quality_before(',1)+';');q((source_fx/'cases.sql').read_text())
  qualify_selected_membership_bags(q,(source_fx/'quality-composed-before.sql').read_text(),after,rec)
  qualify_fee_scope_bags(q,(source_fx/'quality-before-ad73.sql').read_text(),after,rec)
  qualify_installer(candidate,q,definition_hash,state,rec,cmd,env,root,before,after,receipt['native_installer'])
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

  for extra in json.loads((source_fx/'additional-cases.json').read_text()):
   parity(extra['name'],seed+extra['setup'],extra['independent_expected_subset'])
  if a.keyed_event_candidate:qualify_excluded_contract_domains(q,before,after,rec)
  # One caller snapshot is observed blocked at a real advisory barrier.
  q('SELECT fixture.reset();SELECT fixture.event(100);')
  holder=subprocess.Popen([str(x)for x in cmd],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,bufsize=1)
  reader=None
  try:
   holder.stdin.write("SELECT pg_advisory_lock(915141);\n\\echo SNAPSHOT_GATE_LOCKED\n");holder.stdin.flush();deadline=time.monotonic()+5;received=b''
   while time.monotonic()<deadline:
    if select.select([holder.stdout],[],[],.02)[0]:
     received+=os.read(holder.stdout.fileno(),4096)
     if b'SNAPSHOT_GATE_LOCKED'in received:break
   need(b'SNAPSHOT_GATE_LOCKED'in received,'snapshot gate not held')
   reader=subprocess.Popen([str(x)for x in cmd],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
   reader_sql="SET application_name='native_quality_snapshot_reader';WITH gate AS MATERIALIZED(SELECT pg_advisory_xact_lock(915141),fixture.u(1)club) SELECT jsonb_build_array(fixture.quality_before(g.club,'2026-10-05 07:00Z','2026-10-12 07:00Z'),public.fn_accounting_tournament_week_quality(g.club,'2026-10-05 07:00Z','2026-10-12 07:00Z'))FROM gate g;"
   reader.stdin.write(reader_sql);reader.stdin.close();reader.stdin=None;deadline=time.monotonic()+5;blocked=False
   while time.monotonic()<deadline:
    blocked=q("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name='native_quality_snapshot_reader'AND wait_event='advisory'AND backend_xmin IS NOT NULL)")=='t'
    if blocked:break
    time.sleep(.01)
   need(blocked,'actual reader snapshot at advisory barrier was not observed')
   q('UPDATE public.accounting_tournament_recognized_sources SET rake_credit=101;')
   holder.stdin.write("SELECT pg_advisory_unlock(915141);\n\\q\n");holder.stdin.flush();holder.communicate(timeout=5)
   out,err=reader.communicate(timeout=10);need(reader.returncode==0,out+err);seen=json.loads(out.strip());need(seen==[{'status':'ready','checked':1}]*2,'actual caller SQL snapshot changed across concurrent writer')
   changed=json.loads(q("SELECT fixture.verdict('public.fn_accounting_tournament_week_quality')"));need(changed.get('reason')=='tournament_recognized_source_receipts_incomplete','next statement did not see committed source change');rec('actual_STABLE_SQL_snapshot_concurrent_recognition_commit')
  finally:
   if holder.poll()is None:holder.kill();holder.communicate(timeout=3)
   if reader is not None and reader.poll()is None:reader.kill();reader.communicate(timeout=3)
  if a.rr_membership_candidate:qualify_rr_membership_bags(q,before,after,rec)
  if a.keyed_event_candidate:qualify_keyed_event_bags(q,before,after,rec)
  plans=qualify_plan(q,before,after,rec,bank_changed=False,keyed_event=bool(a.keyed_event_candidate))
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
 raw=path.read_bytes();migration=raw.decode();version=config['version'];pre=config.get('before_full_md5','f0d1ca9dace0da884c6b7e77f250604f');post=config['post_full_md5']
 # Only local OID references differ. The production migration retains exact
 # captured metadata; all authority, volatility, ACL and configuration fields
 # are still compared and fault-tested in the fixture.
 import re
 match=re.search(r'\$actual_metadata\$(.*?)\$actual_metadata\$',migration,re.S);need(match is not None,'exact metadata literal missing')
 expected=json.loads(match.group(1));native=json.loads(q("SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE oid="+lit(SIG)+"::regprocedure"))
 for key in ['oid','proowner','prolang','pronamespace']:expected[key]=native[key]
 migration=migration[:match.start(1)]+json.dumps(expected,separators=(',',':'))+migration[match.end(1):]

 seal_before=q("SELECT jsonb_build_array(pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure),smarter_private.original_inventory_basis_generation())")
 def refused(prefix,error):
  previous=state();previous_hash=definition_hash();q(prefix+migration,error);need(state()==previous and definition_hash()==previous_hash,'refusal changed actual function/metadata')
 for prefix in ["SET request.jwt.claims='{}';","SET request.jwt.claim.role='service_role';","SET native.auth_uid='00000000-0000-0000-0000-000000000001';","SET ROLE service_role;"]:
  refused(prefix,'weekly_quality_bags_operator_refused')
 rec('installer_actor_JWT_auth_uid_and_role_refused')
 for prefix in ["SET native.frozen='on';","SET native.window_refusal='fixture';","SET native.boundary='2026-10-18 16:00Z';"]:
  refused(prefix,'weekly_quality_bags_window_refused')
 rec('installer_freeze_break_boundary_refused')
 q("INSERT INTO supabase_migrations.schema_migrations VALUES('"+version+"','existing',ARRAY['installed'])");refused('','weekly_quality_bags_history_replay');q("DELETE FROM supabase_migrations.schema_migrations WHERE version='"+version+"'");rec('installer_history_replay_refused')
 q('ALTER FUNCTION '+SIG+' VOLATILE SECURITY INVOKER');refused('','weekly_quality_bags_exact_preimage_required');q('ALTER FUNCTION '+SIG+' STABLE SECURITY DEFINER');rec('installer_volatility_and_authority_drift_refused')
 q('GRANT EXECUTE ON FUNCTION '+SIG+' TO authenticated');refused('','weekly_quality_bags_exact_preimage_required');q('REVOKE EXECUTE ON FUNCTION '+SIG+' FROM authenticated');rec('installer_ACL_drift_refused')
 q('ALTER FUNCTION '+SIG+' SET search_path=pg_catalog');refused('','weekly_quality_bags_exact_preimage_required');q('ALTER FUNCTION '+SIG+' SET search_path=public');rec('installer_search_path_drift_refused')
 refused("SET native.sources_match='off';",'weekly_quality_bags_source65_required');rec('installer_original_source_guard_refused')
 holder=subprocess.Popen([str(x)for x in cmd],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,bufsize=1)
 try:
  holder.stdin.write("SELECT pg_advisory_lock(hashtextextended('union-accounting-scheduler',0));\n\\echo LOCKED\n");holder.stdin.flush();deadline=time.monotonic()+5;received=b''
  while time.monotonic()<deadline:
   if select.select([holder.stdout],[],[],.2)[0]:
    received+=os.read(holder.stdout.fileno(),4096)
    if b'LOCKED'in received:break
  need(b'LOCKED'in received,'scheduler lock not acknowledged');refused('','weekly_quality_bags_scheduler_owned');rec('installer_competing_original_scheduler_refused')
 finally:
  try:holder.stdin.write("SELECT pg_advisory_unlock(hashtextextended('union-accounting-scheduler',0));\n\\q\n");holder.stdin.flush();holder.communicate(timeout=5)
  except(subprocess.TimeoutExpired,BrokenPipeError):holder.kill();holder.communicate(timeout=3)
 # Installer read witnesses have their own bounded statement; DDL stays five
 # seconds. Accelerated isolation clocks reproduce a witness slower than DDL.
 if '$quality_sources_before$'in migration:
  need(migration.count("SET LOCAL statement_timeout='15s'")==2,'two bounded read phases required')
  ddl=migration.split('DO $original_quality_bags$',1)[1].split('END$original_quality_bags$;',1)[0]
  need('original_inventory_basis_generation()'not in ddl and 'original_inventory_proof_sources_match()'not in ddl,'heavy source reads remain inside DDL')
  narrowed=migration.replace("SET LOCAL statement_timeout='5s'","SET LOCAL statement_timeout='10ms'")
  delayed="BEGIN;CREATE OR REPLACE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE plpgsql STABLE AS $delay$BEGIN PERFORM pg_sleep(0.05);RETURN 'original-inventory-245-v1:3e8afc28be0839e9a91519ba1efc0a12';END$delay$;"
  previous=state();q(delayed+narrowed.rsplit('COMMIT;',1)[0]+'ROLLBACK;');need(state()==previous and definition_hash()==pre,'delayed witness rollback changed function');rec('installer_slow_read_witness_outlives_DDL_budget_without_extending_DDL')
  fault=narrowed.replace(' EXECUTE patched;',' PERFORM pg_sleep(0.05);EXECUTE patched;')
  q(fault,'statement timeout');need(state()==previous and definition_hash()==pre,'DDL timeout failed atomic rollback');rec('installer_DDL_timeout_remains_short_and_atomic')
  for inject,label in [("SET LOCAL native.sources_match='off';",'source65'),("SELECT set_config('ca.weekly_quality_source_qualification',jsonb_set(current_setting('ca.weekly_quality_source_qualification')::jsonb,'{generation}','\"wrong-generation\"')::text,true);",'generation')]:
   fault=migration.replace('DO $quality_sources_after$',inject+'DO $quality_sources_after$',1);q(fault,'weekly_quality_bags_postimage_required');need(state()==previous and definition_hash()==pre,'post witness failure failed rollback');rec('installer_post_'+label+'_refusal_rolls_back_exact_DDL')
  need(q("SELECT COALESCE(NULLIF(current_setting('ca.weekly_quality_source_qualification',true),''),'cleared')")=='cleared','LOCAL qualification escaped aborted transaction')
  rec('installer_LOCAL_qualification_cleared_after_abort')
 i=migration.rfind(post);need(i>=0,'post guard missing');fault=migration[:i]+'0'*32+migration[i+32:];previous=state();q(fault,'weekly_quality_bags_postimage_required');need(state()==previous and definition_hash()==pre,'bad postcondition did not roll back actual full function');rec('installer_bad_postcondition_atomic_rollback')
 committed=q(migration+"SELECT COALESCE(NULLIF(current_setting('ca.weekly_quality_source_qualification',true),''),'cleared');");need(committed=='cleared','LOCAL qualification escaped COMMIT on same connection');rec('installer_LOCAL_qualification_cleared_after_commit_same_connection');need(definition_hash()==post,'actual postimage differs');need(q("SELECT md5(prosrc)FROM pg_proc WHERE oid="+lit(SIG)+"::regprocedure")==config['post_body_md5'],'actual body hash differs');need(q('SELECT pg_get_functiondef('+lit(SIG)+'::regprocedure)')==after.rstrip().rstrip(';'),'installed body is not exact candidate')
 need(q("SELECT jsonb_build_array(pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure),smarter_private.original_inventory_basis_generation())")==seal_before,'original source guard or GEN changed');rec('exact_installer_metadata_source_guard_and_GEN_preserved')
 q("INSERT INTO supabase_migrations.schema_migrations VALUES('"+version+"','installed',ARRAY["+lit(migration)+"])");snap=state();q(migration,'weekly_quality_bags_history_replay');need(state()==snap,'installed replay changed function');rec('installed_replay_preserved')
 q('SET ROLE authenticated;SELECT public.fn_accounting_tournament_week_quality(NULL,NULL,NULL);','permission denied');rec('actual_PG_only_ACL_preserved')

def qualify_selected_membership_bags(q,before,after,rec):
 # Duplicate whole rows/NULL IDs intentionally supported without inferring PKs.
 q("CREATE TABLE fixture.membership_sources AS SELECT * FROM public.accounting_tournament_fee_sources WITH NO DATA;CREATE TABLE fixture.membership_receipts AS SELECT * FROM public.accounting_tournament_recognized_sources WITH NO DATA;")
 q("INSERT INTO fixture.membership_sources(id,tournament_id,rake_record_id,rake_credit,union_id,coordinator_union_id,club_id,player_id,contract,charged_at)VALUES(fixture.u(1),fixture.u(100),fixture.u(800),1.23,NULL,fixture.u(10),fixture.u(20),fixture.u(30),'{\"raw\":\"a\"}','2026-10-01'),(fixture.u(2),fixture.u(101),NULL,-0.11,fixture.u(11),NULL,NULL,NULL,'{\"wrong_event\":true}',NULL),(fixture.u(3),fixture.u(999),fixture.u(801),0,NULL,NULL,NULL,NULL,'{\"global\":true}','2026-10-20'),(NULL,fixture.u(100),NULL,NULL,NULL,NULL,NULL,NULL,'{\"nullid\":true}',NULL),(fixture.u(4),NULL,NULL,7,NULL,NULL,NULL,NULL,'{}',NULL);INSERT INTO fixture.membership_sources SELECT * FROM fixture.membership_sources WHERE id=fixture.u(1);")
 q("INSERT INTO fixture.membership_receipts VALUES(fixture.u(1),fixture.u(999),'2026-10-01','earned',1.23),(fixture.u(2),fixture.u(101),NULL,'refunded',0),(fixture.u(3),fixture.u(100),'2026-10-20','earned',0),(fixture.u(999),fixture.u(100),NULL,'earned',9),(NULL,fixture.u(100),NULL,NULL,NULL),(fixture.u(4),NULL,NULL,'earned',7);INSERT INTO fixture.membership_receipts SELECT * FROM fixture.membership_receipts WHERE source_id=fixture.u(1);")
 def block(source):
  start=source.index('selected_event_sources AS ');end=source.index('), scope_bad AS',start)
  return source[start:end]+')'
 # Independent explicit expected row predicates are not derived from ANY/EXISTS.
 cohorts=[('empty','SELECT NULL::uuid tournament_id WHERE false',['false']*4),('NULL','SELECT NULL::uuid tournament_id',['false']*4),('duplicate','SELECT x tournament_id FROM(VALUES(fixture.u(100)),(fixture.u(100)))v(x)',["tournament_id=fixture.u(100)","tournament_id=fixture.u(100)","source_id=fixture.u(1)","id=fixture.u(3)"]),('mixed','SELECT x tournament_id FROM(VALUES(NULL::uuid),(fixture.u(100)),(fixture.u(101)),(fixture.u(100)))v(x)',["tournament_id IN(fixture.u(100),fixture.u(101))","tournament_id IN(fixture.u(100),fixture.u(101))","source_id IN(fixture.u(1),fixture.u(2))","id IN(fixture.u(2),fixture.u(3))"]),('foreign','SELECT fixture.u(777) tournament_id',['false']*4)]
 for name,members,expected in cohorts:
  prefix='WITH survivors AS MATERIALIZED('+members+'),survivor_ids AS MATERIALIZED(SELECT array_agg(tournament_id)ids FROM survivors),'
  for i,table in enumerate(['selected_event_sources','selected_event_recognized','selected_receipt_recognized','orphan_source_identities']):
   narrow=i==0 and 'SELECT s.id,s.tournament_id,s.rake_record_id FROM public.accounting_tournament_fee_sources s'in after
   projection='id,tournament_id'if i==3 else'id,tournament_id,rake_record_id'if narrow else'*';base='fixture.membership_sources'if i in(0,3)else'fixture.membership_receipts'
   oracle='SELECT '+projection+' FROM '+base+' WHERE '+expected[i]
   queries=[]
   for source in(before,after):
    cte=block(source).replace('public.accounting_tournament_fee_sources','fixture.membership_sources').replace('public.accounting_tournament_recognized_sources','fixture.membership_receipts')
    selected='SELECT '+projection+' FROM '+table
    query=prefix+cte+',actual AS('+selected+'),expected AS('+oracle+")SELECT jsonb_build_object('bag',coalesce((SELECT jsonb_agg(to_jsonb(x)ORDER BY to_jsonb(x)::text)FROM actual x),'[]'),'wrong',EXISTS((SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)UNION ALL(SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)))"
    value=json.loads(q(query));need(value['wrong'] is False,'independent full-field membership bag differs:'+name+':'+table);queries.append(value['bag'])
   need(queries[0]==queries[1],'composed/candidate full bag differs:'+name+':'+table);rec('four_selected_sets_typed_bag_'+name+'_'+table)

def qualify_fee_scope_bags(q,before,after,rec):
 # Reuses duplicate/NULL raw rows, adding SAME-event private plus union scope.
 q("INSERT INTO fixture.membership_sources(id,tournament_id,rake_credit,union_id,contract)VALUES(fixture.u(5),fixture.u(100),0,fixture.u(11),'{\"same_event_mixed\":true}')")
 def block(source):
  if 'fee_scope AS (' in source:
   start=source.index('fee_scope AS (');end=source.index('), scoped AS (',start)
   return source[start:end]+')'
  start=source.index('    FROM ev e LEFT JOIN LATERAL (')+len('    FROM ev e LEFT JOIN LATERAL (')
  end=source.index('    ) f ON true',start)
  inner=source[start:end]
  return 'fee_scope AS (SELECT e.tournament_id,f.* FROM (SELECT DISTINCT tournament_id FROM candidates)e CROSS JOIN LATERAL('+inner+') f)'
 row100="(fixture.u(100),4::bigint,2::bigint,fixture.u(11))";row101="(fixture.u(101),1::bigint,1::bigint,fixture.u(11))";row999="(fixture.u(999),1::bigint,1::bigint,NULL::uuid)"
 for name,keys,rows in [('empty',[],[]),('NULL',['NULL::uuid'],[]),('duplicate',['fixture.u(100)','fixture.u(100)'],[row100]),('mixed',['NULL::uuid','fixture.u(100)','fixture.u(101)','fixture.u(100)'],[row100,row101]),('foreign',['fixture.u(777)'],[]),('global',['fixture.u(100)','fixture.u(101)','fixture.u(999)','NULL::uuid'],[row100,row101,row999])]:
  members='SELECT NULL::uuid tournament_id WHERE false'if not keys else'SELECT x tournament_id FROM(VALUES'+','.join('('+v+')'for v in keys)+')v(x)'
  oracle='SELECT NULL::uuid tournament_id,0::bigint fee_source_count,0::bigint scope_count,NULL::uuid one_union WHERE false'if not rows else'SELECT * FROM(VALUES'+','.join(rows)+')v(tournament_id,fee_source_count,scope_count,one_union)'
  bags=[]
  for source in(before,after):
   cte=block(source).replace('public.accounting_tournament_fee_sources','fixture.membership_sources')
   query='WITH candidates AS MATERIALIZED('+members+'),'+cte+',actual AS(SELECT * FROM fee_scope),expected AS('+oracle+")SELECT jsonb_build_object('bag',coalesce((SELECT jsonb_agg(to_jsonb(x)ORDER BY to_jsonb(x)::text)FROM actual x),'[]'),'wrong',EXISTS((SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)UNION ALL(SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)))"
   value=json.loads(q(query));need(value['wrong']is False,'independent four-field fee_scope differs:'+name);bags.append(value['bag'])
  need(bags[0]==bags[1],'old/new full four-field fee_scope differs:'+name);rec('fee_scope_original_four_fields_independent_'+name)

def qualify_rr_membership_bags(q,before,after,rec):
 q("SELECT fixture.reset();SELECT fixture.event(100);SELECT fixture.event(101);INSERT INTO public.rake_records(id,tournament_id,is_tournament,rake_amount,rake_method,metadata)VALUES(fixture.u(9901),NULL,true,0,'fixture','{\"financial_null\":true}'),(fixture.u(9902),fixture.u(100),false,1,'fixture','{}'),(fixture.u(9903),fixture.u(100),false,-1,'fixture','{}'),(fixture.u(9904),fixture.u(100),true,0,'fixture','{}');")
 def rr(source):
  start=source.index('rr AS MATERIALIZED (');end=source.index('  ), src_sum AS (',start)
  return source[start:end]+'  )'
 for name,members in [('empty',"SELECT NULL::uuid tournament_id WHERE false"),('NULL',"SELECT NULL::uuid tournament_id"),('duplicate',"SELECT tournament_id FROM(VALUES(fixture.u(100)),(fixture.u(100)),(fixture.u(101)))m(tournament_id)"),('mixed_NULL_duplicate',"SELECT tournament_id FROM(VALUES(NULL::uuid),(fixture.u(100)),(fixture.u(100)),(fixture.u(777)))m(tournament_id)"),('foreign',"SELECT fixture.u(777) tournament_id")]:
  prefix='WITH survivors AS MATERIALIZED('+members+'),survivor_ids AS MATERIALIZED(SELECT array_agg(tournament_id)ids FROM survivors),'
  suffix="SELECT coalesce(jsonb_agg(to_jsonb(x)ORDER BY x.id),'[]')FROM rr x"
  old=q(prefix+rr(before)+suffix);new=q(prefix+rr(after)+suffix);need(old==new,'original rr full raw-field bag differs:'+name)
  if name in('duplicate','mixed_NULL_duplicate'):need(len(json.loads(new))>=2,'nonempty duplicate membership proof vacuous')
  rec('original_rr_all_fields_NULL_duplicate_empty_foreign_semijoin_bag_'+name)

def adaptive_mode(source,stream):
 start=source.index('   SELECT (SELECT count(*) FROM selected_event_sources)>=')
 end=source.index(' AS stream',start)
 return source[:start]+'   SELECT '+('true'if stream else'false')+source[end:]

def qualify_excluded_contract_domains(q,before,after,rec,fn_after='public.fn_accounting_tournament_week_quality',suffix=''):
 # NOT MATERIALIZED must not expose contract casts on excluded sources.
 import re
 def prepared_query(source):
  start=source.index('  WITH candidates_all AS (');end=source.index('\n LOOP',start);query=source[start:end]
  for old,new in [('p_from','$1'),('p_to','$2'),('p_club_id','$3'),('scope_union','$4')]:query=re.sub(r'\b'+old+r'\b',new,query)
  return "SELECT COALESCE(jsonb_agg(to_jsonb(z)ORDER BY tournament_id),'[]')FROM("+query+')z'
 domains=[('numeric',{'rake_credit':'not_numeric'}),('timestamp',{'terms_at':'not_timestamp'}),('uuid',{'union_id':'not_uuid','coordinator_union_id':'not_uuid'}),('combined',{'rake_credit':'not_numeric','terms_at':'not_timestamp','union_id':'not_uuid','coordinator_union_id':'not_uuid'})]
 for excluded in ['foreign_scope','outside_week']:
  for domain,invalid in domains:
   setup='SELECT fixture.reset();SELECT fixture.event(100);SELECT fixture.event(200);'
   if excluded=='foreign_scope':
    setup+="UPDATE public.accounting_tournament_fee_sources SET union_id=fixture.u(20),coordinator_union_id=fixture.u(20),club_id=fixture.u(2)WHERE tournament_id=fixture.u(200);UPDATE public.accounting_tournament_fee_recognitions SET union_id=fixture.u(20),bank_club_id=fixture.u(2)WHERE tournament_id=fixture.u(200);UPDATE public.tournament_rake_settlements SET union_id=fixture.u(20),club_id=fixture.u(2)WHERE tournament_id=fixture.u(200);"
   else:
    setup+="UPDATE public.accounting_tournament_fee_recognitions SET recognized_at='2026-09-28'WHERE tournament_id=fixture.u(200);UPDATE public.tournament_rake_settlements SET settled_at='2026-09-28'WHERE tournament_id=fixture.u(200);INSERT INTO public.tournament_terminal_settlements VALUES(fixture.u(200),'2026-10-06',NULL);"
   setup+='UPDATE public.accounting_tournament_fee_sources SET contract=contract||'+lit(json.dumps(invalid))+"::jsonb WHERE tournament_id=fixture.u(200);ANALYZE;";q(setup)
   for mode in ['auto','force_custom_plan','force_generic_plan']:
    body=q('SET plan_cache_mode='+mode+";PREPARE body_before(uuid,timestamptz,timestamptz)AS SELECT fixture.quality_before($1,$2,$3);PREPARE body_after(uuid,timestamptz,timestamptz)AS SELECT "+fn_after+"($1,$2,$3);EXECUTE body_before(fixture.u(1),'2026-10-05 07:00Z','2026-10-12 07:00Z');EXECUTE body_after(fixture.u(1),'2026-10-05 07:00Z','2026-10-12 07:00Z');")
    results=[json.loads(row)for row in body.splitlines()];need(results==[{'status':'ready','checked':1}]*2,'excluded malformed contract full quality domain changed:'+excluded+':'+domain+':'+mode+':'+body)
    sql='SET plan_cache_mode='+mode+';PREPARE rows_before(timestamptz,timestamptz,uuid,uuid)AS '+prepared_query(before)+';PREPARE rows_after(timestamptz,timestamptz,uuid,uuid)AS '+prepared_query(after)+";EXECUTE rows_before('2026-10-05 07:00Z','2026-10-12 07:00Z',fixture.u(1),fixture.u(10));EXECUTE rows_after('2026-10-05 07:00Z','2026-10-12 07:00Z',fixture.u(1),fixture.u(10));"
    rows=[json.loads(row)for row in q(sql).splitlines()];need(len(rows)==2 and rows[0]==rows[1]and len(rows[0])==1 and rows[0][0]['tournament_id']=='00000000-0000-0000-0000-000000000100','excluded malformed contract fullFOR bag changed:'+excluded+':'+domain+':'+mode)
    rec('excluded_contract_domain_fullquality_and_fullFOR_'+excluded+'_'+domain+'_'+mode+suffix)

 if 'receipt_access AS MATERIALIZED'in after and not suffix:
  forced=adaptive_mode(after,False)
  q(forced.replace('FUNCTION public.fn_accounting_tournament_week_quality(','FUNCTION fixture.quality_forced_keyed(',1)+';')
  qualify_excluded_contract_domains(q,before,forced,rec,fn_after='fixture.quality_forced_keyed',suffix='_forced_keyed')

def qualify_keyed_event_bags(q,before,after,rec):
 def selected(source):
  start=source.index('selected_event_sources AS ');end=source.index('), scope_bad AS',start)
  return(source[start:end]+')').replace('public.accounting_tournament_fee_sources','fixture.membership_sources').replace('public.accounting_tournament_recognized_sources','fixture.membership_receipts')
 def joins(source):
  start=source.index('    FROM ',source.index('receipt_bad AS ('));end=source.index('    WHERE (rs.source_id',start)
  return source[start:end].replace('public.accounting_tournament_recognized_sources','fixture.membership_receipts').replace('public.accounting_tournament_fee_sources','fixture.membership_sources')
 for name,ids,want in [('empty',[],0),('NULL',['NULL::uuid'],0),('duplicate',['fixture.u(100)','fixture.u(100)'],12),('missing',['fixture.u(777)'],0),('mixed',['NULL::uuid','fixture.u(100)','fixture.u(101)','fixture.u(100)'],13),('clock_NULL_distinct_duplicate',['fixture.u(100)']*4,24)]:
  members='SELECT NULL::uuid tournament_id,NULL::timestamptz recognized_at WHERE false'if not ids else"SELECT tournament_id,'2026-10-20'::timestamptz recognized_at FROM(VALUES"+','.join('('+v+')'for v in ids)+')m(tournament_id)'
  if name=='clock_NULL_distinct_duplicate':members="SELECT *FROM(VALUES(fixture.u(100),'2026-10-20'::timestamptz),(fixture.u(100),'2026-10-21'::timestamptz),(fixture.u(100),NULL::timestamptz),(fixture.u(100),'2026-10-20'::timestamptz))v(tournament_id,recognized_at)"
  variants=[('original',before)]+([(label,adaptive_mode(after,stream))for label,stream in [('stream',True),('keyed',False)]]if'receipt_access AS MATERIALIZED'in after else[('candidate',after)])
  bags=[]
  for label,source in variants:
   adaptive='receipt_access AS MATERIALIZED'in source;extra=''
   if adaptive:
    a=source.index('survivor_receipt_clock_groups AS NOT MATERIALIZED')if'survivor_receipt_clock_groups AS NOT MATERIALIZED'in source else source.index('receipt_access AS MATERIALIZED');z=source.index('), receipt_bad AS',a)
    extra=','+(source[a:z]+')').replace('public.accounting_tournament_fee_sources','fixture.membership_sources')
   projection="jsonb_build_object('source',to_jsonb(s)-'receipt_recognized_at','receipt',to_jsonb(rs),'survivor',jsonb_build_object('tournament_id',s.tournament_id,'recognized_at',s.receipt_recognized_at))"if adaptive else"jsonb_build_object('source',to_jsonb(s),'receipt',to_jsonb(rs),'survivor',to_jsonb(k))"
   sql='WITH survivors AS MATERIALIZED('+members+'),'+selected(source)+extra+",actual AS(SELECT "+projection+' row'+joins(source)+")SELECT COALESCE(jsonb_agg(row ORDER BY row::text),'[]')FROM actual"
   bags.append(json.loads(q(sql)))
  need(all(b==bags[0]and len(b)==want for b in bags),'adaptive original full source/receipt/survivor bag differs:'+name)
  if name in('duplicate','mixed','clock_NULL_distinct_duplicate'):need(sum(1 for row in bags[-1]if row['receipt']is not None and row['receipt']['tournament_id']!=row['source']['tournament_id'])==(16 if name=='clock_NULL_distinct_duplicate'else 8),'wrong-event receipt multiplicity changed:'+name)
  for label,_ in variants[1:]:rec('adaptive_receipt_full_join_bag_'+name+'_'+label)

def qualify_plan(q,before,after,rec,bank_changed=True,keyed_event=False):
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
 if keyed_event:
  need(newbank and all(n.get('Actual Loops',0)==1 for n in newbank),'original direct recognition/bank joins changed')
  # Point-probe both actual problematic memberships with a nonempty positive book.
  q('SELECT fixture.reset();SELECT fixture.event(1000+n) FROM generate_series(1,5000)n;ANALYZE;')
  sql=query(after)
  prepared=sql.replace("'2026-10-05 07:00Z'::timestamptz",'$1').replace("'2026-10-12 07:00Z'::timestamptz",'$2').replace('fixture.u(1)','$3').replace('fixture.u(10)','$4')
  prepare='PREPARE native_keyed_events(timestamptz,timestamptz,uuid,uuid)AS '+prepared+';'
  for mode in ['auto','force_custom_plan','force_generic_plan']:
   plan=json.loads(q('SET plan_cache_mode='+mode+';'+prepare+"EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF)EXECUTE native_keyed_events('2026-10-05 07:00Z','2026-10-12 07:00Z',fixture.u(1),fixture.u(10))"))[0];plans[mode]=plan
   narrow=[n for n in nodes(plan['Plan'])if n.get('Subplan Name')=='CTE selected_event_sources']
   need(narrow and all(n.get('Plan Width')==48 and n.get('Actual Loops')==1 for n in narrow),'selected-source key materialization is not exactly3UUIDfields:'+mode)
   need(plan['Plan'].get('Actual Rows')==5000,'complete FOR event cardinality changed:'+mode)
   receipts=[n for n in nodes(plan['Plan'])if n.get('Relation Name')=='accounting_tournament_recognized_sources'and n.get('Alias')=='original_receipt']
   need(receipts and all('source_id ='in n.get('Index Cond','')and n.get('Actual Loops',0)>=5000 and n.get('Actual Rows',0)<=1 and 'Index'in n['Node Type']for n in receipts),'combined physical receipt probe not bounded:'+mode)
   if 'receipt_access AS MATERIALIZED'in after:
    raw=[n for n in nodes(plan['Plan'])if n.get('Relation Name')=='accounting_tournament_fee_sources'and n.get('Alias')=='raw'];keyed=[n for n in nodes(plan['Plan'])if n.get('Relation Name')=='accounting_tournament_fee_sources'and n.get('Alias')=='raw_1']
    need(raw and raw[0]['Node Type']=='Seq Scan'and raw[0]['Actual Loops']==1 and keyed and keyed[0]['Actual Loops']==0,'dense receipt branch did not stream exclusively:'+mode)
    append=[n for n in nodes(plan['Plan'])if n['Node Type']=='Append'and any(x.get('Alias')=='raw'for x in nodes(n))and any(x.get('Alias')=='raw_1'for x in nodes(n))]
    hashes=[x for n in append for x in nodes(n)if x['Node Type']=='Hash']
    need(hashes and all(x['Plan Width']<=48 for x in hashes),'dense receipt join hashes wide physical contracts:'+mode)
   rec('actual_full_FOR_adaptive_dense_stream_receipt_'+mode)
  if 'receipt_access AS MATERIALIZED'in after:
   q("UPDATE public.accounting_tournament_fee_recognitions SET recognized_at='2026-09-01'WHERE tournament_id>fixture.u(1050);UPDATE public.tournament_rake_settlements SET settled_at='2026-09-01'WHERE tournament_id>fixture.u(1050);ANALYZE;")
   for mode in ['auto','force_custom_plan','force_generic_plan']:
    plan=json.loads(q('SET plan_cache_mode='+mode+';'+prepare+"EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF)EXECUTE native_keyed_events('2026-10-05 07:00Z','2026-10-12 07:00Z',fixture.u(1),fixture.u(10))"))[0];plans['sparse_'+mode]=plan
    raw=[n for n in nodes(plan['Plan'])if n.get('Relation Name')=='accounting_tournament_fee_sources'and n.get('Alias')=='raw'];keyed=[n for n in nodes(plan['Plan'])if n.get('Relation Name')=='accounting_tournament_fee_sources'and n.get('Alias')=='raw_1']
    need(plan['Plan']['Actual Rows']==50 and raw and raw[0]['Actual Loops']==0 and keyed and keyed[0]['Actual Loops']==50 and 'Index'in keyed[0]['Node Type'],'sparse receipt branch was not exclusively bounded:'+mode)
    rec('actual_full_FOR_adaptive_sparse_keyed_receipt_'+mode)
  q("SELECT fixture.reset();INSERT INTO public.accounting_tournament_fee_recognitions SELECT fixture.u(1000+n),'2026-10-06','cancelled',0,NULL,fixture.u(1),md5('')FROM generate_series(1,5000)n;INSERT INTO public.tournament_rake_settlements SELECT fixture.u(1000+n),'2026-10-06',0,NULL,fixture.u(1)FROM generate_series(1,5000)n;ANALYZE;")
 else:
  need(newbank and all(n.get('Actual Loops',0)==1 for n in newbank),'direct bank bulk access was not proven')
  need(any(n['Node Type']in('Hash Join','Merge Join')for n in nodes(plans['after']['Plan'])),'direct bank query has no bulk join')
  rec('authentic_for_query_5000_full_rows_equal_bank_loops_5000_to_1' if bank_changed else 'authentic_for_query_5000_full_rows_equal_direct_bank_retained')
 # Real full bodies answer the same independently known large cancelled book.
 old=json.loads(q("SELECT fixture.quality_before(fixture.u(1),'2026-10-05 07:00Z','2026-10-12 07:00Z')"));new=json.loads(q("SELECT public.fn_accounting_tournament_week_quality(fixture.u(1),'2026-10-05 07:00Z','2026-10-12 07:00Z')"));need(old==new=={'status':'ready','checked':5000},'large full-body output differs');rec('large_real_quality_full_result_equal')
 return plans
if __name__=='__main__':main()
