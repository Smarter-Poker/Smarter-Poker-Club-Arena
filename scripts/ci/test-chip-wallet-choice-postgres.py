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
def query(sql): return run(psql, sql)
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
    print(result)
finally:
    if (cluster/'data/postmaster.pid').exists():
        run([pg/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
    shutil.rmtree(cluster)
