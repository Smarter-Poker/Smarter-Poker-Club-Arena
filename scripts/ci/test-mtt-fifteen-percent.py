#!/usr/bin/env python3
"""Bounded private PostgreSQL proof of the actual 15% migration; no production URL."""
import argparse
import signal
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
CAPTURE = ROOT / 'scripts/ci/fixtures/mtt-fifteen-percent-preimages.json'
MIGRATION = ROOT / 'supabase/migrations/20261029202310_all_new_mtt_tournaments_pay_the_top_fifteen_percent.sql'
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', type=Path, default=Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')))
parser.add_argument('--work-root', default=os.environ.get('TMPDIR'))
args = parser.parse_args()
PG = args.pg_bin
parent = args.work_root
if not parent:
    raise RuntimeError('An explicit owned TMPDIR is required')
folder = Path(tempfile.mkdtemp(prefix='mtt15-', dir=parent))
data = folder / 'data'
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = str(sock.getsockname()[1])
env = {k: v for k, v in os.environ.items() if not k.startswith('PG') and k not in ('DATABASE_URL', 'SUPABASE_DB_URL')}
env.update(LC_ALL='C', LANG='C', TZ='UTC')
def run(argv, sql=None, refusal=None, cleanup=False):
    result = subprocess.run([str(x) for x in argv], input=sql, text=True, capture_output=True, env=env, timeout=10 if cleanup else max(0.1,min(10,expires-time.monotonic())))
    if refusal:
        assert result.returncode and refusal in result.stderr, (refusal, result.stderr)
    elif result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()
def sql(text, refusal=None):
    return run([PG/'psql', '-X', '-qAt', '-h', '127.0.0.1', '-p', port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], text, refusal)
def require(value, label):
    if not value:
        raise AssertionError(label)
    print('MTT15 PASS: ' + label, flush=True)
def interrupted(signum, _frame):
    raise InterruptedError('private MTT proof interrupted: ' + str(signum))
for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(signum, interrupted)
expires = time.monotonic() + 40
started = False
try:
    require(' 17.' in run([PG/'postgres', '--version']), 'PostgreSQL 17')
    run([PG/'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=trust', '--no-locale', '-E', 'UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses='127.0.0.1'\nunix_socket_directories=''\nport="+port+"\nfsync=off\n")
    run([PG/'pg_ctl', '-D', data, '-l', folder/'server.log', '-w', 'start'])
    started = True
    capture = json.loads(CAPTURE.read_text())['functions']
    candidate = MIGRATION.read_text()
    sql("CREATE TABLE ca_declared_money_triggers(table_name text,trigger_name text,note text); INSERT INTO ca_declared_money_triggers VALUES('tournaments','ca_mtt_payout_depth_guard','Historical 12.5%');")
    sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE TABLE clubs(id uuid,union_id uuid,asset text); CREATE TABLE tournaments(id int PRIMARY KEY,tournament_type text,variant text,satellite_target_id uuid,satellite_target uuid,is_premium_spin boolean,prize_pool_finalized boolean,club_id uuid,union_id uuid,is_xmtt boolean,payout_depth_percent numeric,payout_percent smallint);')
    for item in capture:
        require(hashlib.md5(item['definition'].encode()).hexdigest() == item['md5'], 'captured preimage ' + item['signature'])
        require(candidate.count(item['postimage']) == (1 if item['security_definer'] else 0), 'actual migration binds postimage ' + item['signature'])
        sql(item['definition'] + '; REVOKE ALL ON FUNCTION public.' + item['signature'] + ' FROM PUBLIC;')
        for right in item['acl'].strip('{}').split(','):
            role = right.split('=')[0]
            if role != 'postgres':
                sql('GRANT EXECUTE ON FUNCTION public.'+item['signature']+' TO '+role+';')
    sql('CREATE TRIGGER ca_mtt_payout_depth_guard BEFORE INSERT OR UPDATE OF payout_depth_percent,payout_percent ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_mtt_payout_depth_guard(); INSERT INTO tournaments(id,tournament_type,variant,prize_pool_finalized,payout_depth_percent) VALUES(1,\'MTT\',\'nlh\',true,12.5);')
    require(sql('SELECT payout_depth_percent FROM tournaments WHERE id=1') == '12.5', 'original source reproduces 12.5 depth')
    sql('SET ROLE authenticated; ' + candidate, refusal='permission denied for schema public')
    sql(candidate.replace('\nCOMMIT;', '\nROLLBACK;'))
    require(sql("SELECT md5(pg_get_functiondef('fn_ca_mtt_payout_depth_guard()'::regprocedure))") == next(x['md5'] for x in capture if x['security_definer']), 'rollback preserves original authority')
    sql("ALTER FUNCTION fn_ca_mtt_payout_depth_guard() SET work_mem='1MB';")
    sql(candidate, refusal='MTT_FIFTEEN_PREIMAGE_DRIFT')
    require(sql("SELECT md5(pg_get_functiondef('fn_ca_effective_payout_depth(numeric,smallint)'::regprocedure))") == capture[0]['md5'], 'authority drift refuses before any replacement')
    sql('ALTER FUNCTION fn_ca_mtt_payout_depth_guard() RESET work_mem;')
    sql(candidate)
    sql(candidate, refusal='MTT_FIFTEEN_PREIMAGE_DRIFT')
    for item in capture:
        require(sql("SELECT md5(pg_get_functiondef('public."+item['signature']+"'::regprocedure))") == item['postimage_md5'], 'installed exact postimage ' + item['signature'])
        require(set(sql("SELECT proacl::text FROM pg_proc WHERE oid='public."+item['signature']+"'::regprocedure").strip('{}').split(',')) == set(item['acl'].strip('{}').split(',')), 'preserved rights ' + item['signature'])
    sql("UPDATE tournaments SET payout_depth_percent=15 WHERE id=1;")
    require(sql('SELECT payout_depth_percent FROM tournaments WHERE id=1') == '12.5', 'already finalized prize ladder stays booked')
    for index, depth in enumerate(('NULL', '10', '12.5', '15', '20', '100', '-1'), 2):
        sql(f"INSERT INTO tournaments(id,tournament_type,variant,payout_depth_percent,payout_percent) VALUES({index},'MTT','nlh',{depth},10);")
        require(sql(f'SELECT payout_depth_percent FROM tournaments WHERE id={index}') == '15', 'all MTT creation requests become fifteen: ' + depth)
    for index, variant in enumerate(('spin', 'sng', 'satellite'), 20):
        sql(f"INSERT INTO tournaments(id,tournament_type,variant,payout_depth_percent,payout_percent) VALUES({index},'MTT','{variant}',20,20);")
        require(sql(f'SELECT payout_depth_percent IS NULL AND payout_percent=20 FROM tournaments WHERE id={index}') == 't', 'separate contract preserved: ' + variant)
    for index, target_column in enumerate(('satellite_target_id','satellite_target'), 30):
        sql(f"INSERT INTO tournaments(id,tournament_type,variant,{target_column},payout_depth_percent,payout_percent) VALUES({index},'MTT','nlh',md5('target')::uuid,20,20);")
        require(sql(f'SELECT payout_depth_percent IS NULL AND payout_percent=20 FROM tournaments WHERE id={index}') == 't', 'target-linked satellite contract preserved: ' + target_column)
    for field, places in ((0,0),(1,1),(6,1),(7,2),(8,2),(9,2),(16,3),(17,3),(100,15),(137,21),(315,48),(1000,150)):
        value = json.loads(sql(f'SELECT fn_ca_payout_structure({field},15::numeric)'))
        require(len(value) == places and (not value or round(sum(x['percentage'] for x in value),2) == 100), 'rounded paid field and conserved 100%: ' + str(field))
    require(sql('SELECT fn_ca_effective_payout_depth(12.5,NULL::smallint)=12.5 AND fn_ca_effective_payout_depth(NULL,NULL::smallint)=12.5') == 't', 'generic legacy defaults and explicit historical depths stay intact')
    # Reprice only unfinalized fixtures using the captured real provisional and
    # committed-terms authorities. Existing unrelated tournament triggers are
    # not reproduced by this focused world; required financial CI still runs.
    sql("DROP TABLE tournaments CASCADE; CREATE TABLE tournaments(id uuid PRIMARY KEY,tournament_type text,variant text,satellite_target_id uuid,satellite_target uuid,is_premium_spin boolean,prize_pool_finalized boolean,club_id uuid,union_id uuid,is_xmtt boolean,payout_depth_percent numeric,payout_percent smallint,payout_structure text,status text); CREATE TABLE tournament_players(tournament_id uuid);")
    for table in ('tournament_entry_close_receipts','tournament_place_settlement_batches','tournament_satellite_settlement_batches','tournament_final_table_deal_batches','tournament_terminal_settlements','tournament_cancellation_receipts'):
        sql('CREATE TABLE '+table+'(tournament_id uuid);')
    sql('CREATE TABLE tournament_obligations(id uuid,tournament_id uuid,kind text); CREATE TABLE tournament_payouts(tournament_id uuid,source text,idempotency_key text);')
    sql((ROOT/'scripts/ci/fixtures/mtt-fifteen-place-key-authority.sql').read_text())
    authorities = json.loads((ROOT/'scripts/ci/fixtures/mtt-fifteen-provisional-authorities.json').read_text())
    # SQL-language dependencies resolve at definition time.
    for name in ('fn_safe_jsonb_array(text)','fn_tournament_payout_terms_committed_v1(uuid)','fn_ca_provisional_payout_structure(uuid)','fn_ca_refresh_provisional_payout_structure(uuid)'):
        item = next(x for x in authorities if x['signature'] == name)
        sql(item['definition']+';')
        require(sql("SELECT md5(pg_get_functiondef('public."+name+"'::regprocedure))") == item['md5'], 'actual provisional authority ' + name)
    sql("INSERT INTO tournaments(id,tournament_type,variant,prize_pool_finalized,payout_depth_percent,payout_percent,payout_structure,status) SELECT md5(x)::uuid,'MTT','nlh',x='finalized',12.5,10,'[{\"place\":1,\"percentage\":100}]',CASE WHEN x='running' THEN 'RUNNING' ELSE 'REGISTERING' END FROM unnest(ARRAY['eligible','running','finalized','committed','empty']) x; INSERT INTO tournament_entry_close_receipts VALUES(md5('committed')::uuid); INSERT INTO tournament_players SELECT md5('eligible')::uuid FROM generate_series(1,42); INSERT INTO tournament_players SELECT md5('running')::uuid FROM generate_series(1,137);")
    sql('CREATE TRIGGER ca_mtt_payout_depth_guard BEFORE INSERT OR UPDATE OF payout_depth_percent,payout_percent ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_mtt_payout_depth_guard();')
    configuration = (ROOT/'supabase/migrations/20261029202847_unfinalized_mtt_fields_adopt_fifteen_percent_payout_depth.sql').read_text()
    sql("ALTER FUNCTION fn_ca_provisional_payout_structure(uuid) SET work_mem='1MB';")
    sql(configuration, refusal='MTT_FIFTEEN_UNFINALIZED_AUTHORITY_DRIFT')
    require(sql('SELECT count(*) FROM tournaments WHERE payout_depth_percent=12.5') == '5', 'unfinalized authority drift leaves every ladder untouched')
    sql('ALTER FUNCTION fn_ca_provisional_payout_structure(uuid) RESET work_mem;')
    sql(configuration)
    require(sql("SELECT payout_depth_percent=15 AND payout_percent=15 AND jsonb_array_length(payout_structure::jsonb)=7 FROM tournaments WHERE id=md5('eligible')::uuid") == 't', 'registered unfinalized 42-player field pays seven places')
    require(sql("SELECT payout_depth_percent=15 AND jsonb_array_length(payout_structure::jsonb)=21 FROM tournaments WHERE id=md5('running')::uuid") == 't', 'running unfinalized 137-player field pays twenty-one places')
    require(sql("SELECT count(*) FROM tournaments WHERE id IN(md5('finalized')::uuid,md5('committed')::uuid) AND payout_depth_percent=12.5 AND payout_percent=10 AND jsonb_array_length(payout_structure::jsonb)=1") == '2', 'finalized and committed prize contracts stay byte-equivalent')
    sql(configuration)
    require(sql("SELECT count(*) FROM tournaments WHERE payout_depth_percent=15") == '3', 'configuration replay has no duplicate or additional effect')
    print(json.dumps({'status':'passed','production_mutations':False,'migration_sha256':hashlib.sha256(candidate.encode()).hexdigest(),'capture_sha256':hashlib.sha256(CAPTURE.read_bytes()).hexdigest()}))
finally:
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, signal.SIG_IGN)
    if started:
        run([PG/'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'], cleanup=True)
    shutil.rmtree(folder)
