import ast,json,hashlib,os,subprocess,tempfile,socket,shutil,time
from pathlib import Path
w=Path(os.environ['GROUPED_NATIVE_WORK']);fx=Path(os.environ['GROUPED_NATIVE_FIXTURES']);pg=Path(os.environ['PG_BIN']);migration=Path(os.environ['GROUPED_NATIVE_MIGRATION'])
b=Path(tempfile.mkdtemp(prefix='keeper-',dir=w));started=False
with socket.socket()as s:s.bind(('127.0.0.1',0));port=str(s.getsockname()[1])
env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env['TMPDIR']=str(b)
psql=[pg/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres']
def run(cmd,s=None,error=None):
 r=subprocess.run(list(map(str,cmd)),input=s,text=True,capture_output=True,env=env,timeout=120)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert not r.returncode,r.stdout+r.stderr
 return r.stdout.strip()
def q(s,error=None):return run(psql,s,error)
bootstrap=(fx/'bootstrap.sql').read_text()
club='10000000-0000-0000-0000-000000000001';call="SELECT fn_rakeback_recompute_split('"+club+"','2026-10-12','2026-10-18')";settings="SET app.weekly_accounting_chunked='on';SET app.weekly_accounting_scope_budget='3 minutes';SET app.weekly_accounting_scope_deadline='2026-10-27 05:03Z';"
reset="TRUNCATE accounting_recompute_split_parts;UPDATE native_clock SET at='2026-10-27 05:00Z';RESET app.accounting_split_did;";cases=[];timings={}
def actual_install(name):
 q((fx/'keeper-original.sql').read_text())
 if name=='keeper-candidate.sql':q(migration.read_text())
 return q("SELECT pg_get_functiondef('fn_rakeback_recompute_split(uuid,date,date)'::regprocedure)")
def install(name):q(actual_install(name).replace('clock_timestamp()','public.fixture_clock()'))
def keeper():return json.loads(q(settings+call))
def counts():return json.loads(q("SELECT jsonb_object_agg(part,value) FROM accounting_recompute_split_parts WHERE kind='counts'"))
try:
 run([pg/'initdb','-D',b/'d','-U','postgres','-A','trust','--no-locale','-E','UTF8']);run([pg/'pg_ctl','-D',b/'d','-l',b/'log','-o',f"-h 127.0.0.1 -k '' -p {port}",'-w','start']);started=True
 q(bootstrap);q((fx/'original-cc867.sql').read_text())
 q("""CREATE TABLE native_clock(at timestamptz);INSERT INTO native_clock VALUES('2026-10-27 05:00Z');
 CREATE FUNCTION fixture_clock()RETURNS timestamptz LANGUAGE sql VOLATILE AS 'SELECT at FROM native_clock';
 ALTER TABLE accounting_cash_rake_sources ADD COLUMN recorded_at timestamptz DEFAULT '2026-10-20Z';
 CREATE TABLE accounting_cash_atomic_contract_admissions(source_id uuid,admitted_at timestamptz);
 CREATE TABLE accounting_tournament_fee_sources(club_id uuid,charged_at timestamptz,recorded_at timestamptz);
 CREATE TABLE accounting_cash_accrual_cutover(singleton boolean,starts_at timestamptz);INSERT INTO accounting_cash_accrual_cutover VALUES(true,'2026-01-01Z');
 CREATE TABLE accounting_recompute_split_parts(club_id uuid,period_start date,period_end date,kind text,part int,value jsonb,computed_at timestamptz DEFAULT fixture_clock(),PRIMARY KEY(club_id,period_start,kind,part));
 CREATE TABLE accounting_period_recompute_requests(id uuid DEFAULT gen_random_uuid(),club_id uuid,period_start date,period_end date,requested_at timestamptz DEFAULT fixture_clock(),last_requested_at timestamptz,status text,reason text,attempted_at timestamptz,attempts int DEFAULT 0,last_result jsonb,UNIQUE(club_id,period_start,period_end));
 CREATE TABLE rakeback_periods(id uuid,club_id uuid,period_start date,period_end date,status text);
 CREATE TABLE accounting_rakeback_period_calculations(period_id uuid);
 CREATE VIEW accounting_payable_earning_sources AS SELECT club_id,player_id,earned_at FROM accounting_cash_rake_sources;
 CREATE FUNCTION fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql AS $$SELECT '{"status":"ready"}'::jsonb$$;
 CREATE FUNCTION fn_rakeback_split_check(uuid,date,date,uuid[])RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN UPDATE native_clock SET at=at+interval '91 seconds';RETURN '{"players":1,"same":1}'::jsonb;END$$;
 CREATE FUNCTION fn_rakeback_split_write(uuid,date,date,uuid[])RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'native_money_boundary_must_not_run';END$$;
 """)
 q("INSERT INTO rake_records SELECT md5('bulk-record'||n)::uuid,md5('bulk-hand'||n)::uuid,'"+club+"',2,'2026-10-12 08:00Z'::timestamptz+make_interval(hours=>2*(n%84)::int),false,NULL,NULL,'{}'FROM generate_series(1,5000)n;INSERT INTO rake_attributions SELECT md5('bulk-attr'||r.id||c.id)::uuid,r.id,r.hand_id,md5('bulk-player'||c.id)::uuid,c.id,1 FROM rake_records r CROSS JOIN clubs c WHERE r.id IN(SELECT md5('bulk-record'||n)::uuid FROM generate_series(1,5000)n);INSERT INTO accounting_cash_accrual_batches SELECT md5('bulk-record'||n)::uuid,'accrued'FROM generate_series(1,5000)n;INSERT INTO accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,earned_at,rake_credit,contract,union_id,coordinator_union_id)SELECT md5('bulk-source'||a.id)::uuid,r.id,a.player_id,a.club_id,r.created_at,1,jsonb_build_object('attribution_id',a.id,'player_id',a.player_id,'club_id',a.club_id,'union_id',NULL,'coordinator_union_id',NULL),NULL,NULL FROM rake_records r JOIN rake_attributions a ON a.rake_record_id=r.id WHERE r.id IN(SELECT md5('bulk-record'||n)::uuid FROM generate_series(1,5000)n);ANALYZE")
 canonical={}
 for native_source in ['keeper-original.sql','keeper-candidate.sql']:
  actual_install(native_source)
  canonical[native_source]=json.loads(q("SELECT jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'metadata',jsonb_build_array(p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig))FROM pg_proc p WHERE p.oid='fn_rakeback_recompute_split(uuid,date,date)'::regprocedure"))
 assert canonical['keeper-original.sql']['metadata']==canonical['keeper-candidate.sql']['metadata']
 actual_install('keeper-candidate.sql')
 q(migration.read_text(),error='rakeback_grouped_counts_owner_changed')
 assert q("SELECT md5(pg_get_functiondef('fn_rakeback_recompute_split(uuid,date,date)'::regprocedure))")==canonical['keeper-candidate.sql']['md5']
 actual_install('keeper-original.sql')
 q(migration.read_text().replace("<>'a4f76df2ab80d5b19ccbd923318658d4'","<>'00000000000000000000000000000000'"),error='rakeback_grouped_counts_postimage_changed')
 assert q("SELECT md5(pg_get_functiondef('fn_rakeback_recompute_split(uuid,date,date)'::regprocedure))")==canonical['keeper-original.sql']['md5']
 cases.append('exact_reserved_installer_replay_refusal_and_postimage_failure_atomic_rollback')
 cases.append('actual_unmodified_clock_pg_get_functiondef_identity_and_metadata_preserved')
 oracle=json.loads(q("SELECT jsonb_object_agg(i,fn_rakeback_split_counts('"+club+"','2026-10-12 07:00Z','2026-10-19 07:00Z',g,least(g+interval '2 hours','2026-10-19 07:00Z')))FROM generate_series('2026-10-12 07:00Z'::timestamptz,'2026-10-19 07:00Z'::timestamptz-interval '1 microsecond',interval '2 hours')WITH ORDINALITY x(g,ord)CROSS JOIN LATERAL(SELECT ord-1 i)y"))
 for name in ['keeper-original.sql','keeper-candidate.sql']:
  q(reset);install(name);t=time.monotonic();result=keeper();timings[name]=round((time.monotonic()-t)*1000,3)
  assert result.get('stage')=='write',result
  assert counts()==oracle,(name,counts(),oracle)
  cases.append(name+':actual_keeper84counts_match_cc867_oracle_and_stops_before_money')
 q('CREATE TABLE native_saved_parts AS TABLE accounting_recompute_split_parts')
 # Exact existing parts stay byte/stamp-identical while only absent original windows are inserted.
 q(reset+"INSERT INTO accounting_recompute_split_parts SELECT * FROM native_saved_parts WHERE kind<>'counts' OR part<2;DELETE FROM accounting_recompute_split_parts WHERE kind='check';UPDATE accounting_recompute_split_parts SET computed_at=fixture_clock()-interval '10 minutes' WHERE kind='counts';")
 kept=q("SELECT jsonb_agg(to_jsonb(p)ORDER BY part)FROM accounting_recompute_split_parts p WHERE kind='counts'")
 keeper();assert counts()==oracle
 assert kept==q("SELECT jsonb_agg(to_jsonb(p)ORDER BY part)FROM accounting_recompute_split_parts p WHERE kind='counts'AND part<2")
 cases.append('fresh_partial_restart_preserves_existing_exact_value_and_computed_at')
 for label,change in [('expired12h',"UPDATE accounting_recompute_split_parts SET computed_at=fixture_clock()-interval '13 hours'"),('period_end_mismatch',"UPDATE accounting_recompute_split_parts SET period_end='2026-10-17'"),('new_source_recorded',"UPDATE accounting_cash_rake_sources SET recorded_at='2026-10-27 05:00Z' WHERE club_id='"+club+"'"),('new_atomic_admission',"INSERT INTO accounting_cash_atomic_contract_admissions SELECT id,'2026-10-27 05:00Z' FROM accounting_cash_rake_sources WHERE club_id='"+club+"' LIMIT 1")]:
  # BEGIN cannot span q() connections; use one self-checking transaction instead.
  out=q('BEGIN;'+reset+"INSERT INTO accounting_recompute_split_parts SELECT * FROM native_saved_parts WHERE kind<>'check';UPDATE accounting_recompute_split_parts SET computed_at='2026-10-27 04:50Z';"+change+';'+settings+call+";SELECT count(*)=84 AND bool_and(computed_at='2026-10-27 05:00Z') FROM accounting_recompute_split_parts WHERE kind='counts';ROLLBACK;")
  assert out.splitlines()[-1]=='t',(label,out)
  cases.append('original_freshness_invalidates_and_recomputes:'+label)
 # Soft90-second admission is shared and does not admit a whole-week batch late.
 q(reset+"INSERT INTO accounting_recompute_split_parts SELECT * FROM native_saved_parts WHERE kind IN('players','tq');UPDATE native_clock SET at='2026-10-27 05:01:31Z';")
 late=json.loads(q(settings+"SET app.accounting_split_did='on';"+call))
 assert late['stage']=='windows' and q("SELECT count(*)FROM accounting_recompute_split_parts WHERE kind='counts'")=='0',late
 cases.append('original_shared90second_admission_refuses_late_counts_batch')
 # A malformed original source contract must roll back the entire call and
 # preserve previously committed exact partials, not leave a partial batch.
 q(reset+"INSERT INTO accounting_recompute_split_parts SELECT * FROM native_saved_parts WHERE kind IN('players','tq') OR(kind='counts'AND part=0);")
 snapshot=q('SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY kind,part)::text)FROM accounting_recompute_split_parts p')
 q("BEGIN;UPDATE accounting_cash_rake_sources SET contract=jsonb_set(contract,'{attribution_id}','\"not-a-uuid\"')WHERE id=(SELECT id FROM accounting_cash_rake_sources WHERE club_id='"+club+"'LIMIT1);".replace('LIMIT1','LIMIT 1')+settings+call,error='invalid input syntax for type uuid')
 assert snapshot==q('SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY kind,part)::text)FROM accounting_recompute_split_parts p')
 cases.append('actual_malformed_original_contract_rolls_back_whole_batch_preserving_committed_partials')
 # Unchunked/open-week requests cannot enter the grouped counts path.
 before=q('SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY kind,part)::text)FROM accounting_recompute_split_parts p')
 assert q("RESET app.weekly_accounting_chunked;"+call)==''
 assert q(settings+"SELECT fn_rakeback_recompute_split('"+club+"','2026-11-02','2026-11-08')") ==''
 assert before==q('SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY kind,part)::text)FROM accounting_recompute_split_parts p')
 cases.append('original_unchunked_and_open_week_refusal_no_partial_change')
 # Real same-club/week original advisory lock refuses a competing keeper.
 hold=subprocess.Popen(list(map(str,psql)),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
 hold.stdin.write("BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:"+club+":2026-10-12',0));SELECT 'locked';SELECT pg_sleep(2);ROLLBACK;");hold.stdin.close()
 assert hold.stdout.readline().strip()=='';assert hold.stdout.readline().strip()=='locked'
 q(settings+"SET lock_timeout='100ms';"+call,error='canceling statement due to lock timeout')
 assert hold.wait(timeout=5)==0
 cases.append('actual_original_club_week_lock_refuses_concurrent_keeper')
 result={'passed':True,'cases':cases,'timings_ms':timings,'canonical_sources':canonical,'kernel_sha256':hashlib.sha256((fx/'grouped-counts-kernel.sql').read_bytes()).hexdigest(),'keeper_md5':canonical['keeper-candidate.sql']['md5'],'limits':'Actual original keeper with only fixture_clock substitutions; real cc867/grouped source counts and original locks/freshness/partials. Tournament quality/check/payment boundaries controlled; no full financial writer, production profile or capacity certificate.'}
 (w/'keeper-native-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
finally:
 if started:run([pg/'pg_ctl','-D',b/'d','-m','immediate','-w','stop'])
 shutil.rmtree(b)
