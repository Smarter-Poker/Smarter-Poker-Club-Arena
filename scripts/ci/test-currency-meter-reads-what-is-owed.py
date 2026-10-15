"""Isolated PostgreSQL regression for the currency meter's commission read.

ca-ledger-replay-nightly hit its 600 s statement_timeout on 2026-10-14 inside
fn_ca_currency_meter(): the commission statement aggregated the
agent_commissions_unsettled view, whose fn_ca_launch_accounting_accepts()
filter is a SECURITY DEFINER SQL function (never inlined) called once per row
over every settled_at IS NULL row ever written (21 M on production). The
replay and the meter shared one transaction, so the timeout rolled the
night's replay back too.

Migration 20261015034439 rewrites only that statement (pinned-preimage
substitution) and moves the meter to its own cron job. This test:

  * loads the exact production meter captured 2026-10-15 (md5 e58e5217...)
    and job 286's exact command (md5 12b1a4fb...);
  * proves on randomized books (overlapping, adjacent, empty and unbounded
    settlement periods; NULL and infinite created_at; NULL amounts; settled
    rows; clubs with and without a launch cutoff) that the new per-range read
    returns, per (club, agent), exactly what the view returns;
  * proves the meter's verdict is unchanged: 0 drifted against a correct
    rollup, the same drifted count and worst against a tampered one;
  * applies the migration as production would and proves the derived
    postimage md5, the split cron jobs, and that a second run is refused.

An empty throwaway cluster on a Unix socket; no network, no production
connection.
"""
import argparse
import json
import os
import pathlib
import random
import re
import shutil
import subprocess
import tempfile
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'currency-meter-reads-what-is-owed'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/currency-meter-reads-what-is-owed')
parser.add_argument('--seeds', type=int, default=40)
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='currency-meter-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55823'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

LIVE_METER_MD5 = 'e58e52177046c958f9daacb20a63fade'
POST_METER_MD5 = '183fd3efa020fbe1fed47a692b2b63f1'
LIVE_JOB_MD5 = '12b1a4fb66380fb2d6e9b80d55bed439'
POST_JOB_MD5 = 'd241144c298803f43466859c4e76f6d0'


def command(argv, sql=None):
    r = subprocess.run(list(map(str, argv)), input=sql, text=True, capture_output=True, env=env, timeout=120)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run(sql):
    return command(psql, sql)


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


def one(glob):
    found = sorted(MIGRATIONS.glob(glob))
    if len(found) != 1:
        raise RuntimeError(f'expected exactly one {glob}, found {len(found)}')
    return found[0]


LAUNCH = one('*_scoped_club_launch_reset_and_guarded_recovery.sql').read_text()


def launch_function(name):
    m = re.search(r'CREATE FUNCTION public\.' + name + r'\(.*?\$\$;', LAUNCH, re.S)
    if not m:
        raise RuntimeError('missing ' + name)
    return m.group(0)


def launch_view():
    m = re.search(r'CREATE OR REPLACE VIEW public\.agent_commissions_unsettled .*?;\n', LAUNCH, re.S)
    if not m:
        raise RuntimeError('missing agent_commissions_unsettled view')
    return m.group(0)


SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role', true), '') $$;
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL,
  nodename text NOT NULL DEFAULT 'localhost', nodeport integer NOT NULL DEFAULT 5432, database text NOT NULL DEFAULT 'postgres',
  username text NOT NULL DEFAULT 'postgres', active boolean NOT NULL DEFAULT true, jobname text);
CREATE FUNCTION cron.schedule(p_name text, p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job(jobname, schedule, command) VALUES (p_name, p_schedule, p_command) RETURNING jobid $$;
CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
  database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  UPDATE cron.job SET schedule = COALESCE(alter_job.schedule, job.schedule), command = COALESCE(alter_job.command, job.command),
    active = COALESCE(alter_job.active, job.active) WHERE jobid = job_id $$;
CREATE TABLE public.agent_commissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid NOT NULL, user_id uuid NOT NULL,
  amount numeric, commission_rate numeric, source_type text, source_id uuid, notes text, created_at timestamptz, settled_at timestamptz);
CREATE INDEX agent_commissions_open_idx ON public.agent_commissions (club_id, user_id, created_at) INCLUDE (amount, id) WHERE settled_at IS NULL;
CREATE TABLE public.agent_commission_settlements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid NOT NULL, user_id uuid NOT NULL,
  union_id uuid, period_start timestamptz NOT NULL, period_end timestamptz NOT NULL, amount numeric NOT NULL DEFAULT 0,
  rows_count integer NOT NULL DEFAULT 0, paid_at timestamptz NOT NULL DEFAULT now(), settlement_ref text);
CREATE INDEX agent_commission_settlements_pair_idx ON public.agent_commission_settlements (club_id, user_id, period_start, period_end);
CREATE TABLE public.agent_commission_unsettled_rollup(club_id uuid, user_id uuid, owed numeric, rows_behind bigint,
  oldest_unsettled timestamptz, updated_at timestamptz, PRIMARY KEY (club_id, user_id));
CREATE TABLE public.ca_launch_accounting_boundaries(scope_kind text NOT NULL, scope_id uuid NOT NULL, operation_id uuid NOT NULL,
  cutoff_at timestamptz NOT NULL CHECK (isfinite(cutoff_at)), activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  waiver_reason text NOT NULL DEFAULT 'x', undone_at timestamptz, PRIMARY KEY (scope_kind, scope_id, operation_id));
CREATE UNIQUE INDEX ca_launch_accounting_one_active ON public.ca_launch_accounting_boundaries(scope_kind, scope_id) WHERE undone_at IS NULL;
CREATE TABLE public.vip_points(user_id uuid PRIMARY KEY, current_points bigint, lifetime_points bigint);
CREATE TABLE public.vip_points_ledger(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, points bigint, created_at timestamptz DEFAULT now());
CREATE TABLE public.ca_currency_meter(id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), currency text NOT NULL,
  outstanding numeric, journal_total numeric, accounts integer, drifted integer, worst numeric, enforced boolean, detail jsonb);
CREATE TABLE public.rakeback_periods(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, rakeback_amount numeric, status text, created_at timestamptz DEFAULT now());
CREATE TABLE public.rakeback_period_payouts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rakeback_period_id uuid, payout_amount numeric, status text);
CREATE TABLE public.chip_ledger(id bigserial PRIMARY KEY, category text, to_type text, amount numeric, created_at timestamptz DEFAULT now());
CREATE TABLE public.ca_rakeback_baseline(id integer PRIMARY KEY, known_orphan_amount numeric, known_unpayable_amount numeric, known_through timestamptz);
CREATE TABLE public.ca_ledger_mutation_log(id bigserial PRIMARY KEY, at timestamptz DEFAULT now(), source_table text);
CREATE TABLE public.drift_incidents_seen(key text, payload jsonb);
CREATE FUNCTION public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)
RETURNS void LANGUAGE sql AS $$ INSERT INTO public.drift_incidents_seen VALUES ($4, $21) $$;
"""

GRANTS = """
REVOKE ALL ON FUNCTION public.fn_ca_currency_meter() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_currency_meter() TO service_role;
"""


def lit(v):
    return 'NULL' if v is None else "'" + str(v).replace("'", "''") + "'"


def seed(rng):
    """A random book. Returns nothing; everything lands in the tables."""
    sql = ['TRUNCATE public.agent_commissions, public.agent_commission_settlements, '
           'public.ca_launch_accounting_boundaries, public.agent_commission_unsettled_rollup;']
    base = 1_790_000_000  # 2026-09-21, seconds
    clubs = [uuid.UUID(int=rng.getrandbits(128)) for _ in range(rng.randint(1, 4))]
    for club in clubs:
        if rng.random() < 0.5:
            cutoff = base + rng.randint(0, 20) * 3600
            sql.append(f"INSERT INTO public.ca_launch_accounting_boundaries(scope_kind, scope_id, operation_id, cutoff_at) VALUES "
                       f"('club', {lit(club)}, {lit(uuid.uuid4())}, to_timestamp({cutoff}));")
            if rng.random() < 0.3:  # an undone boundary must not apply
                sql.append(f"INSERT INTO public.ca_launch_accounting_boundaries(scope_kind, scope_id, operation_id, cutoff_at, undone_at) VALUES "
                           f"('club', {lit(club)}, {lit(uuid.uuid4())}, to_timestamp({base + 99 * 3600}), now());")
        for _ in range(rng.randint(1, 5)):
            agent = uuid.UUID(int=rng.getrandbits(128))
            for _ in range(rng.randint(0, 5)):
                kind = rng.random()
                if kind < 0.1:
                    s, e = "'-infinity'", f'to_timestamp({base + rng.randint(0, 40) * 3600})'
                elif kind < 0.2:
                    s, e = f'to_timestamp({base + rng.randint(0, 40) * 3600})', "'infinity'"
                else:
                    a = base + rng.randint(0, 48) * 3600
                    b = a + rng.choice([-3600, 0, 3600, 7200, 86400, 3 * 86400])
                    s, e = f'to_timestamp({a})', f'to_timestamp({b})'
                sql.append(f"INSERT INTO public.agent_commission_settlements(club_id, user_id, period_start, period_end) "
                           f"VALUES ({lit(club)}, {lit(agent)}, {s}, {e});")
            for _ in range(rng.randint(0, 60)):
                r = rng.random()
                if r < 0.04:
                    created = 'NULL'
                elif r < 0.07:
                    created = "'infinity'"
                elif r < 0.10:
                    created = "'-infinity'"
                else:
                    # whole hours hit period and cutoff edges exactly
                    created = f'to_timestamp({base + rng.randint(-24, 72) * 3600 + rng.choice([0, 0, 1, 1799])})'
                amount = 'NULL' if rng.random() < 0.05 else str(round(rng.uniform(0.01, 50), 2))
                settled = 'now()' if rng.random() < 0.15 else 'NULL'
                sql.append(f"INSERT INTO public.agent_commissions(club_id, user_id, amount, created_at, settled_at) "
                           f"VALUES ({lit(club)}, {lit(agent)}, {amount}, {created}, {settled});")
    # The rollup is what the triggers would keep: the view's answer.
    sql.append("""INSERT INTO public.agent_commission_unsettled_rollup(club_id, user_id, owed, rows_behind, updated_at)
      SELECT club_id, user_id, COALESCE(sum(amount), 0), count(*), now() FROM public.agent_commissions_unsettled GROUP BY 1, 2;""")
    run('\n'.join(sql))


def meter():
    run('TRUNCATE public.ca_currency_meter, public.drift_incidents_seen;')
    res = json.loads(run('SELECT public.fn_ca_currency_meter()'))
    return res['agent_commissions']


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    run(launch_function('fn_ca_launch_accounting_cutoff') + '\n' + launch_function('fn_ca_launch_accounting_accepts')
        + '\n' + launch_view())

    # -- Baseline: production's meter and job 286 exactly as they are -------
    run((FIXTURES / 'fn_ca_currency_meter.live-20261015.sql').read_text() + ';' + GRANTS)
    check('baseline-meter-is-production-preimage',
          run("SELECT md5(pg_get_functiondef('public.fn_ca_currency_meter()'::regprocedure))") == LIVE_METER_MD5)
    job_cmd = (FIXTURES / 'ca-ledger-replay-nightly.command.live-20261015.txt').read_text()
    run("INSERT INTO cron.job(jobid, jobname, schedule, command) VALUES (286, 'ca-ledger-replay-nightly', '40 6 * * *', "
        + lit(job_cmd) + "); SELECT setval('cron.job_jobid_seq', 400);")
    check('baseline-job-is-production-preimage',
          run("SELECT md5(command) FROM cron.job WHERE jobid = 286") == LIVE_JOB_MD5)
    plan = run('EXPLAIN SELECT club_id, user_id, sum(amount) FROM public.agent_commissions_unsettled GROUP BY 1, 2')
    check('baseline-view-calls-the-definer-per-row', 'fn_ca_launch_accounting_accepts' in plan, plan)

    rng = random.Random(20261015)
    books = []
    for i in range(args.seeds):
        seed(rng)
        books.append(meter())
    check('baseline-meter-finds-no-drift-in-correct-books', all(b['drifted'] == 0 for b in books), books[:3])

    # -- Candidate: the migration, applied as production would --------------
    candidate = one('*_the_currency_meter_reads_what_is_owed_and_runs_on_its_own.sql')
    migration = candidate.read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    check('candidate-carries-a-live-proof', '-- @live-proof: (' in migration)
    run(migration)
    check('candidate-reproduces-production-derived-postimage',
          run("SELECT md5(pg_get_functiondef('public.fn_ca_currency_meter()'::regprocedure))") == POST_METER_MD5)
    check('candidate-meter-no-longer-reads-the-view',
          run("SELECT pg_get_functiondef('public.fn_ca_currency_meter()'::regprocedure) ~ 'FROM public\\.agent_commissions_unsettled'") == 'f')
    check('replay-job-keeps-only-the-replay',
          run("SELECT md5(command) || '|' || schedule || '|' || active FROM cron.job WHERE jobid = 286")
          == POST_JOB_MD5 + '|40 6 * * *|true')
    check('replay-job-keeps-its-lock-isolation-and-budget',
          run("SELECT command ~ 'pg_try_advisory_lock' AND command ~ 'REPEATABLE READ' AND command ~ '600s' "
              "AND command !~ 'fn_ca_currency_meter' FROM cron.job WHERE jobid = 286") == 't')
    check('meter-runs-from-its-own-job',
          run("SELECT jobname || '|' || schedule || '|' || (command ~ '600s') FROM cron.job WHERE command ~ 'fn_ca_currency_meter'")
          == 'ca-currency-meter-nightly|20 7 * * *|true')
    check('grants-unchanged',
          run("SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_currency_meter()'::regprocedure")
          == '{postgres=X/postgres,service_role=X/postgres}')

    # The new read in isolation, compared per (club, agent) with the view.
    new_cte = re.search(r'ARRAY\[\$n1\$(.*?)\$n1\$\]', migration, re.S).group(1)
    compare = new_cte + """
      SELECT count(*) FROM (
        (SELECT club_id, user_id, owed FROM u
         EXCEPT SELECT club_id, user_id, sum(amount) FROM public.agent_commissions_unsettled GROUP BY 1, 2)
        UNION ALL
        (SELECT club_id, user_id, sum(amount) FROM public.agent_commissions_unsettled GROUP BY 1, 2
         EXCEPT SELECT club_id, user_id, owed FROM u)) d"""
    plan = run('EXPLAIN ' + new_cte + ' SELECT * FROM u')
    check('candidate-read-calls-no-definer-per-row', 'fn_ca_launch_accounting_accepts' not in plan
          and 'agent_commissions_open_idx' in plan, plan)

    rng = random.Random(20261015)
    mismatched, nonempty, cutoff_books = 0, 0, 0
    for i in range(args.seeds):
        seed(rng)
        diff = int(run(compare))
        mismatched += diff
        nonempty += int(run('SELECT count(*) > 0 FROM public.agent_commissions_unsettled') == 't')
        cutoff_books += int(run('SELECT count(*) > 0 FROM public.ca_launch_accounting_boundaries WHERE undone_at IS NULL') == 't')
        after = meter()
        check(f'seed-{i}-meter-verdict-unchanged', after == books[i], {'before': books[i], 'after': after})
        if i % 5 == 0 and after['accounts'] > 0:
            # Tamper the rollup: both reads must see the same drift.
            run("UPDATE public.agent_commission_unsettled_rollup SET owed = owed + 7.5 "
                "WHERE (club_id, user_id) = (SELECT club_id, user_id FROM public.agent_commission_unsettled_rollup ORDER BY 1, 2 LIMIT 1)")
            tampered = meter()
            check(f'seed-{i}-meter-still-sees-drift', tampered['drifted'] == 1 and float(tampered['worst']) == 7.5, tampered)
    check('candidate-read-equals-the-view-on-every-book', mismatched == 0, mismatched)
    check('books-were-not-trivial', nonempty >= args.seeds * 0.8 and cutoff_books >= args.seeds * 0.3,
          {'nonempty': nonempty, 'cutoff': cutoff_books})
    results['books'] = {'seeds': args.seeds, 'nonempty': nonempty, 'with_cutoff': cutoff_books}

    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned text' in replay.stderr, replay.stderr[-300:])
    check('second-run-left-one-meter-job',
          run("SELECT count(*) FROM cron.job WHERE command ~ 'fn_ca_currency_meter'") == '1')
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'books': results.get('books'),
                  'output': str(out / 'RESULTS.json')}))
