#!/usr/bin/env python3
"""Stand the installed Diamond tournament doors up on the historical base.

Isolated PostgreSQL 17 only. This runner never connects to production: it
initdbs its own cluster on a private unix socket with listen_addresses empty,
loads the estate's historical schema pair, adds the sliced fixture delta and
the bound capture, and then requires the capture's own verification block to
report every door matching its installed pin. It drops the cluster afterwards
whether it passed or failed.

Usage:
  python3 tests/sql/run-diamond-tournament-doors.py [--bindir DIR] [--keep]

DIR must hold PostgreSQL 17 initdb/pg_ctl/psql. Without --bindir the runner
looks at PG_BIN, then the usual Homebrew and Debian locations. An absent
PostgreSQL 17 is a failure, not a skip: a fixture that quietly does nothing is
the thing CLAUDE.md 10.86 is about.
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
CAPTURE = SQL / 'diamond-tournament-doors-captured.sql'
DELTA = SQL / 'diamond-tournament-fixture-schema.sql'
MANIFEST = SQL / 'diamond-tournament-doors-captured.manifest.json'
PORT = '55731'
DB = 'diamond_tournament_doors'
# PG_BIN is the ONLY thing this runner reads from the environment, and it names
# the PostgreSQL 17 binaries - never a server. The cluster below is one this run
# creates, owns and destroys, on a socket inside its own temporary directory
# with listen_addresses empty, so no environment variable can point this runner
# at a real database. CANDIDATES is a fixed fallback in source, not a second
# variable that has to be kept in step with the first.
PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
CANDIDATES = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin',
              '/usr/pgsql-17/bin', '/opt/postgresql@17/bin']


def find_bindir(explicit):
    for d in ([explicit] if explicit else []) + [PG_BIN] + CANDIDATES:
        if not d:
            continue
        p = pathlib.Path(d)
        if (p / 'initdb').exists() and (p / 'psql').exists() and (p / 'pg_ctl').exists():
            out = subprocess.run([str(p / 'postgres'), '--version'], capture_output=True, text=True).stdout
            if re.search(r'\(PostgreSQL\) 17\.', out):
                return p, out.strip()
    raise SystemExit('PostgreSQL 17 binaries not found; pass --bindir or set PG_BIN')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bindir')
    ap.add_argument('--keep', action='store_true')
    args = ap.parse_args()

    for f in (CAPTURE, DELTA, MANIFEST, BASE / '00-roles.sql', BASE / '10-historical-schema.sql'):
        if not f.exists():
            raise SystemExit('missing fixture input: ' + str(f))

    # The capture is its own binding: every @@PIN must match the block under it.
    text = CAPTURE.read_text()
    blocks = re.findall(
        r'-- @@DOOR (?P<ident>[^\n]+)\n-- @@PIN md5=(?P<md5>[0-9a-f]{32}) len=(?P<len>\d+) owner=\S+\n'
        r'(?P<body>.*?);\nALTER FUNCTION ', text, re.S)
    if not blocks:
        raise SystemExit('the capture carries no readable doors')
    bad = []
    for ident, md5, ln, body in blocks:
        cand = body + '\n'
        if hashlib.md5(cand.encode()).hexdigest() != md5 or len(cand) != int(ln):
            bad.append(ident)
    if bad:
        raise SystemExit('captured door bodies disagree with their own pins: ' + ', '.join(bad[:5]))
    manifest = json.loads(MANIFEST.read_text())
    if len(manifest['doors']) != len(blocks):
        raise SystemExit('the manifest names %d doors, the capture carries %d'
                         % (len(manifest['doors']), len(blocks)))
    print('PASS: %d captured doors agree with their own pins and the manifest'
          % len(blocks), flush=True)

    bindir, version = find_bindir(args.bindir)
    print('using ' + version, flush=True)
    root = pathlib.Path(tempfile.mkdtemp(prefix='diamond-doors-'))
    data, sock = root / 'data', root / 'sock'
    sock.mkdir(mode=0o700)
    os.chmod(root, 0o700)
    env = dict(os.environ, LC_ALL='C', PGTZ='UTC')

    def run(argv, **kw):
        r = subprocess.run([str(x) for x in argv], capture_output=True, text=True,
                           env=env, timeout=1800, **kw)
        if r.returncode:
            sys.stderr.write(r.stdout + '\n' + r.stderr + '\n')
            raise SystemExit('refused: ' + ' '.join(str(x) for x in argv[:2]))
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
                               "SELECT (inet_server_addr() IS NULL)::text||' '||current_user"]).stdout.split()
        if boundary[0] != 'true' or boundary[1] != 'postgres':
            raise SystemExit('the fixture boundary is not the private socket it requires')
        print('PASS: private socket-only PostgreSQL 17, owned by this run', flush=True)
        for f in (BASE / '00-roles.sql', BASE / '10-historical-schema.sql', DELTA, CAPTURE):
            r = run(psql + ['-d', DB, '-f', f])
            for line in (r.stdout + r.stderr).splitlines():
                if 'PASS:' in line:
                    print(line.split('PASS:', 1)[1].strip(), flush=True)
        seen = run(psql + ['-At', '-d', DB, '-c', """
            SELECT count(*) FROM (VALUES %s) AS t(ident)
             WHERE EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                            WHERE n.nspname='public'
                              AND p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' = t.ident)"""
            % ','.join("('" + d['identity'].replace("'", "''") + "')" for d in manifest['doors'])]).stdout.strip()
        if int(seen) != len(manifest['doors']):
            raise SystemExit('%s of %d captured doors are installed' % (seen, len(manifest['doors'])))
        print('all %d captured Diamond tournament doors are installed on the historical base'
              % len(manifest['doors']), flush=True)
        closed = run(psql + ['-At', '-d', DB, '-c',
            "SELECT COALESCE(bool_or(cash_games_enabled OR tournaments_enabled),false)::text FROM public.ca_arena_settings"]).stdout.strip()
        if closed != 'false':
            raise SystemExit('the fixture opened an arena switch; it must never do that')
        print('cash_games_enabled and tournaments_enabled are both closed', flush=True)
        print('Diamond tournament door capture verified. This is the fixture base and '
              'its doors; it is not a tournament lifecycle certification.', flush=True)
    finally:
        if started and not args.keep:
            subprocess.run([str(bindir / 'pg_ctl'), '-D', str(data), '-m', 'immediate', '-w', 'stop'],
                           capture_output=True, env=env)
        if not args.keep:
            shutil.rmtree(root, ignore_errors=True)
        else:
            print('kept cluster at ' + str(root), flush=True)


if __name__ == '__main__':
    main()
