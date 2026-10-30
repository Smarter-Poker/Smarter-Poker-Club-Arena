import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const native = parse(readFileSync('.github/workflows/component-fixture-native-smoke.yml', 'utf8'));
const trusted =
  "github.repository_owner == 'Smarter-Software-PIQ' && github.repository_id == '1132369872'";
const recovery = " && vars.CA_REQUIRED_NATIVE_PROFILE == 'large'";
const expression = (standard: string) =>
  '$' + '{{ ' + trusted + recovery + " && 'ca-linux-8core' || '" + standard + "' }}";
const jobs = [
  ['accounting_postgres', ci.jobs.accounting_postgres, 'ubuntu-latest'],
  ['server_shards', ci.jobs.server_shards, 'ubuntu-latest'],
  ['native-smoke', native.jobs['native-smoke'], 'ubuntu-24.04'],
] as const;

describe('required CI uses a closed standard hosted capacity recovery', () => {
  for (const [name, job, standard] of jobs) {
    it(name + ' accepts only its declared standard OS or the fixed large profile', () => {
      expect(job['runs-on']).toBe(expression(standard));
      for (const [owner, id, value, expected] of [
        ['Smarter-Software-PIQ', '1132369872', '', standard],
        ['Smarter-Software-PIQ', '1132369872', 'false', standard],
        ['Smarter-Software-PIQ', '1132369872', 'standard', standard],
        ['Smarter-Software-PIQ', '1132369872', 'large', 'ca-linux-8core'],
        ['Smarter-Software-PIQ', '1132369872', 'self-hosted', standard],
        ['Smarter-Software-PIQ', '1132369872', 'custom-runner', standard],
        ['other-org', '1132369872', 'large', standard],
        ['Smarter-Software-PIQ', '42', 'large', standard],
        ['other-org', '42', 'self-hosted', standard],
      ]) {
        const body = job['runs-on'].slice(3, -2).trim();
        expect(
          runInNewContext(body, {
            github: { repository_owner: owner, repository_id: id },
            vars: { CA_REQUIRED_NATIVE_PROFILE: value },
          })
        ).toBe(expected);
      }
    });
  }

  it('preserves all other CI commands, gates, budgets, permissions and client partitions', () => {
    const normalized = structuredClone(ci);
    // #8759 added the exact roster native pair after the #8715 baseline.
    // Verify each qualified addition before excluding only it from the original fingerprint.
    const additions = [
      {
        name: 'Roster tournament fees read only their charged window',
        if: 'matrix.shard == 4',
        env: {
          PG_BIN: '/usr/lib/postgresql/17/bin',
        },
        run: 'python3 -B scripts/ci/test-roster-tournament-fee-window.py --pg-bin "$PG_BIN" --scratch "$RUNNER_TEMP" --output artifacts/roster-fee-window/native.json',
      },
      {
        name: 'Retain roster fee window index qualification',
        if: 'always() && matrix.shard == 4',
        uses: 'actions/upload-artifact@v4',
        with: {
          name: 'roster-fee-window-${{ github.run_id }}-${{ github.run_attempt }}',
          path: 'artifacts/roster-fee-window/',
          'retention-days': 7,
          'if-no-files-found': 'error',
        },
      },
      {
        name: 'Explicit started tournament abort preserves awards and refunds original charges',
        if: 'matrix.shard == 4',
        run: 'python3 -B scripts/ci/test-tournament-abort.py \\\n  --evidence artifacts/tournament-abort \\\n  --work-root "$RUNNER_TEMP/tournament-abort-work" \\\n  --socket-root "$RUNNER_TEMP/abort-socket" \\\n  --pg-bin /usr/lib/postgresql/17/bin\n',
      },
      {
        name: 'Retain started tournament abort financial evidence',
        if: 'always() && matrix.shard == 4',
        uses: 'actions/upload-artifact@v4',
        with: {
          name: 'tournament-abort-${{ github.run_id }}-${{ github.run_attempt }}',
          path: 'artifacts/tournament-abort/',
          'retention-days': 7,
          'if-no-files-found': 'error',
        },
      },
    ];
    const steps = normalized.jobs.accounting_postgres.steps;
    for (const step of additions) {
      const matching = steps.filter((candidate: { name?: string }) => candidate.name === step.name);
      expect(matching).toEqual([step]);
      expect(
        Object.values(normalized.jobs)
          .flatMap((job: any) => job.steps ?? [])
          .filter((candidate: { name?: string }) => candidate.name === step.name)
      ).toEqual([step]);
    }
    const rosterIndex = steps.findIndex(
      (step: { name?: string }) => step.name === additions[0].name
    );
    const abortIndex = steps.findIndex(
      (step: { name?: string }) => step.name === additions[2].name
    );
    expect(steps[rosterIndex + 1]).toEqual(additions[1]);
    expect(steps[rosterIndex + 2].name).toBe(
      'Check composed alert fixture admission and cleanup guards'
    );
    expect(steps[abortIndex - 1].name).toBe(
      'Retain cancellation admission and funded rollback evidence'
    );
    expect(steps[abortIndex + 1]).toEqual(additions[3]);
    expect(steps[abortIndex + 2].name).toBe(
      'Certification cleanup reserves a turn without blocking players'
    );
    expect(normalized.jobs.accounting_postgres.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
    for (const step of additions) {
      steps.splice(
        steps.findIndex((candidate: { name?: string }) => candidate.name === step.name),
        1
      );
    }
    expect(createHash('sha256').update(JSON.stringify(normalized)).digest('hex')).toBe(
      '756ebaa3b74445e08a3e0fb4e9408607539376c85540311e0fa9e90fda64cbd5'
    );
  });
  it('preserves every native qualification stage and cleanup requirement', () => {
    const normalized = structuredClone(native);
    expect(createHash('sha256').update(JSON.stringify(normalized)).digest('hex')).toBe(
      '9d89b70e835f0476c8b3d4abf5d5c11c07e7b77a83b5bd95aacfae472153c457'
    );
  });
});
