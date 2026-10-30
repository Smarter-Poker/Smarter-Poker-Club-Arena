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
