#!/usr/bin/env python3
"""Unchanged canonical allocation/check/write/certificate/payer math, isolated PG17."""
import argparse,hashlib,json,os,shutil,socket,subprocess,tempfile,time
from pathlib import Path
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[1];FX=HERE/'fixtures/rakeback-player-week-indexes'
p=argparse.ArgumentParser();p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--scratch',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--migration',type=Path,default=ROOT/'supabase/migrations/20261027040245_rakeback_pages_index_the_player_and_earning_week.sql');a=p.parse_args()
if not __debug__:raise RuntimeError('optimized financial qualification refused')
if os.sys.platform=='darwin'and not str(a.scratch.resolve()).startswith('/Volumes/SmarterWork/agent-work/'):raise RuntimeError('external SSD scratch required')
base=Path(tempfile.mkdtemp(prefix='pi-',dir=a.scratch));data=base/'d';started=False;PG=a.pg_bin
with socket.socket()as s:s.bind(('127.0.0.1',0));port=str(s.getsockname()[1])
env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env['TMPDIR']=str(base)
psql=[PG/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres']
def run(cmd,sql=None,error=None):
 r=subprocess.run([str(x)for x in cmd],input=sql,text=True,capture_output=True,env=env,timeout=240)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(sql,error=None):return run(psql,sql,error)
def lit(s):return "'"+s.replace("'","''")+"'"
def nodes(n):
 yield n
 for c in n.get('Plans',[]):yield from nodes(c)
meta=json.loads((FX/'math-owners.json').read_text());source=a.migration.read_text();source_sha=hashlib.sha256(source.encode()).hexdigest();cases=[];plans={}
club='10000000-0000-0000-0000-000000000001';union='20000000-0000-0000-0000-000000000001';players=['30000000-0000-0000-0000-00000000000'+str(n)for n in range(1,4)];arr='ARRAY['+','.join(lit(x)+'::uuid'for x in players)+']::uuid[]'
args=lit(club)+"::uuid,'2026-10-19'::date,'2026-10-25'::date,"+arr
try:
 assert ' 17.'in run([PG/'postgres','--version'])
 js="import{readFileSync}from'node:fs';import{pathToFileURL}from'node:url';const{migrationTransactionShape}=await import(pathToFileURL(process.argv[2]));process.stdout.write(JSON.stringify(migrationTransactionShape(process.argv[1].split('/').pop(),readFileSync(process.argv[1],'utf8'))));"
 shape=json.loads(run(['node','--input-type=module','-e',js,a.migration,ROOT/'scripts/ci/migration-transaction-shape.mjs']));assert shape['ok']and len(shape['indexes'])==2,shape;cases.append('maintained_installer_shape_two_concurrent_preambles_one_assertion_transaction')
 run([PG/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
 with(data/'postgresql.conf').open('a')as h:h.write("\nunix_socket_directories=''\nshared_buffers='256MB'\nwork_mem='32MB'\nmaintenance_work_mem='64MB'\n")
 run([PG/'pg_ctl','-D',data,'-l',base/'log','-o',f'-h 127.0.0.1 -p {port}','-w','start']);started=True
 q("CREATE SCHEMA smarter_private;CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;SET client_min_messages=warning;")
 q("""CREATE TABLE clubs(id uuid PRIMARY KEY,owner_id uuid,union_id uuid,is_union boolean,asset text);
 CREATE TABLE accounting_agreement_history(id bigint PRIMARY KEY,entity_type text,entity_key text,observed_at timestamptz,after_terms jsonb);
 CREATE TABLE accounting_cash_rake_sources(id uuid PRIMARY KEY,rake_record_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,earned_at timestamptz,rake_credit numeric,contract jsonb,recorded_at timestamptz);
 CREATE TABLE accounting_cash_atomic_contract_admissions(source_id uuid PRIMARY KEY,admitted_contract jsonb,admitted_at timestamptz);
 CREATE TABLE accounting_cash_funding_contract_admissions(source_id uuid PRIMARY KEY,funding_club_id uuid,admitted_contract jsonb,admitted_at timestamptz);
 CREATE TABLE accounting_tournament_fee_sources(id uuid PRIMARY KEY,rake_record_id uuid,tournament_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,charged_at timestamptz,rake_credit numeric,contract jsonb,recorded_at timestamptz,source_entitlement_id uuid);
 CREATE TABLE accounting_tournament_recognized_sources(source_id uuid PRIMARY KEY,tournament_id uuid,rake_credit numeric,recognized_at timestamptz,disposition text);
 CREATE TABLE accounting_tournament_fee_recognitions(tournament_id uuid PRIMARY KEY,recognized_at timestamptz,union_id uuid,status text,union_wallet_transaction_id uuid,bank_journal_id uuid);
 CREATE FUNCTION fn_ca_launch_accounting_club_cutoffs()RETURNS TABLE(club_id uuid,cutoff_at timestamptz)LANGUAGE sql STABLE AS 'SELECT NULL::uuid,NULL::timestamptz WHERE false';
 CREATE FUNCTION fn_accounting_tournament_source_terms_at(uuid,timestamptz,jsonb)RETURNS timestamptz LANGUAGE sql STABLE AS 'SELECT $2';
 CREATE FUNCTION fn_caller_is_engine()RETURNS boolean LANGUAGE sql STABLE AS 'SELECT true';
 CREATE FUNCTION fn_ca_launch_accounting_start(text,uuid,timestamptz)RETURNS timestamptz LANGUAGE sql STABLE AS 'SELECT $3';
 CREATE TABLE accounting_cash_accrual_cutover(singleton boolean,starts_at timestamptz);INSERT INTO accounting_cash_accrual_cutover VALUES(true,'2026-01-01Z');
 """)
 for sql in [(FX/'effective-view.sql').read_text(),(FX/'payable-view.sql').read_text()]:q(sql)
 for table,cols in meta['columns'].items():
  q('CREATE TABLE '+table+'('+','.join('"'+c['name']+'" '+c['type']+(' DEFAULT '+c['default']if c['default']else'')for c in cols)+')')
 q("ALTER TABLE accounting_rakeback_period_calculations ALTER COLUMN id SET NOT NULL;ALTER TABLE accounting_rakeback_period_calculations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;ALTER TABLE rakeback_periods ADD PRIMARY KEY(id);ALTER TABLE accounting_rakeback_period_calculations ADD PRIMARY KEY(id);ALTER TABLE accounting_rakeback_payer_contracts ADD PRIMARY KEY(calculation_id,payer_kind,payer_entity_id);CREATE INDEX native_period_cert ON accounting_rakeback_period_calculations(period_id,id DESC);")
 q((FX/'immutable-history.sql').read_text())
 for f in meta['functions']:q(f['definition'])
 for t in meta['triggers']:q(t)
 for ix in json.loads((FX/'existing-indexes.json').read_text()):
  if '_pkey 'in ix:continue
  q(ix)
 # Four clubs /1000 players /historical weeks. Metadata keeps every full contract.
 q("INSERT INTO clubs SELECT md5('club-'||g)::uuid,md5('owner-'||g)::uuid,"+lit(union)+"::uuid,false,'chips'FROM generate_series(1,4)g;INSERT INTO clubs VALUES("+lit(club)+"::uuid,md5('target-owner')::uuid,"+lit(union)+"::uuid,false,'chips');")
 q("""CREATE TABLE native_contracts AS SELECT c.id club_id,md5('background-player-'||p)::uuid player_id,
 row_number()OVER()::bigint history_id,jsonb_build_object('club_id',c.id,'user_id',md5('background-player-'||p)::uuid,'status','active','is_active',true,'agent_id',NULL,'player_rakeback_pct',.2,'player_rakeback_explicit',true)member
 FROM clubs c CROSS JOIN generate_series(1,1000)p;
 INSERT INTO accounting_agreement_history SELECT history_id,'club_members',club_id::text||':'||player_id::text,'2026-01-01Z',member FROM native_contracts;
 """)
 q("INSERT INTO accounting_cash_rake_sources SELECT md5('cash-bg-'||g)::uuid,md5('cash-rake-'||g)::uuid,c.player_id,c.club_id,"+lit(union)+"::uuid,"+lit(union)+"::uuid,'2026-09-01Z'::timestamptz+make_interval(days=>(g%56)::int),1.23,jsonb_build_object('membership',jsonb_build_object('history_id',c.history_id,'terms',c.member),'tiers',jsonb_build_array(),'original_payload',md5(g::text)||md5((g+7)::text)||repeat(md5((g+13)::text),8)),'2026-10-26 08:00Z' FROM generate_series(1,400000)g JOIN native_contracts c ON c.history_id=1+(g%5000);")
 # A real20k-source page has older same-player history that the old player-only index must fetch/filter.
 for i,user in enumerate(players,1):
  member={'club_id':club,'user_id':user,'status':'active','is_active':True,'agent_id':None,'player_rakeback_pct':.2,'player_rakeback_explicit':True}
  contract={'membership':{'history_id':9000+i,'terms':member},'tiers':[]};c=lit(json.dumps(contract))+'::jsonb'
  q("INSERT INTO accounting_agreement_history VALUES("+str(9000+i)+",'club_members',"+lit(club+':'+user)+",'2026-01-01Z',"+lit(json.dumps(member))+"::jsonb);INSERT INTO accounting_cash_rake_sources SELECT md5("+lit('target-'+user)+"||g)::uuid,md5("+lit('target-rake-'+user)+"||g)::uuid,"+lit(user)+"::uuid,"+lit(club)+"::uuid,"+lit(union)+"::uuid,"+lit(union)+"::uuid,CASE WHEN g<=7000 THEN '2026-10-19 07:00Z'::timestamptz+make_interval(secs=>(g%604800)::int)ELSE'2026-09-01Z'::timestamptz+make_interval(days=>(g%42)::int)END,1.23,"+c+"||jsonb_build_object('original_payload',repeat(md5(g::text),16)),'2026-10-26 08:00Z' FROM generate_series(1,35000)g;")
 q("INSERT INTO accounting_tournament_fee_recognitions SELECT md5('event-'||g)::uuid,'2026-09-01Z'::timestamptz+make_interval(days=>(g%56)::int),"+lit(union)+"::uuid,'recognized',NULL,NULL FROM generate_series(1,500)g;")
 q("INSERT INTO accounting_tournament_fee_sources SELECT md5('fee-'||g)::uuid,md5('fee-rake-'||g)::uuid,md5('event-'||(1+g%500))::uuid,c.player_id,c.club_id,"+lit(union)+"::uuid,"+lit(union)+"::uuid,'2026-08-01Z',.25,jsonb_build_object('membership',jsonb_build_object('history_id',c.history_id,'terms',c.member),'tiers',jsonb_build_array()),'2026-10-26 08:00Z',md5('entitlement-'||g)::uuid FROM generate_series(1,250000)g JOIN native_contracts c ON c.history_id=1+(g%5000);INSERT INTO accounting_tournament_recognized_sources SELECT s.id,s.tournament_id,s.rake_credit,r.recognized_at,'earned'FROM accounting_tournament_fee_sources s JOIN accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id;ANALYZE;")
 q("INSERT INTO accounting_tournament_fee_recognitions VALUES(md5('target-event')::uuid,'2026-10-21 07:00Z',"+lit(union)+"::uuid,'recognized',NULL,NULL)")
 for user in players:
  q("INSERT INTO accounting_tournament_fee_sources SELECT md5('target-fee-'||"+lit(user)+"||g)::uuid,md5('target-fee-rake-'||"+lit(user)+"||g)::uuid,md5('target-event')::uuid,"+lit(user)+"::uuid,"+lit(club)+"::uuid,"+lit(union)+"::uuid,"+lit(union)+"::uuid,'2026-10-18 07:00Z',.25,(SELECT contract FROM accounting_cash_rake_sources WHERE player_id="+lit(user)+"::uuid LIMIT 1),'2026-10-26 08:00Z',md5('target-entitlement-'||"+lit(user)+"||g)::uuid FROM generate_series(1,100)g")
 q("INSERT INTO accounting_tournament_recognized_sources SELECT s.id,s.tournament_id,s.rake_credit,r.recognized_at,'earned'FROM accounting_tournament_fee_sources s JOIN accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id WHERE r.tournament_id=md5('target-event')::uuid;ANALYZE;")
 # Actual canonical full allocation SELECT, unchanged, extracted from actual calculator.
 calc=next(f['definition']for f in meta['functions']if f['signature'].startswith('fn_calculate_cash_rakeback_periods('));start=calc.index('  WITH receipts AS (');end=calc.index('\n LOOP',start);query=calc[start:end].replace('p_club_id',lit(club)+'::uuid').replace('v_from',"'2026-10-19 07:00Z'::timestamptz").replace('v_to',"'2026-10-26 07:00Z'::timestamptz").replace('p_user_ids',arr)
 def allocate():return q("SELECT md5(COALESCE(jsonb_agg(to_jsonb(x)ORDER BY player_id),'[]')::text)FROM("+query+')x')
 def financial():return q("SELECT jsonb_build_object('periods',(SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY id)::text)FROM rakeback_periods p),'certificates',(SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY id)::text)FROM accounting_rakeback_period_calculations p),'payers',(SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY calculation_id,payer_kind,payer_entity_id)::text)FROM accounting_rakeback_payer_contracts p),'source_fingerprints',(SELECT jsonb_agg(source_fingerprint ORDER BY player_id)FROM accounting_rakeback_period_calculations))")
 authority=q("SELECT md5(jsonb_agg(jsonb_build_array(p.oid,p.prosrc,p.proowner,p.proacl,p.prosecdef,p.proconfig)ORDER BY p.oid)::text)FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','smarter_private')")
 before_allocation=allocate();first_check=json.loads(q('SELECT fn_rakeback_split_check('+args+')'));first_write=json.loads(q('SELECT fn_rakeback_split_write('+args+')'));assert first_write=={'written':3,'confirmed':3},first_write
 before_check=json.loads(q('SELECT fn_rakeback_split_check('+args+')'));assert before_check['same']==before_check['players']==3
 assert q("SELECT count(*)=3 AND bool_and(rake_generated=8635 AND rakeback_amount=1727) FROM rakeback_periods")=='t'
 cases.append('independent_7000_cash_times_1_23_plus_100_fees_times_0_25_at_20_percent_equals_1727_each')
 before_financial=financial();plans['before']=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+query))[0]
 cases.append('unchanged_whole_calculator_allocation_query_check_write_real_certificate_and_payer_registration_before')
 for ix in shape['indexes']:q(ix['statement'])
 q(shape['body']);plans['after']=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+query))[0]
 assert allocate()==before_allocation
 assert json.loads(q('SELECT fn_rakeback_split_check('+args+')'))==before_check
 assert json.loads(q('SELECT fn_rakeback_split_write('+args+')'))=={'written':0,'confirmed':3}
 assert financial()==before_financial
 assert authority==q("SELECT md5(jsonb_agg(jsonb_build_array(p.oid,p.prosrc,p.proowner,p.proacl,p.prosecdef,p.proconfig)ORDER BY p.oid)::text)FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','smarter_private')")
 cases.append('indexes_preserve_order_sensitive_full_allocations_check_digest_existing_certificate_full_source_fingerprints_payer_rows_and_function_authority')
 expected={x['name']for x in shape['indexes']};actual={n.get('Index Name')for n in nodes(plans['after']['Plan'])};assert expected<=actual,(expected,actual)
 cases.append('natural_actual_unchanged_query_uses_both_matching_indexes_without_planner_switches')
 oids=q("SELECT jsonb_agg(jsonb_build_array(c.oid,pg_relation_filenode(c.oid))ORDER BY c.relname)FROM pg_class c WHERE c.oid IN('accounting_cash_rakeback_player_week'::regclass,'accounting_tournament_rakeback_player'::regclass)")
 for ix in shape['indexes']:q(ix['statement'])
 q(shape['body']);assert oids==q("SELECT jsonb_agg(jsonb_build_array(c.oid,pg_relation_filenode(c.oid))ORDER BY c.relname)FROM pg_class c WHERE c.oid IN('accounting_cash_rakeback_player_week'::regclass,'accounting_tournament_rakeback_player'::regclass)");cases.append('same_named_valid_replay_skips_build_keeps_exact_index_oid_filenode')
 # Real catalogue failures: same name is never enough, and a failed concurrent
 # unique build leaves an actual INVALID index (no system-catalogue edits).
 cash_name='accounting_cash_rakeback_player_week';tour_name='accounting_tournament_rakeback_player'
 q('DROP INDEX '+cash_name)
 q(shape['body'],error='rakeback_player_week_index_missing:')
 q('CREATE INDEX '+cash_name+' ON accounting_cash_rake_sources(player_id,club_id,earned_at)')
 q(shape['body'],error='rakeback_player_week_index_column_changed:')
 q('DROP INDEX '+cash_name)
 q('CREATE UNIQUE INDEX CONCURRENTLY '+cash_name+' ON accounting_cash_rake_sources(club_id)',error='could not create unique index')
 assert q("SELECT NOT indisvalid FROM pg_index WHERE indexrelid='"+cash_name+"'::regclass")=='t'
 q(shape['body'],error='rakeback_player_week_index_shape_changed:')
 invalid_oid=q("SELECT '"+cash_name+"'::regclass::oid")
 q(shape['indexes'][0]['statement'])
 assert q("SELECT '"+cash_name+"'::regclass::oid")==invalid_oid
 q(shape['body'],error='rakeback_player_week_index_shape_changed:')
 cases.append('actual_failed_concurrent_unique_build_invalid_index_refused_and_if_not_exists_does_not_repair_it')
 # Explicit isolated recovery follows observed invalid identity; production
 # cleanup still requires the owning installer recovery route.
 q('DROP INDEX '+cash_name);q(shape['indexes'][0]['statement'])
 kept=q("SELECT '"+cash_name+"'::regclass::oid")
 q('DROP INDEX '+tour_name)
 q(shape['body'],error='rakeback_player_week_index_missing:')
 for ix in shape['indexes']:q(ix['statement'])
 q(shape['body'])
 assert kept==q("SELECT '"+cash_name+"'::regclass::oid")
 assert allocate()==before_allocation and financial()==before_financial
 cases.append('partial_first_valid_second_missing_replay_preserves_first_identity_and_completes_exact_assertions')
 cases.append('missing_and_wrong_column_order_indexes_refused_without_financial_changes')
 assert hashlib.sha256(a.migration.read_bytes()).hexdigest()==source_sha
 blocks=lambda p:p['Plan'].get('Shared Hit Blocks',0)+p['Plan'].get('Shared Read Blocks',0)
 result={'passed':True,'migration':a.migration.name,'migration_sha256':source_sha,'cases':cases,'rows':{'cash':505000,'tournament':250300,'page':21300},'native_query_ms':{k:v['Execution Time']for k,v in plans.items()},'native_query_blocks':{k:blocks(v)for k,v in plans.items()},'limits':'Unchanged actual calculator allocation query/check/write/payer owners on synthetic full-source rows. Original full-calculator upstream evidence gates are outside this per-page index qualification; unchanged launch/terms authority boundaries controlled; no production DDL. Local build/query timing does not certify production duration, disk headroom, 04:00 delivery or payment.'}
 a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2)+'\n');a.output.with_suffix('.plans.json').write_text(json.dumps(plans)+'\n');print(json.dumps(result))
finally:
 if started:run([PG/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
 shutil.rmtree(base)
