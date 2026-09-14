"""Exercise actual conservation definitions against native PostgreSQL 17 fixtures."""
import argparse
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import uuid

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--fixture', type=Path, required=True)
p.add_argument('--candidate', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
a.output.mkdir(parents=True, exist_ok=False)
fixture = json.loads(a.fixture.read_text())
candidate = a.candidate.read_text()
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
assert shutil.disk_usage(tempfile.gettempdir()).free > 2 * 1024**3
cluster = Path(tempfile.mkdtemp(prefix='conservation-native-'))
sock = cluster / 'sock'
sock.mkdir()
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
psql = [str(pg/'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(sock), '-p', '55794', '-U', 'postgres', '-d', 'postgres']
started = False
children = []
checks = []

def run(command, source=None):
    r = subprocess.run(list(map(str, command)), input=source, text=True, capture_output=True, env=env, timeout=25)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()

def sql(source):
    return run(psql, source)

def uid(i):
    return str(uuid.UUID(int=i))

def check(name, good):
    assert good, name
    checks.append(name)

def delta():
    return sql(f"SELECT public.fn_tournament_conservation_delta('{uid(1)}');")

def reset():
    sql('TRUNCATE tournaments,wallet_transactions,rake_records,chip_ledger,tournament_guarantee_overlays,tournament_conservation_baseline,tournament_payouts,tournament_satellite_awards,tournament_tickets;')
    sql(f"INSERT INTO tournaments VALUES('{uid(1)}','native event',now()-interval '1 day','COMPLETED','sng',2,0,100,'{uid(2)}',NULL); INSERT INTO wallet_transactions VALUES('{uid(1)}','{uid(4)}','debit','tournament_buyin',100,'native'); INSERT INTO wallet_transactions VALUES('{uid(1)}','{uid(4)}','credit','prize',280,'native');")

def correction(amount='180', category='correction', status='posted', from_type='union_bank', to_type='prize_liability', tournament=1, destination=1, source=3):
    entity = 'NULL' if source is None else f"'{uid(source)}'"
    sql(f"INSERT INTO chip_ledger VALUES('{uuid.uuid4()}','{uid(tournament)}','{category}','{status}','{from_type}',{entity},'{to_type}','{uid(destination)}','{amount}'::numeric);")

try:
    check('native PostgreSQL17', 'PostgreSQL) 17.' in run([pg/'postgres','--version']))
    run([pg/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    run([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'log','-o',f"-k {sock} -p 55794 -c listen_addresses='' -c timezone=UTC -c shared_buffers=16MB -c max_connections=6",'-w','start'])
    started = True
    sql('''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE tournaments(id uuid PRIMARY KEY,name text,ended_at timestamptz,status text,variant text,max_players integer,guaranteed_prize numeric,prize_pool numeric,club_id uuid,satellite_target_id uuid);
    ALTER TABLE tournaments ADD COLUMN tournament_type text DEFAULT 'MTT';
    CREATE TABLE wallet_transactions(related_entity_id uuid,user_id uuid,type text,category text,amount numeric,description text);
    CREATE TABLE rake_records(tournament_id uuid,is_tournament boolean,rake_amount numeric);
    CREATE TABLE chip_ledger(id uuid PRIMARY KEY,tournament_id uuid,category text,status text,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,amount numeric);
    CREATE TABLE tournament_guarantee_overlays(tournament_id uuid PRIMARY KEY,amount numeric);
    CREATE TABLE tournament_conservation_baseline(tournament_id uuid PRIMARY KEY,amount numeric);
    CREATE TABLE tournament_payouts(tournament_id uuid,source text,metadata jsonb,position integer,amount numeric);
    CREATE TABLE tournament_satellite_awards(tournament_id uuid,place integer,ticket_id uuid,delivery_kind text);
    CREATE TABLE tournament_tickets(id uuid PRIMARY KEY,status text);
    CREATE TABLE financial_alerts(id bigint GENERATED ALWAYS AS IDENTITY,severity text,source text,message text,context jsonb,resolved boolean,created_at timestamptz DEFAULT now());
    CREATE TABLE tournament_payout_backfill_log(tournament_id uuid PRIMARY KEY,top_up numeric,delta_before numeric,delta_after numeric);
    CREATE FUNCTION fn_tournament_payout_reconcile(uuid,boolean) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'unexpected payout-reconcile call in excluded event'; END $$;''')
    sql(fixture['baseline'])
    sql('REVOKE ALL ON FUNCTION fn_tournament_conservation_delta(uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION fn_tournament_conservation_delta(uuid) TO service_role;')
    for caller in fixture['callers']:
        sql(caller['definition'])
    check('baseline exactly matches captured production', sql("SELECT md5(pg_get_functiondef('fn_tournament_conservation_delta(uuid)'::regprocedure));") == fixture['baseline_md5'])
    reset(); correction()
    check('original missed house correction reproduces minus180', delta() == '-180.00')
    sql(candidate)
    digest = sql("SELECT md5(pg_get_functiondef('fn_tournament_conservation_delta(uuid)'::regprocedure));")
    check('posted union funding closes exact historical shortage', delta() == '0.00')
    check('zero delta cannot enter actual heads-up payment candidate reader', sql('SELECT count(*) FROM fn_hu_shortfall_candidates(100);') == '0')
    preview = json.loads(sql('SELECT fn_pay_backed_payout_shortfalls(false,500);'))
    check('actual backed-payment reader excludes repaired zero-delta event without a reconciliation call', preview['events_paid'] == 0 and preview['chips_paid'] == 0 and preview['applied'] is False)
    reset(); correction(from_type='club_treasury')
    check('posted club funding is also recognized', delta() == '0.00')
    for field, value in [('status','pending'),('status','reversed'),('from_type','player_wallet'),('to_type','player_wallet'),('category','adjustment')]:
        reset(); correction(**{field:value})
        check(f'{field}={value} cannot manufacture house funding', delta() == '-180.00')
    for value in ['0','-180','NaN','Infinity','-Infinity']:
        reset(); correction(amount=value)
        check(f'invalid funding amount {value} cannot erase deficit', delta() == '-180.00')
    for params in [{'tournament':2},{'destination':2},{'source':None},{'source':1}]:
        reset(); correction(**params)
        check(f'incomplete or wrong ledger identity {params} cannot fund event', delta() == '-180.00')
    reset(); correction(); sql(f"UPDATE wallet_transactions SET amount=300 WHERE type='credit';")
    check('additional genuine20chip overpayment remains negative', delta() == '-20.00')
    reset(); correction(amount='100'); correction(amount='80')
    check('distinct actual house funding transfers sum', delta() == '0.00')
    reset(); correction(); sql(f"INSERT INTO tournament_guarantee_overlays VALUES('{uid(1)}',180);")
    check('legacy side-table record of same funding is never double-counted', delta() == '0.00')
    reset(); correction(); correction(amount='20',category='overlay'); sql("UPDATE wallet_transactions SET amount=300 WHERE type='credit';")
    check('overlay and correction are separate real funding transfers', delta() == '0.00')
    reset(); sql(f"INSERT INTO tournament_guarantee_overlays VALUES('{uid(1)}',180);")
    check('legacy guarantee funding remains recognized', delta() == '0.00')
    reset(); sql(f"INSERT INTO tournament_conservation_baseline VALUES('{uid(1)}',180);")
    check('existing acknowledged baseline semantics remain unchanged', delta() == '0.00')
    reset(); correction(); sql("UPDATE wallet_transactions SET amount=100 WHERE type='credit';")
    check('genuine unspent house funding remains visible', delta() == '180.00')
    check('actual heads-up reader retains genuinely backed candidate', sql('SELECT delta FROM fn_hu_shortfall_candidates(100);') == '180.00')
    reset(); correction(); sql(f"INSERT INTO tournament_payouts VALUES('{uid(1)}','satellite_ticket','{{}}',1,10); INSERT INTO tournament_satellite_awards VALUES('{uid(1)}',1,'{uid(50)}','ticket'); INSERT INTO tournament_tickets VALUES('{uid(50)}','issued');")
    check('issued satellite ticket still leaves its source immediately', delta() == '-10.00')
    sql("UPDATE tournament_tickets SET status='cancelled';")
    check('cancelled ticket is excluded from seat spend', delta() == '0.00')
    reset(); correction(); sql(f"INSERT INTO tournament_payouts VALUES('{uid(7)}','satellite_ticket',jsonb_build_object('satellite_target_id','{uid(1)}'),1,10); INSERT INTO tournament_satellite_awards VALUES('{uid(7)}',1,'{uid(50)}','ticket'); INSERT INTO tournament_tickets VALUES('{uid(50)}','issued');")
    check('unredeemed ticket cannot invent target income', delta() == '0.00')
    sql("UPDATE tournament_tickets SET status='redeemed';")
    check('redeemed ticket still credits target income', delta() == '10.00')
    reset()
    child = subprocess.Popen(psql, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    children.append(child)
    child.stdin.write(f"BEGIN; INSERT INTO chip_ledger VALUES('{uid(99)}','{uid(1)}','correction','posted','union_bank','{uid(3)}','prize_liability','{uid(1)}',180); SELECT 'ready';\n")
    child.stdin.flush()
    assert select.select([child.stdout],[],[],10)[0], 'Concurrent funding acknowledgment timed out'
    assert child.stdout.readline().strip() == 'ready'
    check('uncommitted correction never becomes funding', delta() == '-180.00')
    child.stdin.write('ROLLBACK;\n'); child.stdin.close(); child.stdin = None
    _, err = child.communicate(timeout=5)
    assert child.returncode == 0, err
    check('rolled-back correction never becomes funding', delta() == '-180.00')
    correction()
    check('committed correction becomes visible', delta() == '0.00')
    check('detector remains read-only under service role', sql(f"BEGIN READ ONLY;SET LOCAL ROLE service_role;SELECT fn_tournament_conservation_delta('{uid(1)}');ROLLBACK;") == '0.00')
    check('anonymous and browser callers remain denied', sql("SELECT has_function_privilege('anon','fn_tournament_conservation_delta(uuid)','execute') OR has_function_privilege('authenticated','fn_tournament_conservation_delta(uuid)','execute');") == 'f')
    check('fixture payment tripwire and read-only calls created no alerts', sql('SELECT count(*) FROM financial_alerts;') == '0')
    sql(candidate)
    check('qualified migration replay is idempotent', delta() == '0.00')
    sql("CREATE OR REPLACE FUNCTION fn_tournament_conservation_delta(p_tournament_id uuid) RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ SELECT 123::numeric $$;")
    unknown = sql("SELECT md5(pg_get_functiondef('fn_tournament_conservation_delta(uuid)'::regprocedure));")
    try:
        sql(candidate)
        raise AssertionError('unqualified definition was overwritten')
    except RuntimeError as error:
        check('unqualified definition is refused', 'Unqualified conservation definition' in str(error))
    check('refused migration preserves unknown source', sql("SELECT md5(pg_get_functiondef('fn_tournament_conservation_delta(uuid)'::regprocedure));") == unknown)
    result = {'check_count':len(checks),'checks':checks,'candidate_md5':digest,'production_connections':0,'financial_payments':0,'scope':'Conservation funding recognition and actual excluded-candidate readers; not general financial settlement qualification.'}
    (a.output/'RESULTS.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:result[k] for k in ['check_count','candidate_md5','production_connections','financial_payments']}))
finally:
    for child in children:
        if child.poll() is None:
            child.kill(); child.wait()
    if started:
        run([pg/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
    shutil.rmtree(cluster)
