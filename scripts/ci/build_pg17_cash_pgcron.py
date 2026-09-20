#!/usr/bin/env python3
"""Build exact pg_cron1.6.4 for the existing disposable hosted PG17 allocation.

Standard PGXS native compilation; no C changes. Supabase's documented heap-only
SQL patch and schema-identical 1.6->1.6.4 packaging alignment are fixture inputs.
No database service is created or started by this program.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
import urllib.request
from build_pg17_isolationtester import VERSION, validate_version

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'artifacts/production-alerts-cash-pgcron-build'
URL = 'https://codeload.github.com/citusdata/pg_cron/tar.gz/refs/tags/v1.6.4'
SOURCE_SHA = '52d1850ee7beb85a4cb7185731ef4e5a90d1de216709d8988324b0d02e76af61'
SOURCE_COMMIT = '9490f9cc9803f75105f2f7d89839a998f011f8d8'
HEAP_PATCH = ROOT / 'scripts/qualification/fixtures/cash-native-pgcron/pg_cron-heap-tables.patch'
HEAP_SHA = '47134f2c718dfb6bdad59da4fde12af4fb82db1f7725c02729aaf7521392bc0c'
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    require(os.geteuid() != 0, 'Run in the original hosted nonroot job')
    pg = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin')).resolve()
    config = pg / 'pg_config'
    output = OUTPUT
    output.mkdir(parents=True, exist_ok=False)
    deadline = time.monotonic() + 180
    receipt = {'passed': False, 'source': URL, 'sourceSha256': SOURCE_SHA,
               'sourceCommit': SOURCE_COMMIT, 'version': '1.6.4', 'pgVersion': VERSION,
               'packaging': 'upstream1.6 plus official schema-identical Supabase alignment',
               'steps': [], 'installed': {}}
    old = {}
    failure = None

    def interrupt(signum, _frame):
        raise RuntimeError('pg_cron build interrupted: ' + str(signum))

    def run(argv, name, cwd=ROOT):
        budget = deadline-time.monotonic()
        require(budget > 0, 'pg_cron build deadline exhausted')
        log = output / (name + '.log')
        with log.open('wb') as sink:
            child = subprocess.Popen([str(x) for x in argv], cwd=cwd, env=ENV,
                stdout=sink, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                start_new_session=True)
            try:
                code = child.wait(timeout=budget)
            except BaseException:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
                raise
        receipt['steps'].append({'name': name, 'exit': code, 'sha256': sha(log)})
        require(code == 0, name + ' failed; see retained log')
        return log.read_text().strip()

    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            old[sig] = signal.signal(sig, interrupt)
        require(config.is_file(), 'Matching postgresql-server-dev-17 pg_config required')
        validate_version(run([config, '--version'], 'pg-config-version'), 'pg_config')
        validate_version(run([pg/'postgres', '--version'], 'postgres-version'), 'postgres')
        require(HEAP_PATCH.is_file() and sha(HEAP_PATCH) == HEAP_SHA, 'provider heap patch differs')
        package_lib = Path(run([config, '--pkglibdir'], 'pg-pkglibdir'))
        package_share = Path(run([config, '--sharedir'], 'pg-sharedir')) / 'extension'
        require(package_lib == Path('/usr/lib/postgresql/17/lib')
                and package_share == Path('/usr/share/postgresql/17/extension'),
                'Only existing hosted PG17 package prefix is supported')
        archive = output / 'pg_cron-1.6.4.tar.gz'
        with urllib.request.urlopen(URL, timeout=30) as response:
            blob = response.read(1024*1024)
            require(len(blob) < 1024*1024 and hashlib.sha256(blob).hexdigest() == SOURCE_SHA,
                    'exact official pg_cron archive checksum required')
            archive.write_bytes(blob)
        run(['tar','-xzf',archive,'-C',output], 'extract')
        source = output / 'pg_cron-1.6.4'
        run(['patch','--batch','--forward','-p1','-i',HEAP_PATCH], 'provider-heap-patch', source)
        run(['make','-j2','PG_CONFIG='+str(config),'with_llvm=no','all'], 'pgxs-build', source)
        stage=output/'stage'
        run(['make','PG_CONFIG='+str(config),'with_llvm=no','DESTDIR='+str(stage),'install'], 'pgxs-stage', source)
        staged_lib=stage/str(package_lib).lstrip('/')/'pg_cron.so'
        staged_share=stage/str(package_share).lstrip('/')
        control=staged_share/'pg_cron.control'
        original=control.read_text()
        require(original.count("default_version = '1.6'") == 1, 'upstream SQL version differs')
        control.write_text(original.replace("default_version = '1.6'", "default_version = '1.6.4'"))
        (staged_share/'pg_cron--1.6--1.6.4.sql').write_text(
            '-- Alignment migration: 1.6 and 1.6.4 are schema-identical.\n')
        require(staged_lib.is_file(), 'native pg_cron.so absent')
        for source_file, target in [(staged_lib,package_lib/'pg_cron.so')]+[
            (leaf,package_share/leaf.name) for leaf in sorted(staged_share.glob('pg_cron*'))]:
            require(source_file.is_file() and not source_file.is_symlink(), 'unexpected staged input')
            run(['sudo','-n','install','-m','755' if target.suffix=='.so' else '644',source_file,target],
                'install-'+source_file.name)
            require(sha(source_file)==sha(target), 'installed extension bytes differ')
            receipt['installed'][str(target)]={'sha256':sha(target),'bytes':target.stat().st_size}
        receipt['postgresSha256']=sha(pg/'postgres')
        receipt['pgConfigSha256']=sha(config)
        receipt['passed']=True
    except BaseException as exc:
        failure=exc
        receipt['failure']=str(exc)
    finally:
        (output/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
        for sig, handler in old.items():
            signal.signal(sig,handler)
    if failure:
        raise RuntimeError('pg_cron source setup failed; see '+str(output)) from failure


if __name__=='__main__':
    main()
