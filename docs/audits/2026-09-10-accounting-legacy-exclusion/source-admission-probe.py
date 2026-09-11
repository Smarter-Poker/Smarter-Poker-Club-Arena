#!/usr/bin/env python3
"""Only admission changes and preservation of already-existing historical rights."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
from fixture_helpers import sql, setup, source, state

here = Path(os.environ['SOURCE_ADMISSION_HERE'])
checks = []
def check(label, condition):
    assert condition, label
    checks.append(label)
    print('PASS: ' + label, flush=True)
def load(name):
    return sql((here / name).read_text())
def insert(source_id, amount=1, source_type='rake_settlement', capture=None):
    marker = 'NULL' if capture is None else str(capture)
    return f"""INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,
      source_type,source_id,contributing_user_id,created_at,commission_capture_version)
      VALUES(test_id(900),test_id(301),{amount},.70,'{source_type}',test_id({source_id}),
        test_id(201),'2026-08-25T12:00:00Z',{marker});"""

setup()
load('fixture-view.sql')
load('00-expand.sql')
subprocess.run([os.environ['COMMISSION_PSQL'], '-X', '-q', '-v', 'ON_ERROR_STOP=1',
                '-f', str(here / '00-online-index.sql')], check=True)
load('00-preflight.sql')
# Explicit historical liability input predates this new INSERT classifier.
# No claim that a historical production accrual owner emitted this row.
sql(insert(1900901, 7))
legacy_id = sql("SELECT id FROM agent_commissions WHERE source_id=test_id(1900901);")
load('01-source-exclusion.sql')
load('02-excluded-owners.sql')
load('03-excluded-unpaid-rollups.sql')
check('Existing historical row without accepted receipt remains unchanged and payable',
      sql("SELECT amount=7 AND commission_capture_version IS NULL FROM agent_commissions "
          "WHERE id='" + legacy_id + "';") == 't'
      and sql("SELECT fn_agent_unsettled_commission(test_id(900),test_id(301));", actor=301) == '7')
before = json.loads(sql("SELECT jsonb_build_object('bank',(SELECT chip_treasury FROM clubs "
                       "WHERE id=test_id(900)),'wallet',(SELECT chip_balance FROM club_members "
                       "WHERE club_id=test_id(900) AND user_id=test_id(301)));") )
paid = json.loads(sql("SELECT fn_agent_claim_commission(test_id(900),test_id(1900101),1000);", actor=301))
after = json.loads(sql("SELECT jsonb_build_object('bank',(SELECT chip_treasury FROM clubs "
                      "WHERE id=test_id(900)),'wallet',(SELECT chip_balance FROM club_members "
                      "WHERE club_id=test_id(900) AND user_id=test_id(301)));") )
check('Actual unchanged legacy claim still pays existing no-hand historical entitlement once',
      paid['success'] and paid['amount'] == 7 and before['bank'] - after['bank'] == 7
      and after['wallet'] - before['wallet'] == 7)
before = state()
replayed = json.loads(sql("SELECT fn_agent_claim_commission(test_id(900),test_id(1900101),1000);", actor=301))
check('Historical lost-response replay creates no second money movement',
      replayed['replayed'] and replayed['amount'] == 7 and state() == before)
check('Historical fixture comes from actual accepted owner before capture activation',
      sql("SELECT commission_capture_version IS NULL AND post_commit_payload_hash IS NOT NULL "
          "FROM hand_atomic_commits WHERE hand_id=test_id(1000001);") == 't')
sql(insert(1000001, 3))
check('Known historical accepted source retains NULL commission authority',
      sql("SELECT commission_capture_version IS NULL FROM agent_commissions "
          "WHERE source_id=test_id(1000001) AND user_id=test_id(301);") == 't')
# The identities and amounts are fixture inputs; actual accepted/bank/batch owners execute.
source(1900001, '20', '2026-08-25T12:00:00Z', '2026-08-25T12:00:00Z')
batch = json.loads(sql("SELECT fn_credit_agent_commissions_batch(jsonb_agg(jsonb_build_object("
    "'user_id',player_id,'club_id',booked_club_id,'rake_credit',rake_credit,"
    "'source_type','rake_settlement','source_id',hand_id))) FROM ca_cash_commission_facts "
    "WHERE hand_id=test_id(1900001) AND rake_credit>0;"))
check('Actual accepted bank and batch owners classify new captured projections as marker one',
      batch.get('failed') == 0 and sql("SELECT count(*)>0 AND bool_and(commission_capture_version=1) "
          "FROM agent_commissions WHERE source_id=test_id(1900001);") == 't')
for source_id in [1900902, 1900901]:
    before = state()
    error = sql(insert(source_id), False)
    check(('Unknown cash source cannot insert payable legacy projection' if source_id == 1900902 else
           'Existing no-hand historical liability does not authorize a new projection'),
          'requires an accepted hand receipt' in error and state() == before)
sql(insert(1900903, 5, 'tournament_rake_settlement'))
check('Legitimate tournament source type retains existing legacy classification',
      sql("SELECT commission_capture_version IS NULL FROM agent_commissions "
          "WHERE source_id=test_id(1900903);") == 't')
before = state()
error = sql(insert(1000001, 1, capture=1), False)
check('Historical accepted source cannot be forged into captured authority',
      'contradicts accepted hand' in error and state() == before)
check('Updated classification helper retains private execution privileges',
      sql("SELECT NOT has_function_privilege('anon','fn_ca_commission_uses_captured_source(text,uuid)','execute') "
          "AND NOT has_function_privilege('authenticated','fn_ca_commission_uses_captured_source(text,uuid)','execute') "
          "AND NOT has_function_privilege('service_role','fn_ca_commission_uses_captured_source(text,uuid)','execute');") == 't')
inputs = ['00-expand.sql','00-online-index.sql','00-preflight.sql','01-source-exclusion.sql',
          '02-excluded-owners.sql','03-excluded-unpaid-rollups.sql','fixture-view.sql',
          'source-admission-probe.py','run-admission-local.py']
result = {'status': 'native_candidate_only', 'baseline_commit': 'b332bbefba8dca6a06b7d3de39631240cd6f9538',
          'baseline_groups_not_rerun': 30, 'checks': checks, 'runtime': sql('SELECT version();'),
          'cluster_identity': json.loads((Path(os.environ['SOURCE_ADMISSION_WORK']) / 'cluster-identity.json').read_text()),
          'inputs': {name: hashlib.sha256((here / name).read_bytes()).hexdigest() for name in inputs},
          'fixture_inputs': {str(p.relative_to(Path(os.environ['ROUND1_INPUT']))): hashlib.sha256(p.read_bytes()).hexdigest()
                            for p in Path(os.environ['ROUND1_INPUT']).rglob('*') if p.is_file()},
          'limits': ['No production activation.', 'No R2 concurrency diagnostics executed.',
                     'Known historical hand uses actual accepted owner; historical liability rows and calendar stamps are synthetic inputs.',
                     'Missing-hand historical source RPC returns without creating new allocations; existing liability rows remain payable.',
                     'No full outer cascade, source-period finality, browser or HTTP/RLS certification.']}
(here / 'source-admission-proof.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'passed': len(checks)}))
