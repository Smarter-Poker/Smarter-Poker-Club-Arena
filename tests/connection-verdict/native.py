#!/usr/bin/env python3
"""Run the exact connection verdict in an owned, socket-only PostgreSQL 17 cluster."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source-root', type=Path, required=True)
    p.add_argument('--evidence', type=Path, required=True)
    p.add_argument('--pg-bin', type=Path, default=Path('/opt/homebrew/opt/postgresql@17/bin'))
    args = p.parse_args()
    source = args.source_root.resolve(strict=True)
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    inputs = [
        source / 'supabase/migrations/20260911195214_engine_table_connection_one_snapshot_verdict.sql',
        source / 'server/src/services/TableConnectionAccess.ts',
        source / 'supabase/migrations/20260823_03_club_members_overview.sql',
        Path(__file__).resolve(), Path(__file__).with_name('integration.mjs').resolve(),
    ]
    hashes = {str(f): hashlib.sha256(f.read_bytes()).hexdigest() for f in inputs}
    (evidence / 'inputs.json').write_text(json.dumps(hashes, indent=2) + '\n')
    # Neither libpq defaults nor inherited Git hook state may reach the fixture.
    env = {k: v for k, v in os.environ.items() if not k.startswith(('PG', 'GIT_'))}
    owner = Path(tempfile.mkdtemp(prefix='ca-connection-owned-', dir='/tmp')).resolve()
    os.chmod(owner, 0o700)
    data, socket = owner / 'data', owner / 'socket'
    socket.mkdir(mode=0o700)
    started = False
    def run(argv, **kw):
        return subprocess.run([str(x) for x in argv], env=env, check=True, **kw)
    try:
        version = run([args.pg_bin / 'postgres', '--version'], capture_output=True, text=True).stdout.strip()
        if ' 17.' not in version:
            raise RuntimeError('This qualification requires native PostgreSQL 17')
        with (evidence / 'bootstrap.log').open('w') as log:
            run([args.pg_bin / 'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale'], stdout=log, stderr=log)
            with (data / 'postgresql.conf').open('a') as conf:
                conf.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nport=55473\nmax_connections=12\nshared_buffers='16MB'\nfsync=on\n")
            run([args.pg_bin / 'pg_ctl', '-D', data, '-l', evidence / 'postgres.log', '-w', 'start'], stdout=log, stderr=log)
            started = True
            run([args.pg_bin / 'createdb', '-h', socket, '-p', '55473', '-U', 'postgres', 'ca_connection_verdict'], stdout=log, stderr=log)
        cluster = {'host': str(socket), 'port': 55473, 'user': 'postgres', 'database': 'ca_connection_verdict'}
        (evidence / 'cluster.json').write_text(json.dumps(cluster) + '\n')
        node = shutil.which('node', path=env.get('PATH'))
        if not node:
            raise RuntimeError('Node.js is required')
        with (evidence / 'integration.log').open('w') as log:
            run([node, '--experimental-vm-modules', Path(__file__).with_name('integration.mjs'), source, evidence], stdout=log, stderr=log, timeout=90)
        assert hashes == {str(f): hashlib.sha256(f.read_bytes()).hexdigest() for f in inputs}, 'source changed during qualification'
        cases = json.loads((evidence / 'cases.json').read_text())
        result = {'status': 'passed', 'postgres': version, 'cases': cases, 'inputs': hashes,
                  'scope': 'Isolated projected schema and exact helper/RPC; no production identity, writes or deployed transport claim.'}
        (evidence / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'status': 'passed', 'cases': len(cases), 'evidence': str(evidence)}))
    finally:
        if started:
            with (evidence / 'shutdown.log').open('w') as log:
                run([args.pg_bin / 'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'], stdout=log, stderr=log)
        shutil.rmtree(owner)


if __name__ == '__main__':
    main()
