"""Native date-input regression; no money writer or production connection."""
import json,os,pathlib,shutil,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
PG=pathlib.Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
OUT=pathlib.Path(os.environ.get('DAILY_FACT_TEST_OUTPUT',ROOT/'artifacts/digest-oct27-reporting/day-index'));OUT.mkdir(parents=True,exist_ok=True)
BASE=pathlib.Path(tempfile.mkdtemp(prefix='dfd-'));SOCK=BASE/'s';SOCK.mkdir()
owner=['runuser','-u','postgres','--']if os.geteuid()==0 else[]
if owner:shutil.chown(BASE,'postgres');shutil.chown(SOCK,'postgres')
env={k:v for k,v in os.environ.items()if not k.startswith('PG')}
SQL=[PG/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h',SOCK,'-p','55842','-U','postgres']
checks=[]
def cmd(args,value=None,ok=True):
 r=subprocess.run(list(map(str,args)),input=value,text=True,capture_output=True,env=env,timeout=90)
 if ok and r.returncode:raise RuntimeError(r.stderr)
 return r
def sql(value):return cmd(SQL,value).stdout.strip()
def check(name,value):
 checks.append({'name':name,'passed':bool(value)})
 assert value,name
def nodes(p):
 yield p
 for c in p.get('Plans',[]):yield from nodes(c)
query="SELECT club_id,game_id,stat_date,kind,user_id,fee,buyins,cashouts,winnings FROM ca_club_data_fact WHERE stat_date='2026-10-27'"
summary="SELECT count(*),sum(fee),sum(buyins),sum(cashouts),sum(winnings),count(DISTINCT club_id) FROM ("+query+") f"
try:
 cmd(owner+[PG/'initdb','-D',BASE/'d','-A','trust','-U','postgres','--no-locale','--encoding=UTF8'])
 cmd(owner+[PG/'pg_ctl','-D',BASE/'d','-l',BASE/'log','-o',f"-k {SOCK} -p 55842 -c listen_addresses='' -c shared_buffers=32MB",'-w','start'])
 # Actual original table definition, without unrelated money triggers.
 source=(ROOT/'supabase/migrations/20261017160125_club_data_counts_what_the_club_played.sql').read_text()
 start=source.index('CREATE TABLE IF NOT EXISTS public.ca_club_data_fact (')
 sql(source[start:source.index('\nALTER TABLE',start)])
 sql("INSERT INTO ca_club_data_fact SELECT md5((n%100)::text)::uuid,'2026-09-01'::date+(n-1)/5000,CASE WHEN n%2=0 THEN 'CASH' ELSE 'TOURNAMENT' END,md5((n%1000)::text)::uuid,md5(n::text)::uuid,(n%19)::numeric/100,(n%29)::numeric/100,(n%31)::numeric/100,(n%37)::numeric/100,now() FROM generate_series(1,300000)n; VACUUM ANALYZE ca_club_data_fact;")
 before=sql(summary);old=json.loads(sql('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+query))[0]['Plan']
 check('old-date-input-scans-unselected-history',any(n.get('Node Type')=='Seq Scan'and n.get('Rows Removed by Filter',0)*n.get('Actual Loops',1)>=294000 for n in nodes(old)))
 migration=(ROOT/'supabase/migrations/20261028162611_daily_reporting_facts_begin_with_their_selected_date.sql').read_text()
 sql(migration)
 after=sql(summary);new=json.loads(sql('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+query))[0]['Plan']
 check('all-selected-numeric-values-and-keys-preserved',before==after and after.startswith('5000|'))
 check('date-is-index-admission-not-post-scan-filter',any(n.get('Index Name')=='ca_club_data_fact_day_idx'and 'stat_date'in n.get('Index Cond','')for n in nodes(new)))
 check('selected-date-buffer-work-is-bounded',new['Shared Hit Blocks']+new['Shared Read Blocks']<(old['Shared Hit Blocks']+old['Shared Read Blocks'])/4)
 check('date-boundaries-and-empty-day-exact',sql("SELECT count(*) FROM ca_club_data_fact WHERE stat_date='2026-10-26'")=='5000'and sql("SELECT count(*) FROM ca_club_data_fact WHERE stat_date='2026-11-01'")=='0')
 # psql sessions are separate, so prepare and EXPLAIN in one actual session.
 generic=json.loads(sql("SET plan_cache_mode=force_generic_plan; PREPARE day_input(date) AS SELECT club_id,game_id,stat_date,kind,user_id,fee,buyins,cashouts,winnings FROM ca_club_data_fact WHERE stat_date=$1; EXPLAIN(FORMAT JSON) EXECUTE day_input('2026-10-27');"))[0]['Plan']
 check('generic-parameter-plan-also-bounds-date',any(n.get('Index Name')=='ca_club_data_fact_day_idx'and '$1'in n.get('Index Cond','')for n in nodes(generic)))
 oid=sql("SELECT 'ca_club_data_fact_day_idx'::regclass::oid")
 sql(migration)
 check('replay-does-not-rebuild-valid-index',sql("SELECT 'ca_club_data_fact_day_idx'::regclass::oid")==oid)
 sql('DROP INDEX ca_club_data_fact_day_idx; CREATE INDEX ca_club_data_fact_day_idx ON ca_club_data_fact(club_id);')
 check('wrong-existing-index-refused',cmd(SQL,migration,False).returncode!=0)
 (OUT/'plans.json').write_text(json.dumps({'before':old,'after':new,'generic':generic},indent=2))
 print(json.dumps({'checks':checks,'production_mutations':False,'limits':'Exact date-input projection on actual original table schema; not whole rollup latency or the sole cause of its historical timeout.'}))
finally:
 (OUT/'RESULTS.json').write_text(json.dumps({'checks':checks,'production_mutations':False},indent=2))
 cmd(owner+[PG/'pg_ctl','-D',BASE/'d','-m','immediate','-w','stop'],ok=False)
 shutil.rmtree(BASE)
