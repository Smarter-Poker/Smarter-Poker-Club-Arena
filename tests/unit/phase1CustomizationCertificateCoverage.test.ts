import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  contracts,
  inspectPhase1CustomizationReports,
} from '../../scripts/ci/phase1-customization-certificate-coverage.mjs';

const ROOT = resolve(__dirname, '../..');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/post-deploy-e2e.yml'), 'utf8');

function workflowStep(name: string): string {
  const at = WORKFLOW.indexOf(`- name: ${name}`);
  if (at < 0) throw new Error(`workflow step not found: ${name}`);
  const lineStart = WORKFLOW.lastIndexOf('\n', at) + 1;
  const indent = WORKFLOW.slice(lineStart, at);
  const next = WORKFLOW.indexOf(`\n${indent}- name: `, at + 1);
  return next < 0 ? WORKFLOW.slice(at) : WORKFLOW.slice(at, next);
}

function validReport(contract: (typeof contracts)[number]) {
  return {
    errors: [],
    stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
    suites: [
      {
        specs: [
          {
            file: contract.file,
            title: contract.title,
            ok: true,
            tests: [
              {
                projectName: 'chromium',
                expectedStatus: 'passed',
                status: 'expected',
                results: [{ status: 'passed', retry: 0 }],
              },
            ],
          },
        ],
      },
    ],
  };
}

function inspect(
  edit?: (reports: ReturnType<typeof validReport>[]) => void,
  names = contracts.map((contract) => contract.report)
) {
  const directory = mkdtempSync(join(tmpdir(), 'phase1-customization-coverage-'));
  try {
    const reports = contracts.map(validReport);
    edit?.(reports);
    const paths = reports.map((report, index) => {
      const path = join(directory, names[index] ?? `unexpected-${index}.json`);
      writeFileSync(path, JSON.stringify(report));
      return path;
    });
    return inspectPhase1CustomizationReports(paths);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('the Phase 1 customization cutover certificate', () => {
  it('accepts exactly one first-attempt Chromium pass for every affected journey', () => {
    expect(inspect()).toEqual({ complete: true, missing: [] });
  });

  it.each([
    'report error',
    'not-run reason',
    'extra spec',
    'wrong file',
    'wrong title',
    'failed spec',
    'wrong project',
    'expected failure',
    'failed test',
    'missing result',
    'multiple attempts',
    'retry index',
    'failed result',
  ])('refuses %s instead of weakening the cutover receipt', (reason) => {
    const result = inspect((reports) => {
      const report = reports[0];
      const spec = report.suites[0].specs[0];
      const test = spec.tests[0];
      if (reason === 'report error') report.errors.push({ message: 'runner failed' } as never);
      if (reason === 'not-run reason') Object.assign(report, { notRunReason: 'not invoked' });
      if (reason === 'extra spec') report.suites[0].specs.push(structuredClone(spec));
      if (reason === 'wrong file') spec.file = 'some-other.spec.ts';
      if (reason === 'wrong title') spec.title = 'a weaker journey';
      if (reason === 'failed spec') spec.ok = false;
      if (reason === 'wrong project') test.projectName = 'webkit';
      if (reason === 'expected failure') test.expectedStatus = 'failed';
      if (reason === 'failed test') test.status = 'unexpected';
      if (reason === 'missing result') test.results = [];
      if (reason === 'multiple attempts') test.results.push({ status: 'passed', retry: 1 });
      if (reason === 'retry index') test.results[0].retry = 1;
      if (reason === 'failed result') test.results[0].status = 'failed';
    });
    expect(result.complete).toBe(false);
    expect(result.missing).toContain(
      'customization-realtime.json did not contain its one exact first-attempt pass'
    );
  });

  it('refuses a missing, duplicated, renamed, malformed, or empty report set', () => {
    expect(inspectPhase1CustomizationReports([]).complete).toBe(false);
    expect(
      inspect(undefined, [
        'customization-realtime.json',
        'customization-realtime.json',
        'customization-commerce.json',
      ]).complete
    ).toBe(false);

    const directory = mkdtempSync(join(tmpdir(), 'phase1-customization-coverage-'));
    try {
      const paths = contracts.map((contract, index) => {
        const path = join(directory, contract.report);
        writeFileSync(path, index === 1 ? '{' : JSON.stringify(validReport(contract)));
        return path;
      });
      expect(inspectPhase1CustomizationReports(paths).complete).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('wires the narrow evidence into the seal without hiding the broad client verdict', () => {
    expect(WORKFLOW).toContain(
      "phase1_certified: ${{ steps.phase1_verdict.outcome == 'success' && steps.phase1_verdict.outputs.certified == 'true' }}"
    );
    expect(
      WORKFLOW.match(
        /certified: \$\{\{ steps\.release_window\.outcome == 'success' && steps\.release_window\.outputs\.certified == 'true' \}\}/g
      )
    ).toHaveLength(2);
    expect(WORKFLOW).toContain('id: phase1_coverage');
    expect(WORKFLOW).toContain('id: account_cleanup');
    expect(WORKFLOW).toContain(
      'CUSTOMIZATION_COVERAGE_OUTCOME: ${{ steps.phase1_coverage.outcome }}'
    );
    expect(WORKFLOW).toContain('RELEASE_WINDOW_OUTCOME: ${{ steps.release_window.outcome }}');
    expect(WORKFLOW).toContain(
      'PHASE1_RELEASE_CERTIFIED: ${{ steps.phase1_release.outputs.certified }}'
    );
    expect(WORKFLOW).toContain('PHASE1_RELEASE_OUTCOME: ${{ steps.phase1_release.outcome }}');
    expect(WORKFLOW).toContain('ACCOUNT_CLEANUP_OUTCOME: ${{ steps.account_cleanup.outcome }}');
    expect(WORKFLOW).toContain('phase1-customization-certificate-coverage.mjs');
    for (const contract of contracts) {
      expect(WORKFLOW).toContain(`e2e-report/${contract.report}`);
    }
    const seal = WORKFLOW.slice(WORKFLOW.indexOf('  phase1-customization-cutover-seal:'));
    expect(seal).toContain("needs.production-e2e.outputs.phase1_certified == 'true'");
    // The whole-job window is reported, never required: the seal's client
    // evidence is the bracket around its own three journeys (2026-10-07).
    expect(seal).not.toContain("needs.production-e2e.outputs.certified == 'true'");
    expect(seal).not.toContain("needs.production-e2e.result == 'success'");
    expect(workflowStep('Write the durable cutover receipt')).toContain(
      "if: steps.artifacts.outcome == 'success' && steps.artifacts.outputs.ready == 'true'"
    );
  });

  it.each([
    {
      coverage: 'true',
      coverageOutcome: 'success',
      cleanup: 'success',
      release: 'true',
      releaseOutcome: 'success',
      bracketOutcome: 'success',
      status: 0,
      certified: true,
    },
    {
      coverage: 'true',
      coverageOutcome: 'success',
      cleanup: 'success',
      release: 'false',
      releaseOutcome: 'success',
      bracketOutcome: 'success',
      status: 0,
      certified: false,
    },
    {
      coverage: 'true',
      coverageOutcome: 'failure',
      cleanup: 'success',
      release: 'true',
      releaseOutcome: 'success',
      bracketOutcome: 'success',
      status: 1,
      certified: false,
    },
    {
      coverage: 'true',
      coverageOutcome: 'success',
      cleanup: 'success',
      release: 'true',
      releaseOutcome: 'failure',
      bracketOutcome: 'success',
      status: 1,
      certified: false,
    },
    {
      coverage: 'false',
      coverageOutcome: 'success',
      cleanup: 'success',
      release: 'true',
      releaseOutcome: 'success',
      bracketOutcome: 'success',
      status: 1,
      certified: false,
    },
    {
      coverage: 'true',
      coverageOutcome: 'success',
      cleanup: 'failure',
      release: 'true',
      releaseOutcome: 'success',
      bracketOutcome: 'success',
      status: 1,
      certified: false,
    },
    {
      coverage: 'true',
      coverageOutcome: 'success',
      cleanup: 'success',
      release: 'true',
      releaseOutcome: 'success',
      bracketOutcome: 'failure',
      status: 1,
      certified: false,
    },
  ])(
    'classifies coverage=$coverage/$coverageOutcome cleanup=$cleanup bracket=$release/$bracketOutcome window=$releaseOutcome without inventing a seal',
    ({
      coverage,
      coverageOutcome,
      cleanup,
      release,
      releaseOutcome,
      bracketOutcome,
      status,
      certified,
    }) => {
      const block = workflowStep('Classify the Phase 1 customization certificate');
      const body = block.split('\n        run: |\n')[1];
      expect(body).toBeDefined();
      const directory = mkdtempSync(join(tmpdir(), 'phase1-customization-verdict-'));
      try {
        const output = join(directory, 'output.txt');
        const summary = join(directory, 'summary.md');
        writeFileSync(output, '');
        writeFileSync(summary, '');
        const result = spawnSync(
          'bash',
          ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', body.replace(/^ {10}/gm, '')],
          {
            cwd: ROOT,
            encoding: 'utf8',
            env: {
              ...process.env,
              CUSTOMIZATION_COVERAGE_COMPLETE: coverage,
              CUSTOMIZATION_COVERAGE_OUTCOME: coverageOutcome,
              ACCOUNT_CLEANUP_OUTCOME: cleanup,
              PHASE1_RELEASE_CERTIFIED: release,
              PHASE1_RELEASE_OUTCOME: bracketOutcome,
              RELEASE_WINDOW_OUTCOME: releaseOutcome,
              GITHUB_OUTPUT: output,
              GITHUB_STEP_SUMMARY: summary,
            },
          }
        );
        expect(result.status).toBe(status);
        expect(readFileSync(output, 'utf8')).toContain(`certified=${certified}`);
        if (coverage === 'true' && cleanup === 'success' && release === 'false') {
          expect(readFileSync(summary, 'utf8')).toContain('NON-VERDICT');
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
});

describe('the Phase 1 seal is owed exactly when its own condition holds', () => {
  const condition = (text: string) =>
    text
      .replace(/\s+/g, ' ')
      .replace(/^.*?\$\{\{ (?:always\(\) && )?/, '')
      .replace(/ \}\}.*$/, '')
      .trim();

  it('keeps SEAL_OWED in the verdict recorder identical to the seal job if', () => {
    const sealJob = WORKFLOW.slice(WORKFLOW.indexOf('  phase1-customization-cutover-seal:'));
    const sealIf = sealJob.slice(sealJob.indexOf('    if: >-'), sealJob.indexOf('    name:'));
    const verdictJob = WORKFLOW.slice(WORKFLOW.indexOf('  post-deploy-verdict:'));
    const owed = verdictJob.slice(
      verdictJob.indexOf('SEAL_OWED: >-'),
      verdictJob.indexOf('        run: |', verdictJob.indexOf('SEAL_OWED: >-'))
    );
    expect(condition(sealIf)).toContain("needs.production-e2e.outputs.phase1_certified == 'true'");
    expect(condition(owed)).toBe(condition(sealIf));
    expect(verdictJob).toContain(
      "UNOWED_LANES+=$'Seal certified Phase 1 customization cutover\\n'"
    );
    // The SEO lane is owed only for a publisher event; an engine-triggered
    // certificate (run 37604057526, which sealed) skips it by design.
    const seoJob = WORKFLOW.slice(
      WORKFLOW.indexOf('  seo-contract:'),
      WORKFLOW.indexOf('  production-e2e:')
    );
    const seoIf = seoJob.match(/\n {4}if: (.+)\n/)?.[1];
    expect(seoIf).toBeDefined();
    expect(verdictJob).toContain(`SEO_OWED: \${{ ${seoIf} }}`);
    expect(verdictJob).toContain("UNOWED_LANES+=$'The Live SEO Contract Holds\\n'");
    expect(verdictJob).toMatch(/permissions:\n(?:\s+#.*\n)*\s+actions: read\n\s+contents: read/);
  });

  it('brackets the three journeys, and runs them before every other sweep suite', () => {
    const sweep = workflowStep('Run the specs that need a deployed page');
    const before = sweep.indexOf('read_release release-bracket/phase1-before.json');
    const after = sweep.indexOf('read_release release-bracket/phase1-after.json');
    expect(before).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(before);
    for (const contract of contracts) {
      const at = sweep.indexOf(`run_suite ${contract.report}`);
      expect(at).toBeGreaterThan(before);
      expect(at).toBeLessThan(after);
    }
    expect(after).toBeLessThan(sweep.indexOf('run_suite stats.json'));
    const classify = workflowStep('Classify the release the Phase 1 journeys ran against');
    expect(classify).toContain('production-e2e-provenance.mjs bracket "$EXPECTED_LIVE_SHA"');
    expect(classify).toContain(
      'release-bracket/phase1-before.json release-bracket/phase1-after.json'
    );
  });
});
