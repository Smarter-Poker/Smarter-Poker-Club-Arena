#!/usr/bin/env python3
"""The transfer door is named and DR16 has a consumer: isolated PostgreSQL 17 proof.

Never connects to production. Builds the Phase 3 custody fixture, the Phase 4
wallet transfer chain and then, unlike the Phase 4 runner, attaches the EXACT
production profile guard to profiles. That is the gap: the guard refuses every
profiles.diamonds write from a call stack it does not name, and the transfer
door was never named, so every real transfer answered 42501 while the fixture
without the guard stayed green.

  1. negative control: with the production guard attached, an authenticated
     friend transfer answers 42501 and nothing moves; the detector lists the
     door as client_reachable_but_guard_refuses and DR16 as
     rule_with_no_consumer; the reserve refuses an unsettled lot with a plain
     insufficient_settled_diamonds in either mode;
  2. the migration applies (md5 pins on the guard, the door and the reserve);
  3. the same transfer commits: both wallets move, both journal legs land, the
     receipt replays; a stranger's direct UPDATE of profiles.diamonds is still
     refused; the detector lists neither finding; the reserve still refuses an
     unsettled lot in BOTH modes, plain in 'log' and under P0416 with a DETAIL
     naming DR16 in 'refuse', a wallet short even when settled is never
     attributed to DR16, and a settled amount still reserves.
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
SQL_DIR = ROOT / 'tests/sql'
PG = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
SOCKET = '/tmp/codex-diamond-phase2-pg'
PORT = '55472'
DB = 'poker_diamond_transfer_door_test'
MIGRATION = ROOT / 'supabase/migrations/20260919223115_the_transfer_door_is_named_and_dr16_has_a_consumer.sql'
BASE = [str(PG / 'psql'), '-X', '-q', '-h', SOCKET, '-p', PORT, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-At']

A = '10000000-0000-0000-0000-000000000001'
B = '10000000-0000-0000-0000-000000000002'
C = '10000000-0000-0000-0000-000000000003'   # no friendship, no lots: the reserve's wallet
TABLE = '30000000-0000-0000-0000-000000000001'
LIVE_CLAIMS = json.dumps({'role': 'authenticated', 'session_id': '60000000-0000-0000-0000-000000000001'})

passed = 0


def check(condition, label):
    global passed
    assert condition, label
    passed += 1
    print('PASS:', label, flush=True)


def psql(args, sql=None, db=DB, ok=True):
    r = subprocess.run(BASE + ['-d', db] + args, input=sql, text=True, capture_output=True,
                       cwd=SQL_DIR, timeout=120)
    if ok and r.returncode:
        print(r.stdout)
        print(r.stderr, file=sys.stderr)
        raise RuntimeError('isolated transfer door SQL failed')
    return r


def sql(q, ok=True):
    r = psql(['-c', q], ok=ok)
    return r.stdout.strip() if ok else r


def script(text):
    with tempfile.NamedTemporaryFile(mode='w+', suffix='.sql', dir=SQL_DIR) as f:
        f.write(text)
        f.flush()
        r = psql(['-P', 'pager=off', '-f', f.name])
    for line in r.stderr.splitlines():
        if 'PASS:' in line:
            print(line.split('PASS:', 1)[1].strip())
    return r.stdout.strip(), r.stderr


def send(amount=100, request=None, sender=A, recipient=B, claims=LIVE_CLAIMS):
    ref = request or str(uuid.uuid4())
    r = sql("SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','" + sender + "',false); "
            "SELECT set_config('request.jwt.claims','" + claims.replace("'", "''") + "',false); "
            "SELECT send_wallet_diamond_transfer('" + recipient + "'," + str(amount) + ",NULL,'" + ref + "')", False)
    if r.returncode:
        return r
    return json.loads(r.stdout.strip().splitlines()[-1])


def reserve(amount, request=None, table=TABLE):
    request = request or str(uuid.uuid4())
    return sql(f"select fn_poker_diamond_reserve('{C}','cash_seat','{table}','{request}',{amount},'{request}')", False)


def detector():
    return sql("SELECT string_agg(finding || ' ' || object, E'\\n') FROM fn_ca_diamond_unreachable_money()")


def ready():
    return subprocess.run([str(PG / 'pg_isready'), '-h', SOCKET, '-p', PORT], capture_output=True).returncode == 0


started_here = None
if not ready():
    data = pathlib.Path(SOCKET) / 'data-transfer-door'
    if not (data / 'PG_VERSION').exists():
        data.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([str(PG / 'initdb'), '-D', str(data), '--auth=trust', '-E', 'UTF8'],
                       check=True, capture_output=True, env={**os.environ, 'LC_ALL': 'C', 'LANG': 'C'})
    subprocess.run([str(PG / 'pg_ctl'), '-D', str(data), '-l', str(data.parent / 'server-transfer-door.log'),
                    '-o', f"-p {PORT} -k {SOCKET} -c listen_addresses='' -c fsync=off", '-w', '-t', '30', 'start'],
                   check=True, capture_output=True, env={**os.environ, 'LC_ALL': 'C', 'LANG': 'C'})
    started_here = data
    check(ready(), 'private isolated cluster started on the estate socket')

try:
    exists = psql(['-c', f"SELECT 1 FROM pg_database WHERE datname='{DB}'"], db='postgres').stdout.strip()
    if not exists:
        psql(['-c', f'CREATE DATABASE {DB}'], db='postgres')

    # The Phase 3 custody fixture (setup only), then the Phase 4 wallet transfer chain exactly
    # as tests/sql/run-diamond-wallet-transfer.py builds it, then the tournament switch that
    # brought fn_poker_diamond_reserve to its live text, then the production guard.
    fixture = (SQL_DIR / 'poker-diamond-custody.sql').read_text().split('CREATE TEMP TABLE receipts')[0]
    fixture = fixture.replace('poker_diamond_phase3_test', DB)
    for line in fixture.splitlines():
        if line.startswith('\\ir '):
            fixture = fixture.replace(line, '\\ir ' + str((SQL_DIR / line[4:]).resolve()))
    fixture += """
ALTER TABLE profiles ADD COLUMN created_at timestamptz DEFAULT now()-interval '180 days', ADD COLUMN is_farming_flagged boolean DEFAULT false;
CREATE TABLE friendships(id uuid DEFAULT gen_random_uuid(),user_id uuid,friend_id uuid,status text);
CREATE TABLE live_streams(id uuid,broadcaster_id uuid);
CREATE TABLE live_bans(stream_id uuid,banned_user_id uuid);
CREATE TABLE diamond_purchases(user_id uuid,status text,completed_at timestamptz,refunded_at timestamptz);
INSERT INTO profiles(id,diamonds) VALUES('10000000-0000-0000-0000-000000000002',1000),('10000000-0000-0000-0000-000000000003',1000);
INSERT INTO friendships(user_id,friend_id,status) VALUES('10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','accepted');
"""
    fixture += '\n\\ir ' + str(SQL_DIR / 'poker-diamond-production-wallet-fixture.sql')
    fixture += '\n\\ir ' + str(SQL_DIR / 'diamond-transfer-cap-fixture.sql')
    fixture += '\n\\ir ' + str(ROOT / 'supabase/migrations/20260909200327_atomic_wallet_diamond_transfers.sql')
    fixture += '\n\\ir ' + str(SQL_DIR / 'diamond-session-fixture.sql')
    fixture += '\n\\ir ' + str(ROOT / 'supabase/migrations/20260910012514_diamond_wallet_transfers_require_a_live_session.sql')
    fixture += '\n\\ir ' + str(ROOT / 'supabase/migrations/20260912112311_the_tournament_door_has_a_switch.sql')
    fixture += '\n\\ir ' + str(SQL_DIR / 'diamond-transfer-door-fixture.sql')
    script(fixture)
    # Let the custody fixture's journal grace expire without altering any financial history.
    sql('select pg_sleep(2.1)')

    # ---- 1. Negative controls against the production guard. ----
    before = sql('SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM profiles p')
    refused = send()
    check(not isinstance(refused, dict) and '42501' in refused.stderr and 'server-managed' in refused.stderr,
          'negative control: with the production guard attached, a friend transfer answers 42501')
    check(before == sql('SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM profiles p')
          and sql('SELECT count(*) FROM diamond_wallet_transfers') == '0'
          and sql("SELECT count(*) FROM diamond_transactions WHERE source='wallet_diamond_transfer'") == '0',
          'negative control: the refused transfer moved nothing and journaled nothing')
    findings = detector()
    check('client_reachable_but_guard_refuses send_wallet_diamond_transfer(p_recipient_id uuid, p_amount integer, p_message text, p_reference_id text)' in findings,
          'negative control: the detector lists the transfer door as client_reachable_but_guard_refuses')
    check('rule_with_no_consumer DR16:deposit_inside_settlement_window' in findings,
          'negative control: the detector lists DR16 as rule_with_no_consumer')

    # An unsettled lot: C's wallet is 1000, of which 800 is a purchased lot created today.
    sql(f"INSERT INTO diamond_purchase_lots(user_id,issued,created_at) VALUES('{C}',800,now())")
    r = reserve(300)
    check(r.returncode != 0 and 'P0001: insufficient_settled_diamonds' in r.stderr and 'DR16' not in r.stderr,
          'negative control: the live reserve refuses an unsettled lot by name, with no rule attribution')
    sql("UPDATE ca_diamond_rule_modes SET mode='refuse' WHERE rule='DR16:deposit_inside_settlement_window'")
    r = reserve(300)
    check(r.returncode != 0 and 'P0001: insufficient_settled_diamonds' in r.stderr and 'DR16' not in r.stderr,
          'negative control: arming DR16 changes nothing while nothing consults it')
    sql("UPDATE ca_diamond_rule_modes SET mode='log' WHERE rule='DR16:deposit_inside_settlement_window'")

    # ---- 2. The migration. ----
    out, err = script(MIGRATION.read_text())
    check('ERROR' not in err, 'the migration applied against the production text')
    r = psql(['-f', str(MIGRATION)], ok=False)
    check(r.returncode != 0 and ('already names send_wallet_diamond_transfer' in r.stderr or 'changed (md5' in r.stderr),
          'the migration refuses to apply a second time (md5 pins)')

    # ---- 3. The transfer door works under the guard. ----
    ref = str(uuid.uuid4())
    first = send(request=ref)
    check(isinstance(first, dict) and first.get('success') is True, 'the same friend transfer now commits')
    check(sql(f"SELECT diamonds FROM profiles WHERE id='{A}'") == '900'
          and sql(f"SELECT diamonds FROM profiles WHERE id='{B}'") == '1100',
          'both wallets moved by exactly the amount')
    check(sql("SELECT count(*) FROM diamond_transactions WHERE source='wallet_diamond_transfer'") == '2'
          and sql("SELECT sum(amount) FROM diamond_transactions WHERE source='wallet_diamond_transfer'") == '0',
          'both journal legs landed and conserve')
    check(first == send(request=ref), 'the receipt replays exactly')
    check(sql('SELECT count(*) FROM diamond_wallet_transfers') == '1', 'one transfer row')
    no_session = send(claims=json.dumps({'role': 'authenticated'}))
    check(not isinstance(no_session, dict) and 'authentication_required' in no_session.stderr,
          'a transfer without a live session is still refused before any wallet is touched')
    direct = sql(f"SET ROLE authenticated; SELECT set_config('request.jwt.claims','{LIVE_CLAIMS}',false); "
                 f"UPDATE profiles SET diamonds=diamonds+1 WHERE id='{A}'", False)
    check(direct.returncode != 0 and '42501' in direct.stderr,
          'a direct write to profiles.diamonds from a browser role is still refused by the guard')
    check(sql("SELECT position('send_wallet_diamond_transfer[(]' in prosrc) > 0 FROM pg_proc WHERE proname='fn_guard_profile_privileged_columns'") == 't',
          'the guard names the door the way the detector reads it')
    findings = detector() or ''
    check('send_wallet_diamond_transfer' not in findings, 'the detector no longer lists the transfer door')
    check('DR16:deposit_inside_settlement_window' not in findings, 'the detector no longer lists DR16')

    # ---- 4. DR16 is consumed: the refusal stands in both modes; the mode decides its report. ----
    wallet = sql(f"SELECT diamonds FROM profiles WHERE id='{C}'")
    r = reserve(300)
    check(r.returncode != 0 and 'P0001: insufficient_settled_diamonds' in r.stderr and 'DETAIL' not in r.stderr,
          "in 'log' mode the settlement refusal is raised exactly as before")
    sql("UPDATE ca_diamond_rule_modes SET mode='refuse' WHERE rule='DR16:deposit_inside_settlement_window'")
    r = reserve(300)
    check(r.returncode != 0 and 'P0416: insufficient_settled_diamonds' in r.stderr,
          "in 'refuse' mode the same refusal is raised under the rule's own code, same leading token")
    check('DETAIL:  DR16:deposit_inside_settlement_window refused 300: 800 purchased diamond(s) frozen or inside the 14-day settlement window; 200 settled' in r.stderr,
          'the armed refusal carries the rule, the amount, the unsettled lots, the window and what is settled')
    check(sql(f"SELECT diamonds FROM profiles WHERE id='{C}'") == wallet
          and sql("SELECT count(*) FROM poker_diamond_custody WHERE purpose='cash_seat' AND balance=300") == '0',
          'a refused reserve moves nothing into custody')
    # A table whose maximum exceeds the whole wallet, so the shortfall is the wallet's, not the window's.
    sql("INSERT INTO tables VALUES('30000000-0000-0000-0000-000000000009','20000000-0000-0000-0000-000000000001',10,5000,'waiting')")
    r = reserve(1200, table='30000000-0000-0000-0000-000000000009')
    check(r.returncode != 0 and 'P0001: insufficient_settled_diamonds' in r.stderr and 'DR16' not in r.stderr,
          'a wallet that could not cover the amount even fully settled is plain insufficiency, not DR16')
    ok = reserve(50)
    check(ok.returncode == 0 and json.loads(ok.stdout.strip())['success'] is True,
          'an amount the settled balance covers still reserves with DR16 armed')
    sql("UPDATE ca_diamond_rule_modes SET mode='log' WHERE rule='DR16:deposit_inside_settlement_window'")
    ok = reserve(50, table='30000000-0000-0000-0000-000000000009')   # one open entry per table
    check(ok.returncode == 0 and json.loads(ok.stdout.strip())['success'] is True,
          'and in log mode')
    check(sql("SELECT count(*) FROM pg_proc WHERE proname='fn_poker_diamond_reserve' AND prosrc LIKE "
              "'%fn_ca_diamond_rule_mode(''DR16:deposit_inside_settlement_window'')%'") == '1',
          'the reserve consults DR16 by its literal name, which is what the flip door checks')
finally:
    if started_here is not None:
        subprocess.run([str(PG / 'pg_ctl'), '-D', str(started_here), '-m', 'fast', '-w', '-t', '30', 'stop'],
                       capture_output=True, env={**os.environ, 'LC_ALL': 'C', 'LANG': 'C'})

print(f'{passed} isolated transfer door and DR16 checks passed; this is not a production certification.')
