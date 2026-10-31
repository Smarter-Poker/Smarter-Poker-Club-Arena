import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

const frameCoverSteps = [
  {
    name: 'Weekly cash boundaries keep original rows and use the frame cover',
    if: 'matrix.shard == 2',
    env: { PG_BIN: '/usr/lib/postgresql/17/bin' },
    run: 'python3 -B scripts/ci/test-weekly-pending-funding-index-postgres.py --pg-bin "$PG_BIN" --scratch "${{ runner.temp }}" --candidate supabase/migrations/20261031081522_cover_original_cash_boundary_transaction_frames.sql --output "${{ runner.temp }}/weekly-pending-funding-index.json"',
  },
  {
    name: 'Retain weekly pending funding index qualification',
    if: 'always() && matrix.shard == 2',
    uses: 'actions/upload-artifact@v4',
    with: {
      name: 'weekly-pending-funding-index-${{ github.run_id }}-${{ github.run_attempt }}',
      path: '${{ runner.temp }}/weekly-pending-funding-index.json',
      'if-no-files-found': 'error',
    },
  },
];

const normalizeFrameCoverAddition = (job: { steps: Array<Record<string, unknown>> }) => {
  const start = job.steps.findIndex((step) => step.name === frameCoverSteps[0].name);
  for (const step of frameCoverSteps) {
    expect(job.steps.filter((actual) => actual.name === step.name)).toHaveLength(1);
  }
  expect(job.steps[start - 1]?.name).toBe(
    'Weekly linked proofs preserve original windows and paid books'
  );
  expect(job.steps.slice(start, start + 2)).toStrictEqual(frameCoverSteps);
  expect(job.steps[start + 2]?.name).toBe(
    'Cash horses use bankroll eligibility and table closure preserves seats'
  );
  // Strip only the exact, separately enforced addition; retain every prior pin.
  job.steps.splice(start, 2);
};

const postpaidQualityStep = {
  name: 'Paid weekly books qualify statements before replaying cash checks',
  if: 'matrix.shard == 1',
  run: 'set -o pipefail\nmkdir -p artifacts/weekly-payout-owned-pause\npython3 -B scripts/ci/test-weekly-postpaid-quality-postgres.py --repo . --candidate-source scripts/ci/fixtures/weekly-postpaid-quality/after-scope.json --before-source scripts/ci/fixtures/weekly-postpaid-quality/before-scope.json --prepare-source scripts/ci/fixtures/weekly-postpaid-quality/prepare.sql --catalog scripts/ci/fixtures/weekly-postpaid-quality/actual-owners.json --pg-bin /usr/lib/postgresql/17/bin --scratch "$RUNNER_TEMP" --output artifacts/weekly-payout-owned-pause/postpaid-quality.json\npython3 -B scripts/ci/test-weekly-postpaid-discovery-postgres.py --repo . --before-scope scripts/ci/fixtures/weekly-postpaid-quality/before-scope.json --after-scope scripts/ci/fixtures/weekly-postpaid-quality/after-scope.json --before-eligible scripts/ci/fixtures/weekly-postpaid-quality/before-discovery.sql --after-eligible scripts/ci/fixtures/weekly-postpaid-quality/after-discovery.sql --pg-bin /usr/lib/postgresql/17/bin --scratch "$RUNNER_TEMP" --output artifacts/weekly-payout-owned-pause/postpaid-discovery.json\npython3 -B scripts/ci/test-weekly-postpaid-migration-postgres.py --candidate supabase/migrations/20261031162838_qualify_paid_weekly_statement_evidence_before_replaying_cash.sql --owners scripts/ci/fixtures/weekly-postpaid-quality/actual-owners.json --discovery scripts/ci/fixtures/weekly-postpaid-quality/actual-discovery-owners.json --pg-bin /usr/lib/postgresql/17/bin --scratch "$RUNNER_TEMP" --output artifacts/weekly-payout-owned-pause/postpaid-migration.json\n',
};

const normalizePostpaidQualityAddition = (job: { steps: Array<Record<string, unknown>> }) => {
  const start = job.steps.findIndex((step) => step.name === postpaidQualityStep.name);
  expect(job.steps.filter((step) => step.name === postpaidQualityStep.name)).toHaveLength(1);
  expect(job.steps[start - 1]?.name).toBe(
    'Original weekly financial rounds wait for the concurrent physical fleet ACK'
  );
  // Exact shape rejects added env/continue-on-error as well as changed commands.
  expect(job.steps[start]).toStrictEqual(postpaidQualityStep);
  expect(job.steps[start + 1]?.name).toBe('Preserve original weekly payout qualification evidence');
  job.steps.splice(start, 1);
};

describe('required CI uses a closed standard hosted capacity recovery', () => {
  for (const [name, job, standard] of jobs) {
    it(name + ' permits only its fixed standard hosted OS', () => {
      expect(job['runs-on']).toBe(standard);
      expect(job['runs-on']).not.toMatch(/ca-linux|self-hosted|vars\./);
    });
  }

  it('preserves all other CI commands, gates, budgets, permissions and client partitions', () => {
    const normalized = structuredClone(ci);
    normalizeFrameCoverAddition(normalized.jobs.accounting_postgres);
    normalizePostpaidQualityAddition(normalized.jobs.accounting_postgres);
    const formerClientRoute = '$' + '{{ ' + trusted + " && 'ca-linux-4core' || 'ubuntu-latest' }}";
    const intendedRoutes = {
      typecheck: 'ubuntu-latest',
      unit: 'ubuntu-latest',
      server: 'ubuntu-latest',
      verdict: 'ubuntu-latest',
      'css-beats-gate': 'ubuntu-latest',
      'css-beats-e2e': 'ubuntu-latest',
      'diamond-playfield-e2e': 'ubuntu-latest',
    };
    // Assert each authorized route before normalizing just that field. The
    // exhaustive sectional fingerprints protect every command and financial gate.
    for (const [name, route] of Object.entries(intendedRoutes)) {
      expect(normalized.jobs[name]['runs-on'], name).toBe(route);
      normalized.jobs[name]['runs-on'] = formerClientRoute;
    }
    for (const name of ['typecheck_compile', 'unit_shards', 'build']) {
      expect(normalized.jobs[name]['runs-on']).toBe('ubuntu-latest');
      normalized.jobs[name]['runs-on'] = formerClientRoute;
    }
    for (const name of ['changes', 'source_windows', 'stub_gate']) {
      expect(normalized.jobs[name]['runs-on']).toBe('ubuntu-latest');
      normalized.jobs[name]['runs-on'] = formerClientRoute;
    }
    for (const name of ['live-e2e', 'post-deploy-check']) {
      expect(normalized.jobs[name]['runs-on']).toBe('ubuntu-latest');
      normalized.jobs[name]['runs-on'] = formerClientRoute.replace('4core', '8core');
    }
    for (const name of ['accounting_postgres', 'server_shards']) {
      expect(normalized.jobs[name]['runs-on']).toBe('ubuntu-latest');
      normalized.jobs[name]['runs-on'] = expression('ubuntu-latest');
    }
    expect(normalized.jobs.unit_shards.env.VITEST_MAX_THREADS).toBe(8);
    normalized.jobs.unit_shards.env.VITEST_MAX_THREADS = 4;
    // Ordered inventories plus all non-job fields and every whole job cover the
    // complete reviewed workflow. Unrelated job edits update only their own pin.
    const fingerprint = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');
    expect(Object.keys(normalized)).toEqual(['name', 'on', 'concurrency', 'jobs']);
    expect(
      fingerprint(Object.fromEntries(Object.entries(normalized).filter(([key]) => key !== 'jobs')))
    ).toBe('bf371889e58c11a6f6178fd7405b0cb3a484ed6016b88629bc790f4b4ed83d0e');
    const expectedJobs = {
      changes: 'f9d317d1503f4dc8a8945bb2b9238bcfa89b2ea551a970dd23ddb3d531f4a481',
      source_windows: 'a9830648dfc81b5558d0e9a45d75307210fa1535926da65e087f6647e1fa4189',
      stub_gate: '166528cc83e7d0c075c59b6facb1a6782f3e2eda6c334f9608b933319aca9c80',
      fixture_native: '0df5b9e9f46fe331ce65fbdeaed5584c18e4756fddc7b4e3f417fc4694d2e2ff',
      typecheck: '07758ff6fff680beb77a9e38725eecc5776b94db14cdc3499783c049ce771750',
      typecheck_compile: '88a03bf85dc749608900101f598720ad93c957e5b5bf75791c589c9e25228168',
      unit_shards: 'a694772adb1e9b9c9cf9e8ff24d9a655deb26d18b5d1f191b120ac3b4516c474',
      unit: '69c8c0e64dddf305dd3336a22d977be302c177d26adb4f19a9928efd40fe42a0',
      // Retain both original top-up receipt and funded satellite qualifications.
      // Every other normalized job and prior accounting command is unchanged.
      accounting_postgres: '8fe0309bc5f9c00d2987d02020e9ef6aa0a13eb2dcbcd16ae69e21274d5735a3',
      server_shards: '9b89b7ee75080d4d8b5aafd55d35adf888bd49c30720aa96ad2225bad240ee41',
      server: '086cab96ac6e24b0ced5ab9407a2c406eddfa451de33d6b614953b1f9f94bd1d',
      verdict: 'cbcc5b069cdc625a6fb5a5c23b6a5c6a4ed2c3669f37bf74163c3eea6c5fbd0f',
      build: '1b0ed1fea04c1e6ef74fcde68387787cf36b0fe589539caf71cdfe7e314fa76b',
      'live-e2e': 'fae9db0fd7b5ad3a502a34981574aa5ac43c01d763d2a0c518a7d98572ae796d',
      'post-deploy-check': '86936192ff526aab46d57a6e263e27475c3e60da754b0f04f4948ec40b8b4fcd',
      'css-beats-e2e': '4fc89c871e60dd6d303d87c79e32a25022dc944a772de6b69c919f623f208bbf',
      'diamond-playfield-e2e': '2802fb1377e89b20cfd5dfd89155194bd41921da2b014220040728d27e4d690d',
      'css-beats-gate': '71e08443dc0eee58fbb9055054e02643edbe532aeae3c3073fcf04ae8e35a944',
    };
    expect(Object.keys(normalized.jobs)).toEqual(Object.keys(expectedJobs));
    expect(
      Object.fromEntries(
        Object.entries(normalized.jobs).map(([name, job]) => [name, fingerprint(job)])
      )
    ).toEqual(expectedJobs);
  });
  it('rejects missing, duplicate, displaced or weakened frame cover qualification steps', () => {
    const mutations = [
      (steps: Array<Record<string, unknown>>, start: number) => steps.splice(start, 1),
      (steps: Array<Record<string, unknown>>, start: number) =>
        steps.push(structuredClone(steps[start])),
      (steps: Array<Record<string, unknown>>, start: number) => {
        [steps[start - 1], steps[start]] = [steps[start], steps[start - 1]];
      },
      (steps: Array<Record<string, unknown>>, start: number) => {
        steps[start].if = 'matrix.shard == 1';
      },
      (steps: Array<Record<string, unknown>>, start: number) => {
        steps[start].run = String(steps[start].run) + ' || true';
      },
      (steps: Array<Record<string, unknown>>, start: number) => {
        (steps[start + 1].with as Record<string, unknown>)['if-no-files-found'] = 'ignore';
      },
    ];
    for (const mutate of mutations) {
      const job = structuredClone(ci.jobs.accounting_postgres);
      const start = job.steps.findIndex(
        (step: Record<string, unknown>) => step.name === frameCoverSteps[0].name
      );
      mutate(job.steps, start);
      expect(() => normalizeFrameCoverAddition(job)).toThrow();
    }
  });
  it('rejects missing, duplicate, displaced or weakened paid-book qualification', () => {
    const mutations = [
      (steps: Array<Record<string, unknown>>, start: number) => steps.splice(start, 1),
      (steps: Array<Record<string, unknown>>, start: number) =>
        steps.push(structuredClone(steps[start])),
      (steps: Array<Record<string, unknown>>, start: number) => {
        [steps[start - 1], steps[start]] = [steps[start], steps[start - 1]];
      },
      (steps: Array<Record<string, unknown>>, start: number) => {
        steps[start].if = 'false';
      },
      (steps: Array<Record<string, unknown>>, start: number) => {
        steps[start].env = { SKIP: 'true' };
      },
      (steps: Array<Record<string, unknown>>, start: number) => {
        steps[start]['continue-on-error'] = true;
      },
      (steps: Array<Record<string, unknown>>, start: number) => {
        steps[start].run = String(steps[start].run).replace(
          'postpaid-discovery-postgres.py',
          'wrong.py'
        );
      },
      (steps: Array<Record<string, unknown>>, start: number) => {
        steps[start].run = String(steps[start].run) + 'true\n';
      },
    ];
    for (const mutate of mutations) {
      const job = structuredClone(ci.jobs.accounting_postgres);
      const start = job.steps.findIndex(
        (step: Record<string, unknown>) => step.name === postpaidQualityStep.name
      );
      mutate(job.steps, start);
      expect(() => normalizePostpaidQualityAddition(job)).toThrow();
    }
  });
  it('preserves every native qualification stage and cleanup requirement', () => {
    const normalized = structuredClone(native);
    expect(normalized.jobs['native-smoke']['runs-on']).toBe('ubuntu-24.04');
    normalized.jobs['native-smoke']['runs-on'] = expression('ubuntu-24.04');
    expect(createHash('sha256').update(JSON.stringify(normalized)).digest('hex')).toBe(
      '9d89b70e835f0476c8b3d4abf5d5c11c07e7b77a83b5bd95aacfae472153c457'
    );
  });
});
