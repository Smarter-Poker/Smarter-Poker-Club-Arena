import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const ci = YAML.parse(readFileSync(resolve('.github/workflows/ci.yml'), 'utf8'));
const browser = ci.jobs['css-beats-e2e'];
const gate = ci.jobs['css-beats-gate'];
const step = (name: string) =>
  browser.steps.find((value: { name?: string }) => value.name === name);

describe('browser qualification parallel delivery', () => {
  it('partitions the existing browser selector into three complete, non-fail-fast shards', () => {
    expect(browser.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2, 3] } });
    expect(browser['timeout-minutes']).toBe(30);
    expect(browser['continue-on-error']).toBeUndefined();
    const beats = browser.steps.find((value: { id?: string }) => value.id === 'css-beats');
    expect(beats.if).toBeUndefined();
    expect(beats.run).toContain('node scripts/ci/ui-test-selection.mjs browser ');
    expect(beats.run).toContain('--project=chromium --project=webkit-footer');
    expect(beats.run).toContain('--retries=1');
    expect(beats.run.trim()).toMatch(/--shard=\$\{\{ matrix\.shard \}\}\/3$/);
    expect((beats.run.match(/tests\/e2e\//g) || []).length).toBe(26);
    for (const value of browser.steps) expect(value['continue-on-error']).toBeUndefined();
    const evidence = step('Preserve failed CSS beat browser evidence');
    expect(evidence.if).toContain("steps.css-beats.outcome == 'failure'");
    expect(evidence.with.name).toContain('${{ matrix.shard }}');
    expect(evidence.with.path).toBe('test-results/');
  });

  it('executes every independent financial, Studio and enrollment gate exactly once', () => {
    for (const [name, command, shard] of [
      [
        'Table Studio real-component purchase, sync, and accessibility gate',
        'npm run test:e2e:customization',
        1,
      ],
      ['Insurance and Rabbit Hunt 375px decision gate', 'npm run test:e2e:financial-decisions', 2],
      ['Push enrollment opt-in browser gate', 'npm run test:e2e:push-enrollment', 3],
    ]) {
      const matching = browser.steps.filter((value: { run?: string }) => value.run === command);
      expect(matching).toHaveLength(1);
      expect(step(name)).toBe(matching[0]);
      expect(matching[0].if).toBe(`matrix.shard == ${shard}`);
      expect(matching[0]['continue-on-error']).toBeUndefined();
      expect(matching[0]['timeout-minutes']).toBeUndefined();
    }
    expect(step('Stop the shared preview').if).toBe('always()');
  });

  it('keeps the required aggregate dependent on the entire matrix and Diamond and refuses every non-success result', () => {
    expect(gate.needs).toEqual(['changes', 'css-beats-e2e', 'diamond-playfield-e2e']);
    expect(gate.name).toBe('CSS Beat E2E (multi-table + animations)');
    expect(gate.if).toContain('always()');
    expect(gate.if).toContain("needs.changes.result != 'success'");
    expect(gate['timeout-minutes']).toBe(5);
    expect(gate['continue-on-error']).toBeUndefined();
    const judge = gate.steps.find(
      (value: { name?: string }) => value.name === 'Both halves passed'
    );
    expect(judge.env).toEqual({
      BEATS_RESULT: '${{ needs.css-beats-e2e.result }}',
      PLAYFIELD_RESULT: '${{ needs.diamond-playfield-e2e.result }}',
    });
    for (const result of ['success', 'failure', 'cancelled', 'skipped', '', 'unknown']) {
      for (const field of ['BEATS_RESULT', 'PLAYFIELD_RESULT']) {
        const run = spawnSync('bash', ['-e', '-c', judge.run], {
          encoding: 'utf8',
          env: {
            ...process.env,
            BEATS_RESULT: 'success',
            PLAYFIELD_RESULT: 'success',
            [field]: result,
          },
        });
        expect(run.status, run.stderr).toBe(result === 'success' ? 0 : 1);
      }
    }
  });
});

function reserve(free: string, fail = false) {
  if (process.platform === 'darwin' && !tmpdir().startsWith('/Volumes/SmarterWork/agent-work/'))
    throw Error('Owned external SSD TMPDIR required');
  const root = mkdtempSync(join(tmpdir(), 'browser-reserve-'));
  const sdk = join(root, 'sdk');
  const bin = join(root, 'bin');
  const trace = join(root, 'trace');
  mkdirSync(sdk);
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'df'),
    '#!/bin/bash\nif [ "$1" = -Pk ]; then\n [ "$FAIL_DF" = false ] || exit 23\n printf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 999999999 1 %s 1%% /\\n" "$FREE_TEST"\nelse\n echo fixture-capacity\nfi\n',
    { mode: 0o755 }
  );
  writeFileSync(
    join(bin, 'sudo'),
    '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TRACE_TEST"\ncase "$1" in\n du) [ "$2" = -sh ] && [ "$3" = "$SDK_TEST" ] || exit 81 ;;\n rm) [ "$2" = -rf ] && [ "$3" = -- ] && [ "$4" = "$SDK_TEST" ] || exit 82; /bin/rm -rf -- "$SDK_TEST" ;;\n *) exit 83 ;;\nesac\n',
    { mode: 0o755 }
  );
  try {
    const source = step('Reserve disk for browser checks').run;
    expect(source.match(/\/usr\/local\/lib\/android\/sdk/g)).toHaveLength(3);
    const result = spawnSync('bash', ['-c', source.replaceAll('/usr/local/lib/android/sdk', sdk)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FREE_TEST: free,
        FAIL_DF: String(fail),
        SDK_TEST: sdk,
        TRACE_TEST: trace,
      },
    });
    return {
      status: result.status,
      exists: existsSync(sdk),
      calls: existsSync(trace)
        ? readFileSync(trace, 'utf8')
            .trim()
            .split('\n')
            .map((line) => line.replaceAll(sdk, 'SDK'))
        : [],
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it.each(['104857600', '386924544', '0104857600'])(
  'proven ample capacity %s avoids both expensive SDK operations',
  (free) => {
    expect(reserve(free)).toEqual({ status: 0, exists: true, calls: [] });
  }
);
it.each(['104857599', '0', '', 'unknown', '-1', '1.2'])(
  'low or unreadable capacity %s retains the exact SDK cleanup',
  (free) => {
    expect(reserve(free)).toEqual({
      status: 0,
      exists: false,
      calls: ['du -sh SDK', 'rm -rf -- SDK'],
    });
  }
);
it('does not turn a failed capacity read into an ample-capacity success', () => {
  expect(reserve('386924544', true)).toEqual({ status: 23, exists: true, calls: [] });
});
