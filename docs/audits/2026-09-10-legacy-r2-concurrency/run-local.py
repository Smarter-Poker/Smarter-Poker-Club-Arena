#!/usr/bin/env python3
"""Run the legacy-owner concurrency proof in a new local-only PG17 cluster."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tempfile

here = Path(__file__).resolve().parent
payer = Path(os.environ['ROUND1_FIXTURE']).resolve()
source = Path(os.environ['LEGACY_SOURCE_FIXTURE']).resolve()
frozen = Path(tempfile.mkdtemp(prefix='ca-legacy-r2-input.'))
runner = frozen / 'runner'
shutil.copytree(payer, runner, ignore=shutil.ignore_patterns('__pycache__'))
shutil.copy2(payer.parent / 'source-payer-proposal.sql', frozen / 'source-payer-proposal.sql')
candidate = frozen / 'source-candidate'
shutil.copytree(source, candidate, ignore=shutil.ignore_patterns('__pycache__'))
catalogs = ['function-catalog-reader-dependencies.json', 'trigger-catalog-legacy.json',
            'table-catalog-legacy.json', 'function-catalog-commission-batch.json',
            'function-catalog-legacy.json']
for name in catalogs:
    shutil.copy2(candidate / name, runner / 'vendor/source-authority/owner-composition' / name)
# Synthetic opening custody is established before enabling financial triggers.
# Every subsequent payment/debit/receipt uses the unchanged actual money owners.
seed = runner / 'fixture-seed.sql'
seed.write_text(seed.read_text() + "\nUPDATE clubs SET chip_treasury=1000 WHERE id=test_id(900);\n")
shell = runner / 'run-local.sh'
text = shell.read_text()
assert text.count('/tmp/ca-source-funding.XXXXXX') == 1
text = text.replace('/tmp/ca-source-funding.XXXXXX', '/tmp/ca-legacy-r2-native.XXXXXX')
assert text.count('/tmp/ca-source-funding-latest') == 1
text = text.replace('/tmp/ca-source-funding-latest', str(frozen / 'cluster-root.txt'))
text = text.replace('PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"', 'PGBIN="/opt/homebrew/opt/postgresql@17/bin"')
anchor='python3 "$fixture/build-fixture.py"'
identity='''identity=$("$PGBIN/psql" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT current_setting('data_directory') || '|' || (inet_server_addr() IS NULL)::text || '|' || current_setting('server_version_num');")
case "$identity" in "$proof_tmp/data|true|17"*) ;; *) printf '%s\\n' 'Private PG17 identity refused' >&2; exit 1;; esac
'''
assert text.count(anchor)==1
text=text.replace(anchor,identity+anchor)
shell.write_text(text)
inputs = {str(p.relative_to(frozen)): hashlib.sha256(p.read_bytes()).hexdigest()
          for p in sorted(frozen.rglob('*')) if p.is_file()}
clean_env={k:v for k,v in os.environ.items() if not k.startswith('PG') and k not in ('COMMISSION_PSQL','ROUND1_INPUT','ROUND1_HERE')}
env = dict(clean_env, LC_ALL='C', LANG='C', ROUND1_PROBE=str(here / 'native-probe.py'),
           LEGACY_R2_HERE=str(here), LEGACY_R2_SOURCE=str(candidate),
           PYTHONPATH=str(runner), PGHOSTADDR='', PGSSLMODE='disable')
result = subprocess.run(['bash', str(shell)], text=True, capture_output=True, env=env)
(here / 'native-run.log').write_text(result.stdout + result.stderr)
cluster = Path((frozen / 'cluster-root.txt').read_text().strip())
assert str(cluster).startswith('/tmp/ca-legacy-r2-native.')
assert not (cluster / 'data/postmaster.pid').exists(), 'private PG17 cluster did not stop'
# Preserve this stopped, task-owned fixture and all current evidence.
print('Retained stopped private cluster: '+str(cluster),flush=True)
if result.returncode:
    print((result.stdout + result.stderr)[-16000:])
    raise SystemExit(result.returncode)
proof = json.loads((here / 'native-proof.json').read_text())
proof.update(runner_exit=0, private_cluster_removed=False, private_cluster_stopped=True, private_cluster_path=str(cluster), frozen_input_sha256=inputs,
             harness_sha256={p.name:hashlib.sha256(p.read_bytes()).hexdigest()
                             for p in [Path(__file__).resolve(), here / 'native-probe.py']},
             opening_custody_fixture='club 900 treasury set to 1000 before captured financial triggers are enabled')
(here / 'native-proof.json').write_text(json.dumps(proof, indent=2) + '\n')
print(json.dumps({'checks':len(proof['checks']),'runner_exit':0,'private_cluster_removed':False,'private_cluster_stopped':True}))
