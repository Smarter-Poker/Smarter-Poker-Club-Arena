#!/usr/bin/env python3
"""A cluster wake does not queue behind the pass.

Migration 20261003223747_a_cluster_wake_does_not_queue_behind_the_pass
rewrites one lock in fn_cash_cluster_tick by substitution on the live text.
The live body (41,928 characters) is not in this repository, so this harness
runs the SHIPPED migration against a stand-in function that carries the exact
replaced fragment, with only the md5 pin rewritten to the stand-in's, and
proves:

  APPLY    the substitution finds the fragment once, the reverse substitution
           reproduces the pin, privileges are unchanged;
  WAKE     called alone while another transaction holds the game row, the
           tick returns ticking_elsewhere at once instead of waiting;
  FREE     called alone on a free row it ticks as before;
  MISSING  an unknown game is still not_found;
  PASS     called inside a pass (ca.cluster_pass_deadline set) it still waits
           for the row, bounded by the pass's lock_timeout;
  RESET    a session whose pass transaction ended is a wake again.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = (ROOT / 'artifacts/cluster-wake-skip-locked').resolve()
OUT.mkdir(parents=True, exist_ok=True)


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

found = sorted((ROOT / 'supabase/migrations').glob('*_a_cluster_wake_does_not_queue_behind_the_pass.sql'))
if len(found) != 1:
    raise RuntimeError(f'expected exactly one shipped migration, found {len(found)}')
SHIPPED = found[0].read_text()
PIN = '8b1223ad422f9a147e6719c8522217b9'
assert SHIPPED.count(PIN) == 2, 'the shipped migration pins the live text twice'

STAND_IN = r"""
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE TABLE public.cash_games (id uuid PRIMARY KEY, must_move boolean DEFAULT true);
INSERT INTO public.cash_games VALUES ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2');
CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick(p_game_id uuid, p_eligible_horses integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g record;
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  RETURN jsonb_build_object('ok', true, 'game', g.id);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) TO service_role;
"""

HELD = '00000000-0000-0000-0000-0000000000a1'
FREE = '00000000-0000-0000-0000-0000000000a2'


class Cluster:
    def __init__(self, port):
        self.dir = Path(tempfile.mkdtemp(prefix='cluster-wake-', dir='/tmp'))
        self.sock = self.dir / 'socket'
        self.sock.mkdir(mode=0o700)
        if AS_PG:
            shutil.chown(self.dir, 'postgres')
            shutil.chown(self.sock, 'postgres')
        self.port = str(port)
        subprocess.run(AS_PG + [str(PG / 'initdb'), '-D', str(self.dir / 'data'), '-U', 'postgres', '-A', 'trust'],
                       env=ENV, check=True, capture_output=True)
        subprocess.run(AS_PG + [str(PG / 'pg_ctl'), '-D', str(self.dir / 'data'), '-l', str(self.dir / 'log'), '-w',
                        '-o', f"-k {self.sock} -p {self.port} -c listen_addresses='' -c fsync=off",
                        'start'], env=ENV, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def psql(self, sql, check=True):
        r = subprocess.run([str(PG / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(self.sock),
                            '-p', self.port, '-U', 'postgres', '-d', 'postgres'],
                           input=sql, text=True, capture_output=True, env=ENV, timeout=120)
        if check and r.returncode != 0:
            raise RuntimeError(r.stderr)
        return r

    def stop(self):
        subprocess.run(AS_PG + [str(PG / 'pg_ctl'), '-D', str(self.dir / 'data'), '-m', 'immediate', 'stop'],
                       env=ENV, capture_output=True)
        shutil.rmtree(self.dir, ignore_errors=True)


def holding(c, seconds):
    """Another transaction (the pass) holds HELD's row for `seconds`."""
    t = threading.Thread(target=c.psql, args=(
        f"BEGIN; SELECT 1 FROM public.cash_games WHERE id = '{HELD}' FOR UPDATE; SELECT pg_sleep({seconds}); COMMIT;",))
    t.start()
    time.sleep(0.4)
    return t


results = {'scope': 'a cluster wake does not queue behind the pass', 'cases': [], 'passed': False}
c = None
try:
    c = Cluster(55821)
    c.psql(STAND_IN)
    stand_in_md5 = c.psql("SELECT md5(pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure));").stdout.strip()
    r = c.psql(SHIPPED.replace(PIN, stand_in_md5), check=False)
    after = c.psql("SELECT md5(pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure)), "
                   "position('A WAKE DOES NOT QUEUE BEHIND THE PASS' IN pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure)) > 0;").stdout.strip()
    results['cases'].append({'case': 'APPLY the shipped substitution', 'stderr': r.stderr.strip()[-400:], 'after': after,
                             'ok': r.returncode == 0 and after.endswith('|t')})

    t = holding(c, 3)
    t0 = time.time()
    out = c.psql(f"SELECT public.fn_cash_cluster_tick('{HELD}', 0);").stdout.strip()
    ms = round((time.time() - t0) * 1000)
    t.join()
    results['cases'].append({'case': 'WAKE on a held row answers at once', 'result': out, 'ms': ms,
                             'ok': '"ticking_elsewhere"' in out and ms < 1500})

    out = c.psql(f"SELECT public.fn_cash_cluster_tick('{FREE}', 0);").stdout.strip()
    results['cases'].append({'case': 'FREE row ticks', 'result': out, 'ok': '"ok": true' in out})

    out = c.psql("SELECT public.fn_cash_cluster_tick('00000000-0000-0000-0000-0000000000ff', 0);").stdout.strip()
    results['cases'].append({'case': 'MISSING game is not_found', 'result': out, 'ok': '"not_found"' in out})

    t = holding(c, 3)
    t0 = time.time()
    r = c.psql("BEGIN; SET LOCAL lock_timeout = '1200ms'; "
               "SELECT set_config('ca.cluster_pass_deadline', (clock_timestamp() + interval '5 s')::text, true); "
               f"SELECT public.fn_cash_cluster_tick('{HELD}', 0); COMMIT;", check=False)
    ms = round((time.time() - t0) * 1000)
    t.join()
    results['cases'].append({'case': 'PASS still waits for its row', 'ms': ms, 'stderr': r.stderr.strip()[-200:],
                             'ok': r.returncode != 0 and 'lock timeout' in r.stderr and ms >= 1100})

    t = holding(c, 3)
    t0 = time.time()
    out = c.psql("BEGIN; SELECT set_config('ca.cluster_pass_deadline', clock_timestamp()::text, true); COMMIT; "
                 f"SELECT public.fn_cash_cluster_tick('{HELD}', 0);").stdout.strip()
    ms = round((time.time() - t0) * 1000)
    t.join()
    results['cases'].append({'case': 'RESET a session after its pass is a wake again', 'result': out.splitlines()[-1:], 'ms': ms,
                             'ok': '"ticking_elsewhere"' in out and ms < 1500})

    results['passed'] = all(x['ok'] for x in results['cases'])
finally:
    if c:
        c.stop()
    (OUT / 'result.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))

if not results['passed']:
    raise SystemExit(1)
