#!/usr/bin/env python3
"""Exercise the deletion lifecycle writer in disposable PostgreSQL.

The fixture witnesses wallet movements and receipts. Production's full ledger
and guard compatibility is separately proved by a self-aborting live probe.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--baseline-credit-locks', action='store_true', help='Reproduce the old cross-wallet lock failure in the disposable fixture')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
if sys.platform == 'darwin' and not Path('/Volumes/SmarterWork').is_mount():
    raise RuntimeError('The work SSD must be mounted; no internal-drive fallback is allowed')
storage = '/Volumes/SmarterWork/agent-work' if sys.platform == 'darwin' else None
cluster = Path(tempfile.mkdtemp(prefix='cashier-delete-', dir=storage))
socket = cluster / 's'
socket.mkdir(mode=0o700)
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
port = '55758'
cmd = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', socket, '-p', port, '-U', 'postgres', '-d', 'postgres']
cases = []
started = False
club = '10000000-0000-0000-0000-000000000001'
deleted = '00000000-0000-0000-0000-000000000002'
active = '00000000-0000-0000-0000-000000000001'
closing = '00000000-0000-0000-0000-000000000003'
call = f"SELECT fn_ca_deleted_account_bank_return('{club}','{deleted}')->>'amount';"

def command(argv, sql=None):
    return subprocess.run([str(v) for v in argv], input=sql, text=True,
                          capture_output=True, env=env, timeout=45)

def run(name, sql, expected=None, error=None):
    r = command(cmd, sql)
    (out / (name + '.log')).write_text(r.stdout + r.stderr)
    ok = r.returncode != 0 and error in r.stderr if error else r.returncode == 0
    if expected is not None:
        ok = ok and r.stdout.strip() == expected
    cases.append({'name': name, 'passed': ok})
    if not ok:
        raise RuntimeError(name + ': ' + r.stdout[-500:] + r.stderr[-1500:])
    return r.stdout.strip()

try:
    r = command([pg / 'initdb', '-D', cluster / 'd', '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'])
    if r.returncode:
        raise RuntimeError(r.stderr)
    r = command([pg / 'pg_ctl', '-D', cluster / 'd', '-l', cluster / 'server.log', '-o', f"-k {socket} -p {port} -h ''", '-w', 'start'])
    if r.returncode:
        raise RuntimeError(r.stderr)
    started = True
    run('fixture', (root / 'tests/fixtures/cashier-deleted-accounts/bootstrap.sql').read_text())
    run('baseline-deleted-is-listed', f"SELECT fn_cashier_member_is_active('{club}','{deleted}');", 't')
    migrations = list((root / 'supabase/migrations').glob('*_deleted_accounts_cannot_receive_cashier_transfers.sql'))
    if len(migrations) != 1:
        raise RuntimeError('Expected exactly one deleted-account custody migration')
    migration = migrations[0].read_text()
    run('install', migration)
    refinements = list((root / 'supabase/migrations').glob('*_deleted_account_bank_returns_lock_only_their_credited_wallet.sql'))
    if len(refinements) != 1:
        raise RuntimeError('Expected exactly one source-lock refinement')
    if not args.baseline_credit_locks:
        run('source-lock-refinement', refinements[0].read_text())
    run('deleted-is-excluded', f"SELECT fn_cashier_member_is_active('{club}','{deleted}');", 'f')
    run('active-name-prefix-is-kept', f"SELECT fn_cashier_member_is_active('{club}','{active}');", 't')
    run('browser-cannot-return-funds', f"SET ROLE authenticated; {call}", error='42501')
    run('active-account-refused', f"SELECT fn_ca_deleted_account_bank_return('{club}','{active}')->>'reason';", 'account_not_deleted')
    run('frozen-refuses-atomically', "SET fixture.frozen='1';" + call, error='platform_is_frozen')
    run('frozen-left-bank-alone', 'SELECT chip_treasury FROM clubs;', '1000')
    with ThreadPoolExecutor(max_workers=2) as pool:
        race = list(pool.map(lambda _: command(cmd, call), range(2)))
    ok = all(r.returncode == 0 for r in race) and sorted(r.stdout.strip() for r in race) == ['0', '100']
    cases.append({'name': 'concurrent-return-is-once', 'passed': ok})
    if not ok:
        raise RuntimeError(str([(r.stdout, r.stderr) for r in race]))
    run('conserved-bank-and-two-source-receipts', "SELECT chip_treasury||'/'||(SELECT count(*) FROM chip_transactions)||'/'||(SELECT sum(amount) FROM chip_transactions) FROM clubs;", '1100/2/100')
    run('journal-names-the-bank', "SELECT count(*) FROM movement_witness WHERE amount<0 AND counterparty='club_treasury';", '2')
    run('repeat-does-not-move-money', call, '0')
    run('cashout-credit-returns-immediately', f"UPDATE club_members SET chip_balance=chip_balance+7 WHERE club_id='{club}' AND user_id='{deleted}'; SELECT chip_balance||'/'||(SELECT chip_treasury FROM clubs) FROM club_members WHERE user_id='{deleted}';", '0/1107')
    run('agent-credit-returns-immediately', f"UPDATE agents SET agent_wallet_balance=agent_wallet_balance+3 WHERE user_id='{deleted}'; SELECT agent_wallet_balance||'/'||(SELECT chip_treasury FROM clubs) FROM agents;", '0/1110')
    run('active-credit-stays-with-player', f"UPDATE club_members SET chip_balance=chip_balance+4 WHERE user_id='{active}'; SELECT chip_balance FROM club_members WHERE user_id='{active}';", '34')
    run('deletion-transition-returns-existing-chips', f"UPDATE profiles SET status='deleted' WHERE id='{closing}'; SELECT chip_balance||'/'||(SELECT chip_treasury FROM clubs) FROM club_members WHERE user_id='{closing}';", '0/1120')
    run('held-chips-stay-protected', f"UPDATE club_members SET held_chips=5,chip_balance=10 WHERE user_id='{deleted}'; SELECT chip_balance FROM club_members WHERE user_id='{deleted}';", '5')
    run('released-hold-returns-at-release', f"UPDATE club_members SET held_chips=0 WHERE user_id='{deleted}'; SELECT chip_balance FROM club_members WHERE user_id='{deleted}';", '0')
    run('caller-ledger-context-restored', f"BEGIN; SELECT set_config('app.ledger_category','incoming_credit',true) \\g /dev/null\nUPDATE club_members SET chip_balance=chip_balance+1 WHERE user_id='{deleted}'; SELECT current_setting('app.ledger_category'); ROLLBACK;", 'incoming_credit')
    credits = [
        f"BEGIN; SELECT 1 FROM club_members WHERE user_id='{deleted}' FOR UPDATE; SELECT pg_sleep(0.15); UPDATE club_members SET chip_balance=chip_balance+7 WHERE user_id='{deleted}'; COMMIT;",
        f"BEGIN; SELECT 1 FROM agents WHERE user_id='{deleted}' FOR UPDATE; SELECT pg_sleep(0.15); UPDATE agents SET agent_wallet_balance=agent_wallet_balance+3 WHERE user_id='{deleted}'; COMMIT;"
    ]
    with ThreadPoolExecutor(max_workers=2) as pool:
        race = list(pool.map(lambda sql: command(cmd, sql), credits))
    ok = all(r.returncode == 0 for r in race)
    cases.append({'name': 'simultaneous-member-agent-credits-do-not-cross-lock', 'passed': ok})
    if not ok:
        raise RuntimeError(str([(r.stdout, r.stderr) for r in race]))
    run('simultaneous-credit-conservation', 'SELECT chip_treasury FROM clubs;', '1140')
    run('source-helper-refuses-browser', f"SET ROLE authenticated; SELECT fn_ca_deleted_wallet_bank_return('{club}','{deleted}','player_wallet');", error='42501')
    run('downline-fixture', (root / 'tests/fixtures/cashier-deleted-accounts/downline.sql').read_text())
    original = (root / 'supabase/migrations/20261010074219_player_downline_reads_exact_retained_hand_totals.sql').read_text()
    original = original[original.index('CREATE OR REPLACE FUNCTION'):original.rindex('COMMIT;')]
    run('downline-original', original)
    downline = f"public.ca_club_member_downline('{club}','{closing}')"
    run('downline-baseline-shows-deleted', f"SELECT count(*) FROM {downline};", '3')
    run('downline-install', (root / 'supabase/migrations/20261010202722_deleted_profiles_stay_out_of_player_downline_lists.sql').read_text())
    run('downline-deleted-is-excluded', f"SELECT count(*) FROM {downline} d JOIN profiles p ON p.id=d.user_id WHERE p.status='deleted';", '0')
    run('downline-keeps-active-descendant-and-exact-fees', f"SELECT depth||'/'||total_fees||'/'||alias FROM {downline} WHERE user_id='{active}';", '2/12.34/deleted-active-name')
    run('downline-keeps-profile-less-member', f"SELECT count(*) FROM {downline} WHERE user_id='00000000-0000-0000-0000-000000000004';", '1')
    run('downline-preserves-access-refusal', f"SET fixture.access='restricted'; SELECT count(*) FROM {downline};", '0')
    run('member-data-fixture', (root / 'tests/fixtures/cashier-deleted-accounts/member-data.sql').read_text())
    run('member-detail-preimage', (root / 'tests/fixtures/cashier-deleted-accounts/member-detail-preimage.sql').read_text())
    run('roster-rows-preimage', (root / 'tests/fixtures/cashier-deleted-accounts/roster-rows-preimage.sql').read_text())
    detail = f"public.ca_club_member_detail('{club}','{closing}')"
    roster = f"public.ca_club_roster_rows('{club}')"
    run('detail-baseline-counts-deleted', f"SELECT {detail}->'downline'->>'downline_total';", '3')
    run('detail-baseline-shows-deleted-identity', f"SELECT public.ca_club_member_detail('{club}','{deleted}') IS NOT NULL;", 't')
    run('roster-baseline-shows-deleted', f"SELECT count(*) FROM {roster} r JOIN profiles p ON p.id=r.user_id WHERE p.status='deleted';", '1')
    run('roster-baseline-unaffiliated-falls-through', f"SET request.jwt.claim.role='authenticated'; SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000099'; SELECT count(*) FROM {roster};", '4')
    run('member-data-install', (root / 'supabase/migrations/20261010215612_player_data_hides_deleted_members.sql').read_text())
    run('member-data-definition-readback', "SELECT md5(pg_get_functiondef('ca_club_member_detail(uuid,uuid,date,date)'::regprocedure))||'/'||md5(pg_get_functiondef('ca_club_roster_rows(uuid)'::regprocedure));", 'f759121885ceda3a05158cb28c9c3e34/c8db941a412d88ccfb075d3d5c9cd32d')
    run('detail-counts-only-visible-descendants', f"SELECT ({detail}->'downline'->>'downline_direct')||'/'||({detail}->'downline'->>'downline_total');", '1/2')
    run('detail-deleted-identity-is-absent', f"SELECT public.ca_club_member_detail('{club}','{deleted}')->'identity'->>'user_id' IS NULL;", 't')
    run('detail-missing-membership-is-absent', f"SELECT public.ca_club_member_detail('{club}','00000000-0000-0000-0000-000000000099')->'identity'->>'user_id' IS NULL;", 't')
    run('detail-keeps-profile-less-member', f"SELECT public.ca_club_member_detail('{club}','00000000-0000-0000-0000-000000000004')->'identity'->>'user_id';", '00000000-0000-0000-0000-000000000004')
    run('detail-keeps-active-deleted-prefix-name', f"SELECT public.ca_club_member_detail('{club}','{active}')->'identity'->>'alias';", 'deleted-active-name')
    run('roster-excludes-deleted', f"SELECT count(*) FROM {roster} r JOIN profiles p ON p.id=r.user_id WHERE p.status='deleted';", '0')
    run('roster-counts-only-visible-descendants', f"SELECT downline_direct||'/'||downline_total FROM {roster} WHERE user_id='{closing}';", '1/2')
    run('roster-retains-active-under-deleted-parent', f"SELECT total_fees FROM {roster} WHERE user_id='{active}';", '12.34')
    run('roster-retains-historical-downline-fees', f"SELECT downline_fees FROM {roster} WHERE user_id='{closing}';", '12.34')
    run('detail-preserves-access-refusal', f"SET fixture.access='none'; SELECT {detail} IS NULL;", 't')
    run('roster-preserves-unaffiliated-refusal', f"SET request.jwt.claim.role='authenticated'; SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000099'; SELECT count(*) FROM {roster};", '0')
    wallet = subprocess.run([sys.executable, str(root / 'tests/sql/run-diamond-transfer-door-and-dr16.py')], capture_output=True, text=True, env={**env, 'PG_BIN': str(pg)}, timeout=120)
    (out / 'diamond-transfer-door.log').write_text(wallet.stdout + wallet.stderr)
    cases.append({'name': 'deleted-diamond-transfer-under-production-guard', 'passed': wallet.returncode == 0})
    if wallet.returncode:
        raise RuntimeError(wallet.stdout[-2000:] + wallet.stderr[-2000:])
    print(json.dumps({'passed': True, 'cases': cases}))
finally:
    (out / 'results.json').write_text(json.dumps({'passed': bool(cases) and all(v['passed'] for v in cases), 'cases': cases}, indent=2))
    if started:
        command([pg / 'pg_ctl', '-D', cluster / 'd', '-m', 'immediate', '-w', 'stop'])
    shutil.rmtree(cluster)
