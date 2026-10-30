import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { describe, it, expect } from 'vitest';
import { conservativeClientInput } from '../../scripts/ci/client-runtime-inputs.mjs';
import { publisherJobKey } from '../../scripts/ci/publisher-job-identity.mjs';

const caller = parse(readFileSync('.github/workflows/publish-club-arena.yml', 'utf8'));
const transaction = parse(
  readFileSync('.github/workflows/publish-club-arena-transaction.yml', 'utf8')
);
const golden = JSON.parse(
  readFileSync('tests/operations/publication-transaction-source.json', 'utf8')
);
const moved = [
  'retain-runtime',
  'publish-to-app',
  'publish-to-origin',
  'publish-record-gateway',
  'bootstrap-record-gateway',
  'install-record-gateway-credentials',
  'inspect-record-gateway-host',
];
const replacements: Record<string, string> = {
  'inputs.target_sha': 'needs.publish-needed.outputs.target_sha',
  'inputs.component': 'needs.publish-needed.outputs.component',
  'inputs.publish': 'needs.publish-needed.outputs.publish',
  'inputs.tests_proven': 'needs.publish-needed.outputs.tests_proven',
  'inputs.client_result': 'needs.client-tests.result',
  'inputs.build_result': 'needs.build-and-store.result',
  'inputs.gateway_build_result': 'needs.build-record-gateway.result',
};
// Snapshot from protected7447: only flow-control contexts are rebound.
const normalizeSteps = (body: unknown) => {
  let source = JSON.stringify(body);
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(from, to);
  return source;
};
const gate = (overrides: Record<string, string> = {}) => {
  const values = {
    component: 'client',
    publish: 'true',
    tests_proven: 'false',
    client: 'success',
    build: 'success',
    gateway: 'skipped',
    admission: 'success',
    ...overrides,
  };
  const expr = caller.jobs.production.if
    .replaceAll('needs.publish-needed.outputs.component', JSON.stringify(values.component))
    .replaceAll('needs.publish-needed.outputs.publish', JSON.stringify(values.publish))
    .replaceAll('needs.publish-needed.outputs.tests_proven', JSON.stringify(values.tests_proven))
    .replaceAll('needs.publish-needed.result', JSON.stringify(values.admission))
    .replaceAll('needs.client-tests.result', JSON.stringify(values.client))
    .replaceAll('needs.build-and-store.result', JSON.stringify(values.build))
    .replaceAll('needs.build-record-gateway.result', JSON.stringify(values.gateway));
  return Function('always', `return (${expr})`)(() => true);
};

describe('one publication transaction follows parallel preparation', () => {
  it('has one event entry point and one continuous unchanged production lock', () => {
    expect(Object.keys(transaction.on)).toEqual(['workflow_call']);
    expect(transaction.concurrency).toBeUndefined();
    expect(caller.concurrency).toBeUndefined();
    expect(caller.jobs.production.concurrency).toEqual({
      group: 'publish-club-arena-production',
      'cancel-in-progress': false,
    });
    expect(caller.jobs.production.uses).toBe(
      './.github/workflows/publish-club-arena-transaction.yml'
    );
    expect(Object.keys(transaction.jobs).sort()).toEqual(moved.sort());
    for (const job of Object.values(transaction.jobs) as any[])
      expect(job.concurrency).toBeUndefined();
  });
  it('keeps qualification outside the lock and binds all exact preparation results', () => {
    expect(caller.jobs.production.needs).toEqual([
      'publish-needed',
      'client-tests',
      'build-and-store',
      'build-record-gateway',
    ]);
    expect(caller.jobs.production.with).toEqual({
      target_sha: '${{ needs.publish-needed.outputs.target_sha }}',
      component: '${{ needs.publish-needed.outputs.component }}',
      publish: '${{ needs.publish-needed.outputs.publish }}',
      tests_proven: '${{ needs.publish-needed.outputs.tests_proven }}',
      client_result: '${{ needs.client-tests.result }}',
      build_result: '${{ needs.build-and-store.result }}',
      gateway_build_result: '${{ needs.build-record-gateway.result }}',
    });
    for (const key of [
      'publish-needed',
      'client-tests',
      'build-and-store',
      'build-record-gateway',
    ]) {
      expect(caller.jobs[key]).toBeDefined();
      expect(caller.jobs[key].concurrency).toBeUndefined();
    }
    expect(transaction.jobs['publish-to-app'].needs).toBe('publish-to-origin');
  });
  for (const key of Object.keys(golden))
    it(`preserves every existing step, secret scope and command for ${key}`, () => {
      const job = caller.jobs[key] ?? transaction.jobs[key];
      expect(job).toBeDefined();
      const body = { ...job };
      delete body.if;
      delete body.needs;
      // Assert only the approved warm routes and hardware-bounded client worker cap, then
      // retain the complete original command/permission/secret snapshot.
      if (
        [
          'publish-needed',
          'client-tests',
          'build-and-store',
          'retain-runtime',
          'publish-to-app',
          'publish-to-origin',
        ].includes(key)
      ) {
        expect(body['runs-on']).toBe('ubuntu-latest');
        const label = key === 'publish-needed' ? 'ca-linux-4core' : 'ca-linux-8core';
        body['runs-on'] =
          "${{ github.repository_owner == 'Smarter-Software-PIQ' && github.repository_id == '1132369872' && '" +
          label +
          "' || 'ubuntu-latest' }}";
        if (key === 'client-tests') {
          expect(body.env.VITEST_MAX_THREADS).toBe(4);
          body.env = {
            ...body.env,
            VITEST_MAX_THREADS:
              "${{ github.repository_owner == 'Smarter-Software-PIQ' && github.repository_id == '1132369872' && '4' || '2' }}",
          };
        }
      }

      // The qualified gateway URL is the only intentionally changed build input.
      // Assert its exact value, then compare every other byte with the retained baseline.
      if (key === 'build-and-store' || key === 'publish-to-app') {
        const builds = body.steps.filter((step: any) =>
          Object.hasOwn(step.env ?? {}, 'VITE_PRIVATE_RECORD_FALLBACK_URL')
        );
        expect(builds).toHaveLength(1);
        expect(builds[0].env.VITE_PRIVATE_RECORD_FALLBACK_URL).toBe(
          'https://ca-static.smarter.poker/private-record'
        );
        body.steps = body.steps.map((step: any) =>
          step === builds[0]
            ? { ...step, env: { ...step.env, VITE_PRIVATE_RECORD_FALLBACK_URL: '' } }
            : step
        );
      }

      if (key === 'publish-to-origin') {
        // Independently exercised by mttPayoutPublication.test.ts; the original
        // transaction snapshot must remain identical after this narrow addition.
        const additions = [
          'Use the production Node major for payout admission',
          'Install locked payout publication driver',
          'Verify installed MTT payout policy before origin publication',
        ];
        expect(body.steps.filter((step: any) => additions.includes(step.name))).toHaveLength(3);
        body.steps = body.steps.filter((step: any) => !additions.includes(step.name));
      }

      expect(createHash('sha256').update(normalizeSteps(body)).digest('hex')).toBe(
        golden[key].bodySHA256
      );
    });
  for (const key of moved)
    it(`refuses foreign or branch-authored callers for ${key}`, () => {
      const condition = transaction.jobs[key].if;
      let original = String(golden[key].condition);
      for (const [to, from] of Object.entries(replacements))
        original = original.replaceAll(from, to);
      original = original.replaceAll("needs.publish-needed.result == 'success' &&", '');
      expect(condition.replace(/\s/g, '')).toContain(original.replace(/\s/g, ''));
      expect(condition).toContain("github.repository_id == '1132369872'");
      expect(condition).toContain("github.ref == 'refs/heads/main'");
      expect(condition).toContain(
        "github.workflow_ref == format('{0}/.github/workflows/publish-club-arena.yml@refs/heads/main', github.repository)"
      );
      expect(condition).toContain(
        "github.event_name == 'push' || github.event_name == 'repository_dispatch'"
      );
    });
  it('requires successful preparation, accepting only the existing proven-test skip', () => {
    expect(gate()).toBe(true);
    expect(gate({ client: 'skipped', tests_proven: 'true' })).toBe(true);
    for (const status of ['failure', 'cancelled', 'skipped', 'unknown', '']) {
      expect(gate({ client: status })).toBe(false);
      expect(gate({ build: status })).toBe(false);
      expect(gate({ admission: status })).toBe(false);
    }
    expect(
      gate({
        component: 'private-record-gateway',
        gateway: 'success',
        client: 'skipped',
        build: 'skipped',
      })
    ).toBe(true);
    expect(gate({ component: 'private-record-gateway', gateway: 'failure' })).toBe(false);
    expect(gate({ component: 'unknown' })).toBe(false);
  });
  it('treats transaction source as a conservative client release input', () => {
    expect(conservativeClientInput('.github/workflows/publish-club-arena-transaction.yml')).toBe(
      true
    );
  });
  it('normalizes only exact legacy or protected transaction job names', () => {
    for (const key of ['publish-to-origin', 'retain-runtime']) {
      expect(publisherJobKey(key)).toBe(key);
      expect(publisherJobKey(`production / ${key}`)).toBe(key);
      for (const bad of [`other / ${key}`, `production / other / ${key}`, `${key} extra`, '', null])
        expect(publisherJobKey(bad)).toBeNull();
    }
  });
});
