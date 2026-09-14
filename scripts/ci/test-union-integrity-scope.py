"""Native read-scope counterexamples. No production connection or delivery triggers."""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, tempfile, time, uuid

repo = pathlib.Path(__file__).resolve().parents[2]
base = repo / 'scripts/ci/probes/union-integrity-scope'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=pathlib.Path,default=repo/'artifacts/union-integrity-scope')
out=parser.parse_args().output.resolve();out.mkdir(parents=True,exist_ok=False)
pg = pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
installer=(repo/'supabase/migrations/20260914110900_union_integrity_observes_its_own_events.sql').read_text()
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
root = pathlib.Path(tempfile.mkdtemp(prefix='union-scope-native-'))
sock = root / 'socket'
sock.mkdir()
started = False
children=[]
psql = [str(pg/'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(sock), '-p', '55786', '-U', 'postgres', '-d', 'postgres']
def run(args, source=None, expected=0):
    r = subprocess.run(list(map(str,args)), input=source, text=True, capture_output=True, env=env, timeout=25)
    if expected == 0 and r.returncode: raise RuntimeError(r.stderr)
    if expected != 0 and not r.returncode: raise AssertionError('expected refusal')
    return r.stdout.strip() if expected == 0 else r.stderr
def sql(source, expected=0): return run(psql,source,expected)
def uid(n): return str(uuid.UUID(int=n))
def caller(n, statement):
    return "SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{\"role\":\"authenticated\",\"sub\":\""+uid(n)+"\"}', false);"+statement
def sweep(user, union):
    return json.loads(sql(caller(user, f"SELECT fn_union_integrity_sweep('{uid(union)}',24);" )).splitlines()[-1])
def pending(source):
    child=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    children.append(child);child.stdin.write(source+'\n');child.stdin.flush();return child
def finish(child,commit=True):
    child.stdin.write(('COMMIT;' if commit else 'ROLLBACK;')+'\n');child.stdin.close();child.stdin=None
    out_text,error=child.communicate(timeout=5)
    if child.returncode: raise RuntimeError(error)
    return out_text
try:
    assert 'PostgreSQL) 17.' in run([pg/'postgres','--version'])
    run([pg/'initdb','-D',root/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    run([pg/'pg_ctl','-D',root/'data','-l',root/'log','-o',f"-k {sock} -p 55786 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=8",'-w','start'])
    started=True
    sql((base/'schema.sql').read_text())
    defs=[]
    for r in json.loads((base/'definitions.json').read_text()):
        body=r['definition'];assert hashlib.md5(body.encode()).hexdigest()==r['md5']
        sql(body);defs.append({'signature':r['signature'],'md5':r['md5']})
    sql('GRANT USAGE ON SCHEMA auth,public TO authenticated; REVOKE ALL ON FUNCTION fn_union_integrity_sweep(uuid,integer) FROM PUBLIC; GRANT EXECUTE ON FUNCTION fn_union_integrity_sweep(uuid,integer) TO authenticated,service_role;')
    for union,club,owner in [(100,101,10),(200,201,20)]:
        sql(f"INSERT INTO unions VALUES('{uid(union)}','{uid(owner)}'); INSERT INTO clubs VALUES('{uid(club)}','{uid(owner)}',false); INSERT INTO union_clubs VALUES('{uid(union)}','{uid(club)}');")
    sql(f"INSERT INTO chip_transactions(club_id,from_user_id,to_user_id,amount,transaction_type,created_at) VALUES('{uid(201)}','{uid(30)}','{uid(31)}',23,'player_transfer',now());")
    first=sweep(10,100)
    assert first['direct_chip_transfer']==[{'from_user':uid(30),'to_user':uid(31),'transfers':1,'total':23.00}],first
    assert int(sql("SELECT count(*) FROM financial_alerts WHERE context->>'union_id'='"+uid(100)+"'"))==1
    second=sweep(20,200)
    assert second['signals']==1 and int(sql('SELECT count(*) FROM financial_alerts'))==1
    refusal=sql(caller(20,f"SELECT fn_union_integrity_sweep('{uid(100)}',24);"),1)
    assert 'not_authorised' in refusal
    result={'observed_at':sql('SELECT clock_timestamp()'),'postgres_version':sql('SHOW server_version'),'baseline_md5':'4d64aa69476db5aa5ae5c5695dcb7b18','definitions':defs,'counterexamples':[{'case':'foreign_union_transfer_returned_to_authorized_owner','union':uid(100),'response':first},{'case':'foreign_transfer_creates_wrong_union_incident','incorrect_alert_count':1},{'case':'prior_union_suppresses_legitimate_union_incident','union':uid(200),'response':second,'total_alerts':1,'expected_total':2}],'unrelated_owner_refused':True,'production_connections':0,'production_mutations':0,'candidate_qualified':False,'scope':'Exact live sweep and real caller/overseer/auth bodies with current typed fixture columns and local roles. No delivery triggers, money moves or complete financial-provider acceptance.'}
    (out/'BASELINE.json').write_text(json.dumps(result,indent=2)+'\n')
    a=installer.index('CREATE OR REPLACE FUNCTION public.fn_union_integrity_sweep')
    opening=installer.index('$function$',a)
    z=installer.index('$function$',opening+len('$function$'))+len('$function$\n')
    candidate=installer[a:z]
    assert hashlib.md5(candidate.encode()).hexdigest()=='24d4f8cf076499a6e90f5c221a135c4a'
    sql(installer)
    checks=[]
    def check(name,condition):
        assert condition,name
        checks.append(name)
    digest="SELECT md5(pg_get_functiondef('fn_union_integrity_sweep(uuid,integer)'::regprocedure))"
    check('guarded migration installs exact candidate',sql(digest)=='24d4f8cf076499a6e90f5c221a135c4a')
    sql(installer)
    check('guarded migration replay preserves identity',sql(digest)=='24d4f8cf076499a6e90f5c221a135c4a')
    sql('TRUNCATE financial_alerts;')
    own=sweep(10,100)
    check('foreign transfer is not returned',own['direct_chip_transfer']==[] and own['signals']==0)
    check('foreign transfer creates no wrong union incident',int(sql('SELECT count(*) FROM financial_alerts'))==0)
    own_b=sweep(20,200)
    check('own union transfer remains visible',own_b['direct_chip_transfer']==first['direct_chip_transfer'])
    sql(f"INSERT INTO chip_transactions(club_id,from_user_id,to_user_id,amount,transaction_type,created_at) VALUES('{uid(101)}','{uid(32)}','{uid(33)}',11,'player_transfer',now());")
    own_a=sweep(10,100)
    check('earlier different union incident does not suppress this union',int(sql('SELECT count(*) FROM financial_alerts'))==2)
    sweep(10,100)
    check('repeat same union is deduplicated',int(sql('SELECT count(*) FROM financial_alerts'))==2)
    check('own transfer amount and identity survive',own_a['direct_chip_transfer']==[{'from_user':uid(32),'to_user':uid(33),'transfers':1,'total':11}])
    sql(f"INSERT INTO agents VALUES('{uid(32)}','{uid(201)}');")
    check('agent in another union cannot hide this union transfer',sweep(10,100)['direct_chip_transfer']==own_a['direct_chip_transfer'])
    sql(f"INSERT INTO agents VALUES('{uid(32)}','{uid(101)}');")
    check('same club agent transfer keeps established exclusion',sweep(10,100)['direct_chip_transfer']==[])
    sql('TRUNCATE agents,chip_transactions,financial_alerts;')
    for union,club,table,tournament in [(100,101,300,400),(200,201,301,401)]:
        sql(f"INSERT INTO tables VALUES('{uid(table)}','{uid(union)}','{uid(club)}'); INSERT INTO tournaments VALUES('{uid(tournament)}','{uid(union)}','{uid(club)}');")
    sql(f"INSERT INTO club_members VALUES('{uid(101)}','{uid(40)}','member','active','{uid(50)}');")
    sql(f"INSERT INTO wallet_transactions(user_id,amount,type,category,created_at,table_id) VALUES('{uid(40)}',100,'credit','cashout',now(),'{uid(301)}');")
    check('shared player foreign cash result does not enter this union report',sweep(10,100)['agent_roster_winning']==[])
    sql(f"INSERT INTO wallet_transactions(user_id,amount,type,category,created_at,related_entity_id) VALUES('{uid(40)}',100,'credit','prize',now(),'{uid(401)}');")
    check('foreign tournament result does not enter this union report',sweep(10,100)['agent_roster_winning']==[])
    sql(f"INSERT INTO wallet_transactions(user_id,amount,type,category,created_at,table_id) VALUES('{uid(40)}',30,'credit','cashout',now(),'{uid(300)}');")
    flags=sweep(10,100)['agent_roster_winning']
    check('own cash signal retained with exact amount',len(flags)==1 and flags[0]['player_net']==30)
    sql(f"INSERT INTO rake_records(rake_amount,player_contributions,created_at,club_id,table_id) VALUES(1000,'{{\"{uid(40)}\":1}}',now(),'{uid(201)}','{uid(301)}');")
    check('foreign rake does not hide own cash signal',sweep(10,100)['agent_roster_winning']==flags)
    sql(f"INSERT INTO rake_records(rake_amount,player_contributions,created_at,club_id,table_id) VALUES(1000,'[]',now(),'{uid(201)}','{uid(301)}');")
    check('malformed foreign rake is not parsed',sweep(10,100)['agent_roster_winning']==flags)
    sql(f"INSERT INTO wallet_transactions(user_id,amount,type,category,created_at,related_entity_id) VALUES('{uid(40)}',20,'credit','prize',now(),'{uid(400)}');")
    flags=sweep(10,100)['agent_roster_winning']
    check('own tournament result remains attributed',len(flags)==1 and flags[0]['player_net']==50)
    sql(f"INSERT INTO tables VALUES('{uid(302)}','{uid(200)}','{uid(101)}'); INSERT INTO tournaments VALUES('{uid(402)}','{uid(200)}','{uid(101)}');")
    sql(f"INSERT INTO wallet_transactions(user_id,amount,type,category,created_at,table_id) VALUES('{uid(40)}',888,'credit','cashout',now(),'{uid(302)}');")
    check('explicit foreign table union overrides conflicting club attribution',sweep(10,100)['agent_roster_winning']==flags)
    sql(f"INSERT INTO wallet_transactions(user_id,amount,type,category,created_at,related_entity_id) VALUES('{uid(40)}',777,'credit','prize',now(),'{uid(402)}');")
    check('explicit foreign tournament union overrides conflicting club attribution',sweep(10,100)['agent_roster_winning']==flags)
    sql(f"INSERT INTO wallet_transactions(user_id,amount,type,category,created_at,table_id,related_entity_id) VALUES('{uid(40)}',666,'credit','cashout',now(),'{uid(303)}','{uid(400)}');")
    check('unknown nonnull table identity cannot borrow a tournament identity',sweep(10,100)['agent_roster_winning']==flags)
    sql(f"INSERT INTO rake_records(rake_amount,player_contributions,created_at,club_id,table_id) VALUES(1000,'{{\"{uid(40)}\":1}}',now(),'{uid(101)}','{uid(302)}');")
    check('explicit foreign rake event cannot borrow club attribution',sweep(10,100)['agent_roster_winning']==flags)
    sql(f"INSERT INTO clubs VALUES('{uid(102)}','{uid(10)}',false); INSERT INTO union_clubs VALUES('{uid(100)}','{uid(102)}'); INSERT INTO club_members VALUES('{uid(102)}','{uid(40)}','member','active','{uid(50)}');")
    check('same player and agent across member clubs are not multiplied',sweep(10,100)['agent_roster_winning']==flags)
    sql(f"INSERT INTO rake_records(rake_amount,player_contributions,created_at,club_id,table_id) VALUES(1,'{{\"{uid(40)}\":1}}',now(),'{uid(101)}','{uid(300)}');")
    check('own rake share remains counted',sweep(10,100)['agent_roster_winning'][0]['rake_generated']==1)
    sql(f"INSERT INTO clubs VALUES('{uid(100)}','{uid(10)}',true); INSERT INTO chip_transactions(club_id,from_user_id,to_user_id,amount,transaction_type,created_at) VALUES('{uid(100)}','{uid(32)}','{uid(33)}',9,'player_transfer',now());")
    check('union host club transaction remains visible',sweep(10,100)['direct_chip_transfer'][0]['total']==9)
    refusal=sql(caller(20,f"SELECT fn_union_integrity_sweep('{uid(100)}',24);"),1)
    check('unrelated owner still refused','not_authorised' in refusal)
    check('null union refused','union identity is required' in sql(caller(10,'SELECT fn_union_integrity_sweep(NULL,24);'),1))
    check('anonymous role cannot execute',sql("SELECT has_function_privilege('anon','fn_union_integrity_sweep(uuid,integer)','EXECUTE')")=='f')
    check('anonymous request cannot inherit engine authority','not_authorised' in sql("SET request.jwt.claims='{\"role\":\"anon\"}';SELECT fn_union_integrity_sweep('"+uid(100)+"',24);",1))
    # Two real transactions hold the same reporting window concurrently.
    sql('TRUNCATE financial_alerts;')
    a=pending('BEGIN;'+caller(10,f"SELECT fn_union_integrity_sweep('{uid(100)}',24);"))
    a.stdout.readline();check('first concurrent report succeeds',json.loads(a.stdout.readline())['signals']>0)
    b=pending("BEGIN;SET statement_timeout='3s';SET application_name='union-scope-native-b';"+caller(10,f"SELECT fn_union_integrity_sweep('{uid(100)}',24);"))
    lock_seen=False
    for _ in range(50):
        if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='union-scope-native-b' AND wait_event='advisory'")=='1':lock_seen=True;break
        time.sleep(0.02)
    check('second reporter waits on actual shared union advisory claim',lock_seen)
    finish(a);finish(b)
    check('concurrent same union creates one incident',int(sql('SELECT count(*) FROM financial_alerts'))==1)
    sql('TRUNCATE financial_alerts;')
    a=pending('BEGIN;'+caller(10,f"SELECT fn_union_integrity_sweep('{uid(100)}',24);"))
    a.stdout.readline();a.stdout.readline()
    finish(a,False)
    check('rollback removes incident',int(sql('SELECT count(*) FROM financial_alerts'))==0)
    sweep(10,100)
    check('report after rollback can acquire claim and write',int(sql('SELECT count(*) FROM financial_alerts'))==1)
    sql('TRUNCATE financial_alerts;')
    sql(f"INSERT INTO chip_transactions(club_id,from_user_id,to_user_id,amount,transaction_type,created_at) VALUES('{uid(201)}','{uid(30)}','{uid(31)}',23,'player_transfer',now());")
    a=pending('BEGIN;'+caller(10,f"SELECT fn_union_integrity_sweep('{uid(100)}',24);"))
    a.stdout.readline();a.stdout.readline()
    other=json.loads(sql("SET statement_timeout='1s';"+caller(20,f"SELECT fn_union_integrity_sweep('{uid(200)}',24);")).splitlines()[-1])
    check('different union report proceeds while first union transaction is held',other['signals']>0)
    finish(a)
    check('independent concurrent unions each retain incident',int(sql('SELECT count(*) FROM financial_alerts'))==2)
    # A real PostgreSQL trigger refusal must leave no success-shaped residue.
    sql('TRUNCATE financial_alerts;')
    sql("CREATE FUNCTION native_alert_refusal() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'native alert refusal';END$$; CREATE TRIGGER native_alert_refusal BEFORE INSERT ON financial_alerts FOR EACH ROW EXECUTE FUNCTION native_alert_refusal();")
    check('failed incident insert propagates failure','native alert refusal' in sql(caller(10,f"SELECT fn_union_integrity_sweep('{uid(100)}',24);"),1))
    check('failed report does not leave incident',int(sql('SELECT count(*) FROM financial_alerts'))==0)
    sql('DROP TRIGGER native_alert_refusal ON financial_alerts;')
    sweep(10,100)
    check('retry after actual trigger refusal writes once',int(sql('SELECT count(*) FROM financial_alerts'))==1)
    # Installing against changed authorization or an unknown function is refused.
    originals={r['signature']:r['definition'] for r in json.loads((base/'definitions.json').read_text())}
    for signature,declaration in [('fn_caller_is_engine()', 'fn_caller_is_engine()'),('fn_is_union_overseer(uuid,uuid)','fn_is_union_overseer(p_union_id uuid,p_user_id uuid)')]:
        sql('CREATE OR REPLACE FUNCTION '+declaration+' RETURNS boolean LANGUAGE sql AS $$SELECT true$$;')
        check(signature+' drift refuses migration','union integrity caller authority drift' in sql(installer,1))
        check(signature+' refusal leaves candidate untouched',sql(digest)=='24d4f8cf076499a6e90f5c221a135c4a')
        sql(originals[signature])
    sql("CREATE OR REPLACE FUNCTION fn_union_integrity_sweep(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid,p_hours integer DEFAULT 24) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;")
    unknown=sql(digest)
    check('unknown sweep definition refuses migration','union integrity definition drift' in sql(installer,1))
    check('unknown definition retained after refusal',sql(digest)==unknown)
    result.update({'candidate_md5':hashlib.md5(candidate.encode()).hexdigest(),'candidate_qualified':True,'candidate_checks':checks,'candidate_check_count':len(checks),'limitations':'Native scoped read, PostgreSQL concurrency, rollback, caller authority and drift-safe migration fixture. Production notification fanout and release verification are separate; no financial-provider or overall task acceptance.'})
    (out/'RESULTS.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'baseline_counterexamples':3,'candidate_checks':len(checks),'production_mutations':0}))
except BaseException as error:
    (out/'FAILURE.json').write_text(json.dumps({'error':str(error),'production_connections':0},indent=2)+'\n')
    raise
finally:
    for child in children:
        if child.poll() is None: child.kill();child.wait()
    if started: run([pg/'pg_ctl','-D',root/'data','-m','fast','-w','stop'])
    shutil.rmtree(root)
