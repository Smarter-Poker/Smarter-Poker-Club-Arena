import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { collect, main, skipsIn, summary } from '../../scripts/ci/report-mobile-e2e-skips.mjs';

const skipped = (reason: string | undefined, projectName = 'chromium') => ({
  projectName,
  annotations: reason === undefined ? [] : [{ type: 'skip', description: reason }],
  results: [{ status: 'skipped' }],
});
const report = (tests: unknown[], file = 'club-lobby.spec.ts') => ({
  suites: [
    {
      title: file,
      file,
      suites: [
        {
          title: 'Club lobby',
          specs: [
            {
              title: 'a full table offers the queue',
              file,
              line: 232,
              tests,
            },
          ],
        },
      ],
    },
  ],
});

describe('named mobile E2E skips', () => {
  it('retains the complete nested name, project, source location and verbatim reason', () => {
    const reason = 'no full cash tables in this lobby right now\n100% <ready> | `queue`';
    expect(skipsIn(report([skipped(reason, 'webkit-footer')]), 'e2e-report/lobby.json')).toEqual([
      {
        report: 'e2e-report/lobby.json',
        file: 'club-lobby.spec.ts',
        line: 232,
        project: 'webkit-footer',
        title: 'club-lobby.spec.ts > Club lobby > a full table offers the queue',
        reasons: [reason],
        reasonProvided: true,
      },
    ]);
  });

  it('keeps every skip beyond the annotation limit and retains all reason annotations', () => {
    const tests = Array.from({ length: 15 }, (_, i) => skipped(`exact reason ${i}`));
    tests[0].annotations.push({ type: 'fixme', description: 'second exact reason' });
    const evidence = collect(['lobby.json'], () => report(tests));
    expect(evidence.skips).toHaveLength(15);
    expect(evidence.skips[0].reasons).toEqual(['exact reason 0', 'second exact reason']);
    expect(summary(evidence)).toContain('exact reason 14');
    expect(summary(evidence)).toContain('15 skipped test(s). Reporting complete.');
  });

  it('limits sweep reporting to mobile checks while including the entire Cashier and lobby reports', () => {
    expect(
      skipsIn(report([skipped('mobile')], 'mobile-fit-audit.spec.ts'), 'sweep.json')
    ).toHaveLength(1);
    expect(
      skipsIn(report([skipped('mobile')], 'production-mobile-lobby-chrome.spec.ts'), 'sweep.json')
    ).toHaveLength(1);
    expect(skipsIn(report([skipped('footer')], 'footer-route.spec.ts'), 'sweep.json')).toHaveLength(
      1
    );
    expect(skipsIn(report([skipped('unrelated')], 'routes/admin.spec.ts'), 'sweep.json')).toEqual(
      []
    );
    expect(
      skipsIn(report([skipped('cashier')], 'production-cashier.spec.ts'), 'cashier.json')
    ).toHaveLength(1);
    expect(
      skipsIn(
        report(
          [skipped('first-run profile requires its fixture')],
          'production-first-run-iphone.spec.ts'
        ),
        'first-run-iphone.json'
      )[0].reasons
    ).toEqual(['first-run profile requires its fixture']);
  });

  it('never invents a reason or lets a missing reason produce a complete report', () => {
    const evidence = collect(['lobby.json'], () => report([skipped(undefined)]));
    expect(evidence.complete).toBe(false);
    expect(evidence.skips[0].reasons).toEqual([]);
    expect(summary(evidence)).toContain('omitted its reason');
    expect(summary(evidence)).toContain('a full table offers the queue');
  });

  it('distinguishes missing, malformed and not-run reports from zero skips', () => {
    expect(
      collect(['lobby.json'], () => {
        throw new Error('missing file');
      }).complete
    ).toBe(false);
    expect(collect(['lobby.json'], () => ({})).unavailable[0].reason).toContain(
      'no Playwright suites'
    );
    expect(
      collect(['lobby.json'], () => ({ notRunReason: 'no deployed spec' })).unavailable
    ).toEqual([{ report: 'lobby.json', reason: 'no deployed spec' }]);
    expect(collect(['lobby.json'], () => ({ suites: [] }))).toMatchObject({
      complete: true,
      skips: [],
    });
  });

  it('writes the durable artifact and job summary before refusing incomplete reporting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mobile-skip-receipt-'));
    try {
      const input = join(dir, 'lobby.json'),
        output = join(dir, 'mobile-skips.json'),
        step = join(dir, 'summary.md');
      writeFileSync(input, JSON.stringify(report([skipped(undefined)])));
      expect(main([output, input], { GITHUB_STEP_SUMMARY: step })).toBe(1);
      expect(JSON.parse(readFileSync(output, 'utf8')).skips).toHaveLength(1);
      expect(readFileSync(step, 'utf8')).toContain('Reporting INCOMPLETE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extracts exact runtime, inherited and fixme reasons from real Playwright JSON without launching a browser', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mobile-skip-playwright-'));
    try {
      const dependency = JSON.stringify(resolve('node_modules/@playwright/test'));
      writeFileSync(
        join(dir, 'skips.spec.cjs'),
        `const {test}=require(${dependency});
test('runtime skip',()=>test.skip(true,'no full cash tables in this lobby right now'));
test.describe('inherited',()=>{test.beforeEach(()=>test.skip(true,'no bottom nav on this layout'));test('footer',()=>{});});
test('fixme reason',()=>test.fixme(true,'fixture is not available'));
test('passed',()=>{});`
      );
      writeFileSync(
        join(dir, 'playwright.config.cjs'),
        `module.exports={testDir:__dirname,testMatch:'skips.spec.cjs',workers:1,retries:0,reporter:[['json',{outputFile:'${join(dir, 'lobby.json')}'}]],outputDir:'${join(dir, 'results')}'};`
      );
      execFileSync(
        process.execPath,
        [
          resolve('node_modules/@playwright/test/cli.js'),
          'test',
          '--config',
          join(dir, 'playwright.config.cjs'),
        ],
        { stdio: 'pipe', timeout: 20_000 }
      );
      const evidence = collect([join(dir, 'lobby.json')]);
      expect(evidence.complete).toBe(true);
      expect(evidence.skips.map((skip: any) => skip.reasons[0]).sort()).toEqual([
        'fixture is not available',
        'no bottom nav on this layout',
        'no full cash tables in this lobby right now',
      ]);
      expect(evidence.skips.map((skip: any) => skip.title).join('\n')).toContain(
        'inherited > footer'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 25_000);

  it('runs and retains the mobile receipt on every outcome without changing engine reporting', () => {
    const workflow = parse(readFileSync('.github/workflows/post-deploy-e2e.yml', 'utf8'));
    const steps = workflow.jobs['production-e2e'].steps;
    const generate = steps.find(
      (step: any) => step.name === 'Name every skipped mobile check and its exact reason'
    );
    const upload = steps.find(
      (step: any) => step.name === 'Retain named mobile skips on every outcome'
    );
    // Ordinary publication still emits the full receipt on every outcome.
    // The closed navigation recovery has its own exact three-case report.
    expect(generate.if).toBe(
      "always() && steps.live.outputs.ready == 'true' && needs.publication-gate.outputs.client_navigation != 'true'"
    );
    expect(generate.run).toContain('report-mobile-e2e-skips.mjs');
    expect(generate.run).toContain('e2e-report/first-run-iphone.json');
    expect(generate.run).toContain('e2e-report/lobby.json');
    expect(generate.run).toContain('e2e-report/cashier.json');
    expect(generate.run).toContain('e2e-report/sweep.json');
    expect(upload.if).toBe(generate.if);
    expect(upload.with).toMatchObject({
      name: 'post-deploy-mobile-skips',
      path: 'e2e-report/mobile-skips.json',
      'if-no-files-found': 'error',
    });
    expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(generate));
    expect(JSON.stringify(workflow.jobs['live-table-e2e'])).not.toContain(
      'report-mobile-e2e-skips'
    );
  });
});
