import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { lobbyCoverage, requiredLobbyCases } from '../../scripts/ci/lobby-certificate-coverage.mjs';

const report = () => ({
  errors: [],
  suites: [
    {
      specs: requiredLobbyCases.map((title) => ({
        title,
        file: 'club-lobby.spec.ts',
        ok: true,
        tests: [
          {
            projectName: 'chromium',
            expectedStatus: 'passed',
            status: 'expected',
            results: [{ status: 'passed', retry: 0 }],
          },
        ],
      })),
    },
  ],
});

describe('complete production lobby coverage', () => {
  it('requires all ten first-attempt cases', () => {
    expect(lobbyCoverage(report())).toEqual({ complete: true, missing: [] });
  });
  it('refuses an otherwise passing report missing both maintained Madness cases', () => {
    const r = report();
    r.suites[0].specs = r.suites[0].specs.filter((spec) => !spec.title.includes('Madness'));
    expect(lobbyCoverage(r).complete).toBe(false);
  });
  it.each([393, 1440])('requires the %ipx Madness case to execute once without retry', (width) => {
    const title = `PLO5 1/2 Madness exposes its actual rules at ${width}px`;
    expect(requiredLobbyCases).toContain(title);
    for (const mode of ['missing', 'skipped', 'retried', 'duplicate']) {
      const r = report();
      const target = r.suites[0].specs.find((spec) => spec.title === title)!;
      if (mode === 'missing')
        r.suites[0].specs = r.suites[0].specs.filter((spec) => spec !== target);
      if (mode === 'skipped') target.tests[0].results[0].status = 'skipped';
      if (mode === 'retried') target.tests[0].results[0].retry = 1;
      if (mode === 'duplicate') r.suites[0].specs.push(target);
      expect(lobbyCoverage(r).complete, `${title}: ${mode}`).toBe(false);
    }
  });
  it.each(['missing', 'skipped', 'retried', 'wrong-project', 'duplicate', 'error'])(
    'refuses %s evidence',
    (mode) => {
      const r = report();
      const target = r.suites[0].specs[4];
      if (mode === 'missing') r.suites[0].specs.splice(4, 1);
      if (mode === 'skipped') target.tests[0].results[0].status = 'skipped';
      if (mode === 'retried') target.tests[0].results[0].retry = 1;
      if (mode === 'wrong-project') target.tests[0].projectName = 'other';
      if (mode === 'duplicate') r.suites[0].specs.push(target);
      if (mode === 'error') (r.errors as unknown[]).push({ message: 'fixture failed' });
      expect(lobbyCoverage(r).complete).toBe(false);
    }
  );
  it('is invoked immediately after the maintained club lobby suite', () => {
    const workflow = readFileSync('.github/workflows/post-deploy-e2e.yml', 'utf8');
    expect(workflow).toContain(
      'E2E_CLUB_ID=002c2d27-9584-4e52-835a-bb2be148fc81 run_suite lobby.json'
    );
    expect(workflow).toContain(
      'node scripts/ci/lobby-certificate-coverage.mjs e2e-report/lobby.json'
    );
    expect(workflow).toContain(
      'lobby_coverage_rc=$?; [ $lobby_coverage_rc -ne 0 ] && rc=$lobby_coverage_rc'
    );
  });
});
