"""Native returned-draw detector regression; never executes payout or source migrations."""
import argparse,json,os,pathlib,re,select,shutil,subprocess,tempfile,uuid
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--repo',type=pathlib.Path,default=pathlib.Path(__file__).resolve().parents[2]);p.add_argument('--output',type=pathlib.Path,default=pathlib.Path(__file__).resolve().parents[2]/'artifacts/spin-return-detector');a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False)
pattern=re.compile(r'CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?v_spin_unpaid_settlements\b[\s\S]*?;',re.I)
versions=[]
for f in sorted((a.repo/'supabase/migrations').glob('*.sql')):
 s=f.read_text();m=pattern.findall(s)
 if m:
  assert len(m)==1,f'Unclassified multiple view declarations: {f}'
  versions.append((f.name,m[0]))
baseline=next(s for name,s in versions if name=='20260831193833_the_spin_unpaid_view_stays_narrow_and_here_is_why.sql')
current_name,current=versions[-1]
assert current_name=='20260909085407_an_escrow_that_never_heard_about_the_return_is_not_a_shortfall.sql',f'Review new source {current_name}'
pg=pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
assert shutil.disk_usage(tempfile.gettempdir()).free>2*1024**3
cluster=pathlib.Path(tempfile.mkdtemp(prefix='spin-return-native-'));sock=cluster/'sock';sock.mkdir();started=False;children=[];checks=[]
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['LC_ALL']='C'
psql=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(sock),'-p','55793','-U','postgres','-d','postgres']
def run(cmd,source=None):
 r=subprocess.run(list(map(str,cmd)),input=source,text=True,capture_output=True,env=env,timeout=25)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
def sql(s):return run(psql,s)
def uid(i):return str(uuid.UUID(int=i))
def check(n,v):
 assert v,n
 checks.append(n)
def view():return json.loads(sql("SELECT coalesce(jsonb_agg(to_jsonb(v)),'[]'::jsonb) FROM v_spin_unpaid_settlements v;"))
def reset(draw=3,returned=3,escrow=.24,paid=0,refund=3,status='CANCELLED',variant='spin',age=60):
 sql('TRUNCATE tournaments,spin_reserve_ledger,wallet_transactions,tournament_players,tournament_escrow;')
 sql(f"INSERT INTO tournaments VALUES('{uid(1)}','{uid(2)}','native Spin','{status}',1,3,now()-interval '4 hours',now()-interval '{age} minutes','{variant}'); INSERT INTO spin_reserve_ledger VALUES('{uid(10)}','{uid(1)}','jackpot_draw',{-draw},now()-interval '3 hours');")
 if returned is not None:sql(f"INSERT INTO spin_reserve_ledger VALUES('{uid(11)}','{uid(1)}','surplus_return',{returned},now()-interval '1 hour');")
 if escrow is not None:sql(f"INSERT INTO tournament_escrow VALUES('{uid(1)}',{escrow});")
 if paid:sql(f"INSERT INTO wallet_transactions VALUES('{uid(20)}','{uid(1)}',{paid},'credit','prize');")
 if refund:sql(f"INSERT INTO wallet_transactions VALUES('{uid(21)}','{uid(1)}',{refund},'credit','refund');")
try:
 check('PostgreSQL17','PostgreSQL) 17.' in run([pg/'postgres','--version']))
 run([pg/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 run([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'log','-o',f"-k {sock} -p 55793 -c listen_addresses='' -c timezone=UTC -c shared_buffers=16MB -c max_connections=6",'-w','start']);started=True
 sql('''CREATE TABLE tournaments(id uuid PRIMARY KEY,club_id uuid,name text,status text,buy_in_amount numeric,spin_multiplier numeric,started_at timestamptz,ended_at timestamptz,variant text);
 CREATE TABLE spin_reserve_ledger(id uuid PRIMARY KEY,tournament_id uuid,kind text,amount numeric,created_at timestamptz);
 CREATE TABLE wallet_transactions(id uuid PRIMARY KEY,related_entity_id uuid,amount numeric,type text,category text);
 CREATE TABLE tournament_players(tournament_id uuid,position integer,status text,prize numeric);
 CREATE TABLE tournament_escrow(tournament_id uuid PRIMARY KEY,prize_balance numeric);''')
 sql(baseline);reset();old=view();check('old actual view reproduces fully returned 3-chip false shortage',len(old)==1 and old[0]['chips_short']==3)
 (a.output/'BASELINE.json').write_text(json.dumps(old,indent=2)+'\n')
 sql(current);digest=sql("SELECT md5(pg_get_viewdef('v_spin_unpaid_settlements'::regclass,true))")
 check('repository view is exact current production definition',digest=='baf8fddf0ea192ad20ec9ca2f860237f')
 check('fully returned draw does not owe another prize',view()==[])
 reset(escrow=3);check('stale full escrow cannot create another payment after full return',view()==[])
 reset(escrow=None);legacy_without_escrow=view();check('missing escrow does not raise an unpaid-prize finding after full return',not any(r['chips_short']>0 for r in legacy_without_escrow))
 reset(returned=1,escrow=2,refund=0);check('partial return retains unpaid remainder',view()[0]['chips_short']==2)
 reset(returned=None,escrow=3,refund=0,status='COMPLETED');check('actual unfunded-player prize remains visible in escrow',view()[0]['chips_short']==3)
 reset(returned=None,escrow=None,refund=0,status='COMPLETED');check('missing escrow cannot hide an unreturned unpaid draw',view()[0]['chips_short']==3)
 reset(returned=1,escrow=None,paid=1,refund=0);check('partial prize plus partial return leave exact residual',view()[0]['chips_short']==1)
 reset(returned=1,escrow=None,paid=2,refund=0);check('prize and return together close the draw exactly',view()==[])
 reset(returned=None,escrow=None,paid=2,refund=1);check('legacy classified refunds retain existing allowance',view()==[])
 reset(returned=None,escrow=0,paid=3,refund=0,status='COMPLETED');check('fully paid complete Spin remains clear',view()==[])
 reset(returned=None,escrow=None,paid=4,refund=0,status='COMPLETED');check('true excess remains visible with its negative sign',view()[0]['chips_short']==-1)
 reset(returned=None,escrow=3,refund=0,variant='freezeout');check('non-Spin remains outside reserve view',view()==[])
 for status in ['RUNNING','REGISTERING']:
  reset(returned=None,escrow=3,refund=0,status=status);check(status+' is not prematurely declared unpaid',view()==[])
 reset(returned=None,escrow=3,refund=0,age=5);sql("UPDATE spin_reserve_ledger SET created_at=now()-interval '5 minutes';");check('ten-minute terminal grace is preserved',view()==[])
 reset(returned=None,escrow=3,refund=0);sql(f"INSERT INTO spin_reserve_ledger VALUES('{uid(12)}','{uid(3)}','surplus_return',3,now());");check('another tournament return cannot close this draw',view()[0]['chips_short']==3)
 reset(returned=None,escrow=3,refund=0);sql(f"INSERT INTO spin_reserve_ledger VALUES('{uid(12)}','{uid(1)}','contribution',3,now());");check('entry contribution is not a returned jackpot',view()[0]['chips_short']==3)
 reset(returned=None,escrow=3,refund=0)
 child=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env);children.append(child)
 child.stdin.write(f"BEGIN;INSERT INTO spin_reserve_ledger VALUES('{uid(11)}','{uid(1)}','surplus_return',3,now());SELECT 'return-uncommitted';\n");child.stdin.flush()
 assert select.select([child.stdout],[],[],10)[0], 'Concurrent return transaction did not acknowledge within 10 seconds'
 assert child.stdout.readline().strip()=='return-uncommitted'
 check('uncommitted return cannot suppress an actual shortage',view()[0]['chips_short']==3)
 child.stdin.write('ROLLBACK;\n');child.stdin.close();child.stdin=None;_,err=child.communicate(timeout=5);assert child.returncode==0,err
 check('rolled-back return cannot become funding evidence',view()[0]['chips_short']==3)
 sql(f"INSERT INTO spin_reserve_ledger VALUES('{uid(11)}','{uid(1)}','surplus_return',3,now());");check('committed exact return closes only its own draw',view()==[])
 check('detector can run in a read-only transaction',sql('BEGIN READ ONLY; SELECT count(*) FROM v_spin_unpaid_settlements;ROLLBACK;')=='0')
 out={'observed_at':sql('SELECT clock_timestamp()'),'source':current_name,'definition_md5':digest,'checks':checks,'check_count':len(checks),'production_connections':0,'financial_writers_invoked':0,'legacy_refund_without_escrow_observation':legacy_without_escrow,'scope':'Exact returned-draw detector regression only, not general payout qualification.'}
 (a.output/'RESULTS.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'checks_passed':len(checks),'definition_md5':digest,'production_connections':0,'financial_writers_invoked':0}))
finally:
 for child in children:
  if child.poll() is None:child.kill();child.wait()
 if started:run([pg/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
 shutil.rmtree(cluster)
