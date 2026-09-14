"""Native regression for received last-place remainder false alert6550."""
import argparse
import json
import os
from pathlib import Path
import re
import select
import shutil
import subprocess
import tempfile
import uuid

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
a.output.mkdir(parents=True, exist_ok=False)
repo = Path(__file__).resolve().parents[2]
migrations = repo/'supabase/migrations'
pattern = re.compile(r'CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_payout_guarantee_check\s*\([\s\S]*?AS\s+\$function\$[\s\S]*?\$function\$;', re.I)
def definition(name):
    matches = pattern.findall((migrations/name).read_text())
    assert len(matches) == 1, name
    return matches[0]
baseline = definition('20260901195005_the_guarantee_check_reconciles_the_bounty_pool_too.sql')
direct_versions = [(f.name, pattern.findall(f.read_text())) for f in sorted(migrations.glob('*.sql'))]
direct_versions = [(name, matches) for name, matches in direct_versions if matches]
current_name, current_matches = direct_versions[-1]
assert current_name == '20260907163820_a_pool_that_is_fully_paid_has_nobody_left_to_pay.sql', f'Review newer guarantee definition: {current_name}'
assert len(current_matches) == 1, 'Ambiguous current guarantee definition'
current = current_matches[0]
# Only this guarded function-specific block is run, never the surrounding
# historical migration or its financial writers.
patch_source = (migrations/'20260914111709_a_diamond_bounty_is_paid_from_its_own_bank.sql').read_text()
start = patch_source.index('-- 6d. fn_payout_guarantee_check:')
patch_start = patch_source.index('DO $m$', start)
patch_end = patch_source.index('END $m$;', patch_start) + len('END $m$;')
current_patch = patch_source[patch_start:patch_end]
pg = Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
assert shutil.disk_usage(tempfile.gettempdir()).free > 2*1024**3
cluster = Path(tempfile.mkdtemp(prefix='remainder-alert-'))
sock = cluster/'sock'; sock.mkdir()
env = {k:v for k,v in os.environ.items() if not k.startswith('PG')}; env['LC_ALL']='C'
psql = [str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(sock),'-p','55795','-U','postgres','-d','postgres']
started=False; children=[]; checks=[]
pcts=[26.64,19.18,13.81,9.94,7.16,5.15,3.71,2.67,1.92,.85,.82,.8,.77,.75,.73,.71,.68,.66,.64,.62,.61,.59,.59]
cents=[35964,25893,18644,13419,9666,6953,5009,3605,2592,1148,1107,1080,1040,1013,986,959,918,891,864,837,824,797,791]
def run(command, source=None):
    r=subprocess.run(list(map(str,command)),input=source,text=True,capture_output=True,env=env,timeout=25)
    if r.returncode: raise RuntimeError(r.stderr)
    return r.stdout.strip()
def sql(source): return run(psql,source)
def uid(i): return str(uuid.UUID(int=i))
def check(name, condition):
    assert condition,name
    checks.append(name)
def reset():
    sql('TRUNCATE tournaments,tournament_players,wallet_transactions,tournament_payouts,poker_diamond_tournament_ledger,financial_alerts;')
    structure=json.dumps([{'place':i+1,'percentage':v} for i,v in enumerate(pcts)])
    sql(f"INSERT INTO tournaments VALUES('{uid(1)}','native remainder','{uid(2)}','MTT',now()-interval '1 day',1350,0,'freezeout','{structure}','COMPLETED',0);")
    sql(f"INSERT INTO tournament_players SELECT '{uid(1)}',lpad(to_hex(n),32,'0')::uuid,n FROM generate_series(1,150)n;")
    for i,c in enumerate(cents,1):
        sql(f"INSERT INTO wallet_transactions VALUES('{uid(1)}','{uid(i)}',{c}/100.0,'credit','prize'); INSERT INTO tournament_payouts VALUES('{uid(1)}','structure',{c}/100.0);")
def check_run(): return json.loads(sql('SELECT fn_payout_guarantee_check(7);'))
def open_count(): return sql("SELECT count(*) FROM financial_alerts WHERE NOT resolved AND context->>'kind'='earner_not_paid';")
def erase_last(): sql(f"DELETE FROM wallet_transactions WHERE user_id='{uid(23)}';")
try:
    check('PostgreSQL17','PostgreSQL) 17.' in run([pg/'postgres','--version']))
    run([pg/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    run([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'log','-o',f"-k {sock} -p 55795 -c listen_addresses='' -c timezone=UTC -c shared_buffers=16MB -c max_connections=6",'-w','start']); started=True
    sql('''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE tournaments(id uuid PRIMARY KEY,name text,club_id uuid,tournament_type text,ended_at timestamptz,prize_pool numeric,satellite_seats integer,variant text,payout_structure text,status text,bounty_pool numeric);
    CREATE TABLE tournament_players(tournament_id uuid,user_id uuid,position integer);
    CREATE TABLE wallet_transactions(related_entity_id uuid,user_id uuid,amount numeric,type text,category text);
    CREATE TABLE tournament_payouts(tournament_id uuid,source text,amount numeric);
    CREATE TABLE poker_diamond_tournament_ledger(tournament_id uuid,kind text,amount numeric);
    CREATE TABLE financial_alerts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),severity text,source text,message text,context jsonb,resolved boolean DEFAULT false,created_at timestamptz DEFAULT now(),resolved_at timestamptz,resolution text);''')
    sql(baseline);reset(); before=check_run()
    check('original checker falsely reports exactly one earner',before['earners_not_paid']==1 and open_count()=='1')
    check('original false shortage is exactly six cents',sql("SELECT context->>'short' FROM financial_alerts WHERE context->>'kind'='earner_not_paid';")=='0.06')
    sql(current);sql(current_patch)
    digest=sql("SELECT md5(pg_get_functiondef('fn_payout_guarantee_check(integer)'::regprocedure));")
    check('actual repository definition and guarded patch match current production',digest=='7c57c1a27ae394f67010bf5f54cdab27')
    result=check_run()
    check('installed root correction clears this exact false alert',result['earners_not_paid']==0 and result['alerts_cleared']==1 and open_count()=='0')
    check('remainder difference remains visible in the checker result',result['short_of_structure_but_pool_distributed']==1)
    check('repeat does not raise or repeatedly resolve an alert',check_run()['alerts_raised']==0 and check_run()['alerts_cleared']==0)
    check('full pool and23actual payments are preserved',sql("SELECT sum(amount)=1350 AND count(*)=23 FROM wallet_transactions WHERE category='prize';")=='t')
    reset();erase_last();result=check_run()
    check('an unpaid last place with undistributed pool still raises a critical',result['earners_not_paid']==1 and open_count()=='1')
    sql(f"INSERT INTO wallet_transactions VALUES('{uid(2)}','{uid(23)}',7.91,'credit','prize');")
    check('another tournament payment cannot clear this player',check_run()['alerts_cleared']==0 and open_count()=='1')
    sql(f"INSERT INTO wallet_transactions VALUES('{uid(1)}','{uid(23)}',7.91,'credit','refund');")
    check('a refund does not masquerade as a paid prize',check_run()['alerts_cleared']==0 and open_count()=='1')
    sql(f"INSERT INTO wallet_transactions VALUES('{uid(1)}','{uid(23)}',1,'credit','prize');")
    check('partial payment leaves the actual shortage open',check_run()['alerts_cleared']==0 and open_count()=='1')
    sql(f"INSERT INTO wallet_transactions VALUES('{uid(1)}','{uid(23)}',6.91,'credit','prize');")
    check('completed exact remaining payment clears its existing alert',check_run()['alerts_cleared']==1 and open_count()=='0')
    reset();erase_last();check_run()
    child=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env);children.append(child)
    child.stdin.write(f"BEGIN;INSERT INTO wallet_transactions VALUES('{uid(1)}','{uid(23)}',7.91,'credit','prize');SELECT 'ready';\n");child.stdin.flush()
    assert select.select([child.stdout],[],[],10)[0], 'Concurrent fixture credit did not acknowledge'
    assert child.stdout.readline().strip()=='ready'
    check('uncommitted receipt cannot close an unpaid alert',check_run()['alerts_cleared']==0 and open_count()=='1')
    child.stdin.write('ROLLBACK;\n');child.stdin.close();child.stdin=None
    _,err=child.communicate(timeout=5);assert child.returncode==0,err
    check('rolled-back receipt cannot close an unpaid alert',check_run()['alerts_cleared']==0 and open_count()=='1')
    sql(f"INSERT INTO wallet_transactions VALUES('{uid(1)}','{uid(23)}',7.91,'credit','prize');")
    check('committed exact receipt clears this case',check_run()['alerts_cleared']==1)
    sql('REVOKE ALL ON FUNCTION fn_payout_guarantee_check(integer) FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION fn_payout_guarantee_check(integer) TO service_role;')
    check('service role can run actual checker',json.loads(sql('SET ROLE service_role;SELECT fn_payout_guarantee_check(7);'))['earners_not_paid']==0)
    result={'checks':checks,'check_count':len(checks),'current_md5':digest,'production_connections':0,'financial_writers_invoked':0,'scope':'Exact remainder false alert and notification transitions; not general entitlement or payout certification.'}
    (a.output/'RESULTS.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:result[k] for k in ['check_count','current_md5','production_connections','financial_writers_invoked']}))
finally:
    for child in children:
        if child.poll() is None: child.kill();child.wait()
    if started:run([pg/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
    shutil.rmtree(cluster)
