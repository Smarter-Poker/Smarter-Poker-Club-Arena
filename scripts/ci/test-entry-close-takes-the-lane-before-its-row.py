"""Isolated PostgreSQL regression: entry close takes the tournament lane
before its row, so the pay-at-finalization trigger cannot deadlock.

Fourteen tournament.real_time_payout_refused alerts in three days were all
40P01, and every one was raised by the transaction that closed the event's
entry (fn_close_tournament_entry_window or fn_close_tournament_addon_period).
Both doors locked the tournaments row first and took no lane; finalizing the
pool fires the deferred constraint trigger zzz_pay_finishers_when_pool_
finalizes, whose payer asks for the tournament lane T(id) EXCLUSIVE at
COMMIT. A rebuy, add-on or hand that already held T(id) and was waiting for
the same row closed the cycle (postgres log 2026-10-24 22:31:42 UTC).

The test loads the exact production definitions captured on 2026-10-24 (each
fixture's md5 equals production's pg_get_functiondef md5) of both doors, the
lane helper and the deferred trigger, with the payer and the pool finalizer
reduced to the locks they take in production, in production order:
  payer      fn_ca_lock_settlement_lane_for_tournament(id), then the
             tournaments row FOR UPDATE (its first two statements);
  finalizer  the tournaments row FOR UPDATE, then UPDATE prize_pool_finalized
             (fn_finalize_tournament_entry_pool_locked -> fn_apply_prize_guarantee).
Partners mirror the two shapes in the log:
  add-on     process_tournament_rebuy: lane helper (line 71), key (530090,1)
             shared, then tournaments FOR UPDATE (line 205);
  hand       fn_ca_f06_share_table_lane's G shared then T(id) shared, then
             tournaments FOR SHARE (fn_ca_retain_hand_submission line 61).
For each door and each partner: the door's transaction runs and stays open,
the partner starts and blocks, the door commits. Before the migration the
payer's lane request deadlocks (40P01 caught, alert written, place unpaid);
after the unmodified migration file the partner blocks on the lane instead
of the row, the payer's request is re-entrant, the payer runs to completion,
no alert is written and both transactions commit. The migration's own md5
guards prove the pre-image is production's and the post-image is the one
pinned in its @live-proof lines.

An empty throwaway cluster on a Unix socket; no network, no production
connection.
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase' / 'migrations' / '20261025030526_entry_close_takes_the_tournament_lane_before_its_row.sql'
FIX = ROOT / 'scripts' / 'ci' / 'fixtures' / 'entry-close-lane'
LIVE = {
    'fn_close_tournament_entry_window(uuid,text)': ('fn_close_tournament_entry_window.sql', '45df22d088d6e1e82c7783ae32415112'),
    'fn_close_tournament_addon_period(uuid,text)': ('fn_close_tournament_addon_period.sql', '385d1b85fd08702be6c9bd046c2a7e76'),
    'fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)': ('fn_ca_lock_settlement_lane_for_tournament.sql', '9877846ffabee004690e6b24a3ddcee2'),
    'trg_ca_pay_tournament_finishers_at_commit()': ('trg_ca_pay_tournament_finishers_at_commit.sql', '33d584aad3864a857ead8a933cae46d6'),
}
POST = {
    'fn_close_tournament_entry_window(uuid,text)': '8cb316d211658925f175131f07a5202a',
    'fn_close_tournament_addon_period(uuid,text)': 'd5e0ba63cb0540f4fbfa5b84563b7ca4',
}

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/entry-close-takes-the-lane-before-its-row')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='entry-close-lane-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55847'
CONN = ['-X', '-qAt', '-h', str(sock), '-p', PORT, '-U', 'postgres', '-d', 'postgres']
psql = [str(pg / 'psql'), '-v', 'ON_ERROR_STOP=1'] + CONN
results = {'checks': [], 'scenarios': [], 'production_mutations': False}
TID = '00000000-0000-4000-8000-0000000000a1'


def run(args, stdin=None):
    r = subprocess.run([str(a) for a in args], input=stdin, text=True, capture_output=True, env=env)
    if r.returncode:
        raise RuntimeError(f'{args[0]} failed ({r.returncode}): {r.stderr}')
    return r.stdout


def sql(text):
    return run(psql, text).strip()


def check(name, ok, detail=None):
    results['checks'].append({'name': name, 'ok': bool(ok), 'detail': detail})
    if not ok:
        raise AssertionError(f'{name}: {detail}')


SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.tournaments(
  id uuid PRIMARY KEY, status text, late_reg_mins integer, late_reg_levels integer,
  rebuy_levels integer, started_at timestamptz, prize_pool_finalized boolean,
  add_on_available boolean, addon_period_started_at timestamptz,
  addon_period_ends_at timestamptz);
CREATE TABLE public.tables(id uuid PRIMARY KEY, tournament_id uuid);
CREATE TABLE public.financial_alerts(
  id bigserial PRIMARY KEY, severity text, source text, message text,
  context jsonb, resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.probe_payer_runs(tournament_id uuid, at timestamptz DEFAULT clock_timestamp());

CREATE FUNCTION public.fn_tournament_late_registration_open(p uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT false $$;

-- Production order: the row FOR UPDATE, then fn_apply_prize_guarantee
-- publishes prize_pool_finalized (which fires the deferred payer).
CREATE FUNCTION public.fn_finalize_tournament_entry_pool_locked(p_tournament_id uuid, p_source text, p_close_mode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  PERFORM 1 FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  UPDATE public.tournaments SET prize_pool_finalized = true WHERE id = p_tournament_id;
  RETURN jsonb_build_object('ok', true, 'entry_closed', true, 'finalized', true,
                            'prize_pool', 100, 'close_mode', p_close_mode);
END $$;

-- Production's first two statements: the rolling lane, then the row.
CREATE FUNCTION public.fn_ca_pay_tournament_finishers_now(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM 1 FROM public.tournaments t WHERE t.id = p_tournament_id FOR UPDATE;
  INSERT INTO public.probe_payer_runs(tournament_id) VALUES (p_tournament_id);
  RETURN jsonb_build_object('ok', true, 'paid', '[]'::jsonb);
END $$;

-- process_tournament_rebuy, add-on path: line 71, the receipt key, line 205.
CREATE FUNCTION public.probe_addon_partner(p uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p);
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  PERFORM 1 FROM public.tournaments t WHERE t.id = p FOR UPDATE;
END $$;

-- A hand: G shared, T(id) shared (fn_ca_f06_share_table_lane), then the
-- tournaments row FOR SHARE (fn_ca_retain_hand_submission).
CREATE FUNCTION public.probe_hand_partner(p uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:' || p::text, 0));
  PERFORM 1 FROM public.tournaments WHERE id = p FOR SHARE;
END $$;
"""

TRIGGERS = """
CREATE CONSTRAINT TRIGGER zzz_pay_finishers_when_pool_finalizes
  AFTER UPDATE OF prize_pool_finalized ON public.tournaments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (new.prize_pool_finalized IS TRUE AND old.prize_pool_finalized IS DISTINCT FROM true)
  EXECUTE FUNCTION public.trg_ca_pay_tournament_finishers_at_commit();
"""

DOORS = {
    'entry_window': ("public.fn_close_tournament_entry_window('%s')" % TID,
                     dict(status='RUNNING', late_reg_mins=0, late_reg_levels=0, rebuy_levels=0,
                          prize_pool_finalized=False, add_on_available=False)),
    'addon_period': ("public.fn_close_tournament_addon_period('%s')" % TID,
                     dict(status='RUNNING', late_reg_mins=0, late_reg_levels=0, rebuy_levels=0,
                          prize_pool_finalized=False, add_on_available=True)),
}
PARTNERS = {
    'addon': "public.probe_addon_partner('%s')" % TID,
    'hand': "public.probe_hand_partner('%s')" % TID,
}


def reset(row):
    cols = ', '.join(row)
    vals = ', '.join('NULL' if v is None else (str(v).lower() if isinstance(v, bool) else f"'{v}'") for v in row.values())
    sql(f"""TRUNCATE public.tournaments, public.financial_alerts, public.probe_payer_runs;
INSERT INTO public.tournaments(id, {cols}, addon_period_started_at, addon_period_ends_at)
VALUES ('{TID}', {vals}, clock_timestamp() - interval '5 minutes', clock_timestamp() - interval '1 second');""")


def session(app, deadlock_timeout):
    p = subprocess.Popen([str(pg / 'psql'), '-v', 'ON_ERROR_STOP=0'] + CONN, stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    p.stdin.write(f"SET application_name = '{app}'; SET deadlock_timeout = '{deadlock_timeout}';\n")
    p.stdin.flush()
    return p


def wait_for(query, want, timeout=10.0):
    end = time.time() + timeout
    got = None
    while time.time() < end:
        got = sql(query)
        if got == want:
            return got
        time.sleep(0.05)
    raise AssertionError(f'timed out waiting for {query!r} = {want!r}, last {got!r}')


def state(app):
    return f"SELECT COALESCE((SELECT state || ':' || COALESCE(wait_event_type, '') FROM pg_stat_activity WHERE application_name = '{app}'), 'gone')"


def scenario(phase, door, partner):
    call, row = DOORS[door]
    reset(row)
    # The door detects first, as the payer did in production: the partner's
    # own detector is pushed out so the cycle is resolved against the payer.
    a = session('door', '100ms')
    b = session('partner', '20s')
    a.stdin.write(f'BEGIN; SELECT {call};\n')
    a.stdin.flush()
    wait_for(state('door'), 'idle in transaction:Client')
    b.stdin.write(f'BEGIN; SELECT {PARTNERS[partner]}; COMMIT;\n')
    b.stdin.flush()
    blocked = wait_for(f"SELECT COALESCE((SELECT wait_event_type FROM pg_stat_activity WHERE application_name = 'partner'), 'gone')", 'Lock')
    partner_wait = sql("SELECT wait_event FROM pg_stat_activity WHERE application_name = 'partner'")
    # communicate() writes, flushes and closes stdin itself. Python 3.12
    # (the CI runner) raises "I/O operation on closed file" if stdin was
    # already closed by hand; 3.13 tolerates it.
    a_out, a_err = a.communicate(input='COMMIT;\n', timeout=30)
    b_out, b_err = b.communicate(timeout=30)
    alerts = json.loads(sql("SELECT COALESCE(json_agg(context ORDER BY id), '[]') FROM public.financial_alerts"))
    payer_runs = int(sql('SELECT count(*) FROM public.probe_payer_runs'))
    finalized = sql(f"SELECT prize_pool_finalized FROM public.tournaments WHERE id = '{TID}'")
    rec = {'phase': phase, 'door': door, 'partner': partner, 'partner_waited_on': partner_wait,
           'alerts': alerts, 'payer_completed': payer_runs, 'pool_finalized': finalized,
           'door_stderr': a_err.strip(), 'partner_stderr': b_err.strip(), 'blocked': blocked}
    results['scenarios'].append(rec)
    return rec


try:
    run(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'])
    run(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'pg.log', '-o',
                    f'-k {sock} -p {PORT} -c listen_addresses= -c deadlock_timeout=100ms', '-w', 'start'])
    sql(SCHEMA)
    for sig, (file, want) in LIVE.items():
        text = (FIX / file).read_text()
        check(f'fixture {file} is the production definition', __import__('hashlib').md5(text.encode()).hexdigest() == want)
        sql(text + ';')
        got = sql(f"SELECT md5(pg_get_functiondef('public.{sig}'::regprocedure))")
        check(f'{sig} installs with the production pg_get_functiondef md5', got == want, got)
        sql(f'REVOKE ALL ON FUNCTION public.{sig} FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.{sig} TO service_role;')
    sql(TRIGGERS)

    for door in DOORS:
        for partner in PARTNERS:
            r = scenario('before', door, partner)
            check(f'BEFORE {door} x {partner}: the partner waited on the row the door holds',
                  r['partner_waited_on'] in ('transactionid', 'tuple'), r['partner_waited_on'])
            check(f'BEFORE {door} x {partner}: the payer deadlocked (40P01) and the alert was written',
                  len(r['alerts']) == 1 and r['alerts'][0]['result'].get('sqlstate') == '40P01', r['alerts'])
            check(f'BEFORE {door} x {partner}: the payer did not complete', r['payer_completed'] == 0, r)

    run(psql, MIGRATION.read_text())
    for sig, want in POST.items():
        got = sql(f"SELECT md5(pg_get_functiondef('public.{sig}'::regprocedure))")
        check(f'{sig} post-image is the pinned one', got == want, got)
    check('the migration is one transaction',
          MIGRATION.read_text().count('\nBEGIN;\n') == 1 and MIGRATION.read_text().count('\nCOMMIT;\n') == 1)

    for door in DOORS:
        for partner in PARTNERS:
            r = scenario('after', door, partner)
            check(f'AFTER {door} x {partner}: the partner waits on the lane, not the row',
                  r['partner_waited_on'] == 'advisory', r['partner_waited_on'])
            check(f'AFTER {door} x {partner}: no deadlock, no alert', r['alerts'] == [] and 'deadlock' not in (r['door_stderr'] + r['partner_stderr']), r)
            check(f'AFTER {door} x {partner}: the payer ran to completion at the door commit', r['payer_completed'] == 1, r)
            check(f'AFTER {door} x {partner}: the pool is finalized', r['pool_finalized'] == 't', r)
            check(f'AFTER {door} x {partner}: both transactions committed', 'ERROR' not in (r['door_stderr'] + r['partner_stderr']), r)

    # A NULL tournament takes no lane (the helper would take the global lane).
    sql("SELECT pg_advisory_unlock_all()")
    for door in ('fn_close_tournament_entry_window', 'fn_close_tournament_addon_period'):
        got = sql(f"""BEGIN; SELECT public.{door}(NULL)->>'reason';
SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid(); ROLLBACK;""")
        check(f'{door}(NULL) answers not_found and takes no lane', got.split('\n') == ['not_found', '0'], got)
    results['ok'] = True
finally:
    run(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop']) if (cluster / 'data' / 'postmaster.pid').exists() else None
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
    shutil.rmtree(cluster, ignore_errors=True)

print(json.dumps({'ok': results.get('ok', False), 'checks': len(results['checks'])}))
