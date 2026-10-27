import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
const root = resolve(__dirname, '../..');
const workflow = parse(
  readFileSync(join(root, '.github/workflows/auto-deploy-hetzner.yml'), 'utf8')
);
const job = workflow.jobs['observe-private-horse-fleet'];
const qualification = parse(
  readFileSync(join(root, '.github/workflows/horse-patterned-replacements.yml'), 'utf8')
);
describe('one explicit read-only fleet observation in the original provider', () => {
  it('has no release, receipt, scheduler or public-artifact path', () => {
    expect(workflow.on.repository_dispatch.types).toContain('observe-club-arena-horse-fleet');
    expect(job.if).toBe("github.event.action == 'observe-club-arena-horse-fleet'");
    expect(job.needs).toBeUndefined();
    expect(job['timeout-minutes']).toBe(10);
    expect(job.permissions).toEqual({ contents: 'read' });
    expect(job.concurrency).toEqual({
      group: 'club-arena-private-horse-fleet-observation',
      'cancel-in-progress': false,
    });
    const steps = JSON.stringify(job.steps);
    expect(steps).not.toMatch(
      /upload-artifact|engine-release-transaction|record-engine-deploy|systemctl|repository_dispatch/
    );
    expect(workflow.jobs.preflight.if).toBe("github.event.action == 'deploy-club-arena-engine'");
    expect(workflow.jobs['withdraw-waiting-release'].if).toBe(
      "github.event.action == 'withdraw-club-arena-engine'"
    );
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.concurrency.group).toContain(
      "github.event.action == 'observe-club-arena-horse-fleet'"
    );
    expect(workflow.concurrency.group).toContain(
      "format('-private-observation-{0}', github.run_id)"
    );
  });
  it('uses only protected control, pinned configured SSH identity and private ephemeral packet files', () => {
    expect(job.steps[0].with.ref).toBe('${{ github.sha }}');
    expect(job.steps[0].with['persist-credentials']).toBe(false);
    expect(job.steps[0].with['sparse-checkout']).toContain('/scripts/ci/horse-fleet-packet.py');
    const commands = job.steps.map((s: { run?: string }) => s.run ?? '').join('\n');
    expect(commands).not.toContain('git cat-file -e');
    expect(commands).toContain(
      'git ls-tree "$FLEET_SOURCE_SHA" -- server/src/services/horseDecisionJournal/fleet.ts'
    );
    expect(commands).toContain('git merge-base --is-ancestor "$FLEET_SOURCE_SHA" origin/main');
    expect(commands).toContain('StrictHostKeyChecking=yes');
    expect(commands).toContain('GlobalKnownHostsFile=/dev/null');
    expect(commands).toContain('chmod 0600');
    expect(commands).toContain('--ssh-command "$HSSH"');
    expect(commands).toContain('--summarize');
    expect(job.steps.at(-1).if).toBe('always()');
    expect(job.steps.at(-1).run).toContain('rm -rf -- "$PRIVATE_DIR"');
    expect(
      job.steps.filter((s: { env?: { DATABASE_URL?: string } }) => s.env?.DATABASE_URL)
    ).toHaveLength(1);
  });
  it('qualifies pure packet and caller contracts without requiring PostgreSQL in client CI', () => {
    execFileSync('python3', ['-B', 'scripts/ci/test-horse-fleet-packet.py', '--contracts'], {
      cwd: root,
      timeout: 30000,
      stdio: 'pipe',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
  }, 45000);
});

it('enforces actual native packet execution only after the existing signed PostgreSQL 17 setup', () => {
  const steps = qualification.jobs.qualification.steps;
  const install = steps.findIndex(
    (s: { name?: string }) => s.name === 'Install PostgreSQL 17 from the signed PGDG source only'
  );
  const native = steps.findIndex(
    (s: { run?: string }) => s.run === 'python3 -B scripts/ci/test-horse-fleet-packet.py'
  );
  expect(install).toBeGreaterThanOrEqual(0);
  expect(native).toBeGreaterThan(install);
  expect(steps[native].env.PG_BIN).toBe('/usr/lib/postgresql/17/bin');
  const producer = steps.findIndex(
    (s: { run?: string }) => s.run === 'python3 -B scripts/ci/test-lightning-journal-coordinate.py'
  );
  expect(producer).toBeGreaterThan(install);
  expect(steps[producer].env.PG_BIN).toBe('/usr/lib/postgresql/17/bin');
  expect(qualification.on.pull_request.paths).toContain(
    'scripts/ci/test-lightning-journal-coordinate.py'
  );
  expect(qualification.on.pull_request.paths).toContain(
    'scripts/ci/fixtures/lightning-journal-*.sql'
  );
  expect(qualification.on.pull_request.paths).toContain('scripts/ci/horse-fleet-packet.py');
  expect(qualification.concurrency['cancel-in-progress']).toBe(
    "${{ github.event_name == 'pull_request' }}"
  );
  expect(qualification.jobs['original-operation'].concurrency['cancel-in-progress']).toBe(false);
});

it('retains bounded bootstrap witness contracts in the existing observation route', () => {
  const step = job.steps.find(
    (s: { name?: string }) =>
      s.name === 'Read one bounded current-container public bootstrap witness'
  );
  expect(step.run).toContain('35s python3 -B scripts/ci/horse-public-bootstrap-witness.py');
  expect(step.run).toContain('--source-sha "$FLEET_SOURCE_SHA" --ssh-command "$HSSH"');
  expect(job.steps[0].with['sparse-checkout']).toContain(
    '/scripts/ci/horse-public-bootstrap-witness.py'
  );
  expect(
    job.steps.find(
      (s: { name?: string }) =>
        s.name === 'Reconcile canonical cohort and retained capture witnesses'
    ).run
  ).toContain('"$PRIVATE_DIR/packet.json"');
  execFileSync('python3', ['-B', 'scripts/ci/test-horse-public-bootstrap-witness.py'], {
    cwd: process.cwd(),
    stdio: 'pipe',
  });
});
