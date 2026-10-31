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
    const formerClientRoute = '$' + '{{ ' + trusted + " && 'ca-linux-4core' || 'ubuntu-latest' }}";
    const browserRoute = '$' + '{{ ' + trusted + " && 'ca-linux-delivery' || 'ubuntu-latest' }}";
    const intendedRoutes = {
      typecheck: 'ubuntu-latest',
      unit: 'ubuntu-latest',
      server: 'ubuntu-latest',
      verdict: 'ubuntu-latest',
      'css-beats-gate': 'ubuntu-latest',
      'css-beats-e2e': browserRoute,
      'diamond-playfield-e2e': browserRoute,
    };
    // Assert each authorized route before normalizing just that field. The
    // exhaustive sectional fingerprints protect every command and financial gate.
    for (const [name, route] of Object.entries(intendedRoutes)) {
      expect(normalized.jobs[name]['runs-on'], name).toBe(route);
      normalized.jobs[name]['runs-on'] = formerClientRoute;
    }
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
      accounting_postgres: '92254f3f8e2638c8d3729c82eedad4a91135a507ca1f27d9a61c03d8c7c92cdb',
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
  it('preserves every native qualification stage and cleanup requirement', () => {
    const normalized = structuredClone(native);
    expect(createHash('sha256').update(JSON.stringify(normalized)).digest('hex')).toBe(
      '9d89b70e835f0476c8b3d4abf5d5c11c07e7b77a83b5bd95aacfae472153c457'
    );
  });
});
