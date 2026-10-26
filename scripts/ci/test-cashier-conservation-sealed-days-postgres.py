#!/usr/bin/env python3
"""Qualify the sealed-day conservation read in disposable PostgreSQL.

Issue #7309: fn_cashier_conservation_report re-added every chip_ledger
player-wallet leg since the club baseline on every call (1,069,678 legs for
Club JAQK, 4.5 s cold) and Reconcile Now hit the 8 s statement timeout.
20261017184739 seals finished UTC days into per-member totals and reads only
the cutoff day, the unsealed tail and the sealed totals.

Every case below compares the WHOLE report (minus as_of) with the exact
installed predecessor, which still reads the full journal.
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
OLD = ROOT / 'supabase/migrations/20261016230420_cashier_conservation_reads_cutoff_statistics_from_the_baseli.sql'
NEW = ROOT / 'supabase/migrations/20261017184739_cashier_conservation_reads_sealed_wallet_days.sql'
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
cluster = Path(tempfile.mkdtemp(prefix='sealed-days-pg-', dir=scratch))
socket = cluster / 's'
socket.mkdir()
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
psql = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
        '-h', str(socket), '-p', '55784', '-U', 'postgres', '-d', 'postgres']
results = {'scope': 'cashier conservation sealed wallet days', 'cases': [], 'passed': False}


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


def nodes(n):
    yield n
    for c in n.get('Plans', []):
        yield from nodes(c)


C = '00000000-0000-0000-0000-0000000000c1'
D = '00000000-0000-0000-0000-0000000000c2'
U = '00000000-0000-0000-0000-000000000001'
V = '00000000-0000-0000-0000-000000000002'
W = '00000000-0000-0000-0000-000000000003'
X = '00000000-0000-0000-0000-000000000004'
call = f"public.fn_cashier_conservation_report('{C}')"
claims = f"SET ROLE authenticated; SET request.jwt.claims='{{\"sub\":\"{U}\"}}'; "
SEAL = 'SELECT public.fn_ca_chip_wallet_day_seal(1000);'
ATTEST = """
INSERT INTO ca_ledger_day_manifests(day,row_count,sha256)
SELECT (created_at AT TIME ZONE 'UTC')::date, count(*), md5(string_agg(id::text||':'||amount::text, ',' ORDER BY id))
FROM chip_ledger GROUP BY 1
ON CONFLICT (day) DO UPDATE SET row_count=excluded.row_count, sha256=excluded.sha256;
"""


def equivalent(name, setup=''):
    run(name, setup + claims +
        f"SELECT ({call}-'as_of')=(public.conservation_before('{C}')-'as_of');", 't')


def totals_match(name):
    # Every sealed day's stored nets are exactly the journal's nets for that day.
    run(name, """
WITH j AS (
  SELECT l.club_id, (l.created_at AT TIME ZONE 'UTC')::date AS day, s.uid, sum(s.amt) AS net
  FROM chip_ledger l
  CROSS JOIN LATERAL (VALUES
    (CASE WHEN l.to_type='player_wallet' THEN l.to_entity_id END, l.amount),
    (CASE WHEN l.from_type='player_wallet' THEN l.from_entity_id END, -l.amount)) s(uid, amt)
  WHERE l.club_id IS NOT NULL AND s.uid IS NOT NULL
    AND (l.to_type='player_wallet' OR l.from_type='player_wallet')
    AND (l.created_at AT TIME ZONE 'UTC')::date IN (SELECT day FROM ca_chip_wallet_day_seals)
  GROUP BY 1,2,3)
SELECT count(*) FROM (
  (SELECT club_id, day, uid, net FROM j EXCEPT SELECT club_id, day, user_id, net FROM ca_chip_wallet_day_totals)
  UNION ALL
  (SELECT club_id, day, user_id, net FROM ca_chip_wallet_day_totals EXCEPT SELECT club_id, day, uid, net FROM j)) d;
""", '0')


try:
    r = command([pg / 'initdb', '-D', cluster / 'data', '-A', 'trust', '-U', 'postgres'])
    assert r.returncode == 0, r.stderr
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'postgres.log',
                 '-o', f'-k {socket} -p 55784 -c listen_addresses= -c fsync=off -c TimeZone=America/Chicago',
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
CREATE TABLE ca_ledger_day_manifests(day date PRIMARY KEY,row_count bigint,sha256 text);
CREATE FUNCTION fn_cashier_member_is_active(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS
 $$SELECT EXISTS(SELECT 1 FROM club_members WHERE club_id=$1 AND user_id=$2 AND status='active')$$;
CREATE FUNCTION fn_club_bank_role(uuid,uuid) RETURNS text LANGUAGE sql STABLE AS
 $$SELECT role FROM club_members WHERE club_id=$1 AND user_id=$2$$;
INSERT INTO profiles VALUES ('{U}',NULL);
INSERT INTO clubs VALUES ('{C}','chips',500),('{D}','chips',900);
INSERT INTO ca_treasury_baseline VALUES ('{C}',500,'2026-01-01 00:00+00');
INSERT INTO club_members VALUES
 ('{C}','{U}','owner','active',100,0,'2025-01-01'),
 ('{C}','{V}','player','active',200,0,'2025-01-01'),
 ('{C}','{W}','player','active',0,0,'2026-01-03'),
 ('{C}','{X}','player','active',0,0,'2025-01-01'),
 ('{D}','{U}','player','active',50,0,'2025-01-01');
-- U's cutoff is exactly midnight UTC; V's is mid-day; W joined after both (checked from zero).
INSERT INTO ca_chip_baseline VALUES
 ('{C}','{U}',100,'2026-01-01 00:00+00'),('{C}','{V}',200,'2026-01-02 13:00+00'),
 ('{D}','{U}',50,'2026-01-04 06:00+00');
-- Legs across nine UTC days, both sides, every status, other clubs, non-player
-- sides, a NULL wallet entity, and rows on each side of every UTC midnight.
INSERT INTO chip_ledger(club_id,from_type,from_entity_id,to_type,to_entity_id,amount,created_at,status)
SELECT CASE WHEN i % 11 = 0 THEN '{D}'::uuid WHEN i % 13 = 0 THEN NULL ELSE '{C}'::uuid END,
  CASE WHEN i % 5 = 0 THEN 'club_treasury' ELSE 'player_wallet' END,
  (ARRAY['{U}','{V}','{W}','{X}'])[1 + i % 4]::uuid,
  CASE WHEN i % 7 = 0 THEN 'table_stack' ELSE 'player_wallet' END,
  CASE WHEN i % 17 = 0 THEN NULL ELSE (ARRAY['{V}','{W}','{X}','{U}'])[1 + (i / 3) % 4]::uuid END,
  ((i % 97) + 1) / 4.0,
  timestamptz '2026-01-01 00:00+00' + (i * interval '17 minutes 3 seconds'),
  (ARRAY['posted','correction','reversal'])[1 + i % 3]
FROM generate_series(0, 760) i;
INSERT INTO chip_ledger(club_id,from_type,from_entity_id,to_type,to_entity_id,amount,created_at,status)
SELECT '{C}','player_wallet','{U}','player_wallet','{V}',1.25,t,'posted'
FROM unnest(ARRAY[timestamptz '2026-01-03 23:59:59.999999+00', '2026-01-04 00:00:00+00',
  '2026-01-02 12:59:59.999999+00', '2026-01-02 13:00:00+00']) t;
-- A few legs today, which can never be sealed.
INSERT INTO chip_ledger(club_id,from_type,from_entity_id,to_type,to_entity_id,amount,created_at,status)
SELECT '{C}','player_wallet','{V}','player_wallet','{U}',2.5,now() - (i * interval '1 second'),'posted'
FROM generate_series(1,3) i;
""" + ATTEST)
    before = definition(OLD)
    run('installed-preimage', before + "REVOKE ALL ON FUNCTION fn_cashier_conservation_report(uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION fn_cashier_conservation_report(uuid) TO authenticated,service_role;")
    run('preimage-is-the-production-definition',
        "SELECT md5(pg_get_functiondef('fn_cashier_conservation_report(uuid)'::regprocedure));",
        'f3728357280a30789ff8d7bb30140eae')
    run('before-reference', before.replace('fn_cashier_conservation_report', 'conservation_before'))
    migration = NEW.read_text()
    run('guarded-install', migration)
    # This historical migration has its own exact postimage. The current
    # production canary belongs to the later journal-origin qualifier.
    installed = run('installed-definition',
        "SELECT md5(pg_get_functiondef('fn_cashier_conservation_report(uuid)'::regprocedure));",
        '884cbcbfae7f556ef0d5972e7e9b24c9')
    results['installed_definition_md5'] = installed
    run('replay-refused', migration, refused='55000')
    equivalent('nothing-sealed-reads-the-whole-journal')

    out_seal = run('seal-every-finished-day', SEAL)
    sealed = json.loads(out_seal)
    assert sealed['ran'] and '2026-01-02' in sealed['sealed'] and sealed['waiting'] is None, sealed
    run('the-cutoff-day-itself-is-not-sealed-before-the-first-cutoff-day',
        "SELECT min(day) FROM ca_chip_wallet_day_seals;", '2026-01-02')
    run('today-is-never-sealed',
        "SELECT count(*) FROM ca_chip_wallet_day_seals WHERE day >= (now() AT TIME ZONE 'UTC')::date;", '0')
    run('an-empty-day-is-sealed-without-a-manifest',
        "SELECT count(*) > 0 FROM ca_chip_wallet_day_seals WHERE manifest_sha256 IS NULL AND ledger_rows = 0;", 't')
    totals_match('stored-nets-equal-the-journal')
    equivalent('sealed-days-give-the-identical-report')
    again = json.loads(run('reseal-is-idempotent', SEAL))
    assert again['sealed'] == [] and again['withdrawn'] == [], again
    run('nothing-sealed-before-the-first-cutoff-day',
        "SELECT count(*) FROM ca_chip_wallet_day_seals WHERE day < '2026-01-02';", '0')
    equivalent('still-identical-after-a-second-run')

    # A restated manifest (authorised maintenance) makes that day raw again at
    # once, before any reseal, and the next run reseals it against the new hash.
    run('restate-a-sealed-day', "UPDATE ca_ledger_day_manifests SET sha256='restated' WHERE day='2026-01-05';")
    equivalent('a-restated-day-is-read-raw-until-resealed')
    reseal = json.loads(run('reseal-restated-day', SEAL))
    assert '2026-01-05' in reseal['withdrawn'] and '2026-01-05' in reseal['sealed'], reseal
    run('reseal-carries-the-new-hash',
        "SELECT manifest_sha256 FROM ca_chip_wallet_day_seals WHERE day='2026-01-05';", 'restated')
    equivalent('identical-after-reseal')

    # A row that reached a sealed day afterwards is caught by the daily re-count;
    # the day then stays raw until its manifest attests the same rows.
    run('late-row-in-a-sealed-day', f"""
INSERT INTO chip_ledger(club_id,from_type,from_entity_id,to_type,to_entity_id,amount,created_at,status)
VALUES ('{C}','club_treasury','{C}','player_wallet','{V}',9,'2026-01-06 08:00+00','posted');
UPDATE ca_chip_wallet_day_seals SET checked_at = now() - interval '2 days' WHERE day='2026-01-06';""")
    late = json.loads(run('recount-withdraws-it', SEAL))
    assert '2026-01-06' in late['withdrawn'] and '2026-01-06' not in late['sealed'], late
    assert 'manifest attests' in (late['waiting'] or ''), late
    equivalent('a-withdrawn-day-is-read-raw')
    run('attest-the-late-row', ATTEST)
    late2 = json.loads(run('reseal-after-attestation', SEAL))
    assert '2026-01-06' in late2['sealed'], late2
    totals_match('stored-nets-equal-the-journal-after-reseal')
    equivalent('identical-after-attestation')

    # A day with rows and no manifest yet is not sealed, nor is anything after it.
    run('unattested-day', f"""
DELETE FROM ca_chip_wallet_day_seals WHERE day >= '2026-01-08';
DELETE FROM ca_ledger_day_manifests WHERE day = '2026-01-08';""")
    pending = json.loads(run('seal-stops-at-an-unattested-day', SEAL))
    assert 'not been attested' in (pending['waiting'] or ''), pending
    run('nothing-after-it-is-sealed', "SELECT count(*) FROM ca_chip_wallet_day_seals WHERE day >= '2026-01-08';", '0')
    equivalent('an-unattested-day-and-everything-after-it-is-read-raw')
    run('restore-attestation', ATTEST + SEAL)
    equivalent('identical-with-every-day-sealed-again')

    equivalent('orphan-baseline', f"INSERT INTO ca_chip_baseline VALUES ('{C}',gen_random_uuid(),7,'2026-01-02 05:00+00');")
    equivalent('future-baseline', f"UPDATE ca_chip_baseline SET taken_at=now()+interval '1 day' WHERE user_id='{V}' AND club_id='{C}';")
    equivalent('today-baseline', f"UPDATE ca_chip_baseline SET taken_at=now()-interval '1 second' WHERE user_id='{V}' AND club_id='{C}';")
    equivalent('null-baseline', f"UPDATE ca_chip_baseline SET taken_at=NULL WHERE user_id='{V}' AND club_id='{C}';")
    equivalent('late-cutoff-after-sealed-days', f"UPDATE ca_chip_baseline SET taken_at='2026-01-07 21:30+00' WHERE user_id='{V}' AND club_id='{C}';")
    equivalent('no-player-baselines', f"DELETE FROM ca_chip_baseline WHERE club_id='{C}';")
    equivalent('no-bank-baseline', 'DELETE FROM ca_treasury_baseline;')
    run('restore-baselines', f"""
INSERT INTO ca_chip_baseline VALUES ('{C}','{U}',100,'2026-01-01 00:00+00'),('{C}','{V}',200,'2026-01-02 13:00+00');
INSERT INTO ca_treasury_baseline VALUES ('{C}',500,'2026-01-01 00:00+00');""")
    equivalent('restored-baselines')

    for role in ['owner', 'co_owner', 'admin']:
        run('active-'+role, f"UPDATE club_members SET role='{role}' WHERE user_id='{U}' AND club_id='{C}';" + claims + f"SELECT {call}->>'scope';", 'bank_and_player_baselines')
    run('player-refused', f"UPDATE club_members SET role='player' WHERE user_id='{U}' AND club_id='{C}';" + claims + f'SELECT {call};', refused='42501')
    run('restore-owner', f"UPDATE club_members SET role='owner' WHERE user_id='{U}' AND club_id='{C}';")
    run('missing-session-refused', f'SELECT {call};', refused='42501')
    run('read-only-report', 'BEGIN READ ONLY;' + claims + f"SELECT {call}->>'scope'; COMMIT;", 'bank_and_player_baselines')
    run('report-posture', "SELECT prosecdef AND provolatile='s' AND pg_get_userbyid(proowner)='postgres' AND proconfig=ARRAY['search_path=public, pg_temp'] AND NOT has_function_privilege('anon',oid,'EXECUTE') AND has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='fn_cashier_conservation_report(uuid)'::regprocedure;", 't')
    run('seal-is-not-callable-by-a-player', claims + 'SELECT public.fn_ca_chip_wallet_day_seal(1);', refused='42501')
    run('totals-are-not-readable-by-a-player', claims + 'SELECT count(*) FROM public.ca_chip_wallet_day_totals;', refused='42501')
    run('seals-are-not-readable-by-a-player', claims + 'SELECT count(*) FROM public.ca_chip_wallet_day_seals;', refused='42501')
    run('scheduled-hourly', "SELECT schedule||' '||command FROM cron.job WHERE jobname='ca-chip-wallet-day-seal';",
        '30 * * * * SELECT public.fn_ca_chip_wallet_day_seal()')

    # PRESSURE. 400,000 legs on finished days and a small tail today: the
    # predecessor reads every one; the sealed read touches only the cutoff day
    # and today, whatever the history holds.
    run('pressure-fixture', f"""
INSERT INTO club_members SELECT '{C}',md5(i::text)::uuid,'player','active',0,0,'2025-01-01' FROM generate_series(1,590)i;
INSERT INTO ca_chip_baseline SELECT club_id,user_id,0,'2026-01-01 00:00+00' FROM club_members
 WHERE club_id='{C}' AND user_id NOT IN ('{U}','{V}');
INSERT INTO chip_ledger(club_id,from_type,from_entity_id,to_type,to_entity_id,amount,created_at,status)
SELECT '{C}','player_wallet',md5((i%590+1)::text)::uuid,'player_wallet',md5(((i+7)%590+1)::text)::uuid,1,
 timestamptz '2026-01-10 00:00+00' + (i * interval '37 seconds'),'posted' FROM generate_series(1,400000)i;
INSERT INTO chip_ledger(club_id,from_type,from_entity_id,to_type,to_entity_id,amount,created_at,status)
SELECT '{C}','player_wallet',md5((i%590+1)::text)::uuid,'player_wallet','{U}',1,now()-(i*interval '1 second'),'posted'
FROM generate_series(1,500)i;
""" + ATTEST)
    run('pressure-seal', SEAL)
    run('pressure-cover-visible', 'VACUUM (FREEZE,ANALYZE) chip_ledger; ANALYZE ca_chip_baseline; ANALYZE club_members; ANALYZE ca_chip_wallet_day_totals; ANALYZE ca_chip_wallet_day_seals;')
    totals_match('pressure-stored-nets-equal-the-journal')
    equivalent('pressure-whole-report-identical')
    # What the sealed read still owes raw: each cutoff's own UTC day from the
    # cutoff, plus today (every finished day is sealed), once per cutoff.
    owed_sql = f"""
SELECT sum(x.n) FROM (SELECT DISTINCT taken_at FROM ca_chip_baseline WHERE club_id='{C}' AND taken_at IS NOT NULL) k
CROSS JOIN LATERAL (SELECT count(*) AS n FROM chip_ledger l
  WHERE l.club_id='{C}' AND (l.to_type='player_wallet' OR l.from_type='player_wallet')
    AND ((l.created_at >= k.taken_at
          AND l.created_at < (((k.taken_at AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC'))
      OR l.created_at >= ((now() AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC'))) x;"""
    owed = int(run('pressure-raw-rows-owed', owed_sql))
    plans = {}
    for label, source in [('before', before), ('after', definition(NEW))]:
        query = source[source.index('WITH bank AS MATERIALIZED'):source.index('  IF v_report IS NULL')].replace(' INTO v_report', '').replace('p_club_id', '$1')
        raw = run('pressure-generic-plan-'+label, "SET work_mem='4MB'; SET plan_cache_mode='force_generic_plan'; PREPARE report(uuid) AS " + query + f"EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) EXECUTE report('{C}');")
        plan = json.loads(raw)[0]
        (out / f'pressure-{label}.json').write_text(json.dumps(plan, indent=2))
        plans[label] = plan

    def ledger_rows(plan):
        # Every chip_ledger scan, whichever index the planner chose.
        return sum(n['Actual Rows'] * n['Actual Loops'] for n in nodes(plan['Plan'])
                   if n.get('Relation Name') == 'chip_ledger')
    before_rows, after_rows = ledger_rows(plans['before']), ledger_rows(plans['after'])
    # "Today" is read from now() in each session. A run that crosses 00:00 UTC
    # between the owed count and the measured read sees two different todays
    # (2026-10-26 00:02 UTC: 417 read against 418 owed). Count again after the
    # read; the band must hold for the today the read actually used.
    owed_after = int(run('pressure-raw-rows-owed-after', owed_sql))
    results['pressure'] = {'before_ledger_rows': before_rows, 'after_ledger_rows': after_rows,
                           'raw_rows_owed': owed, 'raw_rows_owed_after': owed_after}
    assert before_rows > 800000, before_rows
    # The bank's two treasury sums add a handful of rows; nothing else is read.
    assert any(o <= after_rows <= o + 10 for o in {owed, owed_after}), (after_rows, owed, owed_after)
    assert plans['after']['Plan']['Temp Written Blocks'] == 0, 'Sealed read must not spill'
    results['cases'].append({'name': 'pressure-reads-only-the-cutoff-day-and-today', 'passed': True})

    run('drifted-preimage-refused', NEW.read_text().replace(
        "IS DISTINCT FROM 'f3728357280a30789ff8d7bb30140eae'", "IS DISTINCT FROM 'not-the-installed-definition'"),
        refused='55000')
    results['passed'] = True
finally:
    command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    (out / 'result.json').write_text(json.dumps(results, indent=2) + '\n')
    shutil.rmtree(cluster)
print(json.dumps(results))

# Keep the bank-entity regression (20261019093951, issue #7321) in this
# required Cashier native lane: it installs this migration's definition as its
# exact production predecessor and qualifies the bank read built on it.
subprocess.run([
    sys.executable, str(ROOT / 'scripts/ci/test-cashier-conservation-bank-entity-postgres.py'),
    '--output', str(out / 'bank-entity'),
], env={**os.environ, 'PG_BIN': str(pg)}, check=True)
