"""Inventory existing BBJ receipts for the existing accounting artifact upload."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import shutil

REPOSITORY = 'Smarter-Poker/Smarter-Poker-Club-Arena'
REQUIRED = ('RESULTS.json', 'funded-source-custody.json', 'funded-source-custody.log',
            'funded/RESULTS.json')


def manifest(repository, environment, event, head):
    repository = Path(repository).resolve()
    if (environment.get('GITHUB_REPOSITORY') != REPOSITORY or
            environment.get('GITHUB_JOB') != 'accounting_postgres' or
            not re.fullmatch('[0-9a-f]{40}', head) or head != environment.get('GITHUB_SHA')):
        raise ValueError('Exact current accounting checkout required for evidence')
    for key in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'):
        if not re.fullmatch('[1-9][0-9]*', environment.get(key, '')):
            raise ValueError('Current run and attempt required')
    outcome = environment.get('BBJ_STEP_OUTCOME')
    timing_outcome = environment.get('BBJ_TIMING_OUTCOME')
    timing_failed = outcome == 'skipped' and timing_outcome in ('failure', 'cancelled')
    if outcome not in ('success', 'failure', 'cancelled') and not timing_failed:
        raise ValueError('An attempted BBJ or timing-admission step is required')
    source = head
    if environment.get('GITHUB_EVENT_NAME') == 'pull_request':
        pr = event.get('pull_request', {})
        source = pr.get('head', {}).get('sha')
        if (pr.get('head', {}).get('repo', {}).get('full_name') != REPOSITORY or
                pr.get('base', {}).get('repo', {}).get('full_name') != REPOSITORY or
                not re.fullmatch('[0-9a-f]{40}', str(source))):
            raise ValueError('Same repository PR source required')
    elif environment.get('GITHUB_EVENT_NAME') != 'schedule':
        raise ValueError('Existing PR or scheduled accounting invocation required')
    output = repository/'artifacts/bbj-bank-replay'
    if any(p.is_symlink() for p in (repository/'artifacts', output)):
        raise ValueError('Evidence root cannot be a symlink')
    output.mkdir(parents=True, exist_ok=True)
    inventory = []
    for path in sorted(output.rglob('*')):
        if path.is_symlink():
            raise ValueError('Evidence cannot contain symlinks')
        if path.is_dir():
            if path.name in ('base', 'global', 'pg_wal', 'pg_tblspc'):
                raise ValueError('PostgreSQL data is not an artifact')
            continue
        if not path.is_file() or path.name in ('PG_VERSION', 'postgresql.conf', 'postmaster.pid'):
            raise ValueError('Only regular receipt files are permitted')
        if path.name == 'EVIDENCE-MANIFEST.json':
            raise ValueError('Existing invocation manifest cannot be replaced')
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        inventory.append({'path': str(path.relative_to(output)),
                          'bytes': path.stat().st_size, 'sha256': digest.hexdigest()})
    present = {row['path'] for row in inventory}
    return {'repository': REPOSITORY, 'checkout_commit': head, 'source_commit': source,
            'workflow_ref': environment.get('GITHUB_WORKFLOW_REF'),
            'run_id': environment['GITHUB_RUN_ID'], 'run_attempt': environment['GITHUB_RUN_ATTEMPT'],
            'job': 'accounting_postgres', 'bbj_step_outcome': outcome,
            'timing_step_outcome': timing_outcome,
            'attempted_phase': 'timing_admission' if timing_failed else 'bbj_verification',
            'files': inventory, 'missing_required_receipts': [p for p in REQUIRED if p not in present],
            'financial_acceptance': False}


def main():
    root = Path(__file__).resolve().parents[4]
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    head = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'],
                                   text=True, timeout=30).strip()
    receipt = manifest(root, os.environ, event, head)
    timing = Path(os.environ['RUNNER_TEMP'])/('bbj-job-timing-' +
             os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT'] + '.json')
    if os.environ.get('BBJ_JOB_TIMING_FILE') != str(timing) or timing.is_symlink():
        raise ValueError('Only the current job timing receipt may be retained')
    receipt['timing_receipt_missing'] = not timing.is_file()
    if timing.is_file():
        destination = root/'artifacts/bbj-bank-replay/job-timing-admission.json'
        with timing.open('rb') as source, destination.open('xb') as target:
            shutil.copyfileobj(source, target)
        receipt = {**manifest(root, os.environ, event, head), 'timing_receipt_missing': False}
    path = root/'artifacts/bbj-bank-replay/EVIDENCE-MANIFEST.json'
    with path.open('x') as stream:
        json.dump(receipt, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
        stream.write('ready=true\n')
    if receipt['bbj_step_outcome'] == 'success' and receipt['missing_required_receipts']:
        raise RuntimeError('Successful BBJ step is missing required receipts: ' +
                           ', '.join(receipt['missing_required_receipts']))


if __name__ == '__main__':
    main()
