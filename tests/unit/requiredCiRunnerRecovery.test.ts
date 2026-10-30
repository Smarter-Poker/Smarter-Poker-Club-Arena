import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const native = parse(readFileSync('.github/workflows/component-fixture-native-smoke.yml', 'utf8'));
const trusted =
  "github.repository_owner == 'Smarter-Software-PIQ' && github.repository_id == '1132369872'";
const recovery = " && vars.CA_REQUIRED_CI_STANDARD_RUNNERS != 'true'";
const expression = (standard: string, recover = true) =>
  '$' +
  '{{ ' +
  trusted +
  (recover ? recovery : '') +
  " && 'ca-linux-8core' || '" +
  standard +
  "' }}";
const jobs = [
  ['accounting_postgres', ci.jobs.accounting_postgres, 'ubuntu-latest'],
  ['server_shards', ci.jobs.server_shards, 'ubuntu-latest'],
  ['native-smoke', native.jobs['native-smoke'], 'ubuntu-24.04'],
] as const;

describe('required CI uses a closed standard hosted capacity recovery', () => {
  for (const [name, job, standard] of jobs) {
    it(name + ' accepts only its declared standard OS or the unchanged paid default', () => {
      expect(job['runs-on']).toBe(expression(standard));
      for (const [owner, id, value, expected] of [
        ['Smarter-Software-PIQ', '1132369872', '', 'ca-linux-8core'],
        ['Smarter-Software-PIQ', '1132369872', 'false', 'ca-linux-8core'],
        ['Smarter-Software-PIQ', '1132369872', 'true', standard],
        ['Smarter-Software-PIQ', '1132369872', 'self-hosted', 'ca-linux-8core'],
        ['Smarter-Software-PIQ', '1132369872', 'custom-runner', 'ca-linux-8core'],
        ['other-org', '1132369872', '', standard],
        ['Smarter-Software-PIQ', '42', 'true', standard],
        ['other-org', '42', 'self-hosted', standard],
      ]) {
        const body = job['runs-on'].slice(3, -2).trim();
        expect(
          runInNewContext(body, {
            github: { repository_owner: owner, repository_id: id },
            vars: { CA_REQUIRED_CI_STANDARD_RUNNERS: value },
          })
        ).toBe(expected);
      }
    });
  }

  it('preserves all other CI commands, gates, budgets, permissions and client partitions', () => {
    const normalized = structuredClone(ci);
    for (const key of ['accounting_postgres', 'server_shards'])
      normalized.jobs[key]['runs-on'] = expression('ubuntu-latest', false);
    expect(createHash('sha256').update(JSON.stringify(normalized)).digest('hex')).toBe(
      'e9fed96150250d02894abfdd79efe214a67b982a7f9b77727f2deced7d0d4885'
    );
  });
  it('preserves every native qualification stage and cleanup requirement', () => {
    const normalized = structuredClone(native);
    normalized.jobs['native-smoke']['runs-on'] = expression('ubuntu-24.04', false);
    expect(createHash('sha256').update(JSON.stringify(normalized)).digest('hex')).toBe(
      'b86cd1553ebc48af73ddcf18a87243fb7dfd868cd0bfd5f209a980cc13ec0d36'
    );
  });
});
