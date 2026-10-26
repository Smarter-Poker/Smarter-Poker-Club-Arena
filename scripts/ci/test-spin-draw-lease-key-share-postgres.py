#!/usr/bin/env python3
"""The Spin draw does not hold the lease against its own heartbeat (20261025224305).

Disposable native PostgreSQL, two sessions - the same harness as
test-launch-lease-key-share-postgres.py, pointed at the Spin's launch door.
Builds engine_tournament_leases, the production heartbeat
(heartbeat_tournament_leases_v4: FOR NO KEY UPDATE ... SKIP LOCKED, `busy` for
a row it cannot lock), a takeover shaped like claim_tournament_lease_v2
(FOR UPDATE first), and fn_spin_draw_and_settle_atomic's trimmed preimage
(the production header, lease lock and receipt check; a parked stub where the
draw and settlement body goes). The stub parks on an advisory lock the harness
holds, so "a draw in flight" is a transaction that has taken the lease-row lock
and not yet committed.

Proves, in order:
  1. BEFORE: with a draw in flight the heartbeat for that Spin answers `busy`.
  2. The migration applies by its anchor, and is a no-op on re-application.
  3. AFTER: with a draw in flight the heartbeat answers `kept` and moves
     heartbeat_at.
  4. AFTER: a takeover (FOR UPDATE) is still blocked by the draw in flight.
  5. The fixed door still verifies the generation and still answers.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261025224305_the_spin_draw_does_not_hold_the_lease_against_its_own_heartb.sql'
PREIMAGE = ROOT / 'scripts/qualification/fixtures/spin-draw-lease-key-share/preimage.sql'
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
cluster = Path(tempfile.mkdtemp(prefix='spin-draw-lease-', dir=os.environ.get('TMPDIR')))
socket = Path(tempfile.mkdtemp(prefix='sdlks-sock-', dir='/tmp'))
data = cluster / 'data'
env = {'PATH': str(PG) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
started = False

T = '44444444-4444-4444-8444-444444444444'
GEN = '55555555-5555-4555-8555-555555555555'
LAUNCH = '66666666-6666-4666-8666-666666666666'
INSTANCE = '1-test'
PARK = 777002


def run(args, sql=None, timeout=600):
    result = subprocess.run([str(a) for a in args], input=sql, text=True,
                            capture_output=True, env=env, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout.strip()


def psql_args():
    return [PG / 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', socket,
            '-U', 'postgres', '-d', 'postgres']


def q(sql, timeout=600):
    return run(psql_args(), sql, timeout)


class Session:
    def __init__(self):
        self.p = subprocess.Popen([str(a) for a in psql_args()], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  text=True, env=env, bufsize=1)
        self.out = []
        self.t = threading.Thread(target=self._pump, daemon=True)
        self.t.start()

    def _pump(self):
        for line in self.p.stdout:
            self.out.append(line.rstrip('\n'))

    def send(self, sql):
        self.p.stdin.write(sql + '\n')
        self.p.stdin.flush()

    def wait_for(self, marker, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if any(marker in line for line in self.out):
                return True
            time.sleep(0.05)
        return False

    def close(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        self.p.wait(timeout=10)


SCHEMA = f"""
CREATE SCHEMA smarter_private;
CREATE SCHEMA extensions;
CREATE TABLE public.engine_tournament_leases (
  tournament_id uuid PRIMARY KEY,
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_generation uuid,
  protocol_version integer NOT NULL DEFAULT 2);
CREATE TABLE public.tournament_launch_receipts (
  tournament_id uuid PRIMARY KEY,
  launch_id uuid NOT NULL,
  lease_generation uuid,
  completed_at timestamptz);
CREATE TABLE public.tournaments (id uuid PRIMARY KEY, status text NOT NULL);

CREATE FUNCTION smarter_private.f06_generation_aborted(p_tournament_id uuid, p_generation uuid)
 RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.fn_ca_launch_tournament_start_refused(p_tournament_id uuid)
 RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
-- The first thing the real body does after the lease lock. Parks on the
-- harness's advisory lock: while a session sits here it IS a draw in flight,
-- holding whatever the door took on the lease row.
CREATE FUNCTION public.fn_lock_tournament_launch_proof_parents(p_ids uuid[])
 RETURNS SETOF uuid LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock({PARK});
  RETURN QUERY SELECT unnest(p_ids);
END $$;

CREATE FUNCTION public.heartbeat_tournament_leases_v4(p_instance_id text, p_claims jsonb, p_stale_seconds integer DEFAULT 30)
 RETURNS TABLE(tournament_id uuid, state text, lease_generation uuid)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH asked AS MATERIALIZED (
    SELECT (item ->> 'tournament_id')::uuid AS id,
           (item ->> 'lease_generation')::uuid AS requested_generation
      FROM jsonb_array_elements(p_claims) item
  ),
  lockable AS MATERIALIZED (
    SELECT l.tournament_id, l.ctid AS row_ctid
      FROM public.engine_tournament_leases l
      JOIN asked a ON a.id = l.tournament_id
     WHERE l.instance_id = p_instance_id
       AND l.protocol_version = 2
       AND l.lease_generation = a.requested_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,a.requested_generation)
       AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
     FOR NO KEY UPDATE OF l SKIP LOCKED
  ),
  renewed AS (
    UPDATE public.engine_tournament_leases l
       SET heartbeat_at = clock_timestamp()
      FROM asked a, lockable k
     WHERE l.ctid = k.row_ctid
       AND l.tournament_id = k.tournament_id
       AND l.tournament_id = a.id
       AND l.instance_id = p_instance_id
       AND l.protocol_version = 2
       AND l.lease_generation = a.requested_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,a.requested_generation)
       AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
    RETURNING l.tournament_id, l.lease_generation
  )
  SELECT a.id,
         CASE
           WHEN r.tournament_id IS NOT NULL THEN 'kept'
           ELSE COALESCE((
             SELECT CASE
                      WHEN l.heartbeat_at < clock_timestamp() - interval '30 seconds' THEN 'stale'
                      WHEN l.instance_id = p_instance_id
                       AND l.protocol_version = 2
                       AND l.lease_generation = a.requested_generation
                       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,a.requested_generation) THEN 'busy'
                      ELSE 'taken'
                    END
               FROM public.engine_tournament_leases l
              WHERE l.tournament_id = a.id), 'missing')
         END,
         CASE
           WHEN r.tournament_id IS NOT NULL THEN r.lease_generation
           ELSE (SELECT l.lease_generation
                   FROM public.engine_tournament_leases l
                  WHERE l.tournament_id = a.id)
         END
    FROM asked a
    LEFT JOIN renewed r ON r.tournament_id = a.id;
END;
$function$;

CREATE FUNCTION public.claim_tournament_lease_v2(p_tournament_id uuid, p_instance_id text, p_version text DEFAULT NULL, p_requested_generation uuid DEFAULT NULL, p_stale_seconds integer DEFAULT 30)
 RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric, lease_generation uuid, protocol_version integer)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM 1 FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  RETURN QUERY SELECT false, l.instance_id, 0::numeric, l.lease_generation, 2
    FROM public.engine_tournament_leases l WHERE l.tournament_id = p_tournament_id;
END;
$function$;

INSERT INTO public.engine_tournament_leases (tournament_id, instance_id, lease_generation, protocol_version)
VALUES ('{T}', '{INSTANCE}', '{GEN}', 2);
INSERT INTO public.tournament_launch_receipts (tournament_id, launch_id, lease_generation)
VALUES ('{T}', '{LAUNCH}', '{GEN}');
INSERT INTO public.tournaments (id, status) VALUES ('{T}', 'REGISTERING');
"""

HEARTBEAT = f"""SELECT state FROM public.heartbeat_tournament_leases_v4('{INSTANCE}',
  '[{{"tournament_id":"{T}","lease_generation":"{GEN}"}}]'::jsonb, 30);"""
DRAW = f"SELECT public.fn_spin_draw_and_settle_atomic('{T}','{LAUNCH}','{GEN}', '{{}}'::jsonb);"


def heartbeat():
    return q(HEARTBEAT, timeout=30)


def heartbeat_at():
    return q(f"SELECT heartbeat_at FROM public.engine_tournament_leases WHERE tournament_id = '{T}';")


def draw_in_flight(check):
    holder = Session()
    holder.send(f"BEGIN; SELECT pg_advisory_lock({PARK}); \\echo PARKED")
    assert holder.wait_for('PARKED'), holder.out
    drawer = Session()
    drawer.send(f"{DRAW} \\echo DRAWN")
    deadline = time.time() + 30
    while time.time() < deadline:
        waiting = q(f"""SELECT count(*) FROM pg_locks
                         WHERE locktype = 'advisory' AND objid = {PARK} AND NOT granted;""")
        if waiting == '1':
            break
        time.sleep(0.05)
    else:
        raise AssertionError('the draw never reached its body: ' + repr(drawer.out))
    try:
        result = check()
    finally:
        holder.send('ROLLBACK;')
        holder.close()
        assert drawer.wait_for('DRAWN'), drawer.out
        drawer.close()
    return result, '\n'.join(drawer.out)


try:
    run([PG / 'initdb', '-D', data, '-U', 'postgres', '--auth=trust'])
    run([PG / 'pg_ctl', '-D', data, '-l', cluster / 'log', '-w', '-o',
         f"-k {socket} -c listen_addresses='' -c lock_timeout=0", 'start'])
    started = True
    q(SCHEMA)
    q(PREIMAGE.read_text())
    assert heartbeat() == 'kept', 'fixture: an idle lease must renew'

    state, answer = draw_in_flight(heartbeat)
    assert state == 'busy', state
    assert '"ok": true' in answer, answer
    print('PASS: before the migration, a Spin draw in flight answers its own heartbeat with busy (FOR UPDATE)', flush=True)

    q(MIGRATION.read_text())
    src = q("SELECT prosrc FROM pg_proc WHERE proname = 'fn_spin_draw_and_settle_atomic';")
    assert 'FOR KEY SHARE;' in src and 'engine_tournament_leases\n   WHERE tournament_id = p_tournament_id FOR UPDATE;' not in src, src[:400]
    q(MIGRATION.read_text())
    print('PASS: migration rewrote the Spin draw door to FOR KEY SHARE and re-applies as a no-op', flush=True)

    q(f"UPDATE public.engine_tournament_leases SET heartbeat_at = clock_timestamp() - interval '10 seconds' WHERE tournament_id = '{T}';")
    before = heartbeat_at()
    state, answer = draw_in_flight(heartbeat)
    assert state == 'kept', state
    assert heartbeat_at() != before, 'heartbeat_at did not move'
    assert '"ok": true' in answer, answer
    print('PASS: after the migration, a Spin draw in flight answers its own heartbeat with kept and moves heartbeat_at', flush=True)

    def takeover_blocks():
        taker = Session()
        taker.send(f"SELECT granted FROM public.claim_tournament_lease_v2('{T}', '2-other', NULL, gen_random_uuid(), 30); \\echo TOOK")
        blocked = not taker.wait_for('TOOK', timeout=2)
        waiting = q("""SELECT count(*) FROM pg_locks l
                        WHERE (l.locktype = 'tuple' OR l.locktype = 'transactionid') AND NOT l.granted;""")
        taker.p.kill()
        return blocked and int(waiting) >= 1
    blocked, _ = draw_in_flight(takeover_blocks)
    assert blocked, 'the takeover was not blocked by a draw in flight'
    print('PASS: after the migration, a takeover (FOR UPDATE) still waits behind a Spin draw in flight', flush=True)

    out = q(DRAW)
    assert '"ok": true' in out, out
    out = q(f"SELECT public.fn_spin_draw_and_settle_atomic('{T}','{LAUNCH}', gen_random_uuid(), '{{}}'::jsonb);")
    assert 'launch_lease_lost' in out, out
    print('PASS: the fixed Spin draw door still verifies the generation and still answers', flush=True)
finally:
    if started:
        subprocess.run([str(PG / 'pg_ctl'), '-D', str(data), '-m', 'immediate', 'stop'],
                       capture_output=True, env=env)
    shutil.rmtree(cluster, ignore_errors=True)
    shutil.rmtree(socket, ignore_errors=True)
