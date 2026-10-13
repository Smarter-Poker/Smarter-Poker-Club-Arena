from pathlib import Path
import json,subprocess,hashlib,uuid
import argparse,tempfile,os,sys,shutil
P=Path(__file__).resolve().parent;a=argparse.ArgumentParser();a.add_argument('--output',type=Path,required=True);args=a.parse_args();O=args.output.resolve();O.mkdir(parents=True,exist_ok=True);I=P;R=P.parents[2]
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote connection forbidden')
PG=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin' if sys.platform=='darwin' else str(Path(shutil.which('psql')).parent)))
base=Path('/Volumes/SmarterWork/agent-work/weekly-cohort-cutoff-01a13099') if sys.platform=='darwin' else O.parent;B=Path(tempfile.mkdtemp(prefix='native-history-',dir=base));D=B/'d';S=B/'s';S.mkdir();port='56633'
def run(a,n,s=None):
 q=subprocess.run([str(x)for x in a],input=s,text=True,capture_output=True,timeout=60);(O/(n+'.stdout')).write_text(q.stdout);(O/(n+'.stderr')).write_text(q.stderr)
 if s is not None:(O/(n+'.sql')).write_text(s)
 assert q.returncode==0,(n,q.stderr);return q.stdout.strip()
def sql(s,n):return run([PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',S,'-p',port,'-U','postgres'],n,s)
def jid(i):return str(uuid.UUID(hashlib.md5(('club'+str(i)).encode()).hexdigest()))
started=False
try:
 run([PG/'initdb','-D',D,'-U','postgres','-A','trust','--no-locale','-E','UTF8'],'init');run([PG/'pg_ctl','-D',D,'-l',B/'server.log','-o',f"-k {S} -p {port} -h ''",'-w','start'],'start');started=True
 sql((I/'semantic-bootstrap.sql').read_text(),'bootstrap');sql('TRUNCATE accounting_cash_rake_sources,accounting_tournament_fee_sources,accounting_tournament_recognized_sources,accounting_tournament_fee_recognitions,accounting_rakeback_period_calculations,settlement_periods;','unmask-history')
 # Original history: latest initial tie moves club6 OUT; duringweek club7 stays IN.
 cases=[('latest-tie-and-during','',[7]),('remove-winning-tie','DELETE FROM accounting_agreement_history WHERE id=3;',[6,7]),('at-end-excluded',"INSERT INTO accounting_agreement_history VALUES(10,'end','union_clubs','2026-10-12 07:00Z',jsonb_build_object('club_id',md5('club8')::uuid,'union_id',md5('union1')::uuid));",[6,7]),('before-latest-excluded',"INSERT INTO accounting_agreement_history VALUES(11,'a','union_clubs','2026-10-04 08:00Z',jsonb_build_object('club_id',md5('club5')::uuid,'union_id',md5('union1')::uuid));",[6,7])]
 results=[]
 for name,change,ids in cases:
  if change:sql(change,name+'-input')
  outputs=[]
  for label,file in [('old','before-helper.sql'),('new','after-helper.sql')]:
   sql((I/file).read_text()+';',name+'-'+label+'-definition');outputs.append(json.loads(sql("SELECT COALESCE(jsonb_agg(club_id ORDER BY club_id),'[]') FROM fn_accounting_week_clubs(md5('union1')::uuid,NULL,'2026-10-05 07:00Z','2026-10-12 07:00Z');",name+'-'+label)))
  expected=sorted(jid(i)for i in ids);assert outputs==[expected,expected];results.append({'case':name,'expected':expected,'actual':outputs})
 sql("INSERT INTO ca_launch_accounting_boundaries VALUES('club',md5('club1')::uuid,NULL,NULL);",'explicit-null-cutoff')
 result={'history_independent_cases':results,'explicit_null_cutoff':json.loads(sql("SELECT jsonb_build_object('null_earned',fn_ca_launch_accounting_accepts(md5('club1')::uuid,NULL),'negative_infinite',fn_ca_launch_accounting_accepts(md5('club1')::uuid,'-infinity'));",'null-cutoff-authentic'))};assert all(result['explicit_null_cutoff'].values());(O/'result.json').write_text(json.dumps(result,indent=2)+'\n');print('PASS independent history tie/window/NULL cutoff')
 sql("TRUNCATE accounting_agreement_history; INSERT INTO accounting_tournament_fee_sources(id,tournament_id,club_id,union_id,coordinator_union_id,charged_at,rake_credit)VALUES(md5('dup')::uuid,md5('dup-t')::uuid,NULL,NULL,md5('union1')::uuid,NULL,2);INSERT INTO accounting_tournament_recognized_sources VALUES(md5('dup')::uuid,md5('dup-t')::uuid,'2026-10-06 07:00Z','earned',2),(md5('dup')::uuid,md5('dup-t')::uuid,'2026-10-06 07:00Z','earned',2);INSERT INTO accounting_tournament_fee_recognitions VALUES(md5('dup-t')::uuid,'2026-10-06 07:00Z','recognized',NULL),(md5('dup-t')::uuid,'2026-10-06 07:00Z','recognized',NULL);REVOKE ALL ON FUNCTION fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC;",'null-duplicate-input')
 ctes=(I/'earning-ctes.sql').read_text()
 for k,v in {'p_union_id':"md5('union1')::uuid",'p_from':"'2026-10-05 07:00Z'::timestamptz",'p_to':"'2026-10-12 07:00Z'::timestamptz"}.items():ctes=ctes.replace(k,v)
 assert int(sql("SELECT count(*) FROM accounting_payable_earning_sources WHERE coordinator_union_id=md5('union1')::uuid AND earned_at>='2026-10-05 07:00Z' AND earned_at<'2026-10-12 07:00Z';",'dup-old'))==4
 assert int(sql('WITH '+ctes+' SELECT count(*) FROM accepted_earnings;','dup-new'))==4
 for label,file in [('old','before-helper.sql'),('new','after-helper.sql')]:
  sql((I/file).read_text()+';',label+'-definition')
  assert json.loads(sql("SELECT COALESCE(jsonb_agg(club_id),'[]') FROM fn_accounting_week_clubs(md5('union1')::uuid,NULL,'2026-10-05 07:00Z','2026-10-12 07:00Z');",label+'-dup-null-final'))==[]
  assert sql("SELECT p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='s' AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public'] FROM pg_proc p WHERE p.oid='fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure;",label+'-security')=='t'
 print('PASS duplicate NULL club multiplicity/security')
finally:
 if started:run([PG/'pg_ctl','-D',D,'-m','fast','-w','stop'],'stop')

shutil.copyfile(B/'server.log',O/'server.log');shutil.rmtree(B);(O/'cleanup.json').write_text(json.dumps({'own_cluster_stopped':True,'own_cluster_removed':True,'production':False}))
