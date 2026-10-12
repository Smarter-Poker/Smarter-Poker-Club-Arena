#!/usr/bin/env python3
"""A certification fixture never queues in front of the platform.

Migration 20261004002615_a_certification_fixture_never_queues_in_front_of_the_platfor
replaces pg_advisory_xact_lock(530090,1) in four welcome-certification
fixtures with a polling pg_try_advisory_xact_lock. The live bodies are not in
this repository as CREATE statements, so this harness runs the SHIPPED
migration against stand-ins that carry the exact replaced fragment (only the
md5 pins are rewritten to the stand-ins') and proves, on a disposable cluster:

  APPLY    the four substitutions apply, each exactly once;
  BEFORE   on the pre-image, while a purchase holds the gate shared, a waiting
           fixture makes the NEXT purchase wait too (the defect);
  AFTER    the next purchase takes the gate at once; the fixture still gets it
           when the first purchase ends, and finishes;
  HOLD     once the fixture has the gate it still holds it exclusively to the
           end of its transaction;
  BUSY     a gate held shared for longer than 30 s makes the fixture raise
           CERTIFICATION_FIXTURE_GATE_BUSY (55P03) instead of waiting.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = (ROOT / 'artifacts/certification-fixture-gate').resolve()
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

found = sorted((ROOT / 'supabase/migrations').glob('*_a_certification_fixture_never_queues_in_front_of_the_platfor.sql'))
if len(found) != 1:
    raise RuntimeError(f'expected exactly one shipped migration, found {len(found)}')
SHIPPED = found[0].read_text()
NAMES = ['fn_ca_prepare_post_reset_welcome_certification_fixture',
         'fn_ca_prepare_unused_welcome_certification_board_leases',
         'fn_ca_prepare_unused_welcome_certification_board_games',
         'fn_ca_prepare_unused_welcome_certification_board_origins']


def stand_in(name):
    return f"""
CREATE OR REPLACE FUNCTION public.{name}(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(530090,1);
  RETURN jsonb_build_object('prepared', true, 'club_id', p_club_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.{name}(uuid) FROM PUBLIC;
"""


class Cluster:
    def __init__(self, name, port):
        self.dir = Path(tempfile.mkdtemp(prefix=f'cert-gate-{name}-', dir='/tmp'))
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

    def psql(self, sql, check=True, timeout=120):
        r = subprocess.run([str(PG / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(self.sock),
                            '-p', self.port, '-U', 'postgres', '-d', 'postgres'],
                           input=sql, text=True, capture_output=True, env=ENV, timeout=timeout)
        if check and r.returncode != 0:
            raise RuntimeError(r.stderr)
        return r

    def stop(self):
        subprocess.run(AS_PG + [str(PG / 'pg_ctl'), '-D', str(self.dir / 'data'), '-m', 'immediate', 'stop'],
                       env=ENV, capture_output=True)
        shutil.rmtree(self.dir, ignore_errors=True)


def bg(c, sql, out=None):
    def run():
        t0 = time.time()
        r = c.psql(sql, check=False)
        if out is not None:
            out.append((round((time.time() - t0) * 1000), r.returncode, r.stderr.strip()[-200:]))
    t = threading.Thread(target=run)
    t.start()
    return t


PURCHASE = 'BEGIN; SELECT pg_advisory_xact_lock_shared(530090,1); SELECT pg_sleep({s}); COMMIT;'
FIXTURE = "BEGIN; SELECT public.fn_ca_prepare_unused_welcome_certification_board_leases('00000000-0000-0000-0000-0000000000c1'); SELECT pg_sleep({s}); COMMIT;"


def next_purchase_ms(c):
    t0 = time.time()
    c.psql('BEGIN; SELECT pg_advisory_xact_lock_shared(530090,1); COMMIT;')
    return round((time.time() - t0) * 1000)


results = {'scope': 'a certification fixture never queues in front of the platform', 'cases': [], 'passed': False}


def case(name, ok, **kw):
    results['cases'].append({'case': name, **kw, 'ok': bool(ok)})


old = new = None
try:
    old = Cluster('old', 55851)
    new = Cluster('new', 55852)
    shipped = SHIPPED
    for c in (old, new):
        c.psql('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;' + ''.join(stand_in(n) for n in NAMES))
    # Rewrite each function's pre and post pins to the stand-in's.
    frag_old = re.search(r"  v_old := ((?:E'(?:[^'\\]|\\.)*'\s*(?:\|\|\s*)?)+);", shipped).group(1)
    frag_new = re.search(r"  v_new := ((?:E'(?:[^'\\]|\\.)*'\s*(?:\|\|\s*)?)+);", shipped).group(1)
    for n in NAMES:
        pins = new.psql(f"SELECT md5(pg_get_functiondef('public.{n}(uuid)'::regprocedure)) || ',' || "
                        f"md5(replace(pg_get_functiondef('public.{n}(uuid)'::regprocedure), {frag_old}, {frag_new}));").stdout.strip()
        pre, post = pins.split(',')
        seg = re.search(rf"  -- {n}\n(.*?)\n\n", shipped, re.S).group(0)
        seg2 = re.sub(r"v_pin := '[0-9a-f]{32}'", f"v_pin := '{pre}'", seg)
        seg2 = re.sub(r"v_post := '[0-9a-f]{32}'", f"v_post := '{post}'", seg2)
        shipped = shipped.replace(seg, seg2)
    r = new.psql(shipped, check=False)
    n_try = new.psql("SELECT count(*) FROM pg_proc WHERE proname LIKE 'fn_ca_prepare_%welcome_certification%' "
                     "AND prosrc LIKE '%pg_try_advisory_xact_lock(530090,1)%' AND prosrc NOT LIKE '%PERFORM pg_advisory_xact_lock(530090,1)%';").stdout.strip()
    case('APPLY the shipped substitutions', r.returncode == 0 and n_try == '4', stderr=r.stderr.strip()[-300:], substituted=n_try)

    # BEFORE / AFTER: purchase holds shared 2 s; fixture arrives; next purchase arrives.
    for label, c in (('BEFORE the next purchase waits behind the waiting fixture (pre-image)', old),
                     ('AFTER the next purchase takes the gate at once', new)):
        fx = []
        t1 = bg(c, PURCHASE.format(s=2))
        time.sleep(0.4)
        t2 = bg(c, FIXTURE.format(s=0), fx)
        time.sleep(0.4)
        ms = next_purchase_ms(c)
        t1.join()
        t2.join()
        if label.startswith('BEFORE'):
            case(label, ms >= 1000, next_purchase_ms=ms, fixture=fx)
        else:
            case(label, ms < 300 and fx and fx[0][1] == 0, next_purchase_ms=ms, fixture=fx)

    fx = []
    t2 = bg(new, FIXTURE.format(s=2), fx)
    time.sleep(0.5)
    ms = next_purchase_ms(new)
    t2.join()
    case('HOLD the fixture keeps the gate exclusive to its commit', ms >= 1200, next_purchase_ms=ms, fixture=fx)

    fx = []
    t1 = bg(new, PURCHASE.format(s=33))
    time.sleep(0.4)
    t2 = bg(new, FIXTURE.format(s=0), fx)
    time.sleep(0.4)
    ms = next_purchase_ms(new)
    t2.join()
    t1.join()
    case('BUSY a gate held past 30 s refuses the fixture instead of queueing', ms < 300 and fx and fx[0][1] != 0
         and 'CERTIFICATION_FIXTURE_GATE_BUSY' in fx[0][2] and 29000 <= fx[0][0] <= 34000,
         next_purchase_ms=ms, fixture=fx)

    results['passed'] = all(x['ok'] for x in results['cases'])
finally:
    for c in (old, new):
        if c:
            c.stop()
    (OUT / 'result.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))

if not results['passed']:
    raise SystemExit(1)
