import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('on-time starts remain connected to their actual owners', () => {
  it.each([
    'scripts/ci/test-on-time-maintenance-thaw.py',
    'scripts/ci/test-multi-day-stage-foundation.py',
    'scripts/ci/fixtures/on-time-start/authority.sql',
    'scripts/ci/fixtures/on-time-start/authority.json',
    'scripts/ci/fixtures/on-time-start/bypass.sql',
  ])('qualifies native input changes: %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
  it('runs the real PostgreSQL qualification in the required accounting matrix', () => {
    const workflow = read('.github/workflows/ci.yml');
    expect(workflow).toMatch(
      /if: matrix.shard == 1\n\s+env:\n\s+PG_BIN: \/usr\/lib\/postgresql\/17\/bin\n\s+run: python3 -B scripts\/ci\/test-on-time-maintenance-thaw.py/
    );
  });
  it('wakes booked first levels through the real release event before the tables', () => {
    const owner = read('server/src/maintenance/MaintenanceBreak.ts');
    const start = owner.indexOf('setMaintenanceFrozen(false);', owner.indexOf('async end()'));
    expect(start).toBeGreaterThan(0);
    expect(owner.indexOf('this.deps.onReleased?.(reconnectFreezeStartedAt)', start)).toBeLessThan(
      owner.indexOf('const resumed = this.resumeEveryEngine(', start)
    );
    expect(read('server/src/GameServer.ts')).toContain(
      'manager.startBookedLevelAfterMaintenance(freezeStartedAt)'
    );
  });
});
