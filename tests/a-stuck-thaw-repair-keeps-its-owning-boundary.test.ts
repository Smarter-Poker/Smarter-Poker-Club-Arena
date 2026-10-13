import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
const workflow = readFileSync('.github/workflows/apply-merged-migration.yml', 'utf8');
const start = workflow.indexOf('          recovery_args=()');
const end = workflow.indexOf('          node scripts/ci/apply-recorded-migration.mjs', start);
const builder = workflow.slice(start, end);
function flags(repair: string, history = 'false') {
  const result = spawnSync('bash', ['-eu', '-c', builder + '\ndeclare -p recovery_args'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RECOVER_INDEX: '',
      RECOVER_OID: '',
      RECOVER_BEFORE: '',
      RECOVER_TRANSIENT_OID: '',
      FINAL_TABLE_PAGES: '',
      FINAL_TABLE_OPERATION: '',
      MAINTENANCE_THAW_REPAIR: repair,
      QUALIFY_RAKE_REPORT_HISTORY: history,
    },
  });
  expect(result.status).toBe(0);
  return result.stdout.match(/--[a-z-]+/g) ?? [];
}
describe('The published guarded thaw repair is reachable through its owning workflow', () => {
  it('keeps the emergency option explicitly disabled by default', () => {
    expect(workflow).toMatch(
      /maintenance_thaw_repair:[\s\S]*?required: false[\s\S]*?default: false[\s\S]*?type: boolean/
    );
    expect(workflow).toContain('MAINTENANCE_THAW_REPAIR: ${{ inputs.maintenance_thaw_repair }}');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(flags('false')).toEqual([]);
  });
  it('passes the exact maintained emergency flag only when explicitly enabled', () => {
    expect(flags('true')).toEqual(['--maintenance-thaw-repair']);
    expect(flags('true; arbitrary command')).toEqual([]);
  });
  it('preserves the independent report-history option', () => {
    expect(flags('false', 'true')).toEqual(['--qualify-rake-report-history']);
    expect(flags('true', 'true')).toEqual([
      '--qualify-rake-report-history',
      '--maintenance-thaw-repair',
    ]);
  });
});
