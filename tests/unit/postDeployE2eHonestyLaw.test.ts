/**
 * POST-DEPLOY E2E HONESTY LAW (Phase 6, 2026-08-31)
 *
 * The rule this pins: **the post-deploy run must not report success when it did
 * not verify production.**
 *
 * It could, four different ways, and all four were live on `main`:
 *
 *   1. Playwright exits 0 when every test skips. Dozens of these specs skip
 *      themselves on /auth or when a live fixture is missing, so a run in which
 *      nothing executed was a green run.
 *   2. `global-setup.ts` falls back to a signed-out session when a login fails.
 *      Correct for a merge gate; fatal to the meaning of THIS job, whose entire
 *      purpose is to look at production with a real session.
 *   3. A failed Cashier step SKIPPED the broader sweep, so one money-surface red
 *      hid thirteen spec files and all of tests/e2e/routes - the precise
 *      opposite of the independence the workflow's own comment promises.
 *   4. Inside that sweep, `set -e` let a red Stats invocation abort the route
 *      invocation behind it. Same fault, one level down.
 *
 * Each assertion below is written against the shape that FIXED one of those.
 * If someone reverts one, this test names which.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/post-deploy-e2e.yml'), 'utf8');
const ENGINE_STAGE = readFileSync(join(ROOT, '.github/workflows/stage-engine-release.yml'), 'utf8');
const LIVE_TABLE = readFileSync(
  join(ROOT, 'tests/e2e/production-live-table-realtime.spec.ts'),
  'utf8'
);
const GLOBAL_SETUP = readFileSync(join(ROOT, 'tests/e2e/global-setup.ts'), 'utf8');
const CHECKER = join(ROOT, 'scripts/ci/assert-e2e-actually-ran.mjs');

/**
 * ONE WORKFLOW STEP, bounded by the next step at the same indent.
 *
 * tests/helpers/sourceWindow.ts is the right idea in the wrong language: its
 * extractors match braces and parens, and YAML has neither. So the structure
 * here is the step list itself. A byte count would drift the moment a comment
 * is added inside a step, which is exactly the outage
 * noFixedSizeSourceWindows.test.ts exists to prevent - and this file was caught
 * by that test, correctly, on its first full-suite run.
 */
function step(workflow: string, name: string): string {
  const at = workflow.indexOf(`- name: ${name}`);
  if (at < 0) throw new Error(`step: "${name}" not found in the workflow`);
  const lineStart = workflow.lastIndexOf('\n', at) + 1;
  const indent = workflow.slice(lineStart, at);
  const next = workflow.indexOf(`\n${indent}- name: `, at + 1);
  return next < 0 ? workflow.slice(at) : workflow.slice(at, next);
}

/** Run the checker over throwaway reports and return its exit code. */
function check(reports: unknown[]): number {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-honesty-'));
  const paths = reports.map((r, i) => {
    const p = join(dir, `r${i}.json`);
    writeFileSync(p, JSON.stringify(r));
    return p;
  });
  try {
    execFileSync(process.execPath, [CHECKER, ...paths], { stdio: 'pipe' });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

const spec = (file: string, statuses: (string | null)[]) => ({
  suites: [
    {
      title: file,
      file,
      specs: statuses.map((s, i) => ({
        title: `t${i}`,
        file,
        tests: [{ results: [{ status: s ?? 'skipped' }] }],
      })),
    },
  ],
});

describe('the checker refuses a run that verified nothing', () => {
  it('fails when every test in a spec file skipped', () => {
    expect(check([spec('tests/e2e/a.spec.ts', [null, null])])).toBe(1);
  });

  it('passes when the file executed at least one test', () => {
    expect(check([spec('tests/e2e/a.spec.ts', ['passed', null])])).toBe(0);
  });

  it('still fails when only ONE of several files went silent', () => {
    // The failure mode a pass-rate percentage hides: eleven healthy files can
    // carry an entire money surface that verified nothing.
    expect(
      check([
        spec('tests/e2e/a.spec.ts', ['passed']),
        spec('tests/e2e/production-cashier.spec.ts', [null, null]),
      ])
    ).toBe(1);
  });

  it('treats a MISSING report as "it did not run", never as "nothing to check"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-honesty-'));
    let code = 0;
    try {
      execFileSync(process.execPath, [CHECKER, join(dir, 'never-written.json')], { stdio: 'pipe' });
    } catch (err) {
      code = (err as { status?: number }).status ?? -1;
    }
    expect(code).toBe(1);
  });

  it('fails an empty report rather than calling zero specs a success', () => {
    expect(check([{ suites: [] }])).toBe(1);
  });

  it('counts a failed test as executed - a red run is honest, just red', () => {
    expect(check([spec('tests/e2e/a.spec.ts', ['failed'])])).toBe(0);
  });

  it('rejects a stated notRunReason even alongside a real report', () => {
    // The workflow writes this when it decides not to invoke Playwright for a
    // path at all, because the file does not exist at the deployed commit.
    expect(
      check([
        { notRunReason: 'absent at the deployed commit' },
        spec('tests/e2e/a.spec.ts', ['passed']),
      ])
    ).toBe(1);
  });

  it('refuses a run in which EVERY invocation was declined', () => {
    // Reasons are not a verdict. If nothing was invoked, nothing was verified.
    expect(check([{ notRunReason: 'absent' }, { notRunReason: 'absent' }])).toBe(1);
  });
});

describe('the allowlist is a ratchet, not an escape hatch', () => {
  const allowlist = JSON.parse(
    readFileSync(join(ROOT, 'scripts/ci/e2e-may-skip-entirely.json'), 'utf8')
  ) as { allowed: { file: string; reason: string }[] };

  it('every exemption carries a reason that says what is missing', () => {
    for (const entry of allowlist.allowed) {
      expect(entry.file, 'an exemption without a file').toBeTruthy();
      expect(
        (entry.reason ?? '').length,
        `${entry.file} is exempt with no reason - say WHAT is missing`
      ).toBeGreaterThan(20);
    }
  });

  it('spells paths the way the JSON report does, or the exemption is a no-op', () => {
    // Playwright reports `file` relative to testDir. An entry written from the
    // repo root matches nothing, exempts nothing, and looks exactly like an
    // exemption that works - the quietest possible way for this ratchet to
    // stop holding. Verified against a real report, not assumed.
    for (const entry of allowlist.allowed) {
      expect(entry.file, `${entry.file} must be relative to tests/e2e`).not.toMatch(/^tests\//);
      expect(entry.file).toMatch(/\.spec\.ts$/);
    }
  });

  it('holds the number of specs allowed to verify nothing at or below its ceiling', () => {
    // Lower this when a spec is made to run. Never raise it to make a run green.
    expect(allowlist.allowed.length).toBeLessThanOrEqual(6);
  });
});

describe('the workflow cannot go back to reporting success dishonestly', () => {
  it('runs the honesty check, and runs it even when the suite went red', () => {
    expect(WORKFLOW).toContain('assert-e2e-actually-ran.mjs');
    expect(step(WORKFLOW, 'Did the suite actually verify production?')).toContain('if: always()');
  });

  it('preserves the production report when GitHub cancels at the job timeout', () => {
    const upload = step(WORKFLOW, 'Upload the report when something is wrong on production');
    expect(upload).toContain('if: always()');
    expect(upload).toContain('failure() || cancelled()');
  });

  it('cannot pass after production changes or loses exact provenance during the suite', () => {
    const cleanupAt = WORKFLOW.indexOf('- name: Hard-delete the isolated production E2E account');
    const proofAt = WORKFLOW.indexOf(
      '- name: Prove production stayed on one exact release during certification'
    );
    const uploadAt = WORKFLOW.indexOf(
      '- name: Upload the report when something is wrong on production'
    );
    const proof = step(
      WORKFLOW,
      'Prove production stayed on one exact release during certification'
    );

    expect(cleanupAt).toBeGreaterThan(-1);
    expect(proofAt).toBeGreaterThan(cleanupAt);
    expect(uploadAt).toBeGreaterThan(proofAt);
    expect(proof).toContain("if: always() && steps.live.outputs.ready == 'true'");
    expect(proof).toContain('EXPECTED_LIVE_SHA: ${{ steps.live.outputs.sha }}');
    expect(proof).toContain('production-e2e-provenance.mjs unchanged "$EXPECTED_LIVE_SHA"');
    expect(proof).not.toContain('for i in');
    expect(proof).not.toContain('sleep ');
  });

  it('emits the JSON the honesty check reads, from every playwright invocation', () => {
    for (const report of [
      'cashier.json',
      'stats.json',
      'live-table-realtime.json',
      'club-members.json',
      'daily-missions.json',
      'daily-missions-accessibility.json',
      'daily-missions-settlement.json',
      'sweep.json',
    ]) {
      expect(WORKFLOW, `no PLAYWRIGHT_JSON_OUTPUT_NAME for ${report}`).toContain(
        `e2e-report/${report}`
      );
    }
    expect(WORKFLOW).toContain('--reporter=line,json');
    expect(WORKFLOW).toContain('--output="test-results/$output_dir"');
    expect(WORKFLOW, 'a line-only reporter leaves the honesty check nothing to read').not.toMatch(
      /--reporter=line\s+--retries/
    );
  });

  it('refuses a green verdict when the Daily Missions accessibility suite only skipped', () => {
    const honesty = step(WORKFLOW, 'Did the suite actually verify production?');
    expect(honesty).toContain('e2e-report/daily-missions-accessibility.json');

    const sweep = step(WORKFLOW, 'Run the specs that need a deployed page');
    expect(sweep).toContain('daily missions accessibility exit=$daily_missions_accessibility_rc');
  });

  it('runs live-table continuity as real mobile WebKit with exact engine provenance', async () => {
    const sweep = step(WORKFLOW, 'Run the specs that need a deployed page');
    const honesty = step(WORKFLOW, 'Did the suite actually verify production?');
    const engine = step(WORKFLOW, 'Resolve the exact protected-main engine component');

    expect(sweep).toContain('tests/e2e/production-live-table-realtime.spec.ts');
    expect(sweep).toContain('--project=webkit-live-table-realtime');
    expect(sweep).toContain("LIVE_TABLE_REALTIME_CERTIFICATION: '1'");
    expect(sweep).toContain('EXPECTED_ENGINE_SHA: ${{ steps.engine.outputs.sha }}');
    expect(sweep).toContain('live table realtime exit=$live_table_realtime_rc');
    expect(honesty).toContain('e2e-report/live-table-realtime.json');
    const classifierPath = join(ROOT, 'scripts/ci/classify-engine-release.mjs');
    const classifier = (await import(classifierPath)) as { runtimePathspecs: readonly string[] };
    expect(classifier.runtimePathspecs).toEqual([
      'server/**',
      ':(exclude)server/**/*.test.ts',
      ':(exclude)server/sim/**',
    ]);
    for (const pathspec of classifier.runtimePathspecs) {
      expect(engine).toContain(`'${pathspec}'`);
    }
    expect(ENGINE_STAGE).toContain('node scripts/ci/classify-engine-release.mjs');
    expect(engine).toContain('git log "$MAIN_SHA" -1 --format=%H');
    expect(engine).toContain('ENGINE_SHA="$ENGINE_TRIGGER_SHA"');
    expect(engine).toContain('git cat-file -e "$ENGINE_SHA^{commit}"');
    expect(engine).toContain('git merge-base --is-ancestor "$ENGINE_SHA" "$MAIN_SHA"');
    expect(LIVE_TABLE).toContain('releaseSha: string | null;');
    expect(LIVE_TABLE).toContain('observedReleaseSha');
    expect(LIVE_TABLE).toContain('toMatch(/^[0-9a-f]{40}$/)');
    expect(LIVE_TABLE).toContain('toBe(EXPECTED_ENGINE_SHA)');
    expect(LIVE_TABLE).not.toContain('engineVersionMatchesExpected');
    expect(LIVE_TABLE).not.toContain('EXPECTED_ENGINE_SHA.startsWith');
  });

  it('accepts an engine certification trigger only with one exact protected-main SHA', () => {
    const gate = step(WORKFLOW, 'Read The Origin Job Verdict');
    expect(WORKFLOW).toContain(
      'run-name: Post-Deploy E2E ${{ github.event.client_payload.engine_sha || github.sha }}'
    );
    expect(gate).toContain('if [ "$EVENT_NAME" = repository_dispatch ]');
    expect(gate).toMatch(/\[\[ "\$ENGINE_TRIGGER_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
    expect(gate).toContain('engine_trigger_sha=$ENGINE_TRIGGER_SHA');
  });

  it('refuses a green verdict when the Daily Missions database settlement suite only skipped', () => {
    const honesty = step(WORKFLOW, 'Did the suite actually verify production?');
    expect(honesty).toContain('e2e-report/daily-missions-settlement.json');

    const sweep = step(WORKFLOW, 'Run the specs that need a deployed page');
    expect(sweep).toContain('tests/e2e/daily-missions-database-settlement.spec.ts');
    expect(sweep).toContain('daily missions settlement exit=$daily_missions_settlement_rc');
  });

  it('demands a real session, so a signed-out fallback cannot pass as a verdict', () => {
    expect(WORKFLOW).toContain("E2E_REQUIRE_AUTH: '1'");
    expect(GLOBAL_SETUP).toContain("process.env.E2E_REQUIRE_AUTH === '1'");
    expect(
      GLOBAL_SETUP.slice(
        GLOBAL_SETUP.indexOf('function signedOut'),
        GLOBAL_SETUP.indexOf('export default')
      ),
      'signedOut() must THROW under E2E_REQUIRE_AUTH, not merely log'
    ).toMatch(/E2E_REQUIRE_AUTH === '1'[\s\S]{0,200}throw new Error/);
  });

  it('does not let the spec swap silently restore the signed-out fallback', () => {
    // Taking tests/e2e wholesale from the deployed commit would also take
    // global-setup.ts back to before E2E_REQUIRE_AUTH existed - disabling the
    // fix on precisely the runs it was written for.
    const align = step(WORKFLOW, 'Take the specs from the commit production is actually serving');
    expect(align).toContain('tests/e2e/global-setup.ts');
    expect(align).toContain('tests/e2e/production-live-table-realtime.spec.ts');
    expect(align).toContain('tests/e2e/support');
  });

  it('annotates the run when a supplied credential silently did not work', () => {
    // ci.yml's scheduled Live Production E2E tolerates MISSING secrets on
    // purpose. It must not tolerate a BROKEN one in silence: that is 47 route
    // specs skipping inside a green job.
    const fn = GLOBAL_SETUP.slice(
      GLOBAL_SETUP.indexOf('function signedOut'),
      GLOBAL_SETUP.indexOf('export default')
    );
    expect(fn).toContain('process.env.SP_EMAIL && process.env.SP_PASS');
    expect(fn).toContain('::error title=');
  });

  it('never lets one red step hide the rest of the production sweep', () => {
    const sweep = step(WORKFLOW, 'Run the specs that need a deployed page');
    expect(sweep, 'a failed Cashier step used to skip this one entirely').toContain(
      "if: always() && steps.live.outputs.ready == 'true'"
    );
    expect(
      sweep,
      'without set +e a red Stats invocation aborts the route invocation behind it'
    ).toContain('set +e');
    expect(sweep).toContain('sweep_rc=$?');
  });

  it('keeps the specs and the deployed bundle on the same commit', () => {
    // Runs 33394046555 and 33394398578 failed on an element that existed on
    // main and was simply not deployed yet. Nothing was broken.
    expect(WORKFLOW).toContain('Take the specs from the commit production is actually serving');
    expect(WORKFLOW).toContain('production-e2e-provenance.mjs lineage "$LIVE" "$HERE"');
    expect(WORKFLOW).not.toContain('::warning::deployed sha');
    expect(WORKFLOW, 'the ancestor check needs history the shallow clone lacks').toContain(
      'fetch-depth: 0'
    );
  });
});
