#!/usr/bin/env python3
"""Execute the per-MTT progress reader over private synthetic PostgreSQL rows.

No database URL is accepted. This checks classification, read-only behavior and
RPC grants; it does not deal hands, test the collector or load alert rules.
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
migrations = list((repo / 'supabase/migrations').glob('*_tournament_progress_is_measured_per_event.sql'))
assert len(migrations) == 1
migration = migrations[0]
configured = os.environ.get('POKER_AUDIT_PG_BIN') or os.environ.get('PGBIN')
pg = Path(configured) if configured else Path(subprocess.check_output(
    ['brew', '--prefix', 'postgresql@17'], text=True).strip()) / 'bin'
root = Path(tempfile.mkdtemp(prefix='ca-tp-'))
cluster, sock = root / 'db', root / 's'
sock.mkdir()
port = str(35000 + os.getpid() % 10000)
env = dict(os.environ, PGHOST=str(sock), PGHOSTADDR='', PGPORT=port,
           PGUSER='progress_test', PGDATABASE='postgres')
passed = []
started = False
event = 'c3000000-0000-4000-8000-000000000001'
query = 'SELECT row_to_json(m) FROM public.fn_tournament_progress_metrics() m;'
with (root / 'results.log').open('w') as log:
    def command(args):
        subprocess.run(args, stdout=log, stderr=log, check=True, timeout=40)
        log.flush()

    def q(sql, error=None):
        with tempfile.TemporaryFile(mode='w+') as request:
            request.write(sql + '\n')
            request.seek(0)
            result = subprocess.run([str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
                                    stdin=request, capture_output=True, text=True, env=env, timeout=15)
        log.write(result.stdout + result.stderr)
        log.flush()
        if error:
            assert result.returncode != 0 and error in result.stderr, result.stderr
        else:
            assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def check(name, stalled, breaks):
        fingerprint = "SELECT md5(jsonb_build_array((SELECT jsonb_agg(t ORDER BY id) FROM tournaments t),(SELECT jsonb_agg(h ORDER BY created_at) FROM hand_history h))::text);"
        before = q(fingerprint)
        expected = dict(stalled_running=stalled, overdue_breaks=breaks)
        assert json.loads(q(query)) == expected, (name, q(query), expected)
        assert json.loads(q(query)) == expected, 'repeated classification changed'
        assert q(fingerprint) == before, 'monitor changed its source rows'
        passed.append(name)
        print('PASS ' + name, flush=True)

    def change(sql):
        q('UPDATE tournaments SET ' + sql + " WHERE id='" + event + "';")

    try:
        assert ' 17.' in subprocess.check_output([str(pg / 'postgres'), '--version'], text=True)
        command([str(pg / 'initdb'), '-D', str(cluster), '-U', 'progress_test', '--auth=trust', '--no-locale'])
        command([str(pg / 'pg_ctl'), '-D', str(cluster), '-o', f'-k {sock} -p {port} -c listen_addresses=', '-w', 'start'])
        started = True
        q("""CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
          CREATE TABLE tournaments (
            id uuid PRIMARY KEY, status text DEFAULT 'RUNNING', tournament_type text DEFAULT 'MTT',
            max_players int DEFAULT 100, on_break boolean DEFAULT false,
            started_at timestamptz DEFAULT now()-interval '2 hours',
            start_time timestamptz DEFAULT now()-interval '2 hours',
            created_at timestamptz DEFAULT now()-interval '1 day',
            break_started_at timestamptz, break_ends_at timestamptz, addon_period_ends_at timestamptz);
          CREATE TABLE hand_history (tournament_id uuid, created_at timestamptz DEFAULT now());
          CREATE INDEX ON hand_history(tournament_id,created_at DESC);
        """)
        q(migration.read_text())
        q(migration.read_text())
        check('empty tournament fleet is a proven zero', 0, 0)
        q("INSERT INTO tournaments(id) VALUES ('" + event + "'),('c3000000-0000-4000-8000-000000000002');"
          "INSERT INTO hand_history(tournament_id) VALUES ('c3000000-0000-4000-8000-000000000002'),(NULL);")
        check('busy cash and another healthy MTT cannot hide one stalled event', 1, 0)
        change("started_at=now()-interval '10 minutes'")
        check('newly launched MTT gets its startup grace', 0, 0)
        change("started_at=now()-interval '2 hours',on_break=true,break_started_at=now(),break_ends_at=now()+interval '5 minutes'")
        check('current synchronized break is not stalled play', 0, 0)
        change("break_ends_at=now()-interval '11 minutes'")
        check('expired break is counted separately from stalled play', 0, 1)
        change("break_ends_at=NULL,break_started_at=now()-interval '16 minutes'")
        check('missing countdown end cannot exempt a break indefinitely', 0, 1)
        change('break_started_at=NULL')
        check('missing break timestamps retain a bounded fallback', 0, 1)
        change("addon_period_ends_at=now()+interval '1 minute'")
        check('active add-on owns the remaining break window', 0, 0)
        change("addon_period_ends_at=now()-interval '5 minutes'")
        check('recent add-on end retains overdue-break grace', 0, 0)
        change("addon_period_ends_at=now()-interval '11 minutes'")
        check('break stuck beyond the later add-on deadline is visible', 0, 1)
        change('on_break=false')
        check('recent add-on end also retains play-recovery grace', 0, 0)
        change("addon_period_ends_at=now()-interval '16 minutes'")
        check('add-on recovery grace eventually expires', 1, 0)
        for kind in ['SNG', 'SPIN']:
            change("tournament_type='" + kind + "'")
            check(kind + ' seat-first format is not counted as a scheduled MTT', 0, 0)
        change("tournament_type='SATELLITE',max_players=2")
        check('heads-up satellite is excluded from the MTT denominator', 0, 0)
        change('max_players=100')
        check('multi-table satellite progress remains observable', 1, 0)
        for status in ['REGISTERING', 'COMPLETING', 'COMPLETED', 'CANCELLED']:
            change("status='" + status + "'")
            check(status + ' is not classified as stalled RUNNING play', 0, 0)
        change("status='RUNNING',started_at=NULL")
        check('missing launch timestamp cannot hide an old RUNNING event', 1, 0)
        q("INSERT INTO hand_history(tournament_id) VALUES ('" + event + "');")
        check('a new hand clears only its own event', 0, 0)
        expected = dict(stalled_running=0, overdue_breaks=0)
        assert json.loads(q('SET ROLE service_role; ' + query)) == expected
        for role in ['anon', 'authenticated']:
            q('SET ROLE ' + role + '; ' + query, 'permission denied')
        passed.append('only the service role can invoke the telemetry RPC')
        print('PASS ' + passed[-1], flush=True)
        body_md5 = q("SELECT md5(prosrc) FROM pg_proc WHERE oid='fn_tournament_progress_metrics(integer,integer)'::regprocedure;")
    finally:
        if started:
            subprocess.run([str(pg / 'pg_ctl'), '-D', str(cluster), '-m', 'fast', '-w', 'stop'],
                           stdout=log, stderr=log, check=True, timeout=30)
        shutil.rmtree(cluster, ignore_errors=True)

(root / 'results.json').write_text(json.dumps({
    'passed': passed, 'body_md5': body_md5, 'migration': str(migration.relative_to(repo)),
    'production_database_used': False,
    'scope': 'Progress reader over synthetic event/hand rows; no dealer or alert delivery.'
}, indent=2) + '\n')
print(f'{len(passed)} groups passed; evidence: {root / "results.json"}')
