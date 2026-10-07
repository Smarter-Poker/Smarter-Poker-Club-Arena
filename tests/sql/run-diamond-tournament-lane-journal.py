#!/usr/bin/env python3
"""Prove the Diamond tournament lane writes no wallet journal row for a house leg.

Issue #6411, migration 20261007132503. Isolated PostgreSQL 17 only.

Never connects to production and needs no credential. It starts a cluster of its
own inside a temporary directory it creates and destroys, with listen_addresses
empty and a socket nobody else can name, so there is no environment variable
that could point it at a real database. PG_BIN selects which PostgreSQL 17
binaries run and is the only thing it reads from the environment.

WHAT IT PROVES. Five writes in the Diamond tournament lane journalled Diamonds
that moved between an entry's arena custody and the house, and never touched a
wallet: the tournament fee, the Spin surplus and the guarantee overlay return
(all three through fn_poker_diamond_tournament_drain), the guarantee overlay
paid in (fn_poker_diamond_tournament_settle_overlay) and the Spin underwrite
(fn_poker_diamond_spin_draw). On production the fee path wrote four -200 rows
at 13:03 UTC on 2026-10-07 and the journal stopped explaining four wallets.

HOW. The fixture world holds the tables these five functions touch, with the
production CHECK constraints, and the functions production ran before the fix,
loaded from tests/sql/diamond-tournament-lane-preimages.sql (pg_get_functiondef
text, md5-pinned). BEFORE reproduces the defect against them inside a
transaction it rolls back: a fee settlement writes journal rows that move no
wallet. The migration is then applied verbatim, its own pre-image and proof
blocks included, and AFTER drives every one of the five legs through the real
functions and asserts, each time: no wallet journal row, one register row per
custody share with the wallet unchanged on both sides, every wallet's journal
explaining its balance, house legs carrying no journal id, and the Diamond
identity whole. One entrant in every event is a horse, settled exactly as a
human (CLAUDE.md 10.5). The mutation cases prove the relaxed constraints are
still strict wherever a wallet leg exists: an error is the success case.

The register follower and the arena float are fixture reductions of the
production triggers and readers (named where they are defined below); the five
functions under test, the drain's readers, the entry guard and the guard
declaration are production's own text.

Every amount here is a legible fixture amount; none is a price.
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SQL_DIR = ROOT / 'tests' / 'sql'
PREIMAGES = SQL_DIR / 'diamond-tournament-lane-preimages.sql'
MIGRATION = ROOT / 'supabase' / 'migrations' / \
    '20261007132503_the_diamond_tournament_lane_leaves_custody_without_a_wallet_.sql'

PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
PACKAGED_BINDIRS = ('/usr/lib/postgresql/17/bin', '/usr/pgsql-17/bin')
ENV = {**os.environ, 'LC_ALL': 'C', 'LANG': 'C'}

ARENA = '002c2d27-9584-4e52-835a-bb2be148fc81'
HOUSE = '00000000-0000-0000-0000-00000000d1a0'
# Players: A, B, D are people; C is a horse. Every event seats C.
P_A = '00000000-0000-0000-0000-00000000000a'
P_B = '00000000-0000-0000-0000-00000000000b'
P_C = '00000000-0000-0000-0000-00000000000c'
P_D = '00000000-0000-0000-0000-00000000000d'
T_FEE = '00000000-0000-0000-0000-0000000000f1'
T_OVL = '00000000-0000-0000-0000-0000000000f2'
T_SPIN_UP = '00000000-0000-0000-0000-0000000000f3'
T_SPIN_DOWN = '00000000-0000-0000-0000-0000000000f4'


def bin_path(name: str) -> str:
    for bindir in (PG_BIN,) + PACKAGED_BINDIRS:
        candidate = pathlib.Path(bindir) / name
        if candidate.exists():
            return str(candidate)
    found = shutil.which(name)
    if not found:
        raise SystemExit(f'PostgreSQL 17 tool not found: {name} (set PG_BIN)')
    return found


SCHEMA = SQL_DIR / 'diamond-tournament-lane-schema.sql'
CASES = SQL_DIR / 'diamond-tournament-lane-cases.sql'
PARTS = ['SEED', 'BEFORE', 'AFTER FEE', 'AFTER OVERLAY', 'AFTER SPIN', 'MUTATIONS']


def parts() -> dict:
    """Split the cases file at its '-- @@ ' markers. Every part must be there."""
    out, name, buf = {}, None, []
    for line in CASES.read_text().splitlines(keepends=True):
        if line.startswith('-- @@ '):
            if name:
                out[name] = ''.join(buf)
            name, buf = line[6:].strip(), []
        elif name:
            buf.append(line)
    if name:
        out[name] = ''.join(buf)
    missing = [p for p in PARTS if p not in out]
    if missing:
        raise SystemExit(f'{CASES.name} is missing parts: {missing}')
    return out


def main() -> int:
    cases = parts()
    tmp = tempfile.mkdtemp(prefix='ca-tlane-')
    data = pathlib.Path(tmp) / 'data'
    sock = pathlib.Path(tmp) / 's'
    sock.mkdir(parents=True, exist_ok=True)
    passes = 0
    try:
        subprocess.run([bin_path('initdb'), '-D', str(data), '-U', 'postgres',
                        '-A', 'trust', '--no-sync', '--locale=C', '--encoding=UTF8'],
                       check=True, capture_output=True, text=True, env=ENV)
        started = subprocess.run(
            [bin_path('pg_ctl'), '-D', str(data), '-w', '-l', str(pathlib.Path(tmp) / 'pg.log'),
             '-o', f'-k {sock} -c listen_addresses= -c fsync=off', 'start'],
            capture_output=True, text=True, env=ENV)
        if started.returncode:
            log = pathlib.Path(tmp) / 'pg.log'
            if log.exists():
                print(log.read_text(), file=sys.stderr)
            raise SystemExit('could not start the isolated PostgreSQL 17 cluster')
        try:
            version = subprocess.run(
                [bin_path('psql'), '-X', '-At', '-h', str(sock), '-U', 'postgres',
                 '-d', 'postgres', '-c', 'SHOW server_version'],
                check=True, capture_output=True, text=True, env=ENV).stdout.strip()
            print(f'Isolated cluster: PostgreSQL {version}')
            if not version.startswith('17'):
                raise SystemExit(f'expected PostgreSQL 17, got {version}')

            def psql(sql: str, label: str) -> int:
                nonlocal passes
                r = subprocess.run(
                    [bin_path('psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1',
                     '-h', str(sock), '-U', 'postgres', '-d', 'postgres', '-f', '-'],
                    input=sql, text=True, capture_output=True, timeout=300, env=ENV)
                if r.returncode:
                    print(r.stdout)
                    print(r.stderr, file=sys.stderr)
                    raise SystemExit(f'{label} failed')
                n = 0
                for line in r.stderr.splitlines():
                    if 'PASS:' in line:
                        print('  ' + line.split('PASS:', 1)[1].strip())
                        n += 1
                passes += n
                return n

            print('\nThe fixture world, and the five functions as production ran them:')
            psql(SCHEMA.read_text(), 'fixture schema')
            psql(PREIMAGES.read_text(), 'the pre-images')
            psql(cases['SEED'], 'the seed')

            print('\nBEFORE:')
            if psql(cases['BEFORE'], 'before') != 1:
                raise SystemExit('BEFORE did not report the defect')

            print(f'\nAPPLYING {MIGRATION.name} verbatim, with its own pre-image and proof blocks:')
            psql(MIGRATION.read_text(), 'the migration')
            print('  the migration committed, including its own assertion blocks')
            passes += 1

            for name in PARTS[2:]:
                print(f'\n{name}:')
                psql(cases[name], name.lower())

            # One contiguous literal, as the other Diamond harnesses print it.
            print(f'\n{passes} Diamond tournament lane checks passed on isolated PostgreSQL 17; this is a fixture proof, not a production certification.')
            return 0
        finally:
            subprocess.run([bin_path('pg_ctl'), '-D', str(data), '-w', '-m', 'immediate', 'stop'],
                           capture_output=True, text=True, env=ENV)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    raise SystemExit(main())
