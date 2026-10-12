#!/usr/bin/env python3
"""Build and qualify the PG17 read-only export client in explicit owned scratch.

No engine image, production installation, release dispatch or credentials are
involved. The maintained native transformation retains upstream object selection
and archive serialization and batches only function and sequence metadata reads.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
ARCHIVE_SHA = 'dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979'
URL = 'https://ftp.postgresql.org/pub/source/v17.11/postgresql-17.11.tar.bz2'


def owned_parent(path):
    path = Path(path).absolute()
    allowed = path.is_relative_to('/Volumes/SmarterWork/agent-work')
    runner = os.environ.get('RUNNER_TEMP')
    if os.environ.get('GITHUB_ACTIONS') == 'true' and runner:
        allowed = allowed or path.is_relative_to(Path(runner).absolute())
    if not allowed or not path.is_dir() or path.resolve() != path:
        raise RuntimeError('Explicit owned external or provider scratch is required')
    return path


def build(args):
    parent = owned_parent(args.scratch)
    # Socket fixtures must also stay in owned storage and fit native limits.
    if len(str(parent).encode()) > 74:
        raise RuntimeError('Use a shorter owned scratch path for native socket qualification')
    work = Path(tempfile.mkdtemp(prefix='dr-client-', dir=parent))
    archive = work / 'postgresql-17.11.tar.bz2'
    with urllib.request.urlopen(URL, timeout=30) as response, archive.open('xb') as target:
        size = 0
        while block := response.read(1024 * 1024):
            size += len(block)
            if size > 64 * 1024 * 1024:
                raise RuntimeError('Pinned source exceeds its bounded download size')
            target.write(block)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != ARCHIVE_SHA:
        raise RuntimeError('Pinned PostgreSQL source checksum differs')
    with tarfile.open(archive) as source:
        source.extractall(work, filter='data')
    tree = work / 'postgresql-17.11'
    prefix = work / 'client'
    environment = dict(os.environ)

    def run(command, name, cwd=tree, env=environment, timeout=180):
        with (work / (name + '.log')).open('xb') as log:
            result = subprocess.run([str(arg) for arg in command], cwd=cwd, env=env,
                                    stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
        if result.returncode:
            raise RuntimeError('Native client stage failed: ' + name)

    transformation = ROOT / 'scripts/verification-harness/leaderboard-native-function-batch.mjs'
    native_source = tree / 'src/bin/pg_dump/pg_dump.c'
    patched = work / 'pg_dump-batched.c'
    run(['node', transformation, native_source, patched], 'transform')
    native_source.write_bytes(patched.read_bytes())
    # Scoped pkg-config directories avoid shadowing the native source's own
    # pg_config headers with an unrelated Homebrew/PostgreSQL installation.
    for variable, flag in [('CPPFLAGS', '--cflags'), ('LDFLAGS', '--libs-only-L')]:
        value = subprocess.run(['pkg-config', flag, 'libzstd', 'openssl'],
                               check=True, capture_output=True, text=True, timeout=15)
        environment[variable] = value.stdout.strip()
    run(['./configure', '--prefix=' + str(prefix), '--without-icu', '--without-readline',
         '--with-zstd', '--with-ssl=openssl'], 'configure')
    run(['make', '-C', 'src/backend', 'generated-headers'], 'headers')
    run(['make', '-C', 'src/bin/pg_dump', '-j4', 'pg_dump'], 'compile')
    run(['make', '-C', 'src/interfaces/libpq', 'install'], 'private-libpq')
    client = tree / 'src/bin/pg_dump/pg_dump'
    test_env = dict(environment, PG_BIN=args.pg_bin, TMPDIR=str(work),
                    NATIVE_PG_SOCKET_ROOT=str(parent), NATIVE_DR_PG_DUMP=str(client))
    run(['python3', '-B', '-m', 'unittest', 'discover', '-s', 'scripts/ci',
         '-p', 'test_native_supabase_export.py'], 'actual-restore-qualification',
        cwd=ROOT, env=test_env)
    receipt = {
        'client_qualified': True, 'production_restore_qualified': False,
        'client': str(client), 'client_sha256': hashlib.sha256(client.read_bytes()).hexdigest(),
        'upstream_archive_sha256': ARCHIVE_SHA,
        'transformation_sha256': hashlib.sha256(transformation.read_bytes()).hexdigest(),
        'test_sha256': hashlib.sha256((ROOT / 'scripts/ci/test_native_supabase_export.py').read_bytes()).hexdigest(),
        'qualification_log': str(work / 'actual-restore-qualification.log'),
    }
    (work / 'qualification.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scratch', required=True)
    parser.add_argument('--pg-bin', default='/opt/homebrew/bin')
    options = parser.parse_args()
    os.umask(0o077)
    print(json.dumps(build(options)))
