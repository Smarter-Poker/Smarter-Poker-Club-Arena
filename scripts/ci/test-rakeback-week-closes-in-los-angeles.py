#!/usr/bin/env python3
"""PostgreSQL 17 proof: a rakeback week closes when its Los Angeles week closes.

The two live payment gates on rakeback periods (fn_ca_legacy_period_maturity on
rakeback_periods, fn_ca_legacy_round3_wallet_receipt on wallet_transactions)
are installed from their exact production definitions (fingerprints pinned
below), RED, and then rebuilt from the old/new pairs written in migration
20261019092211, GREEN. Each gate is asked at fixed instants: inside the
Monday window after UTC midnight and before Los Angeles midnight (PDT and PST),
after the Los Angeles close, and before either close.

The gates read statement_timestamp(); the only edit made for the test is to
read a fixture clock instead (exactly one occurrence per gate), identically for
RED and GREEN, so the instant can be chosen. No production credentials, no
network: an owned cluster in a temporary directory, removed afterwards.
"""
import hashlib
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
PROBE = ROOT / 'scripts/ci/probes/rakeback-week-close'
MIGRATION = ROOT / 'supabase/migrations/20261019092211_a_rakeback_week_closes_when_its_los_angeles_week_closes.sql'
PG_BIN = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
REFUSAL = 'Legacy period payment requires a closed earning period'

# Production definitions read 2026-10-19 on project kuklfnapbkmacvwxktbh.
LIVE = {
    'fn_ca_legacy_period_maturity': '58507b44f4896debdd7b4237c9588719',
    'fn_ca_legacy_round3_wallet_receipt': 'f05849a487f106564c8e52250be3ab45',
}

SUMMER = ('2026-09-07', '2026-09-13')  # closes 2026-09-14T07:00Z (PDT)
WINTER = ('2026-11-02', '2026-11-08')  # closes 2026-11-09T08:00Z (PST)
CASES = [
    # week, instant, admitted before the fix, admitted after the fix
    (SUMMER, '2026-09-13T23:30:00Z', False, False),
    (SUMMER, '2026-09-14T03:00:00Z', True, False),
    (SUMMER, '2026-09-14T06:59:59Z', True, False),
    (SUMMER, '2026-09-14T07:00:01Z', True, True),
    (WINTER, '2026-11-09T07:30:00Z', True, False),
    (WINTER, '2026-11-09T07:59:59Z', True, False),
    (WINTER, '2026-11-09T08:00:01Z', True, True),
]


def pairs():
    sql = MIGRATION.read_text()
    found = {}
    for name, pre, post, old, new, count in re.findall(
        r"pg_temp\.rakeback_week_close_patch\(\s*'public\.(\w+)\([^)]*\)'::regprocedure,\s*"
        r"'(\w{32})','(\w{32})',\s*ARRAY\[\$a\$(.*?)\$a\$\],\s*ARRAY\[\$b\$(.*?)\$b\$\],ARRAY\[(\d+)\]\)",
        sql, re.S):
        found[name] = (pre, post, old, new, int(count))
    assert set(LIVE) <= set(found), found.keys()
    assert 'fn_close_settlement_period' in found
    return found


def run(psql_env, sql, ok=True):
    r = subprocess.run([str(PG_BIN / 'psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql],
                       env=psql_env, capture_output=True, text=True, timeout=60)
    if ok and r.returncode:
        raise AssertionError(r.stderr[-3000:])
    return r


def install(psql_env, patched):
    for name, digest in LIVE.items():
        text = (PROBE / f'{name}.sql').read_text()
        assert hashlib.md5(text.encode()).hexdigest() == digest, f'{name} fixture is not production'
        if patched:
            pre, post, old, new, count = patched[name]
            assert pre == digest, f'{name}: migration preimage is not production'
            assert text.count(old) == count, f'{name}: anchor count'
            text = text.replace(old, new)
            assert hashlib.md5(text.encode()).hexdigest() == post, f'{name}: migration postimage'
        assert text.count('statement_timestamp()') == 1, f'{name}: clock source'
        run(psql_env, text.replace('statement_timestamp()', 'fixture_clock.now()'))


def admitted(psql_env, gate, week, instant):
    start, end = week
    if gate == 'paid':
        body = (f"INSERT INTO rakeback_periods VALUES ('10000000-0000-4000-8000-000000000001',"
                f"'20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',"
                f"'{start}','{end}','pending');"
                "UPDATE rakeback_periods SET status='paid' WHERE id='10000000-0000-4000-8000-000000000001';")
    else:
        body = (f"INSERT INTO rakeback_periods VALUES ('10000000-0000-4000-8000-000000000001',"
                f"'20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',"
                f"'{start}','{end}','pending');"
                "INSERT INTO rakeback_period_payouts VALUES ('40000000-0000-4000-8000-000000000001',"
                "'10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',"
                "'30000000-0000-4000-8000-000000000001',5,'paid',NULL);"
                "INSERT INTO wallet_transactions(user_id,amount,category,description,related_entity_id) VALUES "
                "('20000000-0000-4000-8000-000000000001',5,'rakeback','Rakeback payout',"
                "'40000000-0000-4000-8000-000000000001');")
    r = run(psql_env, f"BEGIN; SET LOCAL fixture.now='{instant}'; {body} ROLLBACK;", ok=False)
    if r.returncode == 0:
        return True
    assert REFUSAL in r.stderr, r.stderr[-2000:]
    return False


def main():
    patched = pairs()
    with tempfile.TemporaryDirectory(prefix='rbw-') as temp:
        root = pathlib.Path(temp)
        sock = root / 's'
        sock.mkdir()
        data = root / 'd'
        subprocess.run([str(PG_BIN / 'initdb'), '-D', str(data), '-U', 'postgres', '-A', 'trust',
                        '--no-locale', '-E', 'UTF8'], check=True, capture_output=True)
        with (data / 'postgresql.conf').open('a') as f:
            f.write(f"\nlisten_addresses=''\nunix_socket_directories='{sock}'\n")
        subprocess.run([str(PG_BIN / 'pg_ctl'), '-D', str(data), '-l', str(root / 'log'), '-w', 'start'],
                       check=True, capture_output=True)
        try:
            env = dict(os.environ, PGHOST=str(sock), PGUSER='postgres', PGDATABASE='postgres')
            run(env, """
              CREATE TABLE rakeback_periods(id uuid PRIMARY KEY, user_id uuid, club_id uuid,
                period_start date, period_end date, status text);
              CREATE TABLE rakeback_period_payouts(id uuid PRIMARY KEY, rakeback_period_id uuid,
                user_id uuid, club_id uuid, payout_amount numeric, status text, wallet_transaction_id uuid);
              CREATE TABLE wallet_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
                amount numeric, category text, description text, related_entity_id uuid);
              CREATE SCHEMA fixture_clock;
              CREATE FUNCTION fixture_clock.now() RETURNS timestamptz LANGUAGE sql STABLE
                AS $$ SELECT current_setting('fixture.now')::timestamptz $$;""")
            results = []
            for state, patch in (('red', None), ('green', patched)):
                install(env, patch)
                if state == 'red':
                    run(env, """
                      CREATE TRIGGER ca_legacy_period_maturity BEFORE UPDATE OF status ON rakeback_periods
                        FOR EACH ROW EXECUTE FUNCTION fn_ca_legacy_period_maturity();
                      CREATE TRIGGER ca_legacy_round3_wallet_receipt BEFORE INSERT ON wallet_transactions
                        FOR EACH ROW EXECUTE FUNCTION fn_ca_legacy_round3_wallet_receipt();""")
                for week, instant, before, after in CASES:
                    expected = before if state == 'red' else after
                    for gate in ('paid', 'wallet_credit'):
                        got = admitted(env, gate, week, instant)
                        assert got == expected, (state, gate, week, instant, got, expected)
                        results.append((state, gate, instant, got))
            red_gap = sum(1 for s, g, i, ok in results if s == 'red' and ok and not i.endswith(('07:00:01Z', '08:00:01Z')))
            print(f'RED: both gates admitted payment inside the open Los Angeles week ({red_gap} gap checks)')
            print('PASS: rakeback weeks close at Los Angeles midnight in PDT and PST, '
                  'both gates refuse inside the window and admit after it')
        finally:
            subprocess.run([str(PG_BIN / 'pg_ctl'), '-D', str(data), '-m', 'immediate', '-w', 'stop'],
                           capture_output=True)


if __name__ == '__main__':
    main()
