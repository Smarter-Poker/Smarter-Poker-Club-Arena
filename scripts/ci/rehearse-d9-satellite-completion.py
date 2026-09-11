#!/usr/bin/env python3
"""Rehearse exact legacy satellite settlement on a fresh offline PG17 cash baseline."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile

base = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--pg-bin', default='/opt/homebrew/opt/postgresql@17/bin')
pg = Path(parser.parse_args().pg_bin).resolve()
assert subprocess.check_output([str(pg/'postgres'), '--version'], text=True).startswith('postgres (PostgreSQL) 17.')
archive = base/'fixtures/d9-satellite-completion-20260911.tar.gz'
assert hashlib.sha256(archive.read_bytes()).hexdigest() == '6348a41f1f03250d0196bbf8ac18cee4cd4d5bf8214d45620a68bcd34ef29145'
out = Path(tempfile.mkdtemp(prefix='ca-d9-satellite-', dir='/tmp'))
with tarfile.open(archive) as source:
    for member in source.getmembers():
        assert member.isfile() and Path(member.name).name == member.name
        (out/member.name).write_bytes(source.extractfile(member).read())
manifest = json.loads((out/'fixture-manifest.json').read_text())
assert manifest['case'] == 'D9-sealed-satellite-completion'
for name, digest in manifest['sha256'].items():
    assert Path(name).name == name
    assert hashlib.sha256((out/name).read_bytes()).hexdigest() == digest, name
for name in ['seed-targets.py', 'test-satellites.py', 'test-satellite-prerequisites.py']:
    assert (out/name).read_bytes() == (base/'rehearsals/d9'/name).read_bytes()
migration = base.parent.parent/'supabase/migrations/20260911172413_complete_legacy_satellites_through_sealed_canonical_settleme.sql'
assert (out/'integration.sql').read_bytes() == migration.read_bytes()
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['PGTZ'] = 'UTC'


def run(command, log):
    result = subprocess.run(command, cwd=out, env=env, text=True, capture_output=True)
    (out/log).write_text(result.stdout+result.stderr)
    if result.returncode:
        raise RuntimeError(log+': '+(result.stderr or result.stdout)[-2000:])
    return result.stdout


# This existing sealed fixture repeats all21 cash completions and the ordinary
# modern E2 path from exact committed source. It stops its own cluster afterward.
cash = run([sys.executable, str(base/'rehearse-d9-cash-completion.py'), '--pg-bin', str(pg)], 'cash-prerequisite.log')
cash_result = json.loads([line for line in cash.splitlines() if line.startswith('{')][-1])
assert cash_result['status'] == 'passed'
cash_receipts = Path(cash_result['receiptDirectory'])
cash_run = json.loads((cash_receipts/'run.json').read_text())
assert cash_run['cashCompleted'] == 21 and cash_run['productionWrites'] == 0
state = json.loads((Path(cash_run['runtime'])/'cluster.json').read_text())
cluster = Path(state['cluster'])
assert cluster.parent == Path('/tmp') and cluster.name.startswith('ca-e2-owned-')
assert state['socket'] == str(cluster/'socket') and state['port'] == 55498
assert state['database'] == 'd9_legacy_completion'
psql = [str(pg/'psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', state['socket'], '-p', str(state['port']), '-U', 'postgres']
started = False
try:
    # Only restart the disposable cluster just created by this invocation.
    run([str(pg/'pg_ctl'), '-D', str(cluster/'data'), '-l', str(cluster/'postgres.log'), '-o', "-h '' -k "+state['socket']+' -p 55498', '-w', 'start'], 'start.log')
    started = True
    database = 'd9_satellite_completion_v2'
    run(psql+['-d', 'postgres', '-c', 'CREATE DATABASE '+database+' TEMPLATE d9_legacy_completion;'], 'clone.log')
    state['database'] = database
    (out/'cluster.json').write_text(json.dumps(state)+'\n')
    for name in ['seed-targets.py', 'test-satellites.py', 'test-satellite-prerequisites.py']:
        text = (out/name).read_text().replace('/opt/homebrew/opt/postgresql@17/bin', str(pg))
        (out/name).write_text(text)
    for name in ['remainders-schema.sql', 'current-functions.sql', 'current-functions-acls.sql']:
        run(psql+['-d', database, '-f', str(out/name)], name+'.log')
    run([sys.executable, str(out/'seed-targets.py')], 'seed.log')
    run([sys.executable, str(out/'test-satellite-prerequisites.py')], 'dependency-refusals.log')
    run(psql+['-d', database, '-f', str(out/'integration.sql')], 'integration.log')
    run([sys.executable, str(out/'test-satellites.py')], 'test-satellites.log')
    result = json.loads((out/'satellite-receipt.json').read_text())
    assert result['completed'] == 3 and result['productionWrites'] == 0
    metadata = run(psql+['-d', database, '-Atc', "SELECT jsonb_agg(jsonb_build_object('identity',oid::regprocedure::text,'source_md5',md5(prosrc),'definition_md5',md5(pg_get_functiondef(oid)),'owner',pg_get_userbyid(proowner),'security_definer',prosecdef,'config',proconfig,'acl',proacl)) FROM pg_proc WHERE oid IN ('fn_ca_complete_legacy_tournament(uuid,text)'::regprocedure,'fn_ca_legacy_satellite_receipt_check(uuid,uuid,boolean)'::regprocedure,'fn_ca_legacy_satellite_contract_proof(uuid)'::regprocedure,'trg_capture_satellite_economics_on_start()'::regprocedure,'fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure,'fn_settle_satellite_tournament(uuid,uuid)'::regprocedure,'fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'::regprocedure);"], 'function-metadata.json')
    json.loads(metadata)
    (out/'cash-prerequisite-run.json').write_bytes((cash_receipts/'run.json').read_bytes())
    (out/'cash-prerequisite-modern-e2-verification-receipt.json').write_bytes((cash_receipts/'modern-e2-verification-receipt.json').read_bytes())

    # Rebuild a fresh modern fixture, then install EVERY satellite replacement
    # before admitting the original hypothetical future finishes. Replaying the
    # already completed cash-prerequisite E2 database would not test this path.
    modern = cluster/'post-satellite-modern-regression'
    modern.mkdir()
    modern_database = 'd9_post_satellite_e2'
    prior_modern = Path(cash_run['modernRuntime'])
    for source in prior_modern.iterdir():
        if source.is_file() and source.suffix in {'.py', '.sql', '.json'}:
            shutil.copyfile(source, modern/source.name)
    loader = modern/'load-local.py'
    loader.write_text(loader.read_text().replace('d9_e2_regression', modern_database))
    modern_state = {**state, 'database': modern_database}
    (modern/'cluster.json').write_text(json.dumps(modern_state)+'\n')
    for name in ['load-local.py', 'seed-local.py']:
        run([sys.executable, str(modern/name)], 'modern-'+name+'.log')
    for name in ['restore-observed-acls.sql', 'shared-late-status-migration.sql',
                 'd12-reviewed-preview.sql', '20260911163920_accepted_tournament_settlement_facts.sql',
                 'integration.sql']:
        run(psql+['-d', modern_database, '-f', str(modern/name)], 'modern-cash-'+name+'.log')
    for name in ['remainders-schema.sql', 'current-functions.sql', 'current-functions-acls.sql', 'integration.sql']:
        run(psql+['-d', modern_database, '-f', str(out/name)], 'modern-satellite-'+name+'.log')
    before_modern = json.loads(run(psql+['-d', modern_database, '-Atc', "SELECT jsonb_build_object('status',(SELECT status FROM tournaments WHERE id='bee519fa-ff07-438c-9542-d386fc821908'),'payouts',(SELECT count(*) FROM tournament_payouts),'legacy_seals',(SELECT count(*) FROM tournament_legacy_finish_evidence),'survivors',(SELECT count(*) FROM tournament_players WHERE status='playing'));"], 'modern-before.json'))
    assert before_modern == {'status': 'RUNNING', 'payouts': 0, 'legacy_seals': 0, 'survivors': 12}, before_modern
    run(psql+['-d', modern_database, '-f', str(modern/'future-finishes.sql')], 'modern-future-finishes.log')
    terminal = json.loads(run(psql+['-d', modern_database, '-Atc', "SELECT fn_complete_tournament_terminal('bee519fa-ff07-438c-9542-d386fc821908','8327a08a-77e7-4f33-be45-e086a718c9e2','places');"], 'modern-terminal.log'))
    assert terminal['status'] == 'COMPLETED'
    run([sys.executable, str(modern/'verify-local.py')], 'modern-verify.log')
    modern_receipt = json.loads((modern/'verification-receipt.json').read_text())
    seals = run(psql+['-d', modern_database, '-Atc', 'SELECT count(*) FROM tournament_legacy_finish_evidence;'], 'modern-legacy-seals.log')
    assert seals.strip() == '0'
    modern_receipt['satelliteMigrationInstalledBeforeFutureFinishes'] = hashlib.sha256(migration.read_bytes()).hexdigest()
    modern_receipt['beforeOrdinaryFinish'] = before_modern
    modern_receipt['legacySealsAfterOrdinaryFinish'] = 0
    (out/'modern-e2-verification-receipt.json').write_text(json.dumps(modern_receipt, indent=2)+'\n')
    dependencies = json.loads((out/'dependency-refusal-receipt.json').read_text())
    summary = {'status': 'passed', 'case': manifest['case'], 'observedAt': datetime.now(timezone.utc).isoformat(), 'postgres': subprocess.check_output([str(pg/'postgres'), '--version'], text=True).strip(), 'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'migrationSha256': hashlib.sha256(migration.read_bytes()).hexdigest(), 'runnerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'completed': 3, 'cashCompletedPreviously': 21, 'negativeCases': len(result['negativeTests']), 'dependencyDriftRefusals': len(dependencies['cases']), 'ordinaryModernCompletionAfterSatelliteMigration': True, 'comparedTables': result['comparedTables'], 'ordinaryStartIgnoresUnsealedRecoveryHint': result['ordinaryStartIgnoresUnsealedRecoveryHint'], 'productionWrites': 0}
    (out/'run.json').write_text(json.dumps(summary, indent=2)+'\n')
finally:
    if started:
        run([str(pg/'pg_ctl'), '-D', str(cluster/'data'), '-m', 'fast', '-w', 'stop'], 'stop.log')
print(json.dumps({'status': 'passed', 'receiptDirectory': str(out)}))
