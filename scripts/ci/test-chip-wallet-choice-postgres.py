#!/usr/bin/env python3
"""Exercise the installed send cores and routing patch in isolated PostgreSQL 17."""
import os
from pathlib import Path
import subprocess
import tempfile
import shutil
import argparse
ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--baseline', action='store_true')
parser.add_argument('--selected-baseline', action='store_true')
args = parser.parse_args()
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin' if Path('/Volumes/SmarterWork').is_dir() else '/usr/lib/postgresql/17/bin'))
scratch = '/Volumes/SmarterWork/agent-work' if Path('/Volumes/SmarterWork').is_dir() else tempfile.gettempdir()
cluster = Path(tempfile.mkdtemp(prefix='wc-pg-', dir=scratch))
socket = cluster/'s'; socket.mkdir()
def run(command, sql=None):
    result = subprocess.run([str(v) for v in command], input=sql, capture_output=True, text=True, timeout=60)
    if result.returncode: raise RuntimeError(result.stderr + result.stdout)
    return result.stdout
psql = [pg/'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-U', 'postgres', '-d', 'postgres']
def query(sql):
    sql_file=cluster/'query.sql'
    sql_file.write_text(sql)
    return run(psql+['-f',sql_file])
try:
    assert ' 17.' in run([pg/'postgres', '--version'])
    shared = Path(run([pg/'pg_config', '--sharedir']).strip())
    if not (shared/'postgres.bki').exists(): shared=pg.parent/'share/postgresql'
    run([pg/'initdb','-L',shared,'-D',cluster/'data','-U','postgres','-A','trust','--no-locale','-E','UTF8'])
    run([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'server.log','-o',f"-h '' -k {socket}",'-w','start'])
    assert query("select inet_server_addr() is null and current_setting('listen_addresses')='';").strip() == 't'
    fixture=ROOT/'scripts/ci/fixtures/chip-wallet-choice'
    query((fixture/'setup.sql').read_text())
    for name in ['fn_agent_wallet_send_core_20260830','fn_agent_wallet_send_phase2_core_20260831','fn_club_bank_send_core_20261004','fn_club_bank_send']:
        query((fixture/(name+'.sql')).read_text())
    migration=(ROOT/'supabase/migrations/20261016021637_chip_send_honors_the_recipient_wallet_chosen_by_the_sender.sql').read_text()
    if not args.baseline:
        query(migration)
        import re
        for proof in re.findall(r'^-- @live-proof: (.+)$', migration, re.M):
            assert query('SELECT '+proof+';').strip() == 't', proof
    # Hold agreement authority in a separate connection. A bank send must wait
    # BEFORE locking the club row, otherwise agreement writers invert the order.
    holder = subprocess.Popen([str(v) for v in psql], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    holder.stdin.write("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('agent-agreement:00000000-0000-0000-0000-000000000001',0)); SELECT 'held';\n"); holder.stdin.flush()
    while True:
        line = holder.stdout.readline()
        if not line: raise RuntimeError('Agreement holder exited before readiness')
        if line.strip() == 'held': break
    worker = subprocess.Popen([str(v) for v in psql], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    worker.stdin.write("SET application_name='wallet-choice-bank-wait'; SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false); SELECT fn_club_bank_send('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',1,'agent_wallet',NULL,gen_random_uuid());\n"); worker.stdin.flush()
    import time
    deadline=time.monotonic()+5
    while query("select count(*) from pg_stat_activity where application_name='wallet-choice-bank-wait' and wait_event='advisory';").strip() != '1':
        if time.monotonic()>deadline: raise RuntimeError('Bank did not reach agreement wait')
        time.sleep(.02)
    try:
        query("BEGIN; SELECT 1 FROM clubs WHERE id='00000000-0000-0000-0000-000000000001' FOR UPDATE NOWAIT; ROLLBACK;")
    finally:
        holder.communicate("ROLLBACK;\n",timeout=5)
        worker_out, worker_error = worker.communicate(timeout=5)
        if worker.returncode or '"success": true' not in worker_out:
            raise RuntimeError(worker_error + worker_out)
    result=query((fixture/'cases.sql').read_text())
    assert 'wallet-choice-passed' in result
    if not args.baseline:
        try: query(migration)
        except RuntimeError as error:
            assert 'Unexpected function preimage' in str(error)
        else: raise RuntimeError('Migration replay was not refused')
    query((fixture/'selected-setup.sql').read_text())
    for name in ['fn_agent_wallet_send','fn_agent_wallet_send_core_20261004','fn_promo_wallet_send_core_20261004','fn_club_promo_send_core_20261004','fn_promo_wallet_send','fn_club_promo_wallet_send','fn_agent_wallet_claim_back_phase2_core_20260831','fn_cashier_batch_transfer']:
        query((fixture/(name+'.sql')).read_text())
    selected_migration=(ROOT/'supabase/migrations/20261016024912_cashier_sends_use_the_selected_source_and_destination_wallet.sql').read_text()
    if not args.selected_baseline:
        query(selected_migration)
        for proof in re.findall(r'^-- @live-proof: (.+)$', selected_migration, re.M):
            assert query('SELECT '+proof+';').strip() == 't', proof
    selected_result=query((fixture/'selected-cases.sql').read_text())
    assert 'selected-wallet-routing-passed' in selected_result
    try: query(selected_migration)
    except RuntimeError as error: assert 'Unexpected preimage' in str(error)
    else: raise RuntimeError('Selected routing migration replay was not refused')
    # Two physical sessions wait together on the SAME exact-intent lock.
    # Releasing it admits a genuine concurrent replay, with one debit/journal.
    concurrent_op='12345678-1234-4234-8234-123456789abc'
    holder=subprocess.Popen([str(v) for v in psql],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    holder.stdin.write("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('test-intent:"+concurrent_op+"',0)); SELECT 'held';\n"); holder.stdin.flush()
    while True:
        line=holder.stdout.readline()
        if not line: raise RuntimeError('Concurrent replay holder exited before readiness')
        if line.strip()=='held': break
    workers=[]
    for index in range(2):
        process=subprocess.Popen([str(v) for v in psql],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        process.stdin.write("SET application_name='selected-wallet-race'; SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false); SELECT fn_cashier_batch_transfer('00000000-0000-0000-0000-000000000001','send','[{\"user_id\":\"00000000-0000-0000-0000-000000000003\",\"amount\":2,\"source\":\"player_wallet\",\"destination\":\"promo_wallet\",\"op_id\":\""+concurrent_op+"\"}]',gen_random_uuid());\n"); process.stdin.flush(); workers.append(process)
    deadline=time.monotonic()+5
    try:
        while query("SELECT count(*) FROM pg_stat_activity WHERE application_name='selected-wallet-race' AND wait_event='advisory';").strip() != '2':
            if time.monotonic()>deadline: raise RuntimeError('Concurrent sends did not reach the shared lock')
            time.sleep(.02)
    finally: holder.communicate('ROLLBACK;\n',timeout=5)
    for process in workers:
        output,error=process.communicate(timeout=5)
        assert process.returncode==0 and '"success": true' in output, error+output
    assert query("SELECT count(*) FROM chip_transactions WHERE metadata->>'op_id'='"+concurrent_op+"';").strip()=='1'
    assert query("SELECT count(*) FROM journal WHERE op='cashier_player_send:"+concurrent_op+"';").strip()=='1'
    for signature in ['public.fn_cashier_recipient_wallet_balances(uuid,uuid[])','public.fn_cashier_player_wallet_send(uuid,uuid,numeric,text,text,uuid)']:
        print('NEW_FUNCTION_HASH',signature,query("SELECT md5(pg_get_functiondef('"+signature+"'::regprocedure));").strip())
    print(result,selected_result,'selected-wallet-concurrent-replay-passed')
finally:
    if (cluster/'data/postmaster.pid').exists():
        run([pg/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
    shutil.rmtree(cluster)
