#!/usr/bin/env python3
"""One explicit logical export using the authenticated CLI and native pg_dump.

The CLI's documented dry-run output contains its ephemeral connection details.
Consume those only in memory; never log, persist, or execute that shell script.
This operation is not a publisher and an export is not a restore certificate.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time

KEYS = {'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'}


class ExportError(RuntimeError):
    pass


def safe_stage(stderr):
    if isinstance(stderr, bytes):
        stderr = stderr.decode(errors='replace')
    stages = ['extensions', 'schemas', 'user-defined tables', 'user-defined functions',
              'user-defined types', 'procedural languages', 'aggregates', 'operators',
              'access methods', 'operator classes', 'operator families', 'event triggers',
              'large objects', 'rewrite rules', 'policies']
    found = [stage for line in (stderr or '').splitlines() for stage in stages
             if line.strip() == 'pg_dump: reading ' + stage]
    return found[-1] if found else 'unknown'


def connection_environment(script):
    """Fail closed on changed CLI connection syntax without exposing values."""
    values = {}
    for line in script.splitlines():
        if not line.startswith('export '):
            continue
        parts = shlex.split(line)
        if len(parts) != 2 or '=' not in parts[1]:
            raise ExportError('CLI connection syntax changed')
        key, value = parts[1].split('=', 1)
        if key not in KEYS or key in values or not value or '\x00' in value:
            raise ExportError('CLI connection contract changed')
        values[key] = value
    if set(values) != KEYS or not re.fullmatch(r'[0-9]{1,5}', values['PGPORT']):
        raise ExportError('CLI connection is incomplete')
    if not 1 <= int(values['PGPORT']) <= 65535:
        raise ExportError('CLI connection port is invalid')
    # Explicit transport encryption; never inherit a caller's disabled setting.
    return dict(os.environ, **values, PGSSLMODE='verify-full', PGSSLROOTCERT='system', PGCONNECT_TIMEOUT='15',
                PGAPPNAME='ca-launch-reset-logical-export',
                PGOPTIONS='-c default_transaction_read_only=on -c idle_in_transaction_session_timeout=60s')


def destination(path):
    path = Path(path).absolute()
    roots = [Path('/Volumes/SmarterWork/agent-work'),
             Path('/Volumes/SmarterArchives/agent-evidence')]
    if not any(path.is_relative_to(root) for root in roots):
        raise ExportError('Export must be on the authorized external volume')
    volume = next(root.parent for root in roots if path.is_relative_to(root))
    if not volume.is_mount():
        raise ExportError('Authorized external volume is not mounted')
    if not path.parent.is_dir() or path.exists() or path.is_symlink():
        raise ExportError('Export requires an existing owned directory and a new file')
    if path.parent.resolve() != path.parent:
        raise ExportError('Export parent must not redirect through a symlink')
    return path


def linked_project(workdir, expected):
    if not re.fullmatch(r'[a-z]{20}', expected):
        raise ExportError('Expected project reference is invalid')
    reference = Path(workdir) / 'supabase/.temp/project-ref'
    if not reference.is_file() or reference.read_text().strip() != expected:
        raise ExportError('Owned checkout is not linked to the expected project')


def cli_environment(cli, workdir):
    result = subprocess.run([cli, 'db', 'dump', '--linked', '--dry-run',
                             '--workdir', str(workdir)],
                            capture_output=True, text=True, timeout=60)
    if result.returncode:
        # Provider output may contain connection details: never surface it.
        raise ExportError('Authenticated CLI connection preparation failed')
    return connection_environment(result.stdout)


def export(pg_dump, environment, path, mode, timeout):
    started = time.monotonic()
    partial = path.with_name(path.name + '.partial')
    flags = ['--schema-only'] if mode == 'schema' else ['--format=custom', '--compress=zstd:3']
    # Full mode deliberately has no schema/table exclusions. Supabase's normal
    # schema export excludes managed schemas and cannot certify a full restore.
    command = [pg_dump, '--verbose', '--lock-wait-timeout=5s', *flags]
    try:
        with partial.open('xb') as output:
            os.chmod(partial, 0o600)
            result = subprocess.run(command, env=environment, stdout=output,
                                    stderr=subprocess.PIPE, timeout=timeout)
        if result.returncode:
            diagnostic = result.stderr.decode(errors='replace').lower()
            kind = next((name for name, phrase in [
                ('permission_denied', 'permission denied'),
                ('lock_timeout', 'lock timeout'),
                ('statement_timeout', 'statement timeout'),
                ('authentication_failed', 'authentication failed'),
                ('version_mismatch', 'version mismatch'),
                ('connection_failed', 'connection to server'),
                ('query_failed', 'query failed'),
                ('concurrent_catalog_change', 'concurrently updated'),
            ] if phrase in diagnostic), 'unclassified')
            raise ExportError('Native export failed (' + kind + '); partial artifact is not qualified')
        if not partial.stat().st_size:
            raise ExportError('Native export produced an empty artifact')
        # Atomic no-replacement promotion: a competing file must never be lost.
        # Both files are on the same authorized volume, so link is atomic.
        os.link(partial, path)
        partial.unlink()
    except subprocess.TimeoutExpired as failure:
        raise ExportError('Native export exceeded its bounded deadline; metadata stage: '
                          + safe_stage(failure.stderr)) from None
    digest = hashlib.sha256()
    with path.open('rb') as exported:
        for block in iter(lambda: exported.read(1024 * 1024), b''):
            digest.update(block)
    return {'exported': True, 'mode': mode, 'bytes': path.stat().st_size,
            'sha256': digest.hexdigest(), 'elapsed_seconds': round(time.monotonic()-started, 3),
            'restore_qualified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli', default='/opt/homebrew/bin/supabase')
    parser.add_argument('--pg-dump', default='/opt/homebrew/bin/pg_dump')
    parser.add_argument('--ssl-root-cert', default='system',
                        help='Official provider CA certificate, or system trust store')
    parser.add_argument('--workdir', required=True)
    parser.add_argument('--project-ref', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--mode', required=True, choices=['schema', 'full'])
    parser.add_argument('--deadline-seconds', type=int, default=300)
    args = parser.parse_args()
    if not 1 <= args.deadline_seconds <= 3600:
        raise ExportError('Export deadline must be between 1 and 3600 seconds')
    os.umask(0o077)
    path = destination(args.output)
    linked_project(args.workdir, args.project_ref)
    environment = cli_environment(args.cli, args.workdir)
    if args.ssl_root_cert != 'system' and not Path(args.ssl_root_cert).is_file():
        raise ExportError('Provider CA certificate is unavailable')
    environment['PGSSLROOTCERT'] = args.ssl_root_cert
    receipt = export(args.pg_dump, environment, path, args.mode, args.deadline_seconds)
    receipt['project_ref'] = args.project_ref
    print(json.dumps(receipt))


if __name__ == '__main__':
    try:
        main()
    except (ExportError, OSError, subprocess.SubprocessError) as failure:
        # No subprocess arguments, exceptions, provider output or secrets.
        print(json.dumps({'exported': False, 'restore_qualified': False,
                          'error': str(failure) if isinstance(failure, ExportError)
                          else 'Export refused or failed without a qualified artifact'}))
        sys.exit(1)
