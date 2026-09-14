"""Run the exact prize-audit function in an isolated PostgreSQL 17 fixture."""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, tempfile, uuid

repo=pathlib.Path(__file__).resolve().parents[2]
fixture=repo/'scripts/ci/probes/spin-prize-overlay'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline',type=pathlib.Path,default=fixture/'baseline.json')
parser.add_argument('--candidate',type=pathlib.Path,default=repo/'supabase/migrations/20260914120920_spin_prize_audit_observes_funded_overlay.sql')
parser.add_argument('--output',type=pathlib.Path,default=repo/'artifacts/spin-prize-overlay')
a=parser.parse_args();a.output.mkdir(parents=True,exist_ok=False)
baseline=json.loads(a.baseline.read_text())
assert hashlib.md5(baseline['definition'].encode()).hexdigest()==baseline['definition_md5']
candidate=a.candidate.read_text()
pg=pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
assert shutil.disk_usage(tempfile.gettempdir()).free > 2*1024**3,'native fixture needs 2 GiB free'
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['LC_ALL']='C'
root=pathlib.Path(tempfile.mkdtemp(prefix='prize-overlay-native-'));sock=root/'socket';sock.mkdir()
started=False;children=[];checks=[]
psql=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(sock),'-p','55792','-U','postgres','-d','postgres']
def run(cmd,source=None,refuse=False):
 r=subprocess.run([str(x) for x in cmd],input=source,text=True,capture_output=True,env=env,timeout=25)
 if refuse:
  assert r.returncode != 0,'expected refusal'
  return r.stderr
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
def sql(source,refuse=False):return run(psql,source,refuse)
def uid(n):return str(uuid.UUID(int=n))
def check(name,truth):
 assert truth,name
 checks.append(name)
def audit():
 return json.loads(sql("SET ROLE service_role; SELECT coalesce(jsonb_agg(to_jsonb(a) order by tournament_id),'[]'::jsonb) FROM fn_tournament_prize_disbursement_audit(24) a;").splitlines()[-1])
def reset(pool=3,paid=11.4,multiplier=10,variant='spin',overlay=1.4,ledger=1.4,status='posted',origin='union_bank',target=1,category='overlay'):
 sql('TRUNCATE wallet_transactions,tournaments,tournament_escrow,chip_ledger,tournament_conservation_baseline;')
 sql(f"INSERT INTO tournaments VALUES('{uid(1)}','historical Spin','{variant}','COMPLETED',{pool},1,{multiplier},now()-interval '1 hour'); INSERT INTO wallet_transactions VALUES('{uid(10)}','{uid(1)}',{paid},'credit','prize'); INSERT INTO tournament_escrow VALUES('{uid(1)}',{overlay});")
 if ledger is not None:
  sql(f"INSERT INTO chip_ledger VALUES('{uid(20)}','{uid(1)}',{ledger},'{category}','prize_liability','{uid(target)}','{origin}','{status}');")
try:
 assert 'PostgreSQL) 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',root/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 run([pg/'pg_ctl','-D',root/'data','-l',root/'log','-o',f"-k {sock} -p 55792 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=6",'-w','start']);started=True
 sql("""CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE TABLE tournaments(id uuid PRIMARY KEY,name text,variant text,status text,prize_pool numeric,buy_in_amount numeric,spin_multiplier numeric,ended_at timestamptz);
 CREATE TABLE wallet_transactions(id uuid PRIMARY KEY,related_entity_id uuid,amount numeric,type text,category text);
 CREATE TABLE tournament_conservation_baseline(tournament_id uuid PRIMARY KEY,amount numeric);
 CREATE TABLE tournament_escrow(tournament_id uuid PRIMARY KEY,overlay_in numeric NOT NULL DEFAULT 0);
 CREATE TABLE chip_ledger(id uuid PRIMARY KEY,tournament_id uuid,amount numeric CHECK(amount>0),category text,to_type text,to_entity_id uuid,from_type text,status text CHECK(status IN('posted','correction','reversal')));
 CREATE INDEX idx_chip_ledger_overlay_by_tournament ON chip_ledger(tournament_id) INCLUDE(amount) WHERE tournament_id IS NOT NULL AND category='overlay' AND to_type='prize_liability';
 """)
 sql(baseline['definition'])
 sql('REVOKE ALL ON FUNCTION fn_tournament_prize_disbursement_audit(integer) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION fn_tournament_prize_disbursement_audit(integer) TO service_role;')
 reset();observed=audit()
 check('baseline reproduces exact funded 1.40 false excess',len(observed)==1 and observed[0]['excess']==1.4)
 (a.output/'BASELINE.json').write_text(json.dumps({'baseline_md5':baseline['definition_md5'],'native_response':observed,'production_connections':0},indent=2)+'\n')
 sql(candidate)
 digest=sql("SELECT md5(pg_get_functiondef('fn_tournament_prize_disbursement_audit(integer)'::regprocedure))")
 check('exact installed candidate identity',digest=='d62ceae6005e91ab678155a826bc50e5')
 sql(candidate);check('migration replay preserves the same definition',sql("SELECT md5(pg_get_functiondef('fn_tournament_prize_disbursement_audit(integer)'::regprocedure))")==digest)
 check('funded historical Spin correction is not an overpayment',audit()==[])
 reset(paid=11.5);check('real excess above funded correction stays visible',audit()[0]['excess']==0.1)
 reset(paid=10,overlay=0,ledger=None);check('drawn Spin prize remains valid above unspun pool',audit()==[])
 reset(paid=10.5,overlay=0,ledger=None);check('unfunded excess above drawn prize stays visible',audit()[0]['excess']==0.5)
 reset(ledger=None);check('escrow counter without funding journal cannot hide payment',audit()[0]['excess']==1.4)
 reset(overlay=0);check('journal without escrow recognition cannot hide payment',audit()[0]['excess']==1.4)
 reset(target=2);check('different target entity cannot fund this event',audit()[0]['excess']==1.4)
 reset();sql(f"UPDATE chip_ledger SET tournament_id='{uid(2)}';");check('different tournament cannot fund this event',audit()[0]['excess']==1.4)
 reset(origin='player_wallet');check('player transfer is not house correction funding',audit()[0]['excess']==1.4)
 reset(category='transfer');check('unrelated journal category is not overlay funding',audit()[0]['excess']==1.4)
 reset();sql("UPDATE chip_ledger SET to_type='bounty_liability';");check('bounty funding cannot increase prize allowance',audit()[0]['excess']==1.4)
 for status in ['correction','reversal']:
  reset(status=status);check(status+' record does not create posted funding',audit()[0]['excess']==1.4)
 reset(ledger=1.5);check('mismatched journal and escrow remain reportable',audit()[0]['excess']==1.4)
 reset(ledger=1);check('short funding journal cannot erase the discrepancy',audit()[0]['excess']==1.4)
 reset(overlay=-1.4,ledger=None);check('negative overlay cannot enlarge allowance',audit()[0]['excess']==1.4)
 reset(overlay="'NaN'",ledger=None);check('unknown numeric escrow is not funding',audit()[0]['excess']==1.4)
 reset(overlay="'Infinity'",ledger="'Infinity'");check('infinite journal and escrow cannot hide payments',audit()[0]['excess']==1.4)
 reset(ledger=.7);sql(f"INSERT INTO chip_ledger SELECT '{uid(21)}',tournament_id,amount,category,to_type,to_entity_id,from_type,status FROM chip_ledger;");check('separate real funding legs aggregate once',audit()==[])
 reset(pool=11.4,paid=11.4);check('pool already reflecting correction is not counted twice',audit()==[])
 reset(pool=11.4,paid=11.5);check('reflected overlay does not hide further excess',audit()[0]['excess']==0.1)
 reset(multiplier=0,paid=4.4);check('undrawn Spin retains prior pool rule',audit()[0]['excess']==1.4)
 reset(multiplier='NULL',paid=4.4);check('missing multiplier retains prior pool rule',audit()[0]['excess']==1.4)
 reset(variant='freezeout',pool=10,paid=11.4);check('non-Spin pool semantics stay unchanged',audit()[0]['excess']==1.4)
 reset(paid=12.4);sql(f"INSERT INTO tournament_conservation_baseline VALUES('{uid(1)}',1);");check('separate declared historical acknowledgment is preserved',audit()==[])
 reset(paid=12.5);sql(f"INSERT INTO tournament_conservation_baseline VALUES('{uid(1)}',1);");check('excess beyond funding and acknowledgment remains visible',audit()[0]['excess']==.1)
 reset();sql("UPDATE tournaments SET ended_at=now()-interval '25 hours';");check('original reporting window remains bounded',audit()==[])
 reset();sql("UPDATE tournaments SET status='RUNNING';");check('running event remains outside completed-event audit',audit()==[])
 reset(paid=11.5);sql("UPDATE wallet_transactions SET category='bounty';");check('bounty credits are not recategorized as prizes',audit()==[])
 reset(ledger=None,overlay=0)
 child=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env);children.append(child)
 child.stdin.write(f"BEGIN; UPDATE tournament_escrow SET overlay_in=1.4; INSERT INTO chip_ledger VALUES('{uid(20)}','{uid(1)}',1.4,'overlay','prize_liability','{uid(1)}','union_bank','posted'); SELECT 'funding-uncommitted';\n");child.stdin.flush()
 assert child.stdout.readline().strip()=='funding-uncommitted'
 check('concurrent uncommitted funding cannot suppress an alert',audit()[0]['excess']==1.4)
 child.stdin.write('COMMIT;\n');child.stdin.close();child.stdin=None
 _,err=child.communicate(timeout=5);assert child.returncode==0,err
 check('one committed funding snapshot becomes visible atomically',audit()==[])
 reset()
 check('anonymous cannot call audit','permission denied' in sql('SET ROLE anon;SELECT * FROM fn_tournament_prize_disbursement_audit();',True))
 check('authenticated browser cannot call audit','permission denied' in sql('SET ROLE authenticated;SELECT * FROM fn_tournament_prize_disbursement_audit();',True))
 check('service audit executes in read-only transaction',sql('BEGIN READ ONLY;SET ROLE service_role; SELECT count(*) FROM fn_tournament_prize_disbursement_audit();ROLLBACK;')=='0')
 check('function metadata remains stable service-only',sql("SELECT provolatile='s' AND prosecdef AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='fn_tournament_prize_disbursement_audit(integer)'::regprocedure")=='t')
 # An unknown concurrent definition must survive a refused installation.
 sql(baseline['definition'].replace('WITH t AS (','WITH t AS (\n    -- unrelated future implementation'))
 unknown=sql("SELECT md5(pg_get_functiondef('fn_tournament_prize_disbursement_audit(integer)'::regprocedure))")
 check('unknown migration preimage is refused','spin prize audit definition drift' in sql(candidate,True))
 check('refused migration preserves unknown definition',sql("SELECT md5(pg_get_functiondef('fn_tournament_prize_disbursement_audit(integer)'::regprocedure))")==unknown)
 sql(baseline['definition']);sql(candidate)
 (a.output/'RESULTS.json').write_text(json.dumps({'observed_at':sql('SELECT clock_timestamp()'),'postgres_version':sql('SHOW server_version'),'baseline_md5':baseline['definition_md5'],'candidate_md5':digest,'checks':checks,'check_count':len(checks),'production_connections':0,'production_mutations':0,'scope':'Prize audit detection only; no payout writer invoked or qualified.'},indent=2)+'\n')
 print(json.dumps({'checks_passed':len(checks),'candidate_md5':digest,'production_connections':0}))
except BaseException as e:
 (a.output/'FAILURE.json').write_text(json.dumps({'error':str(e)},indent=2)+'\n');raise
finally:
 for child in children:
  if child.poll() is None:child.kill();child.wait()
 if started:run([pg/'pg_ctl','-D',root/'data','-m','fast','-w','stop'])
 shutil.rmtree(root)
