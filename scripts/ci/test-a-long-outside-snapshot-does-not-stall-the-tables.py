#!/usr/bin/env python3
"""A long outside snapshot does not stall the tables.

Migration 20261006170925_a_long_outside_snapshot_does_not_stall_the_tables
installs public.fn_ca_bound_outside_snapshots(interval) and its one-minute
schedule. On 2026-10-06 a full data export logged in as `postgres` held one
snapshot from 05:46:46 to 06:19:13 UTC; with the xmin horizon pinned, hand
settlement on the two ~350-player tournaments slowed past the 8 s statement
timeout (1,010 timeouts inside settlement, zero lock waits inside it) and the
tournament lanes queued behind the slow holders.

One disposable PostgreSQL cluster is laid out like production: a superuser
that is not `postgres` (supabase_admin), a NON-superuser `postgres` holding
pg_signal_backend and pg_read_all_stats, the API roles, and a stand-in for the
pg_cron schema. The SHIPPED migration is applied unchanged, as `postgres`.
The harness proves:

  DEFECT    while an outside REPEATABLE READ snapshot is open, VACUUM cannot
            remove a single dead version of a hot row (the horizon is pinned);
  BOUND     fn_ca_bound_outside_snapshots cancels that exporter's running
            statement, after which the same VACUUM removes every dead version;
  IDLE      an idle-in-transaction holder is terminated (a cancel cannot
            reach it) and a running one is cancelled, not terminated;
  SPARED    pg_cron, mgmt-api, apply-recorded-migration, antigravity-sql-push:*,
            an API role (not a postgres member), a superuser, a transaction
            younger than the bound and a session holding no snapshot are all
            left alone;
  READER    supabase_read_only_user is bounded too;
  LOG       every action is one row in ca_long_snapshot_cancellations;
  GUARD     the bound refuses values outside 1 second .. 30 minutes, and no
            API role can execute the function or read its log;
  SCHEDULE  exactly one active job, every minute, calling the function.

Run: PG_BIN=/usr/lib/postgresql/17/bin python3 -B scripts/ci/test-a-long-outside-snapshot-does-not-stall-the-tables.py
"""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]


def find_pg_bin():
    if os.environ.get('PG_BIN'):
        return Path(os.environ['PG_BIN'])
    for cand in sorted(Path('/usr/lib/postgresql').glob('*/bin'), reverse=True):
        if (cand / 'postgres').exists():
            return cand
    return Path('/opt/homebrew/opt/postgresql@17/bin')


PG = find_pg_bin()
AS_PG = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
ENV['LC_ALL'] = 'C'

found = sorted((ROOT / 'supabase/migrations').glob('*_a_long_outside_snapshot_does_not_stall_the_tables.sql'))
if len(found) != 1:
    raise RuntimeError(f'expected exactly one shipped migration, found {len(found)}')
SHIPPED = found[0].read_text()

# Production's shape, as read on 2026-10-06: supabase_admin is the superuser;
# postgres is NOT a superuser and holds pg_signal_backend + pg_read_all_stats;
# cli_login_postgres is a member of postgres. cron.schedule is stood in for.
BOOTSTRAP = r"""
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE;
GRANT pg_signal_backend, pg_read_all_stats TO postgres;
GRANT CREATE ON DATABASE app TO postgres;
GRANT ALL ON SCHEMA public TO postgres;
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE ROLE authenticator LOGIN NOINHERIT;
CREATE ROLE cli_login_postgres LOGIN; GRANT postgres TO cli_login_postgres;
CREATE ROLE supabase_read_only_user LOGIN;
GRANT pg_read_all_data TO supabase_read_only_user;
CREATE SCHEMA smarter_private AUTHORIZATION postgres;
CREATE SCHEMA cron AUTHORIZATION postgres;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text NOT NULL,
  command text NOT NULL, active boolean NOT NULL DEFAULT true, username text NOT NULL DEFAULT current_user);
ALTER TABLE cron.job OWNER TO postgres;
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command, active = true
  RETURNING jobid $$;
ALTER FUNCTION cron.schedule(text, text, text) OWNER TO postgres;
CREATE TABLE public.tournament_players (id int PRIMARY KEY, chips int NOT NULL);
ALTER TABLE public.tournament_players OWNER TO postgres;
ALTER TABLE public.tournament_players SET (autovacuum_enabled = false);
INSERT INTO public.tournament_players SELECT g, 1000 FROM generate_series(1, 50) g;
GRANT SELECT ON public.tournament_players TO authenticator;
"""

failures = []


def check(name, ok, detail=''):
    print(f"{'ok  ' if ok else 'FAIL'} {name}{(': ' + detail) if detail and not ok else ''}")
    if not ok:
        failures.append(name)


class Cluster:
    def __init__(self, port):
        self.dir = Path(tempfile.mkdtemp(prefix='long-snapshot-', dir='/tmp'))
        self.sock = self.dir / 'socket'
        self.sock.mkdir(mode=0o700)
        if AS_PG:
            shutil.chown(self.dir, 'postgres')
            shutil.chown(self.sock, 'postgres')
        self.port = str(port)
        subprocess.run(AS_PG + [str(PG / 'initdb'), '-D', str(self.dir / 'data'), '-U', 'supabase_admin', '-A', 'trust'],
                       env=ENV, check=True, capture_output=True)
        subprocess.run(AS_PG + [str(PG / 'pg_ctl'), '-D', str(self.dir / 'data'), '-l', str(self.dir / 'log'), '-w',
                        '-o', f"-k {self.sock} -p {self.port} -c listen_addresses='' -c fsync=off -c autovacuum=off",
                        'start'], env=ENV, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.psql('CREATE DATABASE app;', user='supabase_admin', db='postgres')

    def conninfo(self, user, app, db='app'):
        return f"host={self.sock} port={self.port} user={user} dbname={db} application_name='{app}'"

    def psql(self, sql, user='postgres', app='harness', db='app', check=True, timeout=120):
        r = subprocess.run([str(PG / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', self.conninfo(user, app, db)],
                           input=sql, text=True, capture_output=True, env=ENV, timeout=timeout)
        if check and r.returncode != 0:
            raise RuntimeError(r.stderr)
        return r

    def hold(self, user, app, sql):
        """Open a session that runs `sql` and then keeps its stdin open (and so its transaction)."""
        p = subprocess.Popen([str(PG / 'psql'), '-X', '-qAt', self.conninfo(user, app)],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=ENV)
        p.stdin.write(sql + '\n')
        p.stdin.flush()
        return p

    def stop(self):
        subprocess.run(AS_PG + [str(PG / 'pg_ctl'), '-D', str(self.dir / 'data'), '-m', 'immediate', 'stop'],
                       env=ENV, capture_output=True)
        shutil.rmtree(self.dir, ignore_errors=True)


def wait_for(c, predicate_sql, seconds=10):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if c.psql(predicate_sql, user='supabase_admin').stdout.strip() == 't':
            return True
        time.sleep(0.1)
    return False


def dead_not_removable(c):
    """Churn one hot row 200 times and return how many dead versions VACUUM had to keep."""
    c.psql('UPDATE public.tournament_players SET chips = chips + 1 WHERE id = 7;\n' * 200)
    r = c.psql('VACUUM (VERBOSE) public.tournament_players;', check=True)
    m = re.search(r'(\d+) are dead but not yet removable', r.stderr)
    if not m:
        raise RuntimeError(f'could not read VACUUM VERBOSE output: {r.stderr[-400:]}')
    return int(m.group(1))


def holder_alive(c, app):
    return c.psql(f"SELECT count(*) FROM pg_stat_activity WHERE application_name = '{app}'",
                  user='supabase_admin').stdout.strip() == '1'


def main():
    c = Cluster(56431)
    sessions = []
    try:
        c.psql(BOOTSTRAP, user='supabase_admin')

        # APPLY: the shipped file, unchanged, as postgres (not a superuser).
        r = c.psql(SHIPPED, check=False)
        check('APPLY the shipped migration installs as a non-superuser postgres', r.returncode == 0, r.stderr[-600:])
        if r.returncode != 0:
            return

        # SCHEDULE
        job = c.psql("SELECT schedule || '|' || active || '|' || (command LIKE '%fn_ca_bound_outside_snapshots()%')"
                     " FROM cron.job WHERE jobname = 'ca-bound-outside-snapshots-1m'").stdout.strip()
        check('SCHEDULE one active job every minute calling the function', job == '* * * * *|true|true', job)

        # GUARD: privileges and range.
        priv = c.psql("SELECT has_function_privilege('anon','public.fn_ca_bound_outside_snapshots(interval)','EXECUTE')"
                      " OR has_function_privilege('authenticated','public.fn_ca_bound_outside_snapshots(interval)','EXECUTE')"
                      " OR has_function_privilege('service_role','public.fn_ca_bound_outside_snapshots(interval)','EXECUTE')"
                      " OR has_table_privilege('service_role','smarter_private.ca_long_snapshot_cancellations','SELECT')"
                      " OR has_function_privilege('authenticator','public.fn_ca_bound_outside_snapshots(interval)','EXECUTE')").stdout.strip()
        check('GUARD no API role can execute the function or read its log', priv == 'f', priv)
        for bad in ("'0 seconds'", "'31 minutes'", 'NULL'):
            rr = c.psql(f'SELECT public.fn_ca_bound_outside_snapshots({bad}::interval);', check=False)
            check(f'GUARD the bound refuses {bad}', rr.returncode != 0 and 'CA_SNAPSHOT_BOUND_OUT_OF_RANGE' in rr.stderr,
                  rr.stderr[-200:])

        # DEFECT: an outside exporter's snapshot pins the horizon.
        baseline = dead_not_removable(c)
        check('DEFECT baseline: with no outside snapshot every dead version is removable', baseline == 0, str(baseline))
        exporter = c.hold('cli_login_postgres', 'club-arena-isolated-recovery-test',
                          'BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT count(*) FROM public.tournament_players; '
                          'SELECT pg_sleep(120);')
        sessions.append(exporter)
        wait_for(c, "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = "
                    "'club-arena-isolated-recovery-test' AND state = 'active' AND backend_xmin IS NOT NULL)")
        pinned = dead_not_removable(c)
        check('DEFECT an outside REPEATABLE READ snapshot keeps every dead version of a hot row', pinned >= 200, str(pinned))

        # Bounded, besides the exporter: an idle-in-transaction holder and the dashboard reader.
        sessions.append(c.hold('postgres', 'psql-idle-holder',
                               'BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT 1 FROM public.tournament_players LIMIT 1;'))
        sessions.append(c.hold('supabase_read_only_user', 'dashboard-reader',
                               'BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT 1 FROM public.tournament_players LIMIT 1;'))
        wait_for(c, "SELECT count(*) = 2 FROM pg_stat_activity WHERE application_name IN "
                    "('psql-idle-holder','dashboard-reader') AND backend_xmin IS NOT NULL")
        time.sleep(1.6)

        # BOUND: one call, as the schedule makes it (as postgres, application pg_cron).
        out = c.psql("SELECT public.fn_ca_bound_outside_snapshots('1 second'::interval)::text;", app='pg_cron').stdout.strip()
        acted = int(re.search(r'"acted": (\d+)', out).group(1))
        check('BOUND the call acted on exactly the exporter, the idle holder and the reader', acted == 3, out)

        wait_for(c, "SELECT NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name IN "
                    "('psql-idle-holder','dashboard-reader') AND backend_xmin IS NOT NULL)")
        wait_for(c, "SELECT NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = "
                    "'club-arena-isolated-recovery-test' AND backend_xmin IS NOT NULL)")
        released = dead_not_removable(c)
        check('BOUND with the outside snapshots released every dead version is removable', released == 0, str(released))

        check('IDLE a running holder is cancelled, not terminated (its connection survives)',
              holder_alive(c, 'club-arena-isolated-recovery-test'))
        check('IDLE an idle-in-transaction holder is terminated', not holder_alive(c, 'psql-idle-holder'))
        check('READER supabase_read_only_user is bounded', c.psql(
            "SELECT NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name='dashboard-reader' "
            "AND backend_xmin IS NOT NULL)", user='supabase_admin').stdout.strip() == 't')

        log = c.psql("SELECT string_agg(application_name || ':' || action || ':' || signalled, ',' ORDER BY application_name)"
                     " FROM smarter_private.ca_long_snapshot_cancellations").stdout.strip()
        check('LOG one row per action, with the right action and a delivered signal',
              log == 'club-arena-isolated-recovery-test:cancel:true,dashboard-reader:terminate:true,psql-idle-holder:terminate:true',
              log)

        # SPARED: everything that must be left alone, each holding a snapshot past the bound.
        spared = {
            'pg_cron': ('postgres', 'BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT 1 FROM public.tournament_players LIMIT 1;'),
            'mgmt-api': ('postgres', 'BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT 1 FROM public.tournament_players LIMIT 1;'),
            'apply-recorded-migration': ('postgres', 'BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT 1 FROM public.tournament_players LIMIT 1;'),
            'antigravity-sql-push:test': ('postgres', 'BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT 1 FROM public.tournament_players LIMIT 1;'),
            'PostgREST 14.5': ('authenticator', 'BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT 1 FROM public.tournament_players LIMIT 1;'),
            'superuser-session': ('supabase_admin', 'BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT 1 FROM public.tournament_players LIMIT 1;'),
            'no-snapshot-idle': ('cli_login_postgres', 'SELECT 1;'),
        }
        for app, (user, sql) in spared.items():
            sessions.append(c.hold(user, app, sql))
        wait_for(c, "SELECT count(*) = 6 FROM pg_stat_activity WHERE backend_xmin IS NOT NULL AND application_name IN "
                    "('pg_cron','mgmt-api','apply-recorded-migration','antigravity-sql-push:test','PostgREST 14.5',"
                    "'superuser-session')")
        wait_for(c, "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'no-snapshot-idle')")
        time.sleep(1.6)
        out_s = c.psql("SELECT public.fn_ca_bound_outside_snapshots('1 second'::interval)::text;", app='pg_cron').stdout.strip()
        check('SPARED the call acts on none of the spared sessions', '"acted": 0' in out_s, out_s)
        young = c.hold('postgres', 'young-holder',
                       'BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT 1 FROM public.tournament_players LIMIT 1;')
        sessions.append(young)
        wait_for(c, "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'young-holder' "
                    "AND backend_xmin IS NOT NULL)")
        for app in list(spared):
            alive = holder_alive(c, app)
            ok = c.psql(f"SELECT (backend_xmin IS NOT NULL OR state = 'idle') FROM pg_stat_activity "
                        f"WHERE application_name = '{app}'", user='supabase_admin').stdout.strip()
            check(f'SPARED {app} keeps its session and its transaction', alive and ok == 't', f'alive={alive} ok={ok}')
        out_y = c.psql("SELECT public.fn_ca_bound_outside_snapshots('30 minutes'::interval)::text;", app='pg_cron').stdout.strip()
        check('SPARED a transaction younger than the bound is left alone',
              '"acted": 0' in out_y and holder_alive(c, 'young-holder'), out_y)

    finally:
        for p in sessions:
            try:
                p.kill()
            except Exception:
                pass
        c.stop()

    if failures:
        raise SystemExit(f'{len(failures)} check(s) failed: {failures}')
    print('all checks passed')


if __name__ == '__main__':
    main()
