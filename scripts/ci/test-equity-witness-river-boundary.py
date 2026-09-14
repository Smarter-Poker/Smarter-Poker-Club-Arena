"""Run the actual EV witness before and after the guarded river-boundary patch.

Only an owned, isolated PostgreSQL 17 cluster is used. Minimal tables qualify
the real full audit function and its ACL; financial authorities are never
installed or invoked. Captured action/stage projections preserve three exact
reported counterexamples without private player or card data.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
repo = Path(__file__).resolve().parents[2]
baseline = (repo/'supabase/migrations/20260908204006_stats_witness_checks_showdown_without_money_reconstruction.sql').read_text()
patch = (repo/'supabase/migrations/20260914135120_equity_witness_river_shove_preserves_prior_betting.sql').read_text()
recorded = json.loads((repo/'scripts/ci/probes/equity-witness-river-betting-cases.json').read_text())
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
assert shutil.disk_usage(tempfile.gettempdir()).free > 2*1024**3
cluster = Path(tempfile.mkdtemp(prefix='equity-witness-'))
sock = cluster/'sock'
sock.mkdir()
env = {k:v for k,v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
psql = [str(pg/'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(sock), '-p', '55797', '-U', 'postgres', '-d', 'postgres']
started = False
checks = []
serial = 0

def run(cmd, source=None, expected=0):
    result = subprocess.run(list(map(str,cmd)), input=source, text=True,
                            capture_output=True, env=env, timeout=30)
    if result.returncode != expected:
        raise AssertionError(result.stderr)
    return result.stdout.strip()

def sql(source):
    return run(psql,source)

def check(name, ok):
    assert ok, name
    checks.append(name)

def literal(value):
    return "'"+json.dumps(value).replace("'","''")+"'::jsonb"

def hand(actions, street='turn', equity=None, history=True, old=False):
    global serial
    serial += 1
    hid = str(uuid.UUID(int=serial))
    if history:
        action_sql = 'NULL' if actions is None else literal(actions)
        sql(f"INSERT INTO hand_history VALUES('{hid}',now()-interval '3 minutes',0,'[]',{action_sql},'[]',false)")
    value = 'NULL' if equity is None else str(equity)
    stage = 'NULL' if street is None else "'"+street+"'"
    age = '8 days' if old else '3 minutes'
    sql(f"INSERT INTO ca_hand_facts VALUES('{hid}','{str(uuid.UUID(int=10000+serial))}',true,true,{stage},now()-interval '{age}',{value})")
    return hid

def reset():
    sql("TRUNCATE hand_history,ca_hand_facts,ca_stats_witness_audit_log,ca_hand_player_stat,ca_hand_player_idx,profiles")

def audit():
    return json.loads(sql("SET ROLE service_role; SELECT ca_stats_witness_audit(10,90)"))

def coverage():
    x=audit()
    return [x['allin_showdown_7d'],x['allin_showdown_without_equity_7d']]

def act(action, stage='turn'):
    return {'action':action,'stage':stage}

def rejected(source, message):
    r=subprocess.run(psql,input=source,text=True,capture_output=True,env=env,timeout=20)
    check(message,r.returncode!=0)

try:
    run([pg/'initdb','-D',cluster/'data','-U','postgres','--auth=trust','--no-locale'])
    with (cluster/'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(sock)+"'\nport=55797\nshared_buffers='16MB'\nmax_connections=6\nstatement_timeout='15s'\nlock_timeout='2s'\n")
    run([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'postgres.log','-w','start'])
    started=True
    sql("""
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE hand_history(id uuid PRIMARY KEY,created_at timestamptz,button_seat int,players jsonb,actions jsonb,showdown jsonb,has_human boolean);
    CREATE TABLE ca_hand_facts(hand_id uuid,user_id uuid,was_all_in boolean,went_to_showdown boolean,all_in_street text,played_at timestamptz,all_in_equity numeric);
    CREATE TABLE ca_hand_player_stat(hand_id uuid);
    CREATE TABLE ca_hand_player_idx(hand_id uuid,user_id uuid);
    CREATE TABLE profiles(id uuid,is_horse boolean);
    CREATE TABLE ca_hand_player_idx_state(id boolean,idx_ceil timestamptz);
    CREATE TABLE ca_hand_player_stat_repair_state(id boolean,done boolean);
    INSERT INTO ca_hand_player_idx_state VALUES(true,now());
    INSERT INTO ca_hand_player_stat_repair_state VALUES(true,true);
    CREATE TABLE ca_stats_witness_audit_log(
      id bigserial PRIMARY KEY,ran_at timestamptz DEFAULT now(),window_from timestamptz,window_to timestamptz,
      hands int,player_hands int,hands_with_posts int,button_disagree int,showdown_disagree int,
      hands_without_stat int,player_hands_without_idx int,human_player_hands int,human_without_facts int,
      allin_showdown_7d int,allin_showdown_without_equity_7d int,idx_lag_seconds numeric,repair_done boolean,duration_ms int);
    """)
    sql(baseline)
    check('tracked baseline equals live definition',sql("SELECT md5(pg_get_functiondef('ca_stats_witness_audit(integer,integer)'::regprocedure))")=='3b3b9610697ea648ee94808ff7ca91b7')
    for row in recorded:
        reset()
        for street in row['streets']: hand(row['actions'],street)
        check('baseline reproduces false missing '+row['hand_id'],coverage()==[1,1])
    sql(patch)
    check('guarded postimage exact',sql("SELECT md5(pg_get_functiondef('ca_stats_witness_audit(integer,integer)'::regprocedure))")=='94b0da0dd3428b42595186266d75ff8b')
    for row in recorded:
        reset()
        for street in row['streets']: hand(row['actions'],street)
        check('river cannot mask prior betting '+row['hand_id'],coverage()==[0,0])

    cases=[
      ('genuine turn runout remains missing',[act('all_in'),act('call')],'turn',None,True,False,[1,1]),
      ('genuine preflop runout remains missing',[act('all_in','preflop'),act('call','preflop')],'preflop',None,True,False,[1,1]),
      ('genuine flop runout remains missing',[act('all_in','flop'),act('call','flop')],'flop',None,True,False,[1,1]),
      ('legacy allin spelling',[act('allin'),act('call')],'turn',None,True,False,[1,1]),
      ('recorded equity remains covered',[act('all_in'),act('call')],'turn',.75,True,False,[1,0]),
      ('river only remains excluded',[act('all_in','river'),act('call','river')],'river',None,True,False,[0,0]),
      ('sidepot without later shove remains excluded',[act('all_in','flop'),act('bet'),act('call')],'flop',None,True,False,[0,0]),
      ('later nonriver allin still forms a runout',[act('all_in','preflop'),act('bet','flop'),act('all_in'),act('call')],'preflop',None,True,False,[1,1]),
      ('unknown legacy stage treatment retained',[{'action':'all_in'},act('call')],'turn',None,True,False,[1,1]),
      ('pruned history remains unknown',[],'turn',None,False,False,[0,0]),
      ('empty action history remains unknown',[],'turn',None,True,False,[0,0]),
      ('null action history remains unknown',None,'turn',None,True,False,[0,0]),
      ('older than seven days excluded',[act('all_in'),act('call')],'turn',None,True,True,[0,0]),
    ]
    for name,actions,street,equity,history,old,expected in cases:
        reset(); hand(actions,street,equity,history,old)
        check(name,coverage()==expected)

    reset()
    hand([act('all_in'),act('call')])
    hand(recorded[0]['actions'])
    hand([act('all_in'),act('call')],equity=.5)
    check('mixed audit keeps genuine gap and covered hand',coverage()==[2,1])
    before=sql("SELECT md5(string_agg(row_to_json(t)::text,'' ORDER BY hand_id::text)) FROM ca_hand_facts t")
    audit()
    check('audit never rewrites original facts',before==sql("SELECT md5(string_agg(row_to_json(t)::text,'' ORDER BY hand_id::text)) FROM ca_hand_facts t"))
    check('audit writes its actual log',sql("SELECT count(*)>=2 FROM ca_stats_witness_audit_log")=='t')
    check('actual log matches returned counts',sql("SELECT allin_showdown_7d=2 AND allin_showdown_without_equity_7d=1 FROM ca_stats_witness_audit_log ORDER BY id DESC LIMIT 1")=='t')
    for role in ['anon','authenticated']:
        rejected(f"SET ROLE {role}; SELECT ca_stats_witness_audit()",role+' denied')
    sql(patch)
    check('migration replay preserves exact body',sql("SELECT md5(pg_get_functiondef('ca_stats_witness_audit(integer,integer)'::regprocedure))")=='94b0da0dd3428b42595186266d75ff8b')
    sql("GRANT EXECUTE ON FUNCTION ca_stats_witness_audit(integer,integer) TO authenticated")
    rejected(patch,'ACL drift refused before replacement')
    sql("REVOKE EXECUTE ON FUNCTION ca_stats_witness_audit(integer,integer) FROM authenticated")
    sql("ALTER FUNCTION ca_stats_witness_audit(integer,integer) SET search_path=public,pg_temp")
    rejected(patch,'definition or settings drift refused')
    result={'checks':checks,'passed':len(checks),'production_writes':False,'scope':'actual full audit on minimal isolated tables; no payment or engine execution'}
    (args.output/'results.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))
finally:
    if started: subprocess.run([str(pg/'pg_ctl'),'-D',str(cluster/'data'),'-m','immediate','-w','stop'],capture_output=True,env=env,timeout=20)
    if (cluster/'postgres.log').exists(): shutil.copyfile(cluster/'postgres.log',args.output/'postgres.log')
    shutil.rmtree(cluster)

