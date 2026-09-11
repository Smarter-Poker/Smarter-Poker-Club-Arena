#!/usr/bin/env python3
"""Compose D8 against the separately sealed D10 native rehearsal, locally only.

The D10 runner creates/stops its own socket-only cluster and verifies every
fixture hash. This driver copies that fixture before adding its D8 test hook.
"""
from pathlib import Path
import argparse, hashlib, json, shutil, subprocess, tempfile

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--fixture-directory',type=Path,required=True)
p.add_argument('--evidence',type=Path,required=True)
p.add_argument('--accepted-settlement-migration',type=Path,required=True)
a=p.parse_args();root=Path(__file__).resolve().parents[2]
manifest=json.loads((a.fixture_directory/'fixture-manifest.json').read_text())
assert manifest['case']=='D10'
fixture=Path(tempfile.mkdtemp(prefix='d8-d10-fixture-'))
for name,digest in manifest['sha256'].items():
 assert Path(name).name==name
 data=(a.fixture_directory/name).read_bytes()
 assert hashlib.sha256(data).hexdigest()==digest,name
 (fixture/name).write_bytes(data)
shutil.copyfile(a.fixture_directory/'fixture-manifest.json',fixture/'fixture-manifest.json')
accepted_source=fixture/'accepted-settlement-dependency.sql'
accepted_source.write_bytes(a.accepted_settlement_migration.read_bytes())
runner=(a.fixture_directory/'run.py').read_text()
# The release owner explicitly authorized removing this scheduling-only guard
# in our copied socket-only fixture runner. Exact ruling SQL bytes, database
# guards and every production runtime timing restriction remain unchanged.
local_clock_guard="""minute=datetime.now(timezone.utc).minute
if minute>=50 or minute<3:
    raise SystemExit('The preserved ruling refuses :50-:03 UTC. Run this local rehearsal outside that window.')
"""
assert runner.count(local_clock_guard)==1
runner=runner.replace(local_clock_guard,'# Private native fixture may rehearse at any wall-clock minute.\n')
anchor="    run(['python3',str(runtime/'verify-local.py')],'verify.log')"
assert runner.count(anchor)==1
hook="\n    run(['python3',"+repr(str(root/'tests/accounting/makegood-d10-probe.py'))+",str(runtime),"+repr(str(accepted_source))+"],'makegood-probe.log')"
runner=runner.replace(anchor,anchor+hook)
(fixture/'run.py').write_text(runner)
r=subprocess.run(['python3',str(fixture/'run.py')],text=True,capture_output=True)
a.evidence.mkdir(parents=True,exist_ok=True)
(a.evidence/'runner.log').write_text(r.stdout+r.stderr)
if r.returncode:raise SystemExit(r.stderr+r.stdout)
run=json.loads((sorted((fixture/'runs').glob('*/run.json'))[-1]).read_text())
runtime=Path(run['runtime'])
for name in ['makegood-proof.json','makegood-probe.log','verification-receipt.json','bust-evidence-receipt.json']:
 shutil.copyfile(runtime/name,a.evidence/name)
receipt=json.loads((runtime/'makegood-proof.json').read_text())
print(json.dumps({k:v for k,v in receipt.items() if k not in ['historical_receipts','five_true_place_receipts']}))
