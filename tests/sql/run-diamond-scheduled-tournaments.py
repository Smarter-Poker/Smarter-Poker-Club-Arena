#!/usr/bin/env python3
"""Prove the Diamond Arena's scheduled tournaments move money correctly.

Isolated PostgreSQL 17 only. This runner never connects to production: it
initdbs its own cluster on a private unix socket with listen_addresses empty,
loads the estate's historical schema pair, the Diamond tournament captures and
the concurrency scene (real players, a platform admin, an open arena inside
this private cluster only), then the live bodies migration 20261007000010
substitutes into (diamond-scheduled-tournaments-prerequisites.sql, every block
md5-pinned), then APPLIES THE MIGRATION VERBATIM - its own pins prove the
bodies it edits are production's - and finally drives the cases in
diamond-scheduled-tournaments-cases.sql through the real doors. Every money
movement happens in this throwaway cluster: it is the rolled-back proof
CLAUDE.md 11.5 requires, taken further, since the whole cluster is destroyed.

What it proves is printed as PASS lines and listed in the changelog
docs/changelog/2026-10-06-the-diamond-arena-spawns-the-midway-schedule.md.

Usage:
  python3 tests/sql/run-diamond-scheduled-tournaments.py [--bindir DIR] [--keep]
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SQL = ROOT / 'tests/sql'
BASE = (ROOT / 'scripts/ci/probes/bbj-bank-replay/funded/source'
             / 'internal-ledger-native-fixture-0006/build')
MIGRATION = (ROOT / 'supabase/migrations'
             / '20261007000010_the_diamond_arena_spawns_the_midway_schedule.sql')
# The concurrency scene refuses any database but this name on this port; the
# port only names the socket file inside this run's own temporary directory.
PORT = '55734'
DB = 'diamond_concurrency'
# PG_BIN is the ONLY thing this runner reads from the environment, and it names
# the PostgreSQL 17 binaries - never a server.
PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
CANDIDATES = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin',
              '/usr/pgsql-17/bin', '/opt/postgresql@17/bin']
# The runner's last line, and the proof run-diamond-sql-acceptance.py requires:
# kept on one line so the wrapper's list check finds it here.
PROOF = 'Diamond scheduled tournaments certified on isolated PostgreSQL 17; the migration is applied by the lead, never by this runner.'

CAPTURES = [
    (SQL / 'diamond-tournament-doors-captured.sql',
     SQL / 'diamond-tournament-doors-captured.manifest.json'),
    (SQL / 'diamond-tournament-lifecycle-doors.sql',
     SQL / 'diamond-tournament-lifecycle-doors.manifest.json'),
    (SQL / 'diamond-concurrency-doors.sql',
     SQL / 'diamond-concurrency-doors.manifest.json'),
    (SQL / 'diamond-scheduled-tournaments-prerequisites.sql',
     SQL / 'diamond-scheduled-tournaments-prerequisites.manifest.json'),
]
LOAD = [
    BASE / '00-roles.sql',
    BASE / '10-historical-schema.sql',
    SQL / 'diamond-tournament-fixture-schema.sql',
    SQL / 'diamond-tournament-doors-captured.sql',
    SQL / 'diamond-tournament-lifecycle-schema.sql',
    SQL / 'diamond-tournament-lifecycle-doors.sql',
    SQL / 'diamond-concurrency-doors.sql',
    SQL / 'diamond-concurrency-schema.sql',
    SQL / 'diamond-concurrency-seed.sql',
    SQL / 'diamond-scheduled-tournaments-prerequisites.sql',
    MIGRATION,
    SQL / 'diamond-scheduled-tournaments-cases.sql',
]


def find_bindir(explicit):
    for d in ([explicit] if explicit else []) + [PG_BIN] + CANDIDATES:
        if not d:
            continue
        p = pathlib.Path(d)
        if (p / 'initdb').exists() and (p / 'psql').exists() and (p / 'pg_ctl').exists():
            out = subprocess.run([str(p / 'postgres'), '--version'],
                                 capture_output=True, text=True).stdout
            if re.search(r'\(PostgreSQL\) 17\.', out):
                return p, out.strip()
    raise SystemExit('PostgreSQL 17 binaries not found; pass --bindir or set PG_BIN')


def check_capture(capture, manifest):
    """Every @@PIN must match the block under it, and the manifest must agree."""
    text = capture.read_text()
    blocks = re.findall(
        r'-- @@DOOR (?P<ident>[^\n]+)\n-- @@PIN md5=(?P<md5>[0-9a-f]{32}) len=(?P<len>\d+) owner=\S+\n'
        r'(?P<body>.*?);\nALTER FUNCTION ', text, re.S)
    if not blocks:
        raise SystemExit('%s carries no readable doors' % capture.name)
    bad = [ident for ident, md5, ln, body in blocks
           if hashlib.md5((body + '\n').encode()).hexdigest() != md5 or len(body + '\n') != int(ln)]
    if bad:
        raise SystemExit('captured door bodies in %s disagree with their own pins: %s'
                         % (capture.name, ', '.join(bad[:5])))
    doors = json.loads(manifest.read_text())['doors']
    if len(doors) != len(blocks):
        raise SystemExit('%s names %d doors, %s carries %d'
                         % (manifest.name, len(doors), capture.name, len(blocks)))
    return len(blocks)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bindir')
    ap.add_argument('--keep', action='store_true')
    args = ap.parse_args()

    for f in LOAD + [m for _, m in CAPTURES]:
        if not f.exists():
            raise SystemExit('missing fixture input: ' + str(f))
    for capture, manifest in CAPTURES:
        n = check_capture(capture, manifest)
        print('PASS: %d doors in %s agree with their own pins and the manifest'
              % (n, capture.name), flush=True)

    bindir, version = find_bindir(args.bindir)
    print('using ' + version, flush=True)
    root = pathlib.Path(tempfile.mkdtemp(prefix='diamond-scheduled-'))
    data, sock = root / 'data', root / 'sock'
    sock.mkdir(mode=0o700)
    os.chmod(root, 0o700)
    env = dict(os.environ, LC_ALL='C', PGTZ='UTC')

    def run(argv):
        r = subprocess.run([str(x) for x in argv], capture_output=True, text=True,
                           env=env, timeout=1800)
        if r.returncode:
            sys.stderr.write(r.stdout[-6000:] + '\n' + r.stderr[-6000:] + '\n')
            raise SystemExit('refused: ' + ' '.join(str(x) for x in argv[-2:]))
        return r

    started = False
    try:
        run([bindir / 'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust',
             '--auth-host=reject', '--encoding=UTF8', '--no-locale'])
        with (data / 'postgresql.conf').open('a') as f:
            f.write("\nlisten_addresses=''\nport=%s\nunix_socket_directories='%s'\n"
                    "unix_socket_permissions=0700\nmax_connections=12\n"
                    "shared_buffers='128MB'\nfsync=off\nsynchronous_commit=off\n"
                    "full_page_writes=off\nlog_min_error_statement=error\n" % (PORT, sock))
        run([bindir / 'pg_ctl', '-D', data, '-l', root / 'postgres.log', '-w', 'start'])
        started = True
        psql = [bindir / 'psql', '-X', '-q', '-h', sock, '-p', PORT, '-U', 'postgres',
                '-v', 'ON_ERROR_STOP=1']
        run(psql + ['-d', 'postgres', '-c', 'CREATE DATABASE %s TEMPLATE template0' % DB])
        boundary = run(psql + ['-At', '-d', DB, '-c',
                               "SELECT (inet_server_addr() IS NULL)::text||' '||current_user"]
                       ).stdout.split()
        if boundary[0] != 'true' or boundary[1] != 'postgres':
            raise SystemExit('the fixture boundary is not the private socket it requires')
        print('PASS: private socket-only PostgreSQL 17, owned by this run', flush=True)
        for f in LOAD:
            r = run(psql + ['-d', DB, '-f', f])
            if f == MIGRATION:
                print('PASS: migration %s applied verbatim, its own pins and post-image held'
                      % MIGRATION.name, flush=True)
            for line in (r.stdout + r.stderr).splitlines():
                if 'PASS:' in line and f.name.startswith('diamond-scheduled'):
                    print('PASS: ' + line.split('PASS:', 1)[1].strip(), flush=True)
        print(PROOF, flush=True)
    finally:
        if started and not args.keep:
            subprocess.run([str(bindir / 'pg_ctl'), '-D', str(data), '-m', 'immediate',
                            '-w', 'stop'], capture_output=True, env=env)
        if not args.keep:
            shutil.rmtree(root, ignore_errors=True)
        else:
            print('kept cluster at ' + str(root), flush=True)


if __name__ == '__main__':
    main()
