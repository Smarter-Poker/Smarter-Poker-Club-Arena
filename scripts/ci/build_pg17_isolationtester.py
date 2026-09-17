#!/usr/bin/env python3
"""Build PostgreSQL's pinned native isolation test client; no database server.

Uses unmodified official release sources and upstream configure/make/install
subdirectory targets. Installs only libpq and the isolation tools below output.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
VERSION = '17.11'
VERSION_NUM = 170011
SOURCE_URL = 'https://ftp.postgresql.org/pub/source/v17.11/postgresql-17.11.tar.bz2'
SOURCE_SHA256 = 'dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979'
OUTPUT = ROOT / 'artifacts/postgresql-17-isolationtester'
TOOL_LEAF = Path('toolchain/lib/pgxs/src/test/isolation/isolationtester')
CLEAN_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
             'PYTHONDONTWRITEBYTECODE': '1'}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def validate_version(value, label):
    matched = re.search(r'\(PostgreSQL\) ([0-9]+(?:\.[0-9]+)+)(?:\s|$)', value.strip())
    require(matched is not None and matched.group(1) == VERSION,
            label + ': exactly PostgreSQL ' + VERSION + ' required')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    output = args.output.resolve()
    # Upstream adds /postgresql to pkglibdir only when the prefix lacks either
    # "postgres" or "pgsql". Keep this reviewed prefix and therefore exact path.
    require('postgres' in str(output) or 'pgsql' in str(output),
            'output must retain PostgreSQL prefix for the reviewed installed tool path')
    output.mkdir(parents=True, exist_ok=False)
    receipt = {'passed': False, 'version': VERSION, 'sourceUrl': SOURCE_URL,
               'sourceSha256': SOURCE_SHA256, 'steps': []}
    pg = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin')).resolve()
    deadline = time.monotonic() + 300
    old_handlers = {}
    failure = None

    def interrupted(signum, _frame):
        raise RuntimeError('Build interrupted by signal ' + str(signum))

    def command(argv, label, cwd=ROOT):
        remaining = deadline - time.monotonic()
        require(remaining > 0, 'Finite build deadline exhausted')
        log = output / (label + '.log')
        with log.open('wb') as sink:
            proc = subprocess.Popen([str(a) for a in argv], cwd=cwd, env=CLEAN_ENV,
                                    stdout=sink, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL, start_new_session=True)
            try:
                code = proc.wait(timeout=remaining)
            except BaseException:
                # Terminate only this command's owned compiler/make process group.
                if proc.poll() is None:
                    os.killpg(proc.pid, signal.SIGTERM)
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait(timeout=5)
                raise
        receipt['steps'].append({'name': label, 'argv': [str(a) for a in argv],
                                 'exit': code, 'logSha256': digest(log)})
        require(code == 0, label + ': command failed; inspect retained log')
        return log.read_text()

    try:
        for sig in (signal.SIGTERM, signal.SIGINT):
            old_handlers[sig] = signal.signal(sig, interrupted)
        require(os.geteuid() != 0, 'Use the existing non-root hosted worker')
        require((pg / 'postgres').is_file(), 'Existing packaged PG_BIN/postgres missing')
        version = command([pg / 'postgres', '--version'], 'packaged-postgres-version')
        validate_version(version, 'packaged server')
        receipt['packagedPostgresSha256'] = digest(pg / 'postgres')
        archive = output / 'postgresql-17.11.tar.bz2'
        with urllib.request.urlopen(SOURCE_URL, timeout=45) as response, archive.open('wb') as target:
            copied = 0
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                copied += len(block)
                require(copied <= 64 * 1024 * 1024 and time.monotonic() < deadline,
                        'Release download exceeded its size or deadline')
                target.write(block)
        require(digest(archive) == SOURCE_SHA256, 'Official release checksum mismatch')
        receipt['sourceBytes'] = archive.stat().st_size
        command(['tar', '-xjf', archive, '-C', output], 'extract-verified-release')
        source = output / ('postgresql-' + VERSION)
        prefix = output / 'toolchain'
        # These options remove optional frontend-build dependencies only. The
        # installed packaged PG17 server and its features are never replaced.
        command([source / 'configure', '--prefix=' + str(prefix), '--without-readline',
                 '--without-zlib', '--without-icu'], 'configure', source)
        command(['make', '-C', source / 'src/backend', 'generated-headers'], 'generated-headers')
        # This subdirectory's recursive libpq and libpgport targets share archive
        # outputs. Parallel recursion can truncate the same libpgport archive.
        command(['make', '-C', source / 'src/test/isolation', '-j1', 'all'], 'build-isolation')
        command(['make', '-C', source / 'src/interfaces/libpq', 'install'], 'install-libpq')
        command(['make', '-C', source / 'src/test/isolation', 'install'], 'install-isolation')
        tool = output / TOOL_LEAF
        require(tool.is_file() and os.access(tool, os.X_OK), 'Expected installed tool is absent')
        validate_version(command([tool, '-V'], 'installed-tool-version'), 'isolationtester')
        # The upstream RPATH points to this same owned libdir. Keep its matching
        # libpq with the executable, including the standard SONAME links.
        library = prefix / 'lib/libpq.so.5'
        require(library.is_file() and library.resolve().is_relative_to(prefix),
                'Matching source-built libpq is absent or outside the owned prefix')
        receipt['tool'] = {'path': str(tool), 'sha256': digest(tool)}
        receipt['libpq'] = {'path': str(library.resolve()), 'sha256': digest(library)}
        receipt['passed'] = True
    except BaseException as error:
        failure = error
        receipt['failure'] = str(error)
    finally:
        config_log = output / ('postgresql-' + VERSION) / 'config.log'
        if config_log.is_file():
            shutil.copyfile(config_log, output / 'configure-detail.log')
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
    if failure is not None:
        raise RuntimeError('Native isolation tool build failed; inspect ' + str(output)) from failure
    print('PG_ISOLATION_TESTER=' + str(output / TOOL_LEAF))


if __name__ == '__main__':
    main()
