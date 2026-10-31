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
  it('uses only standard hosted runners across CI and publication', () => {
    for (const file of [
      'ci.yml',
      'publish-club-arena.yml',
      'publish-club-arena-client.yml',
      'publish-club-arena-transaction.yml',
    ]) {
      const workflow = YAML.parse(readFileSync('.github/workflows/' + file, 'utf8'));
      const jobs = Object.values(workflow.jobs) as Array<Record<string, any>>;
      expect(jobs.filter((job) => job['runs-on']).length).toBeGreaterThan(0);
      for (const job of jobs.filter((job) => job['runs-on'])) {
        expect(job['runs-on']).toBe('ubuntu-latest');
        expect(job['runs-on']).not.toMatch(/ca-linux|self-hosted|vars\./);
      }
    }
    const publishing = YAML.parse(readFileSync('.github/workflows/publish-club-arena.yml', 'utf8'));
    const client = YAML.parse(
      readFileSync('.github/workflows/publish-club-arena-client.yml', 'utf8')
    );
    for (const job of [
      ci.jobs.typecheck_compile,
      ci.jobs.unit_shards,
      ci.jobs.build,
      client.jobs['client-tests'],
      client.jobs['build-and-store'],
    ])
      expect(job['continue-on-error']).toBeUndefined();
    expect(ci.jobs.unit_shards.env.VITEST_MAX_THREADS).toBe(8);
    expect(client.jobs['client-tests'].env.VITEST_MAX_THREADS).toBe(8);
    expect(publishing.jobs.production.concurrency).toEqual({
      group: 'publish-club-arena-production',
      'cancel-in-progress': false,
    });
  });

  it('defaults required native qualification to the approved standard hosted profile', () => {
    for (const job of ['accounting_postgres', 'server_shards']) {
      expect(ci.jobs[job]['runs-on']).toBe('ubuntu-latest');
      expect(ci.jobs[job]['continue-on-error']).toBeUndefined();
      expect(ci.jobs[job].strategy.matrix.shard).toEqual([1, 2, 3, 4]);
      expect(ci.jobs[job].strategy['fail-fast']).toBe(false);
    }
    expect(ci.jobs.accounting_postgres['timeout-minutes']).toBe(50);
    expect(ci.jobs.server_shards['timeout-minutes']).toBe(25);
    expect(ci.jobs.server.needs).toContain('accounting_postgres');
    expect(ci.jobs.server.needs).toContain('server_shards');
  });

  it('keeps the required native fixture callee on the same fixed hosted profile', () => {
    const job = YAML.parse(
      readFileSync('.github/workflows/component-fixture-native-smoke.yml', 'utf8')
    ).jobs['native-smoke'];
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job['timeout-minutes']).toBe(55);
    expect(job['continue-on-error']).toBeUndefined();
    expect(ci.jobs.fixture_native.uses).toBe(
      './.github/workflows/component-fixture-native-smoke.yml'
    );
    expect(ci.jobs.typecheck.needs).toContain('fixture_native');
  });

  it('balances the complete browser selector across general and portrait shards without waivers', () => {
    expect(browser.strategy).toEqual({
      'fail-fast': false,
      matrix: { shard: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], partition: ['general', 'portrait'] },
    });
    expect(browser['timeout-minutes']).toBe(30);
    expect(browser['continue-on-error']).toBeUndefined();
    const beats = browser.steps.find((value: { id?: string }) => value.id === 'css-beats');
    expect(beats.if).toBeUndefined();
    expect(beats.run).toContain('node scripts/ci/ui-test-selection.mjs browser ');
    expect(beats.run).toContain('--project=chromium --project=webkit-footer');
    expect(beats.run).toContain('--retries=1');
    const portrait =
      'occupied portrait rings keep the board clear, bets on the rail and controls at their approved sizes at';
    const grep = beats.env?.CSS_BEAT_GREP ?? browser.env?.CSS_BEAT_GREP;
    expect(grep).toContain(portrait);
    expect(grep).toContain(`^(?!.*${portrait})`);
    expect(grep).toContain("matrix.partition == 'portrait'");
    expect(beats.run).toContain('--grep="$CSS_BEAT_GREP"');
    expect(browser.name).toContain('${{ matrix.partition }}');
    expect(beats.run).not.toContain('--pass-with-no-tests');
    expect(beats.run.trim()).toMatch(/--shard=\$\{\{ matrix\.shard \}\}\/10$/);
    expect((beats.run.match(/tests\/e2e\//g) || []).length).toBe(26);
    for (const value of browser.steps) expect(value['continue-on-error']).toBeUndefined();
    const evidence = step('Preserve failed CSS beat browser evidence');
    expect(evidence.if).toContain("steps.css-beats.outcome == 'failure'");
    expect(evidence.with.name).toContain('${{ matrix.shard }}');
    expect(evidence.with.name).toContain('${{ matrix.partition }}');
    expect(evidence.with.path).toBe('test-results/');
  });

  it('retains the portrait consumer for any focused presentation change', async () => {
    const { browserSpecs } = await import('../../scripts/ci/ui-test-selection.mjs');
    const portraitSpec = 'tests/e2e/table-proportions.spec.ts';
    expect(
      browserSpecs(process.cwd(), ['src/unrelated-presentation.module.css'], [portraitSpec])
    ).toEqual([portraitSpec]);
  });

  it('partitions every Diamond case across three isolated single-worker VMs', () => {
    const diamond = ci.jobs['diamond-playfield-e2e'];
    const cases = readFileSync('tests/e2e/css/diamond-games-playfield.spec.ts', 'utf8');
    expect(cases).toContain("test.describe.configure({ mode: 'parallel', timeout: 180_000 });");
    expect(diamond.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2, 3] } });
    expect(diamond['timeout-minutes']).toBe(25);
    expect(diamond['continue-on-error']).toBeUndefined();
    const run = diamond.steps.find((value: { id?: string }) => value.id === 'diamond-playfield');
    expect(run.if).toBeUndefined();
    expect(run.run).toContain(
      'tests/e2e/css/diamond-games-playfield.spec.ts --project=chromium --workers=1 --reporter=line,json --retries=1 --shard=${{ matrix.shard }}/3'
    );
    for (const value of diamond.steps) expect(value['continue-on-error']).toBeUndefined();
    expect(
      diamond.steps.find(
        (value: { name?: string }) =>
          value.name === 'Name every Diamond playfield case that passed only on retry'
      ).if
    ).toContain("steps.diamond-playfield.outcome == 'failure'");
    const evidence = diamond.steps.find(
      (value: { name?: string }) =>
        value.name === 'Preserve failed Diamond playfield browser evidence'
    );
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
      ['Push enrollment opt-in browser gate', 'npm run test:e2e:push-enrollment', 5],
    ]) {
      const matching = browser.steps.filter((value: { run?: string }) => value.run === command);
      expect(matching).toHaveLength(1);
      expect(step(name)).toBe(matching[0]);
      expect(matching[0].if).toBe(`matrix.partition == 'general' && matrix.shard == ${shard}`);
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

function reserve(free: string, fail = false, failRemove = false) {
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
    '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TRACE_TEST"\ncase "$1" in\n rm) [ "$2" = -rf ] && [ "$3" = -- ] && [ "$4" = "$SDK_TEST" ] || exit 82; [ "$FAIL_RM" = false ] || exit 24; /bin/rm -rf -- "$SDK_TEST" ;;\n *) exit 83 ;;\nesac\n',
    { mode: 0o755 }
  );
  try {
    const source = step('Reserve disk for browser checks').run;
    expect(source.match(/\/usr\/local\/lib\/android\/sdk/g)).toHaveLength(2);
    const result = spawnSync('bash', ['-c', source.replaceAll('/usr/local/lib/android/sdk', sdk)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FREE_TEST: free,
        FAIL_DF: String(fail),
        FAIL_RM: String(failRemove),
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
  'proven ample capacity %s avoids SDK cleanup',
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
      calls: ['rm -rf -- SDK'],
    });
  }
);
it('does not turn a failed capacity read into an ample-capacity success', () => {
  expect(reserve('386924544', true)).toEqual({ status: 23, exists: true, calls: [] });
});

it('does not turn failed SDK cleanup into a successful capacity reservation', () => {
  expect(reserve('0', false, true)).toEqual({
    status: 24,
    exists: true,
    calls: ['rm -rf -- SDK'],
  });
});

describe('eight client shards retain the required verdict and unchanged safeguards', () => {
  it('partitions the same selector inventory across eight distinct standard hosted runners', () => {
    const shards = ci.jobs.unit_shards;
    expect(shards.strategy).toEqual({
      'fail-fast': true,
      matrix: { shard: [1, 2, 3, 4, 5, 6, 7, 8] },
    });
    expect(new Set(shards.strategy.matrix.shard).size).toBe(8);
    expect(shards.env.VITEST_MAX_THREADS).toBe(8);
    expect(shards['timeout-minutes']).toBe(15);
    expect(
      shards.steps.find((value: { name: string }) => value.name === 'Run Test Suite').run
    ).toBe('node scripts/ci/ui-test-selection.mjs unit --shard=${{ matrix.shard }}/8');
    expect(shards.steps.find((value: { name: string }) => value.name === 'Report').run).toContain(
      'Client Unit Tests - shard ${{ matrix.shard }}/8'
    );
    expect(ci.jobs.unit.needs).toBe('unit_shards');
    expect(ci.jobs.unit.if).toBe('always()');
    expect(ci.jobs.unit.name).toBe('Client Unit Tests (vitest)');
  });

  it.each(['success', 'failure', 'cancelled', '', 'skipped'])(
    'the actual eight-shard aggregate preserves result %s without hiding a failed shard',
    (result) => {
      const root = mkdtempSync(join(tmpdir(), 'client-eight-verdict-'));
      try {
        const judge = ci.jobs.unit.steps.find(
          (value: { name: string }) => value.name === 'Every shard passed'
        );
        expect(judge.run).toContain('All eight shards passed.');
        const run = spawnSync(
          'bash',
          ['-e', '-c', judge.run.replace('${{ needs.unit_shards.result }}', result)],
          {
            encoding: 'utf8',
            env: { ...process.env, GITHUB_STEP_SUMMARY: join(root, 'summary') },
          }
        );
        expect(run.status, run.stderr).toBe(['success', 'skipped'].includes(result) ? 0 : 1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('proves presentation scope after dependencies and before judging unchanged bitmap inputs', () => {
    const steps = ci.jobs.typecheck_compile.steps;
    const index = (name: string) =>
      steps.findIndex((value: { name: string }) => value.name === name);
    const proof = steps.findIndex((value: { id?: string }) => value.id === 'compile_scope');
    expect(proof).toBeGreaterThan(index('Install Dependencies'));
    expect(proof).toBeLessThan(index('No asset ships a white matte'));
    expect(steps[proof].env.CI_HEAD_SHA).toBe('${{ github.sha }}');
    expect(steps[proof]['continue-on-error']).toBeUndefined();
    expect(
      steps[index('The matte baseline is a record, not a list of excuses')].if
    ).toBeUndefined();
    expect(
      ci.jobs.source_windows.steps.find(
        (value: { name: string }) => value.name === 'No asset ships a white matte'
      ).if
    ).toBeUndefined();
  });

  it.each([
    'No asset ships a white matte',
    'Evaluate fleet throughput against live dealing capacity',
  ])('%s runs unless GitHub recognizes the positive proof', (name) => {
    const guarded = ci.jobs.typecheck_compile.steps.find(
      (value: { name: string }) => value.name === name
    );
    const key =
      name === 'No asset ships a white matte'
        ? 'presentation_only'
        : 'isolated_simulations_unchanged';
    expect(guarded.if).toBe(`steps.compile_scope.outputs.${key} != 'true'`);
    const evaluate = new Function('steps', `return (${guarded.if});`);
    for (const [presentation, expected] of [
      [undefined, true],
      ['', true],
      ['false', true],
      ['FALSE', true],
      ['unknown', true],
      ['true?', true],
      ['true', false],
      ['TRUE', false],
    ] as const) {
      // GitHub compares expression strings without case; JavaScript does not.
      const output = typeof presentation === 'string' ? presentation.toLowerCase() : presentation;
      expect(evaluate({ compile_scope: { outputs: { [key]: output } } })).toBe(expected);
    }
  });
});
