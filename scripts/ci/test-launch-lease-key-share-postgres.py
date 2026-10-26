#!/usr/bin/env python3
"""A launch does not hold the lease against its own heartbeat (20261025200555).

Disposable native PostgreSQL, two sessions. Builds engine_tournament_leases,
the production heartbeat (heartbeat_tournament_leases_v4: FOR NO KEY UPDATE ...
SKIP LOCKED, `busy` for a row it cannot lock), a takeover shaped like
claim_tournament_lease_v2 (FOR UPDATE first), and the six launch overloads
exactly as installed on 2026-10-25 before the migration (fixture preimage).
The inner launch body is a stub that parks on an advisory lock the harness
holds, so "a launch in flight" is a transaction that has taken the lease-row
lock and not yet committed - the 13:27:10 UTC shape.

Proves, in order:
  1. BEFORE: with a launch in flight the heartbeat for that tournament answers
     `busy` (the measured cause: busy +6 before each of the day's three
     `tournament_lease_lost` kills, 41 tables on the first).
  2. The migration applies through the same anchor on every overload, and is a
     no-op on re-application.
  3. AFTER: with a launch in flight the heartbeat answers `kept` and moves
     heartbeat_at - the launching manager renews through its own launch.
  4. AFTER: a takeover (FOR UPDATE) is still blocked by the launch in flight,
     so the generation a launch verified cannot move under it. A busy manager
     still keeps its lease.
  5. The fixed launch still reaches its body and returns its answer.
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
MIGRATION = ROOT / 'supabase/migrations/20261025200555_a_launch_does_not_hold_the_lease_against_its_own_heartbeat.sql'
PREIMAGE = ROOT / 'scripts/qualification/fixtures/launch-lease-key-share/preimage.sql'
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
cluster = Path(tempfile.mkdtemp(prefix='launch-lease-', dir=os.environ.get('TMPDIR')))
socket = Path(tempfile.mkdtemp(prefix='llks-sock-', dir='/tmp'))
data = cluster / 'data'
env = {'PATH': str(PG) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
started = False

T = '11111111-1111-4111-8111-111111111111'
GEN = '22222222-2222-4222-8222-222222222222'
LAUNCH = '33333333-3333-4333-8333-333333333333'
INSTANCE = '1-test'
PARK = 777001  # advisory lock the harness holds to keep a launch "in flight"


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
    """One long-lived psql, one transaction at a time, driven line by line."""

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
CREATE TABLE public.ca_mtt_admission_contract (singleton boolean PRIMARY KEY DEFAULT true);
INSERT INTO public.ca_mtt_admission_contract DEFAULT VALUES;

CREATE FUNCTION smarter_private.f06_generation_aborted(p_tournament_id uuid, p_generation uuid)
 RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.fn_ca_lock_mtt_admission_contract() RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM 1 FROM public.ca_mtt_admission_contract WHERE singleton FOR SHARE; END $$;
CREATE FUNCTION public.fn_ca_tournament_recorded_format(p_tournament_id uuid)
 RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'mtt-v1'::text $$;
-- The launch body: park on the harness's advisory lock, then answer. While a
-- session sits here it IS a launch in flight, holding whatever the overload
-- took on the lease row.
CREATE FUNCTION public.fn_begin_tournament_launch_before_lease_generation(
  p_tournament_id uuid, p_launch_id uuid, p_started_at timestamptz)
 RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock({PARK});
  INSERT INTO public.tournament_launch_receipts (tournament_id, launch_id, lease_generation)
  VALUES (p_tournament_id, p_launch_id, '{GEN}')
  ON CONFLICT (tournament_id) DO NOTHING;
  RETURN jsonb_build_object('ok', true, 'completed', false, 'launch_id', p_launch_id);
END $$;
CREATE FUNCTION public.fn_complete_tournament_launch_before_lease_generation(
  p_tournament_id uuid, p_launch_id uuid)
 RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock({PARK});
  UPDATE public.tournament_launch_receipts SET completed_at = clock_timestamp()
   WHERE tournament_id = p_tournament_id;
  RETURN jsonb_build_object('ok', true, 'completed', true);
END $$;

-- The production heartbeat, verbatim in the parts that matter: lockable rows
-- FOR NO KEY UPDATE ... SKIP LOCKED, renewed by ctid, busy for a locked row.
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

-- The takeover, shaped like claim_tournament_lease_v2: FOR UPDATE first, so a
-- busy manager (any KEY SHARE holder) keeps its lease until it commits.
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
"""

HEARTBEAT = f"""SELECT state FROM public.heartbeat_tournament_leases_v4('{INSTANCE}',
  '[{{"tournament_id":"{T}","lease_generation":"{GEN}"}}]'::jsonb, 30);"""


def heartbeat():
    return q(HEARTBEAT, timeout=30)


def heartbeat_at():
    return q(f"SELECT heartbeat_at FROM public.engine_tournament_leases WHERE tournament_id = '{T}';")


def launch_in_flight(call_sql, check):
    """Hold PARK in a harness session, start a launch in another session (it
    blocks inside its body with the lease-row lock already taken), run the
    check, then release PARK and collect the launch's answer."""
    holder = Session()
    holder.send(f"BEGIN; SELECT pg_advisory_lock({PARK}); \\echo PARKED")
    assert holder.wait_for('PARKED'), holder.out
    launcher = Session()
    launcher.send(f"{call_sql} \\echo LAUNCHED")
    # The launch has reached its body once it is waiting on PARK.
    deadline = time.time() + 30
    while time.time() < deadline:
        waiting = q(f"""SELECT count(*) FROM pg_locks
                         WHERE locktype = 'advisory' AND objid = {PARK} AND NOT granted;""")
        if waiting == '1':
            break
        time.sleep(0.05)
    else:
        raise AssertionError('the launch never reached its body: ' + repr(launcher.out))
    try:
        result = check()
    finally:
        holder.send('ROLLBACK;')
        holder.close()
        assert launcher.wait_for('LAUNCHED'), launcher.out
        launcher.close()
    return result, '\n'.join(launcher.out)


BEGIN_5 = f"SELECT public.fn_begin_tournament_launch_atomic('{T}','{LAUNCH}', clock_timestamp(), '{GEN}', 'mtt-v1');"
COMPLETE_4 = f"SELECT public.fn_complete_tournament_launch_atomic('{T}','{LAUNCH}', '{GEN}', 'mtt-v1');"

try:
    run([PG / 'initdb', '-D', data, '-U', 'postgres', '--auth=trust'])
    run([PG / 'pg_ctl', '-D', data, '-l', cluster / 'log', '-w', '-o',
         f"-k {socket} -c listen_addresses='' -c lock_timeout=0", 'start'])
    started = True
    q(SCHEMA)
    q(PREIMAGE.read_text())
    assert heartbeat() == 'kept', 'fixture: an idle lease must renew'

    # 1. BEFORE: a launch in flight makes its own heartbeat answer busy.
    state, answer = launch_in_flight(BEGIN_5, heartbeat)
    assert state == 'busy', state
    assert '"ok": true' in answer, answer
    print('PASS: before the migration, a launch in flight answers its own heartbeat with busy (FOR UPDATE)', flush=True)
    state, _ = launch_in_flight(COMPLETE_4, heartbeat)
    assert state == 'busy', state
    print('PASS: before the migration, a completion in flight answers busy too', flush=True)

    # 2. The migration applies by anchor on all six overloads, then is a no-op.
    q(MIGRATION.read_text())
    n = q("""SELECT count(*) FROM pg_proc WHERE proname IN ('fn_begin_tournament_launch_atomic','fn_complete_tournament_launch_atomic')
             AND prosrc ~ 'engine_tournament_leases l\\s[^;]*FOR KEY SHARE;'
             AND prosrc !~ 'engine_tournament_leases l\\s[^;]*FOR UPDATE;';""")
    assert n == '6', n
    q(MIGRATION.read_text())
    print('PASS: migration rewrote all six launch overloads to FOR KEY SHARE and re-applies as a no-op', flush=True)

    # 3. AFTER: the heartbeat renews through the launch.
    q(f"UPDATE public.engine_tournament_leases SET heartbeat_at = clock_timestamp() - interval '10 seconds' WHERE tournament_id = '{T}';")
    before = heartbeat_at()
    state, answer = launch_in_flight(BEGIN_5, heartbeat)
    assert state == 'kept', state
    assert heartbeat_at() != before, 'heartbeat_at did not move'
    assert '"ok": true' in answer, answer
    print('PASS: after the migration, a launch in flight answers its own heartbeat with kept and moves heartbeat_at', flush=True)
    state, answer = launch_in_flight(COMPLETE_4, heartbeat)
    assert state == 'kept', state
    assert '"ok": true' in answer, answer
    print('PASS: after the migration, a completion in flight is renewed too', flush=True)

    # 4. AFTER: a takeover still waits for the launch to commit.
    def takeover_blocks():
        taker = Session()
        taker.send(f"SELECT granted FROM public.claim_tournament_lease_v2('{T}', '2-other', NULL, gen_random_uuid(), 30); \\echo TOOK")
        blocked = not taker.wait_for('TOOK', timeout=2)
        waiting = q(f"""SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
                         WHERE l.locktype = 'tuple' AND NOT l.granted
                            OR (l.locktype = 'transactionid' AND NOT l.granted);""")
        taker.p.kill()
        return blocked and int(waiting) >= 1
    blocked, _ = launch_in_flight(BEGIN_5, takeover_blocks)
    assert blocked, 'the takeover was not blocked by a launch in flight'
    print('PASS: after the migration, a takeover (FOR UPDATE) still waits behind a launch in flight', flush=True)

    # 5. The fixed launch answers as before when nothing is in flight.
    out = q(BEGIN_5)
    assert '"ok": true' in out and '"lease_generation"' in out, out
    out = q(f"SELECT public.fn_begin_tournament_launch_atomic('{T}','{LAUNCH}', clock_timestamp(), gen_random_uuid(), 'mtt-v1');")
    assert 'launch_lease_lost' in out, out
    print('PASS: the fixed launch still verifies the generation and still launches', flush=True)
finally:
    if started:
        subprocess.run([str(PG / 'pg_ctl'), '-D', str(data), '-m', 'immediate', 'stop'],
                       capture_output=True, env=env)
    shutil.rmtree(cluster, ignore_errors=True)
    shutil.rmtree(socket, ignore_errors=True)
