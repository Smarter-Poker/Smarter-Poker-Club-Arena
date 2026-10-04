import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Data console PostgreSQL contracts stay in the required CI verdict', () => {
  const wrapper = read('scripts/ci/test-data-console-postgres-contracts.sh');
  const workflow = read('.github/workflows/ci.yml');
  const packageJson = JSON.parse(read('package.json')) as {
    scripts?: Record<string, string>;
  };
  const statsScripts = readdirSync(resolve(root, 'scripts/dev'))
    .filter((name) => /^test-stats-.*-postgres\.sh$/.test(name))
    .sort();

  it('runs every native Stats contract exactly once plus both financial admin contracts', () => {
    expect(statsScripts).toHaveLength(8);
    for (const script of statsScripts) {
      expect(wrapper.split(`scripts/dev/${script}`)).toHaveLength(2);
      expect(read(`scripts/dev/${script}`)).toContain('STATS_PG_SCRATCH_PARENT');
    }
    expect(wrapper.split('scripts/dev/test-financial-admin-revenue-postgres.sh')).toHaveLength(2);
    expect(read('scripts/dev/test-financial-admin-revenue-postgres.sh')).toContain(
      'DATA_CONSOLE_PG_SCRATCH_PARENT'
    );
    expect(wrapper.split('scripts/dev/test-union-ops-financial-admin-postgres.sh')).toHaveLength(2);
    expect(read('scripts/dev/test-union-ops-financial-admin-postgres.sh')).toContain(
      'UNION_OPS_PG_SCRATCH_PARENT'
    );
    expect(wrapper).toContain(
      'export UNION_OPS_PG_SCRATCH_PARENT="${UNION_OPS_PG_SCRATCH_PARENT:-$DATA_CONSOLE_PG_SCRATCH_PARENT}"'
    );
  });

  it('is one fail-closed accounting shard step using runner-owned scratch space', () => {
    expect(packageJson.scripts?.['test:data:postgres']).toBe(
      'bash scripts/ci/test-data-console-postgres-contracts.sh'
    );
    expect(workflow.split('name: Data console native PostgreSQL contracts')).toHaveLength(2);
    expect(workflow).toMatch(
      /name: Data console native PostgreSQL contracts[\s\S]*?if: matrix\.shard == 2[\s\S]*?PG17_BINDIR: \/usr\/lib\/postgresql\/17\/bin[\s\S]*?STATS_PG_SCRATCH_PARENT: \$\{\{ runner\.temp \}\}[\s\S]*?run: npm run test:data:postgres/
    );
  });

  it.each([
    'scripts/ci/test-data-console-postgres-contracts.sh',
    'scripts/dev/test-financial-admin-revenue-postgres.sh',
    'scripts/dev/test-union-ops-financial-admin-postgres.sh',
    'scripts/dev/test-stats-club-scope-postgres.sh',
    'tests/fixtures/financial-admin-revenue/assertions.sql',
    'tests/fixtures/union-ops-financial-admin/source-binding.json',
    'tests/fixtures/stats-operational-quality/bootstrap.sql',
    'tests/data-console-postgres-contracts-wired.test.ts',
  ])('routes executable contract input %s to the native server job', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
});
