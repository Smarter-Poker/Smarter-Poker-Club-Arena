#!/usr/bin/env python3
"""A disposable PG17 cluster runs the deep-stack commitment detector's controls.

No remote connection: the migration under test is applied to an empty cluster
over the smallest stand-in schema, fixtures are dealt, and every expectation is
asserted inside the database. A silent pass is impossible - the counters are
asserted next to the rows they count, and an unreadable fixture must still be
named rather than dropped.
"""
from pathlib import Path
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

MIGRATION = 'supabase/migrations/20260927220637_horse_deep_stack_one_pair_commitment_detector.sql'
BOOTSTRAP = 'scripts/ci/probes/horse-stackoff-detector/bootstrap.sql'
ASSERTIONS = 'scripts/ci/probes/horse-stackoff-detector/assertions.sql'


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--pg-bin', type=Path, required=True)
    ap.add_argument('--source-root', type=Path, default=Path('.'))
    args = ap.parse_args()

    root = args.source_root.resolve()
    for rel in (MIGRATION, BOOTSTRAP, ASSERTIONS):
        if not (root / rel).is_file():
            print(f'[stackoff] missing required input: {rel}', file=sys.stderr)
            return 2

    initdb = args.pg_bin / 'initdb'
    pg_ctl = args.pg_bin / 'pg_ctl'
    psql = args.pg_bin / 'psql'
    for exe in (initdb, pg_ctl, psql):
        if not exe.is_file():
            print(f'[stackoff] missing postgres binary: {exe}', file=sys.stderr)
            return 2

    work = Path(tempfile.mkdtemp(prefix='stackoff-pg-'))
    data, sock = work / 'data', work / 'sock'
    sock.mkdir()
    # LC_ALL is pinned for two reasons: a macOS postmaster refuses to start
    # without a valid locale ("became multithreaded during startup"), and a
    # fixed collation keeps the ORDER BY in the sweep's cursor deterministic.
    env = dict(os.environ, PGHOST=str(sock), PGDATABASE='postgres', PGTZ='UTC',
               LC_ALL='C', LANG='C')
    started = False
    try:
        subprocess.run([str(initdb), '-D', str(data), '-U', 'postgres', '--no-sync',
                        '-A', 'trust'], check=True, capture_output=True, env=env)
        # The postmaster outlives pg_ctl and inherits whatever it was given for
        # stdout/stderr. Handed a pipe, it holds the write end open for its whole
        # life and subprocess.run() waits forever for an EOF that never comes, so
        # the server log goes to a FILE and pg_ctl's own output is discarded.
        serverlog = work / 'server.log'
        subprocess.run([str(pg_ctl), '-D', str(data), '-w', '-l', str(serverlog), '-o',
                        f'-k {sock} -c listen_addresses= -c fsync=off', 'start'],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        started = True
        for rel in (BOOTSTRAP, MIGRATION, ASSERTIONS):
            done = subprocess.run(
                [str(psql), '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-f', str(root / rel)],
                capture_output=True, text=True, env=env)
            if done.returncode != 0:
                print(f'[stackoff] FAILED applying {rel}', file=sys.stderr)
                print(done.stdout, file=sys.stderr)
                print(done.stderr, file=sys.stderr)
                return 1
            if rel == ASSERTIONS:
                print(done.stdout.strip())
    except subprocess.CalledProcessError as exc:
        print('[stackoff] cluster setup failed', file=sys.stderr)
        print(exc.stdout.decode(errors='replace') if exc.stdout else '', file=sys.stderr)
        print(exc.stderr.decode(errors='replace') if exc.stderr else '', file=sys.stderr)
        log = work / 'server.log'
        if log.is_file():
            print(log.read_text(errors='replace'), file=sys.stderr)
        return 2
    finally:
        if started:
            subprocess.run([str(pg_ctl), '-D', str(data), '-m', 'immediate', 'stop'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        shutil.rmtree(work, ignore_errors=True)
    print('[stackoff] all controls passed')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
