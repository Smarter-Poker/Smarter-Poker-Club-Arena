from pathlib import Path
import argparse,subprocess,tempfile,socket,os,sys,json,hashlib,shutil
def source(path):
 text=path.read_text()
 value=json.loads(text)['definition']if path.suffix=='.json'else text
 assert isinstance(value,str)
 return value
p=argparse.ArgumentParser()
for x in ['repo','scratch','pg-bin','before-scope','after-scope','before-eligible','after-eligible','output']:p.add_argument('--'+x,type=Path,required=True)
a=p.parse_args();assert not a.output.exists();assert sys.platform!='darwin'or a.scratch.resolve().is_relative_to(Path('/Volumes/SmarterWork/agent-work'))
paths=[Path(__file__).resolve(),a.before_scope,a.after_scope,a.before_eligible,a.after_eligible,a.repo/'scripts/ci/fixtures/fees-before-club-books/bootstrap.sql',a.repo/'scripts/ci/fixtures/weekly-fee-preparation/bootstrap.sql'];paths.append(a.repo/'scripts/ci/fixtures/weekly-fee-preparation/original-helpers.json');snap={str(x):x.read_bytes()for x in paths};sha=lambda b:hashlib.sha256(b).hexdigest();md5=lambda s:hashlib.md5(s.encode()).hexdigest();bs=source(a.before_scope);ns=source(a.after_scope);be=source(a.before_eligible);ne=source(a.after_eligible);assert md5(bs)=='a68500342f07e0608c6eb69f4cb0739e';assert md5(ns)=='e4f6b4adc2f43ccd2b7ecd90f2434538';assert md5(be)=='fd2603a21dc9c93a234afbda57d6abba';assert be.count(md5(bs))==1 and ne==be.replace(md5(bs),md5(ns))
D=Path(tempfile.mkdtemp(prefix='coupled-native-',dir=a.scratch));data=D/'pg';env={k:v for k,v in os.environ.items()if not k.startswith('PG')and k not in ('DATABASE_URL','SUPABASE_DB_URL')};env.update(TMPDIR=str(D),LC_ALL='C',LANG='C');started=False;cases=[]
with socket.socket()as s:s.bind(('127.0.0.1',0));port=str(s.getsockname()[1])
def run(sql):return subprocess.run([str(a.pg_bin/'psql'),'-XqAt','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input="SET check_function_bodies=off;SET TIME ZONE 'UTC';SET test.now='2026-10-26 09:00Z';"+sql,text=True,capture_output=True,env=env,timeout=30)
def q(sql):
 r=run(sql);assert r.returncode==0,r.stderr;return r.stdout.strip()
call="SELECT coalesce(jsonb_agg(to_jsonb(x)ORDER BY kind,id),'[]'::jsonb)FROM smarter_private.weekly_payout_eligible_scopes('2026-10-26 07:00Z','2026-10-26 09:00Z')x;"
meta="SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid='smarter_private.weekly_payout_eligible_scopes(timestamptz,timestamptz)'::regprocedure;"
def rejection():
 r=run('\\set VERBOSITY verbose\n'+call);assert r.returncode!=0 and '55000'in r.stderr and 'weekly_payout_original_scope_authority_changed'in r.stderr,r.stderr
try:
 subprocess.run([str(a.pg_bin/'initdb'),'-D',str(data),'-U','postgres','-A','trust','--no-locale'],env=env,stdout=subprocess.DEVNULL,check=True)
 subprocess.run([str(a.pg_bin/'pg_ctl'),'-D',str(data),'-l',str(D/'pg.log'),'-o',f"-k '' -h 127.0.0.1 -p {port} -c fsync=off",'-w','start'],env=env,stdout=subprocess.DEVNULL,check=True);started=True
 for f in paths[-3:-1]:q(f.read_text())
 for h in json.loads(paths[-1].read_text()):q(h['definition'].replace('clock_timestamp()','public.fixture_clock()').replace('statement_timestamp()','public.fixture_clock()').replace('now()','public.fixture_clock()'))
 q("CREATE SCHEMA IF NOT EXISTS smarter_private;ALTER TABLE agents ADD COLUMN credit_limit numeric DEFAULT 0;")
 # Existing maintained real native relation bootstrap, with only the missing current-schema credit_limit column added.
 q(bs+';'+be+';REVOKE ALL ON FUNCTION smarter_private.weekly_payout_eligible_scopes(timestamptz,timestamptz)FROM PUBLIC;')
 before_meta=q(meta);base=json.loads(q(call));assert base==[{'kind':'union','id':'fade0000-0000-0000-0000-000000000001','first_week':'2026-10-19T07:00:00+00:00'}],base;cases.append('old_scope_old_discovery_actual_query_expected_union')
 q(ns+';');rejection();cases.append('new_scope_old_discovery_55000_exact_authority_refusal')
 q(ne+';');assert q(meta)==before_meta;assert md5(ne)==q("SELECT md5(pg_get_functiondef('smarter_private.weekly_payout_eligible_scopes(timestamptz,timestamptz)'::regprocedure));");assert json.loads(q(call))==base;cases.append('new_scope_new_discovery_same_full_row_bag_and_metadata')
 q(bs+';');rejection();cases.append('old_scope_new_discovery_55000_exact_authority_refusal')
 q(be+';TRUNCATE unions;');assert json.loads(q(call))==[];cases.append('old_scope_old_discovery_actual_query_empty_bag')
 q(ns+';'+ne+';');assert json.loads(q(call))==[];cases.append('new_scope_new_discovery_actual_query_empty_bag')
 # Real query standalone cash branch and union branch together, preserve duplicates/order via whole bag.
 q("INSERT INTO unions VALUES(u());INSERT INTO accounting_cash_rake_sources(club_id,earned_at,coordinator_union_id)VALUES(c(),'2026-10-20 08:00Z',NULL),(c(),'2026-10-21 08:00Z',NULL);")
 newbag=json.loads(q(call));assert len(newbag)==2 and {x['kind']for x in newbag}=={'union','club'},newbag
 q(bs+';'+be+';');assert json.loads(q(call))==newbag;cases.append('old_new_discovery_actual_union_and_standalone_cash_full_bag_parity')
 for name,b in snap.items():assert Path(name).read_bytes()==b,'input bytes changed'
 a.output.write_text(json.dumps({'passed':True,'case_count':len(cases),'cases':cases,'before_scope_md5':md5(bs),'after_scope_md5':md5(ns),'before_eligible_md5':md5(be),'after_eligible_md5':md5(ne),'input_sha256':{k:sha(v)for k,v in snap.items()},'limits':['Exact actual current discovery body executes unchanged except one admitted scope identity literal.','Exact scope definitions are compiled only to prove their identity; the separate 19-case suite executes scope behavior.','Existing native weekly preparation schema is used with the missing current-schema credit_limit column added; launch/floor calendar dependencies retain maintained fixture implementations.','Not guarded migration installation, full production discovery cohort, original source65/GEN execution or provider capacity proof.']},indent=2)+'\n');print(json.dumps({'passed':True,'cases':len(cases),'output':str(a.output)}))
finally:
 if started:subprocess.run([str(a.pg_bin/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'],env=env,stdout=subprocess.DEVNULL,check=True)
 shutil.rmtree(D)
