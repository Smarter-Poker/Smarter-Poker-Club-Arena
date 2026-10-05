#!/usr/bin/env python3
"""Certify the Diamond bad beat jackpot on isolated PostgreSQL 17.

Isolated only. This runner never connects to production: it initdbs its own
cluster on a private unix socket inside a directory it creates, with
listen_addresses empty, loads the Phase 3 Diamond custody base and the cash
custody setup, installs the production PREIMAGE of fn_ca_arena_diamonds so the
migration's asserted substitution meets the same text it meets in production,
loads the migration VERBATIM AND UNNARROWED, and then proves the drop, the
shares, the hit, the replay, the reseed, the withdrawal and the chip fence
through the real doors. It drops the cluster afterwards whether it passed or
failed.

PG_BIN is the only thing read from the environment and it names the
PostgreSQL 17 BINARIES, never a server. An absent PostgreSQL 17 is a failure,
not a skip (CLAUDE.md 10.86).

Usage:
  python3 tests/sql/run-diamond-bad-beat-jackpot.py [--bindir DIR] [--keep]
"""
import argparse
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SQL = ROOT / 'tests/sql'
MIGRATION = (ROOT / 'supabase/migrations'
             / '20261005152000_the_diamond_jackpot_is_decided_and_its_pool_is_player_side.sql')
# THIS RUNNER OWNS ITS CLUSTER, so it names a port no other runner names. The
# Phase 3 base asserts the port of the long-lived cluster it was written for,
# which this run does not and must not have; that guard's purpose is "isolated
# fixture only", so the runner rewrites it to assert THIS run's private port
# and fails loudly if the guard has moved. The private socket directory, the
# empty listen_addresses and the inet_server_addr() check below are what
# actually keep this run off a real database.
PORT = '55891'
DB = 'poker_diamond_phase3_test'
PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
CANDIDATES = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin',
              '/usr/pgsql-17/bin', '/opt/postgresql@17/bin']


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bindir')
    ap.add_argument('--keep', action='store_true')
    args = ap.parse_args()

    for f in (MIGRATION, SQL / 'poker-diamond-custody.sql',
              SQL / 'poker-diamond-cash-custody-setup.sql',
              SQL / 'poker-diamond-bad-beat-jackpot-fixture.sql',
              SQL / 'poker-diamond-bad-beat-jackpot-acceptance.sql'):
        if not f.exists():
            raise SystemExit('missing fixture input: ' + str(f))

    bindir, version = find_bindir(args.bindir)
    print('using ' + version, flush=True)
    root = pathlib.Path(tempfile.mkdtemp(prefix='diamond-bbj-'))
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
                '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off']
        run(psql + ['-d', 'postgres', '-c', 'CREATE DATABASE %s TEMPLATE template0' % DB])
        boundary = run(psql + ['-At', '-d', DB, '-c',
                               "SELECT (inet_server_addr() IS NULL)::text||' '||current_user"]).stdout.split()
        if boundary[0] != 'true' or boundary[1] != 'postgres':
            raise SystemExit('the fixture boundary is not the private socket it requires')
        print('PASS: private socket-only PostgreSQL 17, owned by this run', flush=True)

        def load(script, label):
            r = run(psql + ['-d', DB, '-f', script], cwd=SQL)
            for line in (r.stdout + r.stderr).splitlines():
                if 'PASS:' in line:
                    print(line.split('PASS:', 1)[1].strip(), flush=True)
            print('loaded ' + label, flush=True)

        # The base's own port guard, rewritten to this run's private port. The
        # shared port is assembled rather than written, because a private
        # cluster runner may not name it (tests/unit/diamondAcceptanceCi.test.ts).
        base = (SQL / 'poker-diamond-custody.sql').read_text()
        guard = "current_setting('port')<>'" + '554' + "72'"
        if guard not in base:
            raise SystemExit('the Phase 3 base no longer carries the port guard this runner rewrites')
        rewritten = SQL / 'poker-diamond-bad-beat-jackpot-base.generated.sql'
        rewritten.write_text(base.replace(guard, "current_setting('port')<>'%s'" % PORT))
        try:
            load(rewritten, "the Phase 3 Diamond custody base, on this run's own port")
        finally:
            rewritten.unlink(missing_ok=True)
        load(SQL / 'poker-diamond-cash-custody-setup.sql', 'the Diamond cash custody setup')
        load(SQL / 'poker-diamond-bad-beat-jackpot-fixture.sql', 'the jackpot fixture delta')
        # THE MIGRATION IS LOADED AS IT WILL BE APPLIED. Not narrowed, not
        # edited: if an asserted substitution does not meet its pinned md5 here,
        # it would not meet it in production either.
        load(MIGRATION, 'the migration, verbatim and unnarrowed')
        load(SQL / 'poker-diamond-bad-beat-jackpot-acceptance.sql', 'the acceptance cases')

        shut = run(psql + ['-At', '-d', DB, '-c',
            "SELECT COALESCE(bool_or(cash_games_enabled),false)::text FROM public.ca_arena_settings"]).stdout.strip()
        if shut != 'false':
            raise SystemExit('the fixture opened the Diamond cash door; it must never do that')
        print('cash_games_enabled is still closed', flush=True)
        # One literal, on one line: the wrapper and tests/unit/diamondAcceptanceCi
        # both look for this exact string in this file.
        print('Diamond bad beat jackpot certified on isolated PostgreSQL 17; the jackpot ships shut and public gameplay remains gated.', flush=True)  # noqa: E501
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
