import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { migrationTransactionShape } from '../scripts/ci/migration-transaction-shape.mjs';
const base = 'scripts/ci/fixtures/tournament-source-identity-cover/';
const migration =
  'supabase/migrations/20261029020140_weekly_fee_source_identities_retain_their_tournament_and_rak.sql';
describe('tournament source identities retain narrow physical coverage', () => {
  it('adds exactly one fixed-width UUID cover through the existing CCI transaction route', () => {
    const sql = readFileSync(migration, 'utf8');
    const shape = migrationTransactionShape(migration.split('/').at(-1), sql);
    expect(shape.ok).toBe(true);
    expect(shape.ok && shape.indexes.length).toBe(1);
    expect(sql).toMatch(/\(id\) INCLUDE\(tournament_id,rake_record_id\)/);
    expect(sql).not.toMatch(
      /CREATE (?:OR REPLACE )?FUNCTION|ALTER TABLE|DROP INDEX|INSERT INTO|DELETE FROM|UPDATE public\./i
    );
    for (const guard of [
      'operator_refused',
      'history_replay',
      'window_refused',
      'source65_required',
      'original_generation_required',
      'actual_table_required',
      'exact_catalog_required',
      'original_authority_changed',
    ])
      expect(sql).toContain('fee_source_identity_cover_' + guard);
    expect(sql).toContain("SET LOCAL statement_timeout='15s'");
    expect(sql).toContain("SET LOCAL statement_timeout='5s'");
    expect(sql).toContain("qualified->'raw_triggers'");
    expect(sql.match(/\(contract->>'name'\)COLLATE"C"/g)).toHaveLength(2);
    expect(sql.match(/\(contract->>'function'\)COLLATE"C"/g)).toHaveLength(2);
  });
  it('binds the full actual table and both unchanged query snapshots', () => {
    const table = JSON.parse(readFileSync(base + 'actual-table-authority.json', 'utf8')).table;
    expect(table.columns).toHaveLength(15);
    expect(table.constraints).toHaveLength(5);
    expect(table.indexes).toHaveLength(14);
    expect(table.triggers).toHaveLength(8);
    const evidence = JSON.parse(readFileSync(base + 'qualification-evidence.json', 'utf8'));
    expect(evidence.qualification).toBe('passed');
    expect(evidence.plan_count).toBe(24);
    expect(evidence.cases).toContain(
      'real_CCI_old_RR_snapshot_and_concurrent_FK_writer_complete_without_source_mutation'
    );
    expect(evidence.cases).toContain(
      'actual_atomic_history_template_failure_retains_VALID_prefix_without_history'
    );
    expect(evidence.cases).toContain(
      'INVALID_prefix_is_not_repaired_by_IF_NOT_EXISTS_and_cannot_record_history'
    );
    expect(evidence.cases).toContain('after_full_FOR_wrong_event_receipt_bags_all3_modes');
  });
  it('runs the frozen native through the existing required floor family and retained directory', () => {
    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    const steps = ci.jobs.accounting_postgres.steps;
    const matching = steps.filter((step: { run?: string }) =>
      step.run?.includes('python3 -B scripts/ci/test_launch_reset_floor.py')
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].if).toBe('matrix.shard == 1');
    expect(matching[0].run).toContain('--output "$PROBE_EVIDENCE/floor.json"');
    expect(matching[0].env.PROBE_EVIDENCE).toBe('${{ runner.temp }}/scoped-launch-reset');
    const retention = steps.find(
      (step: { with?: { path?: string } }) =>
        step.with?.path === '${{ runner.temp }}/scoped-launch-reset/'
    );
    expect(retention.if).toContain('always()');
    expect(retention.if).toContain('matrix.shard == 1');
    expect(retention.with['if-no-files-found']).toBe('error');
    expect(ci.jobs.server.needs).toContain('accounting_postgres');
  });
  it('executes the actual unconditional floor dispatch with exact arguments and propagates native refusal', () => {
    const result = spawnSync(
      'python3',
      [
        '-c',
        `
import ast,subprocess,sys
from pathlib import Path
from types import SimpleNamespace
floor=Path('scripts/ci/test_launch_reset_floor.py').resolve()
name='test-tournament-source-identity-cover-postgres.py'
nodes=[n for n in ast.parse(floor.read_text()).body if isinstance(n,ast.Expr) and name in ast.unparse(n)]
assert len(nodes)==1
code=compile(ast.Module(body=nodes,type_ignores=[]),str(floor),'exec')
calls=[]
class Dispatch:
 fail=False
 def check_output(self,argv,**kwargs):
  calls.append(argv);assert kwargs=={'text':True}
  if self.fail:raise subprocess.CalledProcessError(7,argv)
  return 'qualified'
dispatch=Dispatch()
scope={'Path':Path,'__file__':str(floor),'sys':SimpleNamespace(executable='/fixture/python'),'subprocess':dispatch,'pg':Path('/fixture/pg'),'args':SimpleNamespace(scratch=Path('/fixture/work'),output=Path('/fixture/evidence/floor.json')),'print':lambda *args:None}
exec(code,scope)
assert calls==[['/fixture/python',str(floor.parent/name),'--pg-bin','/fixture/pg','--scratch','/fixture/work','--output','/fixture/evidence/tournament-source-identity-cover.json']]
dispatch.fail=True
try:exec(code,scope)
except subprocess.CalledProcessError:pass
else:raise AssertionError('native failure was swallowed')
print('PASS exact required floor dispatch and failure propagation')
`,
      ],
      { encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS exact required floor dispatch and failure propagation');
  });
});
