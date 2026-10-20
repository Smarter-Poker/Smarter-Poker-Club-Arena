#!/usr/bin/env python3
"""Qualify that the conservation report reads a club bank by its own entity.

Issue #7321: fn_cashier_conservation_report summed bank legs filtered by
chip_ledger.club_id = the club AND the treasury entity = the club. club_id on a
bank leg names the wallet club of the OTHER side, so a commission paid by
Midway Union's bank into a payee's wallet in another club (20261003092151,
filed under the payee's club) was dropped from Midway's expected balance:
Midway read drift -3,038.33 and Deep Stack Society -81.14 with no chip missing.

20261019093951 selects bank movement by the bank entity only. This harness
installs the exact production predecessor (20261016230420 then
20261017184739), proves the predecessor misreads the cross-filed legs, installs
the fix through its guards, and proves every bank now reconciles while the
player side and inventory are exactly what the predecessor reported.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MIG = ROOT / 'supabase/migrations'
BASE = MIG / '20261016230420_cashier_conservation_reads_cutoff_statistics_from_the_baseli.sql'
SEALED = MIG / '20261017184739_cashier_conservation_reads_sealed_wallet_days.sql'
NEW = MIG / '20261019093951_the_cashier_conservation_bank_side_reads_the_bank_entity.sql'
PREIMAGE = '884cbcbfae7f556ef0d5972e7e9b24c9'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--predecessor-only', action='store_true',
                    help='stop before installing the fix and assert the fixed answers '
                         '(demonstrates the failure the fix removes)')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
if not (pg / 'postgres').exists():
    pg = next(p for p in sorted(Path('/usr/lib/postgresql').glob('*/bin'), reverse=True)
              if (p / 'postgres').exists())
scratch = Path('/Volumes/SmarterWork/agent-work') if sys.platform == 'darwin' else Path(tempfile.gettempdir())
if not scratch.is_dir():
    raise RuntimeError('External SSD is required on macOS')
cluster = Path(tempfile.mkdtemp(prefix='bank-entity-pg-', dir=scratch))
socket = cluster / 's'
socket.mkdir()
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
psql = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
        '-h', str(socket), '-p', '55785', '-U', 'postgres', '-d', 'postgres']
results = {'scope': 'cashier conservation bank side reads the bank entity', 'cases': [], 'passed': False}


def command(cmd, **kwargs):
    return subprocess.run([str(x) for x in cmd], env=env, text=True, capture_output=True,
                          timeout=300, **kwargs)


def run(name, sql, expected=None, refused=None):
    r = command(psql, input=sql)
    if refused:
        assert r.returncode and refused in r.stderr, (name, r.stderr)
    else:
        assert r.returncode == 0, (name, r.stderr)
        if expected is not None:
            assert r.stdout.strip() == expected, (name, r.stdout, expected)
    results['cases'].append({'name': name, 'passed': True})
    return r.stdout.strip()


def definition(path):
    s = path.read_text()
    a = s.index('CREATE OR REPLACE FUNCTION public.fn_cashier_conservation_report')
    return s[a:s.index('$conservation_report$;', a) + len('$conservation_report$;')] + '\n'


A = '00000000-0000-0000-0000-0000000000a1'   # the paying bank (Midway's shape)
B = '00000000-0000-0000-0000-0000000000b1'   # the payee's wallet club
F = '00000000-0000-0000-0000-0000000000f1'   # a club with no cross-filed legs
U = '00000000-0000-0000-0000-000000000001'   # owner of every club
P = '00000000-0000-0000-0000-000000000002'   # payee: a wallet in B, none in A
Q = '00000000-0000-0000-0000-000000000003'


def claims():
    return f"SET ROLE authenticated; SET request.jwt.claims='{{\"sub\":\"{U}\"}}'; "


def bank(club):
    r = f"public.fn_cashier_conservation_report('{club}')"
    return (claims() + f"SELECT {r}->'bank'->>'status'||'|'||({r}->'bank'->>'actual')||'|'||"
            f"({r}->'bank'->>'expected')||'|'||({r}->'bank'->>'drift');")


def players(club):
    r = f"public.fn_cashier_conservation_report('{club}')"
    return (claims() + f"SELECT {r}->'players'->>'status'||'|'||({r}->'players'->>'checked')||'|'||"
            f"({r}->'players'->>'absolute_drift');")


def same_except_bank(club):
    return (claims() + f"SELECT (public.fn_cashier_conservation_report('{club}')-'as_of'-'bank')"
            f"=(public.conservation_before('{club}')-'as_of'-'bank');")


def same_whole(club):
    return (claims() + f"SELECT (public.fn_cashier_conservation_report('{club}')-'as_of')"
            f"=(public.conservation_before('{club}')-'as_of');")


ATTEST = """
INSERT INTO ca_ledger_day_manifests(day,row_count,sha256)
SELECT (created_at AT TIME ZONE 'UTC')::date, count(*), md5(string_agg(id::text||':'||amount::text, ',' ORDER BY id))
FROM chip_ledger GROUP BY 1
ON CONFLICT (day) DO UPDATE SET row_count=excluded.row_count, sha256=excluded.sha256;
"""

try:
    r = command([pg / 'initdb', '-D', cluster / 'data', '-A', 'trust', '-U', 'postgres'])
    assert r.returncode == 0, r.stderr
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'postgres.log',
                 '-o', f'-k {socket} -p 55785 -c listen_addresses= -c fsync=off -c TimeZone=America/Chicago',
                 '-w', 'start'])
    assert r.returncode == 0, r.stderr
    run('minimal-report-schema', f"""
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
 $$SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigserial PRIMARY KEY,jobname text UNIQUE,schedule text,command text,
 active boolean NOT NULL DEFAULT true);
CREATE FUNCTION cron.schedule(job_name text,schedule text,command text) RETURNS bigint LANGUAGE sql AS
 $$INSERT INTO cron.job(jobname,schedule,command) VALUES (job_name,schedule,command)
   ON CONFLICT (jobname) DO UPDATE SET schedule=excluded.schedule,command=excluded.command
   RETURNING jobid$$;
GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;
CREATE TABLE profiles(id uuid PRIMARY KEY,status text);
CREATE TABLE clubs(id uuid PRIMARY KEY,asset text,chip_treasury numeric);
CREATE TABLE club_members(club_id uuid,user_id uuid,role text,status text,chip_balance numeric,
 held_chips numeric DEFAULT 0,joined_at timestamptz,PRIMARY KEY(club_id,user_id));
CREATE TABLE ca_chip_baseline(club_id uuid,user_id uuid,opening_balance numeric,taken_at timestamptz,
 PRIMARY KEY(club_id,user_id));
CREATE TABLE ca_treasury_baseline(club_id uuid PRIMARY KEY,opening_balance numeric,taken_at timestamptz);
CREATE TABLE agents(club_id uuid,agent_wallet_balance numeric,promo_wallet_balance numeric);
CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,tournament_id uuid);
CREATE TABLE table_seats(table_id uuid,stack numeric,left_at timestamptz);
CREATE TABLE chip_ledger(id bigserial PRIMARY KEY,club_id uuid,from_type text,from_entity_id uuid,to_type text,
 to_entity_id uuid,amount numeric,created_at timestamptz,
 status text NOT NULL CHECK(status IN ('posted','correction','reversal')));
CREATE INDEX idx_chip_ledger_created_at ON chip_ledger(created_at);
CREATE INDEX idx_chip_ledger_club_player_legs_cover ON chip_ledger(club_id,created_at)
 INCLUDE(to_type,from_type,to_entity_id,from_entity_id,amount)
 WHERE club_id IS NOT NULL AND (to_type='player_wallet' OR from_type='player_wallet');
-- The production treasury indexes the bank sums read (entity, created_at).
CREATE INDEX idx_chip_ledger_treasury_in ON chip_ledger(to_entity_id,created_at) INCLUDE(amount)
 WHERE to_type='club_treasury' AND to_entity_id IS NOT NULL;
CREATE INDEX idx_chip_ledger_treasury_out ON chip_ledger(from_entity_id,created_at) INCLUDE(amount)
 WHERE from_type='club_treasury' AND from_entity_id IS NOT NULL;
CREATE TABLE ca_ledger_day_manifests(day date PRIMARY KEY,row_count bigint,sha256 text);
CREATE FUNCTION fn_cashier_member_is_active(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS
 $$SELECT EXISTS(SELECT 1 FROM club_members WHERE club_id=$1 AND user_id=$2 AND status='active')$$;
CREATE FUNCTION fn_club_bank_role(uuid,uuid) RETURNS text LANGUAGE sql STABLE AS
 $$SELECT role FROM club_members WHERE club_id=$1 AND user_id=$2$$;
INSERT INTO profiles VALUES ('{U}',NULL);
""")
    # The exact production predecessor, installed through its own guards.
    run('install-20261016230420-definition', definition(BASE) +
        "REVOKE ALL ON FUNCTION fn_cashier_conservation_report(uuid) FROM PUBLIC,anon;"
        " GRANT EXECUTE ON FUNCTION fn_cashier_conservation_report(uuid) TO authenticated,service_role;")
    run('install-20261017184739', SEALED.read_text())
    run('predecessor-is-the-production-definition',
        "SELECT md5(pg_get_functiondef('fn_cashier_conservation_report(uuid)'::regprocedure));", PREIMAGE)
    run('predecessor-acl-is-production',
        "SELECT proacl::text FROM pg_proc WHERE oid='fn_cashier_conservation_report(uuid)'::regprocedure;",
        '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}')
    run('before-reference', definition(SEALED).replace('fn_cashier_conservation_report', 'conservation_before'))

    # THE SHAPE OF #7321, both directions and both banks:
    #   1  A's bank pays U's wallet in A, filed under A               (always read)
    #   2  A's bank pays P's wallet in B, filed under B  -- the 20261003092151 leg
    #   3  P's wallet in B pays A's bank, filed under B  -- a credit filed elsewhere
    #   4  B's bank pays U's wallet in A, filed under A  -- B's debit under A
    # plus a reversal and a correction across clubs, and F, which has none.
    run('cross-filed-bank-fixture', f"""
INSERT INTO clubs VALUES ('{A}','chips',964),('{B}','chips',490),('{F}','chips',195);
INSERT INTO ca_treasury_baseline VALUES ('{A}',1000,'2026-01-01 00:00+00'),('{B}',500,'2026-01-01 00:00+00'),
 ('{F}',200,'2026-01-01 00:00+00');
INSERT INTO club_members VALUES
 ('{A}','{U}','owner','active',117,0,'2025-01-01'),
 ('{B}','{U}','owner','active',0,0,'2025-01-01'),
 ('{B}','{P}','player','active',76,0,'2025-01-01'),
 ('{B}','{Q}','player','active',3,0,'2025-01-01'),
 ('{F}','{U}','owner','active',5,0,'2025-01-01');
INSERT INTO ca_chip_baseline VALUES
 ('{A}','{U}',100,'2026-01-01 00:00+00'),
 ('{B}','{U}',0,'2026-01-01 00:00+00'),('{B}','{P}',50,'2026-01-01 00:00+00'),('{B}','{Q}',0,'2026-01-01 00:00+00'),
 ('{F}','{U}',0,'2026-01-01 00:00+00');
INSERT INTO chip_ledger(club_id,from_type,from_entity_id,to_type,to_entity_id,amount,created_at,status) VALUES
 ('{A}','club_treasury','{A}','player_wallet','{U}',10,'2026-01-02 10:00+00','posted'),
 ('{B}','club_treasury','{A}','player_wallet','{P}',30,'2026-01-03 10:25+00','posted'),
 ('{B}','player_wallet','{P}','club_treasury','{A}',4,'2026-01-04 10:00+00','posted'),
 ('{A}','club_treasury','{B}','player_wallet','{U}',7,'2026-01-05 10:00+00','posted'),
 ('{A}','club_treasury','{B}','player_wallet','{U}',2,'2026-01-05 11:00+00','correction'),
 ('{A}','player_wallet','{U}','club_treasury','{B}',2,'2026-01-05 12:00+00','reversal'),
 ('{B}','club_treasury','{B}','player_wallet','{Q}',3,'2026-01-05 14:00+00','posted'),
 ('{F}','club_treasury','{F}','player_wallet','{U}',5,'2026-01-06 10:00+00','posted'),
 -- before every baseline: never counted by either read
 ('{B}','club_treasury','{A}','player_wallet','{P}',999,'2025-12-31 23:59:59+00','posted');
""")
    # Every leg is filed under the club of its player wallet, as production does.
    # Bank A: 1000 - 10 - 30 + 4 = 964. Bank B: 500 - 7 - 2 + 2 - 3 = 490.
    # U in A: 100 + 10 + 7 + 2 - 2 = 117. P in B: 50 + 30 - 4 = 76. Q in B: 3.
    # F: bank 200 - 5 = 195, U 5.

    # The predecessor misreads both banks by exactly the cross-filed legs.
    run('predecessor-misreads-the-paying-bank', bank(A), 'attention|964|990|-26')
    run('predecessor-misreads-a-bank-whose-legs-are-filed-under-another-club', bank(B), 'attention|490|497|-7')
    run('predecessor-reads-a-club-without-cross-filed-legs', bank(F), 'verified|195|195|0')

    if args.predecessor_only:
        # Demonstrates the defect: assert the FIXED answers against the predecessor.
        run('fixed-answer-against-predecessor', bank(A), 'verified|964|964|0')

    # Guards: a changed posture with an identical body is refused whole.
    run('drift-the-acl', 'GRANT EXECUTE ON FUNCTION fn_cashier_conservation_report(uuid) TO anon;')
    run('changed-acl-refused', NEW.read_text(), refused='55000')
    run('restore-the-acl', 'REVOKE EXECUTE ON FUNCTION fn_cashier_conservation_report(uuid) FROM anon;')
    run('refusal-preserves-the-preimage',
        "SELECT md5(pg_get_functiondef('fn_cashier_conservation_report(uuid)'::regprocedure));", PREIMAGE)
    run('drifted-preimage-refused', NEW.read_text().replace(
        f"IS DISTINCT FROM '{PREIMAGE}'", "IS DISTINCT FROM 'not-the-installed-definition'"), refused='55000')

    run('guarded-install', NEW.read_text())
    installed = run('installed-definition',
                    "SELECT md5(pg_get_functiondef('fn_cashier_conservation_report(uuid)'::regprocedure));")
    results['installed_definition_md5'] = installed
    results['installed_prosrc_md5'] = run('installed-prosrc',
        "SELECT md5(prosrc) FROM pg_proc WHERE oid='fn_cashier_conservation_report(uuid)'::regprocedure;")
    # Qualify this historical bank-entity postimage independently of the
    # current production canary, which the journal-origin successor owns.
    assert installed == '8b13c8eee26460f44bbf977136635c5d', installed
    results['cases'].append({'name': 'exact-bank-entity-postimage', 'passed': True})
    run('replay-refused', NEW.read_text(), refused='55000')

    # THE FIX: every bank is read by its own entity.
    run('a-payout-from-bank-a-filed-under-club-b-counts-against-bank-a', bank(A), 'verified|964|964|0')
    run('a-debit-of-bank-b-filed-under-club-a-counts-against-bank-b', bank(B), 'verified|490|490|0')
    run('a-club-without-cross-filed-legs-is-unchanged', bank(F), 'verified|195|195|0')
    # The player side still reads wallets by their club: unchanged and exact.
    run('payee-wallet-club-players-verified', players(B), 'verified|3|0')
    run('paying-club-players-verified', players(A), 'verified|1|0')
    for club in (A, B, F):
        run('player-side-and-inventory-identical-to-predecessor-' + club[-2:], same_except_bank(club), 't')
    run('whole-report-identical-without-cross-filed-legs', same_whole(F), 't')

    # The sealed-day player read is untouched: seal every finished day and the
    # answers do not move.
    run('attest-and-seal', ATTEST + 'SELECT public.fn_ca_chip_wallet_day_seal(1000);')
    run('sealed-paying-bank', bank(A), 'verified|964|964|0')
    run('sealed-payee-club-players', players(B), 'verified|3|0')
    for club in (A, B, F):
        run('sealed-player-side-identical-' + club[-2:], same_except_bank(club), 't')

    # A real shortfall is still reported: chips leaving the bank with no leg.
    run('unledgered-debit', f"UPDATE clubs SET chip_treasury=chip_treasury-1.5 WHERE id='{A}';")
    run('a-real-shortfall-is-still-attention', bank(A), 'attention|962.5|964|-1.5')
    run('restore-bank', f"UPDATE clubs SET chip_treasury=964 WHERE id='{A}';")
    run('no-bank-baseline-is-incomplete',
        f"DELETE FROM ca_treasury_baseline WHERE club_id='{F}';" + claims() +
        f"SELECT public.fn_cashier_conservation_report('{F}')->'bank'->>'status';", 'incomplete')

    # Posture: identical to production.
    run('report-posture', "SELECT prosecdef AND provolatile='s' AND pg_get_userbyid(proowner)='postgres'"
        " AND proconfig=ARRAY['search_path=public, pg_temp']"
        " AND proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'"
        " FROM pg_proc WHERE oid='fn_cashier_conservation_report(uuid)'::regprocedure;", 't')
    run('player-refused', claims().replace(U, P) + f"SELECT public.fn_cashier_conservation_report('{B}');",
        refused='42501')
    run('missing-session-refused', f"SELECT public.fn_cashier_conservation_report('{A}');", refused='42501')
    run('read-only-report', 'BEGIN READ ONLY;' + claims() +
        f"SELECT public.fn_cashier_conservation_report('{A}')->>'scope'; COMMIT;", 'bank_and_player_baselines')
    results['passed'] = True
finally:
    command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    (out / 'result.json').write_text(json.dumps(results, indent=2) + '\n')
    shutil.rmtree(cluster)
print(json.dumps(results))
