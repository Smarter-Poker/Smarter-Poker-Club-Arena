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

  it('qualifies historical statement payment availability in the same union reporting job', () => {
    expect(read('scripts/dev/test-union-ops-financial-admin-postgres.sh')).toContain(
      'bash "$repo/scripts/dev/test-statement-availability-postgres.sh"'
    );
    const native = read('scripts/dev/test-statement-availability-postgres.sh');
    for (const input of [
      '20260907212347_union_statement_reports_identify_missing_accounting_snapshots.sql',
      '20261018170308_union_statements_distinguish_missing_legacy_payment_details.sql',
      'union-statement-availability/before.sql',
      'union-statement-availability/after.sql',
    ])
      expect(native).toContain(input);
    expect(native).toContain('Statement availability already installed');
    expect(native).toContain(
      '20261018171801_bomb_pot_reports_bound_their_hosted_club_scan_and_utc_calend.sql'
    );
    expect(native).toContain('bomb-before.sql');
    expect(native).toContain('bomb-after.sql');
  });

  it('executes the roster join-order regression in the required PostgreSQL job', () => {
    expect(wrapper).toContain('bash "$repo/scripts/dev/test-roster-join-sort-postgres.sh"');
    const native = read('scripts/dev/test-roster-join-sort-postgres.sh');
    expect(native).toContain('tests/fixtures/stats-club-scope/roster-join-sort');
    expect(native).toContain('20261021174637_roster_club_join_date_sorting.sql');
    expect(native).toContain(
      '20261029064232_player_name_search_ranks_direct_matches_before_upline.sql'
    );
    expect(native).toContain('search-assertions.sql');
    expect(native).toContain('Player name search regression');
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
    'scripts/dev/test-player-throwable-favorites-postgres.sh',
    'tests/fixtures/player-throwable-favorites/assertions.sql',
    'tests/fixtures/player-throwable-favorites/bootstrap.sql',
    'scripts/ci/test-club-data-union-mtt-postgres.py',
    'tests/fixtures/club-data-report-db/union-mtt-scenario.sql',
    'tests/fixtures/club-data-report-db/rake-v2-fixture.sql',
    'tests/fixtures/club-data-report-db/reporting-preimages.sql',
    'tests/fixtures/club-data-fact-db/fixture.sql',
    'scripts/dev/test-member-record-live-postgres.sh',
    'scripts/dev/test-roster-join-sort-postgres.sh',
    'tests/fixtures/stats-club-scope/roster-join-sort/assertions.sql',
    'tests/fixtures/stats-club-scope/member-record-live/readers.sql',
    'tests/fixtures/stats-club-scope/funded-before.sql',
    'tests/fixtures/stats-club-scope/funded-after.sql',
    'scripts/dev/test-financial-admin-revenue-postgres.sh',
    'scripts/dev/test-union-ops-financial-admin-postgres.sh',
    'scripts/dev/test-stats-club-scope-postgres.sh',
    'tests/fixtures/financial-admin-revenue/assertions.sql',
    'tests/fixtures/union-ops-financial-admin/source-binding.json',
    'tests/fixtures/union-statement-availability/after.sql',
    'scripts/dev/test-statement-availability-postgres.sh',
    'tests/fixtures/stats-operational-quality/bootstrap.sql',
    'tests/data-console-postgres-contracts-wired.test.ts',
  ])('routes executable contract input %s to the native server job', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
});
