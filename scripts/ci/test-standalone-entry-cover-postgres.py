#!/usr/bin/env python3
"""Exact original standalone ENTRY rows before/after one physical index on PG17."""
import argparse,hashlib,json,os,re,socket,subprocess,tempfile
from pathlib import Path
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/standalone-entry-cover'
M=R/'supabase/migrations/20261027223143_standalone_entry_covers_original_tournament_witnesses.sql'
p=argparse.ArgumentParser();p.add_argument('--scratch',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();a.scratch.mkdir(parents=True,exist_ok=True)
I='accounting_tournament_standalone_club_event_cover';C='20000000-0000-0000-0000-000000000001';D='20000000-0000-0000-0000-000000000002';U='10000000-0000-0000-0000-000000000001'
def lit(s):return "'"+s.replace("'","''")+"'"
def nodes(n):
 yield n
 for x in n.get('Plans',[]):yield from nodes(x)
with tempfile.TemporaryDirectory(prefix='se-',dir=a.scratch)as tmp:
 t=Path(tmp);data=t/'data';pg=a.pg_bin
 with socket.socket()as so:so.bind(('127.0.0.1',0));port=str(so.getsockname()[1])
 env={**os.environ,'PGHOST':'127.0.0.1','PGPORT':port,'PGUSER':'postgres','PGDATABASE':'postgres','PGSSLMODE':'disable','TMPDIR':str(t)}
 def run(cmd,s=None,error=None):
  o=subprocess.run(list(map(str,cmd)),input=s,text=True,capture_output=True,env=env,timeout=180)
  if error:assert o.returncode and error in o.stderr,(error,o.stdout,o.stderr)
  else:assert o.returncode==0,(o.stdout,o.stderr)
  return o.stdout.strip()
 def q(s,error=None):return run([pg/'psql','-XAtq','-v','ON_ERROR_STOP=1'],s,error)
 assert ' 17.'in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=trust','--no-locale','-E','UTF8'])
 with(data/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses='127.0.0.1'\nunix_socket_directories=''\ntimezone='UTC'\nport="+port+'\n')
 run([pg/'pg_ctl','-D',data,'-l',t/'log','-w','start'])
 try:
  catalog=json.loads((F/'actual-catalog.json').read_text());tables=[x for x in catalog if 'table'in x];owners=[x for x in catalog if 'signature'in x]
  expected_owners={'fn_union_week_start(timestamp with time zone)':'103f192a228084dad0e4268c36c82c4b','fn_union_prev_week_start(timestamp with time zone)':'538130fb95504d2854a9c6e8b75214cc','fn_process_weekly_accounting_scope(uuid,uuid)':'72ab1c8c7e8408119bf670db527e8e64','fn_club_settlement_floor_week(uuid)':'9e7e293af19b244b2176c27e62f678e4','smarter_private.original_inventory_proof_sources_match()':'8734797c6093c7e5a2a72de9b387a6de','fn_ca_launch_accounting_cutoff(text,uuid)':'cc3063873cf25be4b70e7cc893617c37'}
  assert {x['signature']:x['full_md5']for x in owners}==expected_owners
  q('CREATE SCHEMA smarter_private;CREATE SCHEMA auth;CREATE SCHEMA extensions;CREATE EXTENSION "uuid-ossp";CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;')
  # Controlled ID-only endpoints preserve every captured FK, rather than silently
  # removing source constraints. No endpoint financial implementation is invoked.
  endpoints={'auth.users':('id','uuid'),'public.profiles':('id','uuid'),'public.unions':('id','uuid'),'public.accounting_cash_accrual_batches':('rake_record_id','uuid'),'public.accounting_tournament_fee_batches':('rake_record_id','uuid'),'public.union_wallet_transactions':('id','uuid'),'public.chip_ledger':('id','uuid')}
  for name,(col,typ)in endpoints.items():q('CREATE TABLE '+name+'('+col+' '+typ+' PRIMARY KEY);')
  for table in tables:
   cols=[]
   for col in table['columns']:
    s='"'+col['name']+'" '+col['type']
    if col['default']:
     if table['table']=='union_accounting_runs'and col['name']in['scope_id','scope_kind']:s+=' GENERATED ALWAYS AS('+col['default']+') STORED'
     else:s+=' DEFAULT '+col['default']
    if col['notnull']:s+=' NOT NULL'
    cols.append(s)
   q('CREATE TABLE public.'+table['table']+'('+','.join(cols)+');')
  for table in tables:
   for c in table['constraints']:
    if c['definition'].startswith(('CHECK','PRIMARY KEY','UNIQUE')):q('ALTER TABLE '+table['table']+' ADD CONSTRAINT "'+c['name']+'" '+c['definition']+';')
  for ix in json.loads((F/'actual-indexes.json').read_text()):
   if q('SELECT to_regclass('+lit(ix['name'])+')IS NULL')=='t':q(ix['definition']+';')
  for table in tables:
   for c in table['constraints']:
    if c['definition'].startswith('FOREIGN KEY'):q('ALTER TABLE '+table['table']+' ADD CONSTRAINT "'+c['name']+'" '+c['definition']+';')
  for owner in sorted(owners,key=lambda x:('fn_club_settlement_floor_week'in x['signature'],'fn_union_prev_week_start'in x['signature'])):
   q('SET check_function_bodies=off;'+owner['definition']+';')
   assert q('SELECT md5(pg_get_functiondef('+lit(owner['signature'])+'::regprocedure))')==owner['full_md5'],owner['signature']
  signature_list=','.join(lit(x['signature'])+'::regprocedure'for x in owners)
  meta='SELECT jsonb_agg(to_jsonb(p)ORDER BY p.oid)FROM pg_proc p WHERE p.oid IN('+signature_list+')'
  before_meta=q(meta)
  table_meta="SELECT jsonb_agg(jsonb_build_object('table',c.relname,'owner',c.relowner,'acl',c.relacl,'columns',(SELECT jsonb_agg(to_jsonb(a)ORDER BY attnum)FROM pg_attribute a WHERE attrelid=c.oid),'constraints',(SELECT jsonb_agg(to_jsonb(n)ORDER BY n.oid)FROM pg_constraint n WHERE conrelid=c.oid))ORDER BY c.relname)FROM pg_class c WHERE c.oid IN("+','.join(lit('public.'+x['table'])+'::regclass'for x in tables)+")"
  before_table_meta=q(table_meta)
  q('CREATE TABLE install_control(frozen boolean);INSERT INTO install_control VALUES(false);CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT frozen FROM install_control$$;')
  query=(F/'original-entry.sql').read_text().strip().removesuffix(';')
  actual_scope=next(x['definition']for x in owners if x['signature'].startswith('fn_process_weekly_accounting_scope('))
  actual_entry=actual_scope[actual_scope.index('WITH cash_candidates AS MATERIALIZED'):]
  actual_entry=actual_entry[:actual_entry.index('ORDER BY x.club_id')+len('ORDER BY x.club_id')]
  for original,binding in [('p_club_id','$1'),('v_to','$2'),('v_now','$3')]:actual_entry=re.sub(r'\b'+original+r'\b',binding,actual_entry)
  assert ' '.join(actual_entry.split())==' '.join(query.split()),'ENTRY query drifted from full Scope owner'
  def bound(club=C):return query.replace('$1','NULL::uuid'if club is None else lit(club)+'::uuid').replace('$2',"'2026-10-26 07:00Z'::timestamptz").replace('$3',"'2026-10-27 22:00Z'::timestamptz")
  def bag(club=C):return "SELECT coalesce(jsonb_agg(to_jsonb(x)ORDER BY id),'[]'::jsonb)FROM("+bound(club)+')x'
  q(f"INSERT INTO clubs(id,name,is_union)VALUES('{C}','Original Standalone',false),('{D}','Other Standalone',false),('{U}','Union',true);INSERT INTO unions VALUES('{U}');INSERT INTO accounting_tournament_fee_batches VALUES(md5('batch')::uuid);")
  q(f"""INSERT INTO accounting_tournament_fee_sources(id,rake_record_id,tournament_id,player_id,club_id,game_type,registration_id,source_charge_ledger_id,source_entitlement_id,charged_at,rake_credit,contract)
 VALUES(md5('s')::uuid,md5('batch')::uuid,md5('t')::uuid,md5('player')::uuid,'{C}','MTT',md5('reg')::uuid,md5('charge')::uuid,md5('entitlement')::uuid,'2026-10-20 08:00Z',5,'{{}}');
 INSERT INTO accounting_tournament_fee_recognitions(tournament_id,recognized_at,status,net_rake,source_fingerprint,plan)VALUES(md5('t')::uuid,'2026-10-20 08:00Z','recognized',0,'native','{{}}');
 INSERT INTO accounting_tournament_recognized_sources VALUES(md5('s')::uuid,md5('t')::uuid,'2026-10-20 08:00Z','earned',5);""")
  remove='DELETE FROM accounting_tournament_recognized_sources;DELETE FROM accounting_tournament_fee_sources;DELETE FROM accounting_tournament_fee_recognitions;'
  week='2026-10-19T07:00:00+00:00';expected=[{'id':C,'first_week':week}]
  pending=f"INSERT INTO rakeback_periods(club_id,user_id,period_start,period_end,status)VALUES('{C}',NULL,'2026-10-12','2026-10-18','pending')"
  runrow=lambda state,start,end:f"INSERT INTO union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status)VALUES('{C}','{start}','{end}','2026-10-27','{state}')"
  cases=[('earned','',expected),('recognition_cancelled',"UPDATE accounting_tournament_fee_recognitions SET status='cancelled'",[]),('recognition_deferred',"UPDATE accounting_tournament_fee_recognitions SET status='banked_accrual_deferred'",[]),('refunded',"UPDATE accounting_tournament_recognized_sources SET disposition='refunded'",[]),('credit_mismatch','UPDATE accounting_tournament_recognized_sources SET rake_credit=6',[]),('time_mismatch',"UPDATE accounting_tournament_recognized_sources SET recognized_at='2026-10-21'",[]),('union_mismatch',f"UPDATE accounting_tournament_fee_recognitions SET union_id='{U}'",[]),('union_matching',f"UPDATE accounting_tournament_fee_recognitions SET union_id='{U}';UPDATE accounting_tournament_fee_sources SET union_id='{U}'",expected),('nonnull_coordinator_excluded',f"UPDATE accounting_tournament_fee_sources SET coordinator_union_id='{U}'",[]),('end_exclusive',"UPDATE accounting_tournament_recognized_sources SET recognized_at='2026-10-26 07:00Z';UPDATE accounting_tournament_fee_recognitions SET recognized_at='2026-10-26 07:00Z'",[]),('cutoff_after_charge',f"INSERT INTO ca_launch_accounting_boundaries(scope_kind,scope_id,operation_id,cutoff_at)VALUES('club','{C}',md5('boundary')::uuid,'2026-10-20 09:00Z')",[]),('cutoff_equal_charge',f"INSERT INTO ca_launch_accounting_boundaries(scope_kind,scope_id,operation_id,cutoff_at)VALUES('club','{C}',md5('boundary')::uuid,'2026-10-20 08:00Z')",expected),('cutoff_undone',f"INSERT INTO ca_launch_accounting_boundaries(scope_kind,scope_id,operation_id,cutoff_at,undone_at)VALUES('club','{C}',md5('boundary')::uuid,'2026-10-25','2026-10-26')",expected),('historical_first_week',"UPDATE accounting_tournament_fee_sources SET charged_at='2026-09-22';UPDATE accounting_tournament_recognized_sources SET recognized_at='2026-09-22';UPDATE accounting_tournament_fee_recognitions SET recognized_at='2026-09-22'",[{'id':C,'first_week':'2026-09-21T07:00:00+00:00'}]),('floor_rounds_up',f"INSERT INTO club_settlement_floor(club_id,earliest_period_start,reason)VALUES('{C}','2026-10-20','native original floor')",[{'id':C,'first_week':'2026-10-26T07:00:00+00:00'}]),('incomplete_run',remove+runrow('failed','2026-10-05 07:00Z','2026-10-12 07:00Z'),[{'id':C,'first_week':'2026-10-05T07:00:00+00:00'}]),('completed_latest_run',remove+runrow('complete','2026-10-05 07:00Z','2026-10-12 07:00Z'),[{'id':C,'first_week':'2026-10-05T07:00:00+00:00'}]),('pending_period',remove+pending,[{'id':C,'first_week':'2026-10-12T07:00:00+00:00'}]),('union_member_pending_excluded',remove+pending+f";INSERT INTO union_clubs(union_id,club_id)VALUES('{U}','{C}')",[]),('union_is_not_standalone',f"UPDATE clubs SET is_union=true WHERE id='{C}'",[]),('missing_recognized_source','DELETE FROM accounting_tournament_recognized_sources',[]),('empty',remove,[])]
  def semantics():
   out=[]
   for mode in['force_custom_plan','force_generic_plan']:
    for name,change,want in cases:
     got=json.loads(q('BEGIN;SET LOCAL plan_cache_mode='+mode+';'+change+';'+bag()+';ROLLBACK;'))
     assert got==want,(name,got,want);out.append([mode,name,got])
   # Actual prepaid-only constraint means legacy debt rows cannot be forged to
   # manufacture branch coverage. Verify its real refusal, never drop it.
   q(f"INSERT INTO profiles VALUES(md5('agent')::uuid) ON CONFLICT DO NOTHING;INSERT INTO agents(user_id,club_id,role,commission_rate,player_rakeback_rate,is_prepaid,credit_limit,credit_used)VALUES(md5('agent')::uuid,'{C}','agent',0.2,0.1,false,100,1)",error='agents_are_prepaid')
   out.append(['actual_constraint','legacy_nonprepaid_debt_refused',True])
   # Actual NOT NULL/PK/FKs are retained: invalid witnesses fail, not optimized away.
   q("UPDATE accounting_tournament_fee_sources SET charged_at=NULL",error='not-null constraint')
   q("INSERT INTO accounting_tournament_recognized_sources SELECT *FROM accounting_tournament_recognized_sources",error='duplicate key')
   out.append(['actual_constraints','null_and_duplicate_witnesses_refused',True])
   return out
  cash=f"INSERT INTO auth.users VALUES(md5('cash-player')::uuid);INSERT INTO accounting_cash_accrual_batches VALUES(md5('cash-batch')::uuid);INSERT INTO accounting_cash_rake_sources(rake_record_id,player_id,club_id,earned_at,rake_credit,contract)VALUES(md5('cash-batch')::uuid,md5('cash-player')::uuid,'{C}','2026-10-13',1,'{{}}')"
  cases.extend([('cash_first_week',remove+cash,[{'id':C,'first_week':'2026-10-12T07:00:00+00:00'}]),('cash_foreign_coordinator',remove+cash+f";UPDATE accounting_cash_rake_sources SET coordinator_union_id='{U}'",[]),('cash_cutoff',remove+cash+f";INSERT INTO ca_launch_accounting_boundaries(scope_kind,scope_id,operation_id,cutoff_at)VALUES('club','{C}',md5('boundary')::uuid,'2026-10-14')",[]),('cash_end_exclusive',remove+cash+";UPDATE accounting_cash_rake_sources SET earned_at='2026-10-26 07:00Z'",[]),('completed_later_run',remove+runrow('complete','2026-10-05 07:00Z','2026-10-12 07:00Z')+';'+runrow('complete','2026-10-12 07:00Z','2026-10-19 07:00Z'),[{'id':C,'first_week':'2026-10-12T07:00:00+00:00'}])])
  before=semantics()
  splitter="import {splitConcurrentPreamble}from"+json.dumps((R/'scripts/ci/migration-concurrent-preamble.mjs').as_uri())+";import fs from'node:fs';console.log(JSON.stringify(splitConcurrentPreamble(fs.readFileSync(process.argv[1],'utf8'))));"
  pieces=json.loads(run(['node','--input-type=module','-e',splitter,M]));assert pieces['ok']and len(pieces['indexes'])==1
  statement=pieces['indexes'][0]['statement'];body=pieces['body']
  def install():q(statement);q(body)
  install();after=semantics();assert before==after and q(meta)==before_meta
  install();q(body.replace('COMMIT;','ROLLBACK;'))
  # Whole original ENTRY including all history/pending/run/debt branches. Source
  # rows retain large contracts to expose why this scalar cover avoids heap I/O.
  q(remove+'TRUNCATE accounting_tournament_fee_batches CASCADE;INSERT INTO accounting_tournament_fee_batches SELECT md5(\'batch\'||g)::uuid FROM generate_series(1,60000)g;')
  q(f"""INSERT INTO accounting_tournament_fee_sources(id,rake_record_id,tournament_id,player_id,club_id,game_type,registration_id,source_charge_ledger_id,source_entitlement_id,charged_at,rake_credit,contract)
 SELECT md5('source'||g)::uuid,md5('batch'||g)::uuid,md5('tournament'||g)::uuid,md5('player'||g)::uuid,CASE WHEN g%120=0 THEN '{C}'::uuid ELSE '{D}'::uuid END,'MTT',md5('reg'||g)::uuid,md5('charge'||g)::uuid,md5('entitlement'||g)::uuid,'2026-10-20',5,jsonb_build_object('original_contract',repeat(md5('payload'||g),24))FROM generate_series(1,60000)g;
 INSERT INTO accounting_tournament_fee_recognitions(tournament_id,recognized_at,status,net_rake,source_fingerprint,plan)SELECT tournament_id,'2026-10-20','recognized',0,'native','{{}}'FROM accounting_tournament_fee_sources;
 INSERT INTO accounting_tournament_recognized_sources SELECT id,tournament_id,'2026-10-20','earned',rake_credit FROM accounting_tournament_fee_sources;""")
  q('DROP INDEX '+I+';VACUUM ANALYZE accounting_tournament_fee_sources;VACUUM ANALYZE accounting_tournament_recognized_sources;VACUUM ANALYZE accounting_tournament_fee_recognitions;')
  fp="SELECT md5(coalesce(string_agg(md5(to_jsonb(s)::text),''ORDER BY id),''))FROM accounting_tournament_fee_sources s"
  source_fp=q(fp);old_bags=[q(bag(C)),q(bag(D)),q(bag(None))];old_plan=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+bound()))
  install();new_bags=[q(bag(C)),q(bag(D)),q(bag(None))];new_plan=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+bound()));assert old_bags==new_bags and q(fp)==source_fp and q(meta)==before_meta
  scans=[n for n in nodes(new_plan[0]['Plan'])if n.get('Index Name')==I and n['Node Type']=='Index Only Scan'];assert scans and all(x.get('Heap Fetches')==0 for x in scans),new_plan
  point="SELECT id,club_id,tournament_id,charged_at,rake_credit,union_id FROM accounting_tournament_fee_sources WHERE coordinator_union_id IS NULL AND club_id='"+C+"' AND tournament_id=md5('tournament120')::uuid"
  changed=q("BEGIN;UPDATE accounting_tournament_fee_sources SET rake_credit=99 WHERE id=md5('source120')::uuid;SELECT rake_credit FROM("+point+")x;EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)"+point+';ROLLBACK;').split('\n',1)
  assert changed[0]=='99';assert any(x.get('Index Name')==I and x.get('Heap Fetches',0)>0 for x in nodes(json.loads(changed[1])[0]['Plan']))
  faults=[]
  for name,shape in [('expression','((club_id::text),tournament_id) INCLUDE(id,charged_at,rake_credit,union_id) WHERE coordinator_union_id IS NULL'),('keys','(tournament_id,club_id) INCLUDE(id,charged_at,rake_credit,union_id) WHERE coordinator_union_id IS NULL'),('include','(club_id,tournament_id) INCLUDE(id,charged_at,union_id,rake_credit) WHERE coordinator_union_id IS NULL'),('predicate','(club_id,tournament_id) INCLUDE(id,charged_at,rake_credit,union_id) WHERE coordinator_union_id IS NOT NULL'),('order','(club_id DESC,tournament_id) INCLUDE(id,charged_at,rake_credit,union_id) WHERE coordinator_union_id IS NULL'),('missing_include','(club_id,tournament_id) INCLUDE(id,charged_at,rake_credit) WHERE coordinator_union_id IS NULL')]:
   q('DROP INDEX '+I+';CREATE INDEX '+I+' ON accounting_tournament_fee_sources '+shape);q(statement);q(body,error='standalone_club_event_cover_');faults.append(name)
  q('DROP INDEX '+I);q(body,error='standalone_club_event_cover_missing');faults.append('missing')
  q('CREATE UNIQUE INDEX '+I+' ON accounting_tournament_fee_sources(club_id,tournament_id) INCLUDE(id,charged_at,rake_credit,union_id) WHERE coordinator_union_id IS NULL');q(body,error='standalone_club_event_cover_shape_changed');faults.append('unique');q('DROP INDEX '+I)
  q('CREATE UNIQUE INDEX CONCURRENTLY '+I+' ON accounting_tournament_fee_sources(club_id)',error='could not create unique index');assert q("SELECT NOT indisvalid FROM pg_index WHERE indexrelid='"+I+"'::regclass")=='t'
  q(statement);q(body,error='standalone_club_event_cover_shape_changed');faults.append('actual_invalid_concurrent_build')
  q('DROP INDEX '+I);install();q('UPDATE install_control SET frozen=true');q(body,error='standalone_club_event_cover_platform_frozen');q('UPDATE install_control SET frozen=false');faults.append('freeze')
  q('SET ROLE service_role;'+statement,error='must be owner');faults.append('permission')
  assert q(fp)==source_fp and q(meta)==before_meta and q(table_meta)==before_table_meta
  result={'semantic_cases_before_and_after':len(before),'semantics':before,'whole_scope_md5_unchanged':'72ab1c8c7e8408119bf670db527e8e64','whole_source65_md5_unchanged':'8734797c6093c7e5a2a72de9b387a6de','all_six_function_definitions_metadata_unchanged':True,'all_eleven_table_columns_constraints_owner_acl_unchanged':True,'entry_query_matches_full_scope_definition':True,'all_source_rows_unchanged':True,'whole_original_entry_rows_identical':True,'all_original_cutoff_helpers_executed':True,'competing_indexes':58,'installer_faults':faults,'natural_index_only_heap_fetches':0,'mvcc_heap_fallback':True,'native_before_ms':old_plan[0]['Execution Time'],'native_after_ms':new_plan[0]['Execution Time'],'migration_sha256':hashlib.sha256(M.read_bytes()).hexdigest(),'limit':'Native exact ENTRY SELECT/current calendar helpers and constraints, not the full money coordinator or live capacity certificate. Deferred financial triggers and unrelated FK endpoint implementations are controlled; actual CHECK/PK/UNIQUE/FKs retained. Native fixture does not reproduce production285second timeout.'}
  a.output.mkdir(parents=True,exist_ok=True);(a.output/'result.json').write_text(json.dumps(result,indent=2)+'\n');(a.output/'plans.json').write_text(json.dumps({'before':old_plan,'after':new_plan},indent=2)+'\n');print(json.dumps({k:v for k,v in result.items()if k!='semantics'}))
 finally:run([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
