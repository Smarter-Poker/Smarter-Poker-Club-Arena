#!/usr/bin/env python3
"""Qualify the read-only conservation cutoff plan in disposable PostgreSQL."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
OLD = ROOT / 'supabase/migrations/20261015022628_cashier_conservation_covers_members_who_joined_after_the_bas.sql'
NEW = ROOT / 'supabase/migrations/20261016230420_cashier_conservation_reads_cutoff_statistics_from_the_baseli.sql'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
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
cluster = Path(tempfile.mkdtemp(prefix='cutoff-pg-', dir=scratch))
socket = cluster / 's'
socket.mkdir()
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
psql = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
        '-h', str(socket), '-p', '55783', '-U', 'postgres', '-d', 'postgres']
results = {'scope': 'cashier conservation cutoff statistics', 'cases': [], 'passed': False}

def command(cmd, **kwargs):
    return subprocess.run([str(x) for x in cmd], env=env, text=True, capture_output=True,
                          timeout=180, **kwargs)

def run(name, sql, expected=None, refused=None):
    r = command(psql, input=sql)
    if refused:
        assert r.returncode and refused in r.stderr, (name, r.stderr)
    else:
        assert r.returncode == 0, (name, r.stderr)
        if expected is not None:
            assert r.stdout.strip() == expected, (name, r.stdout)
    results['cases'].append({'name': name, 'passed': True})
    return r.stdout.strip()

def definition(path):
    s = path.read_text()
    return s[s.index('CREATE OR REPLACE FUNCTION'):s.index('DO $postcondition$')]

def nodes(n):
    yield n
    for c in n.get('Plans', []):
        yield from nodes(c)

C = '00000000-0000-0000-0000-0000000000c1'
U = '00000000-0000-0000-0000-000000000001'
V = '00000000-0000-0000-0000-000000000002'
W = '00000000-0000-0000-0000-000000000003'
X = '00000000-0000-0000-0000-000000000004'
call = f"public.fn_cashier_conservation_report('{C}')"
claims = f"SET ROLE authenticated; SET request.jwt.claims='{{\"sub\":\"{U}\"}}'; "
def equivalent(name, setup=''):
    run(name, setup + claims + f"SELECT ({call}-'as_of')=(public.conservation_before('{C}')-'as_of');", 't')

try:
    r = command([pg / 'initdb', '-D', cluster / 'data', '-A', 'trust', '-U', 'postgres'])
    assert r.returncode == 0, r.stderr
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'postgres.log',
                 '-o', f'-k {socket} -p 55783 -c listen_addresses= -c fsync=off', '-w', 'start'])
    assert r.returncode == 0, r.stderr
    run('minimal-report-schema', f"""
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
 $$SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
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
CREATE TABLE chip_ledger(club_id uuid,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,
 amount numeric,created_at timestamptz,status text NOT NULL CHECK(status IN ('posted','correction','reversal')));
CREATE FUNCTION fn_cashier_member_is_active(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS
 $$SELECT EXISTS(SELECT 1 FROM club_members WHERE club_id=$1 AND user_id=$2 AND status='active')$$;
CREATE FUNCTION fn_club_bank_role(uuid,uuid) RETURNS text LANGUAGE sql STABLE AS
 $$SELECT role FROM club_members WHERE club_id=$1 AND user_id=$2$$;
INSERT INTO profiles VALUES ('{U}',NULL);
INSERT INTO clubs VALUES ('{C}','chips',500);
INSERT INTO ca_treasury_baseline VALUES ('{C}',500,'2026-01-01');
INSERT INTO club_members VALUES
 ('{C}','{U}','owner','active',100,0,'2025-01-01'),
 ('{C}','{V}','player','active',200,0,'2025-01-01'),
 ('{C}','{W}','player','active',0,0,'2026-01-03'),
 ('{C}','{X}','player','active',0,0,'2025-01-01');
INSERT INTO ca_chip_baseline VALUES
 ('{C}','{U}',100,'2026-01-01'),('{C}','{V}',200,'2026-01-02');
INSERT INTO chip_ledger VALUES
 ('{C}','player_wallet','{U}','player_wallet','{V}',5,'2026-01-01 12:00','posted'),
 ('{C}','player_wallet','{V}','player_wallet','{U}',2,'2026-01-03','correction'),
 ('{C}','player_wallet','{U}','club_treasury','{C}',3,'2026-01-04','reversal');
""")
    before = definition(OLD)
    run('installed-preimage', before + "REVOKE ALL ON FUNCTION fn_cashier_conservation_report(uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION fn_cashier_conservation_report(uuid) TO authenticated,service_role;")
    run('before-reference', before.replace('fn_cashier_conservation_report', 'conservation_before'))
    migration = NEW.read_text()
    run('guarded-install', migration)
    run('replay-refused', migration, refused='55000')
    equivalent('exact-peer-sides-individual-cutoffs-late-and-prebaseline-members')
    equivalent('orphan-baseline', f"INSERT INTO ca_chip_baseline VALUES ('{C}',gen_random_uuid(),7,'2026-01-02');")
    equivalent('future-baseline', f"UPDATE ca_chip_baseline SET taken_at=now()+interval '1 day' WHERE user_id='{V}';")
    equivalent('null-baseline', f"UPDATE ca_chip_baseline SET taken_at=NULL WHERE user_id='{V}';")
    equivalent('no-player-baselines', 'DELETE FROM ca_chip_baseline;')
    equivalent('no-bank-baseline', 'DELETE FROM ca_treasury_baseline;')
    run('non-chip-refused', f"UPDATE clubs SET asset='diamonds';" + claims + f'SELECT {call};', refused='22023')
    run('restore-asset', "UPDATE clubs SET asset='chips';")
    for role in ['owner', 'co_owner', 'admin']:
        run('active-'+role, f"UPDATE club_members SET role='{role}' WHERE user_id='{U}';" + claims + f"SELECT {call}->>'scope';", 'bank_and_player_baselines')
    run('player-refused', f"UPDATE club_members SET role='player' WHERE user_id='{U}';" + claims + f'SELECT {call};', refused='42501')
    run('suspended-owner-refused', f"UPDATE club_members SET role='owner',status='suspended' WHERE user_id='{U}';" + claims + f'SELECT {call};', refused='42501')
    run('deleted-owner-refused', f"UPDATE club_members SET status='active' WHERE user_id='{U}'; UPDATE profiles SET status='deleted';" + claims + f'SELECT {call};', refused='42501')
    run('missing-session-refused', f'SELECT {call};', refused='42501')
    run('null-club-refused', claims + 'SELECT fn_cashier_conservation_report(NULL);', refused='22023')
    run('read-only-posture', "SELECT prosecdef AND provolatile='s' AND pg_get_userbyid(proowner)='postgres' AND proconfig=ARRAY['search_path=public, pg_temp'] AND NOT has_function_privilege('anon',oid,'EXECUTE') AND has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='fn_cashier_conservation_report(uuid)'::regprocedure;", 't')
    run('pressure-fixture', f"""
UPDATE profiles SET status=NULL;
INSERT INTO club_members SELECT '{C}',md5(i::text)::uuid,'player','active',0,0,'2025-01-01' FROM generate_series(1,590)i;
INSERT INTO ca_chip_baseline SELECT club_id,user_id,0,'2026-01-01' FROM club_members WHERE club_id='{C}';
INSERT INTO chip_ledger SELECT '{C}','player_wallet',md5((i%590+1)::text)::uuid,
 'player_wallet',md5((i%590+1)::text)::uuid,1,'2026-01-03','posted' FROM generate_series(1,400000)i;
CREATE INDEX idx_chip_ledger_club_player_legs_cover ON chip_ledger(club_id,created_at)
 INCLUDE(to_type,from_type,to_entity_id,from_entity_id,amount)
 WHERE club_id IS NOT NULL AND (to_type='player_wallet' OR from_type='player_wallet');
ANALYZE ca_chip_baseline; ANALYZE club_members;
""")
    run('pressure-cover-visible', 'VACUUM (FREEZE,ANALYZE) chip_ledger;')
    equivalent('pressure-whole-report-identical')
    run('read-only-report', 'BEGIN READ ONLY;' + claims + f"SELECT {call}->>'scope'; COMMIT;", 'bank_and_player_baselines')
    plans = {}
    for label, source in [('before', before), ('after', definition(NEW))]:
        query = source[source.index('WITH bank AS MATERIALIZED'):source.index('  IF v_report IS NULL')].replace(' INTO v_report','').replace('p_club_id','$1')
        raw = run('pressure-generic-plan-'+label, "SET work_mem='4MB'; SET plan_cache_mode='force_generic_plan'; PREPARE report(uuid) AS " + query + f"EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) EXECUTE report('{C}');")
        plan = json.loads(raw)[0]
        (out / f'pressure-{label}.json').write_text(json.dumps(plan,indent=2))
        plans[label] = plan
    assert plans['before']['Plan']['Temp Written Blocks'] > 0, 'Before must reproduce excess cutoff hash batches'
    assert plans['after']['Plan']['Temp Written Blocks'] == 0, 'Candidate must eliminate artificial spill'
    for label, plan in plans.items():
        scan = [n for n in nodes(plan['Plan']) if n.get('Index Name') == 'idx_chip_ledger_club_player_legs_cover']
        assert len(scan) == 1 and scan[0]['Actual Loops'] == 1 and scan[0]['Heap Fetches'] == 0, (label,scan)
    results['cases'].append({'name': 'pressure-before-spills-after-single-cover-no-spill', 'passed': True})
    run('migration-drift-refused', "ALTER FUNCTION fn_cashier_conservation_report(uuid) SET statement_timeout='7s';" + migration, refused='55000')
    results['passed'] = True
finally:
    command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    (out / 'result.json').write_text(json.dumps(results,indent=2)+'\n')
    shutil.rmtree(cluster)
print(json.dumps(results))
