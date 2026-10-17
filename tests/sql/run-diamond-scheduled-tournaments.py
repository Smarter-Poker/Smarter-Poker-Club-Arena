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
FREEROLL_FEE_MIGRATION = (ROOT / 'supabase/migrations'
             / '20261017042014_diamond_freeroll_recovery_purchases_all_reach_the_prize_pool.sql')
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


def current_authorities_sql():
    """Validate the immutable read-only capture before private installation."""
    manifest = json.loads((SQL / 'diamond-tournament-current.manifest.json').read_text())
    doors = manifest['doors']
    if len(doors) != 134 or len({d['signature'] for d in doors}) != 134:
        raise SystemExit('current tournament capture requires 134 distinct authorities')
    if set(manifest['inputs']) != {
        'diamond-tournament-current-schema.sql', 'diamond-tournament-current-economics.sql',
        'diamond-tournament-current-cases.sql',
    }:
        raise SystemExit('current tournament input set is incomplete')
    for name, digest in manifest['inputs'].items():
        if pathlib.Path(name).name != name or hashlib.sha256((SQL / name).read_bytes()).hexdigest() != digest:
            raise SystemExit('current tournament input differs: ' + name)
    statements = []
    for door in doors:
        signature = door['signature']
        if not re.fullmatch(r'[a-z_0-9]+\([a-z_0-9 ,\[\]]*\)', signature):
            raise SystemExit('unsafe current tournament signature')
        if door['owner'] != 'postgres' or hashlib.md5(door['definition'].encode()).hexdigest() != door['full_md5']:
            raise SystemExit('current tournament capture differs: ' + signature)
        statements.append(door['definition'].rstrip(';\n') + ';')
        statements.append('ALTER FUNCTION public.%s OWNER TO postgres;' % signature)
        statements.append('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role;' % signature)
        entries = door['acl'].strip('{}').split(',')
        for entry in entries:
            role, grant = entry.split('=', 1)
            if role not in ('', 'postgres', 'anon', 'authenticated', 'service_role') or grant != 'X/postgres':
                raise SystemExit('unexpected current tournament execute grant: ' + signature)
            if role != 'postgres':
                statements.append('GRANT EXECUTE ON FUNCTION public.%s TO %s;' % (signature, role or 'PUBLIC'))
        expected = {key: door[key] for key in ('owner', 'security_definer', 'config')}
        expected['acl'] = sorted(entries)
        expected_json = json.dumps(expected).replace("'", "''")
        statements.append("""DO $verify$ BEGIN
          IF md5(pg_get_functiondef('public.%s'::regprocedure)) <> '%s' THEN
            RAISE EXCEPTION 'current function definition differs: %s'; END IF;
          IF (SELECT jsonb_build_object('owner',pg_get_userbyid(proowner),
             'security_definer',prosecdef,'config',proconfig,
             'acl',(SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(proacl) a))
             FROM pg_proc WHERE oid='public.%s'::regprocedure) IS DISTINCT FROM '%s'::jsonb THEN
            RAISE EXCEPTION 'current function metadata differs: %s'; END IF;
          END $verify$;""" % (signature, door['full_md5'], signature, signature, expected_json, signature))
    constraints = manifest['constraints']
    if len(constraints) != 22 or len({(c['table_name'], c['conname']) for c in constraints}) != 22:
        raise SystemExit('current tournament capture requires 22 CHECK constraints')
    for constraint in constraints:
        table, name = constraint['table_name'], constraint['conname']
        if not all(re.fullmatch(r'[a-z_0-9]+', value) for value in (table, name)):
            raise SystemExit('unsafe current constraint identity')
        if hashlib.md5(constraint['definition'].encode()).hexdigest() != constraint['md5']:
            raise SystemExit('current constraint capture differs: ' + name)
        statements.extend([
            'ALTER TABLE public.%s DROP CONSTRAINT IF EXISTS %s;' % (table, name),
            'ALTER TABLE public.%s ADD CONSTRAINT %s %s;' % (table, name, constraint['definition']),
            "DO $verify$ BEGIN IF (SELECT md5(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid='public.%s'::regclass AND conname='%s') IS DISTINCT FROM '%s' THEN RAISE EXCEPTION 'current CHECK differs: %s'; END IF; END $verify$;" % (table, name, constraint['md5'], name),
        ])
    return '\n'.join(statements)


def run_scene(args, current=False):

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
        files = LOAD
        if current:
            authority_file = root / 'current-authorities.sql'
            authority_file.write_text(current_authorities_sql())
            files = LOAD[:-1] + [SQL / 'diamond-tournament-current-schema.sql', authority_file,
                SQL / 'diamond-tournament-current-economics.sql', FREEROLL_FEE_MIGRATION,
                SQL / 'diamond-tournament-current-cases.sql']
        for f in files:
            r = run(psql + ['-d', DB, '-f', f])
            if f == MIGRATION:
                print('PASS: migration %s applied verbatim, its own pins and post-image held'
                      % MIGRATION.name, flush=True)
            for line in (r.stdout + r.stderr).splitlines():
                if 'PASS:' in line and (f.name.startswith('diamond-scheduled') or f.name == 'diamond-tournament-current-cases.sql'):
                    print('PASS: ' + line.split('PASS:', 1)[1].strip(), flush=True)
        if current:
            replay = subprocess.run([str(x) for x in psql + ['-d', DB, '-f', FREEROLL_FEE_MIGRATION]],
                capture_output=True, text=True, env=env, timeout=60)
            if replay.returncode == 0 or 'diamond_freeroll_fee_migration_already_installed' not in replay.stderr:
                raise SystemExit('current freeroll migration replay was not refused')
            result = run(psql + ['-At', '-d', DB, '-c', """SELECT
              md5(pg_get_functiondef('public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure))='30b96a6e6fe359d10e186c68a023c8fd'
              AND md5(pg_get_functiondef('public.fn_ca_tournament_charge_split(uuid,text,numeric)'::regprocedure))='26545c9dc6b043859f3090a915e5347a'
              AND public.fn_ca_tournament_purchase_fee_ratio(0,0,100)=0
              AND public.fn_ca_tournament_purchase_fee_ratio(0,0,1)=0.1
              AND public.fn_ca_tournament_purchase_fee_ratio(90,10,100)=0.1"""]).stdout.strip()
            if result != 't':
                raise SystemExit('freeroll repair authority changed after refused replay')
            print('PASS: migration replay refused; both repaired definitions and Diamond/chip/paid fee rules retained', flush=True)
        print('PASS: %s scheduled tournament scene complete' % ('current 134-authority' if current else 'historical migration'), flush=True)
    finally:
        if started:
            subprocess.run([str(bindir / 'pg_ctl'), '-D', str(data), '-m', 'immediate',
                            '-w', 'stop'], capture_output=True, env=env)
        if not args.keep:
            shutil.rmtree(root, ignore_errors=True)
        else:
            print('kept cluster at ' + str(root), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bindir')
    ap.add_argument('--keep', action='store_true')
    args = ap.parse_args()
    run_scene(args)
    run_scene(args, current=True)
    print(PROOF, flush=True)


if __name__ == '__main__':
    main()
