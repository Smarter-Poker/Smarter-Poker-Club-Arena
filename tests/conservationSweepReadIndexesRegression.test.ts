import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const MIGRATION = 'supabase/migrations/20261001152917_conservation_sweep_reads_use_covering_partial_indexes.sql';
const ONLINE = 'scripts/ops/build-conservation-sweep-read-indexes-concurrently.sql';
const INDEXES = [
  'idx_chip_ledger_player_wallet_drift',
  'idx_chip_ledger_bbj_pool_epoch',
  'idx_tournament_payouts_paid_at',
  'idx_wallet_credit_idempotency_created_at',
];

describe('conservation sweep read indexes qualification', () => {
  const WORKFLOW = '.github/workflows/conservation-sweep-read-proofs.yml';
  const workflow = () => parse(read(WORKFLOW));

  it.each([
    'supabase/migrations/20261001152917_conservation_sweep_reads_use_covering_partial_indexes.sql',
    'supabase/migrations/20261001152926_a_failing_hourly_cron_reaches_the_board.sql',
    ONLINE,
    'scripts/ci/test-conservation-sweep-read-indexes-postgres.py',
    'scripts/ci/test-cron-failure-watch-postgres.py',
    'scripts/ci/fixtures/conservation-sweep-read-indexes/**',
    WORKFLOW,
  ])('a pull request touching %s runs the native proofs', (path) => {
    const on = workflow().on;
    expect(Object.keys(on)).toEqual(['pull_request']);
    expect(on.pull_request.branches).toEqual(['main']);
    expect(on.pull_request.paths).toContain(path);
  });

  it('runs both native proofs, unconditionally, in the dedicated workflow', () => {
    const jobs = Object.values(workflow().jobs) as Array<{
      'continue-on-error'?: unknown;
      steps: Array<{ run?: string; if?: unknown; 'continue-on-error'?: unknown }>;
    }>;
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job['continue-on-error']).toBeUndefined();
    for (const script of [
      'python3 scripts/ci/test-conservation-sweep-read-indexes-postgres.py',
      'python3 scripts/ci/test-cron-failure-watch-postgres.py',
    ]) {
      const steps = job.steps.filter((step) => step.run?.trim() === script);
      expect(steps).toHaveLength(1);
      expect(steps[0].if).toBeUndefined();
      expect(steps[0]['continue-on-error']).toBeUndefined();
    }
    expect(job.steps.some((step) => step.run?.includes('install -y --no-install-recommends postgresql-17'))).toBe(true);
  });

  it('the online operation builds exactly the indexes the recording migration verifies, and only online', () => {
    const online = read(ONLINE);
    const migration = read(MIGRATION);
    const built = [...online.matchAll(/^CREATE INDEX CONCURRENTLY (\w+)/gm)].map((m) => m[1]);
    expect(built).toEqual(INDEXES);
    expect(online).not.toMatch(/^\s*(BEGIN|DROP|REINDEX)\b/im);
    for (const name of INDEXES) expect(migration).toContain(`'CREATE INDEX ${name} ON public.`);
    // recording only: the migration never builds or drops an index
    expect(migration).not.toMatch(/^\s*(CREATE|DROP)\s+INDEX/im);
    // and pins the exact bodies whose plans were qualified
    for (const md5 of ['d0f1d4f355477669a4bc0427de757581', 'cd515fb20589a20ba6b930a6831610b8', 'f5cf519b32f61707d283d634c39190f2']) {
      expect(migration).toContain(md5);
    }
  });
});
