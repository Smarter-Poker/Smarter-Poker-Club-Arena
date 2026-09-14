import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const readWorkflow = (name: string) =>
  parse(readFileSync(resolve(__dirname, '../../.github/workflows', name), 'utf8'));
const publish = readWorkflow('publish-club-arena.yml');
const ci = readWorkflow('ci.yml');
const target = 'a'.repeat(40);

function publishEligible(name: string, testResult: string) {
  const values: Record<string, string> = {
    'vars.CAPGO_OTA_ENABLED': 'true',
    'needs.publish-needed.outputs.target_sha': target,
    // A forged or historical PR verdict must not excuse missing release tests.
    'needs.publish-needed.outputs.tests_proven': 'true',
    'needs.build-and-store.result': 'success',
    'needs.publish-to-origin.result': 'success',
    'needs.publish-to-origin.outputs.verified_sha': target,
    'needs.client-tests.result': testResult,
  };
  const expression = publish.jobs[name].if
    .replace(/always\(\)/g, 'true')
    .replace(/(?:vars|needs)\.[\w.-]+/g, (context: string) => {
      expect(context in values, context).toBe(true);
      return JSON.stringify(values[context]);
    });
  expect(expression.replace(/"[^"\n]*"|'[^'\n]*'|true|false|\s|==|!=|&&|\|\||[()]/g, '')).toBe('');
  return Function('"use strict"; return (' + expression + ');')() as boolean;
}

describe('release decisions and test evidence have their own runner custody', () => {
  it.each(['publish-needed', 'client-tests'])('%s uses a fresh isolated hosted runner', (name) => {
    expect(publish.jobs[name]['runs-on']).toBe('ubuntu-latest');
  });

  it('always tests the exact selected release target in every shard', () => {
    const tests = publish.jobs['client-tests'];
    expect(tests.if).toBeUndefined();
    expect(tests.strategy.matrix).toEqual({ shard: [1, 2, 3, 4] });
    expect(
      tests.steps.find((s: { uses?: string }) => s.uses?.startsWith('actions/checkout@')).with.ref
    ).toBe('${{ needs.publish-needed.outputs.target_sha }}');
    expect(publish.jobs['publish-needed'].outputs).not.toHaveProperty('tests_proven');
  });

  it('does not restore installed test dependencies previously saved by the PR pool', () => {
    const cache = publish.jobs['client-tests'].steps.find(
      (s: { id?: string }) => s.id === 'nm-cache'
    ).with;
    expect(cache.key).toBe(
      "nm-publish-tests-v2-${{ runner.os }}-node22-${{ hashFiles('package-lock.json') }}"
    );
    expect(cache['restore-keys']).toBeUndefined();
  });

  for (const name of ['publish-to-origin', 'publish-to-app']) {
    it.each(['failure', 'cancelled', 'skipped', ''])(
      `${name} refuses %s tests despite claimed PR proof`,
      (result) => {
        expect(publishEligible(name, result)).toBe(false);
      }
    );
    it(`${name} accepts successful release tests with the other prerequisites`, () => {
      expect(publishEligible(name, 'success')).toBe(true);
    });
  }
});

function ciGroup(head: string | undefined, number: number | null = 42, sha = target) {
  const context: Record<string, string | number | null | undefined> = {
    'github.event.pull_request.number': number,
    'github.event.pull_request.head.sha': head,
    'github.ref': number === null ? 'refs/heads/main' : `refs/pull/${number}/merge`,
    'github.sha': sha,
  };
  return ci.concurrency.group.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_: string, expression: string) => {
    const names = expression.split('||').map((s: string) => s.trim());
    for (const name of names) expect(name in context, name).toBe(true);
    return names.map((name: string) => context[name]).find(Boolean) ?? '';
  });
}

describe('out-of-order PR events cannot cancel current-head checks', () => {
  it('a delayed older event and a replay after A -> B -> A never share the current group', () => {
    const a = ciGroup(target);
    const b = ciGroup('b'.repeat(40));
    expect(a).not.toBe(b);
    expect(ciGroup(target)).toBe(a);
    expect(ci.concurrency['cancel-in-progress']).toBe(true);
  });

  it('same-head duplicates share a group without colliding with other PRs', () => {
    expect(ciGroup(target)).toBe(ciGroup(target));
    expect(ciGroup(target, 42)).not.toBe(ciGroup(target, 43));
  });

  it('scheduled main runs use their own immutable commit', () => {
    expect(ciGroup(undefined, null, target)).not.toBe(ciGroup(undefined, null, 'b'.repeat(40)));
    expect(ciGroup(undefined, null, target)).not.toBe(ciGroup(target));
  });
});
