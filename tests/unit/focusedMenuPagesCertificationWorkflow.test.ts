import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const WORKFLOW = readFileSync(
  resolve(ROOT, '.github/workflows/certify-club-arena-menu-pages.yml'),
  'utf8'
);

const EXPECTED_SPECS = [
  'tests/e2e/gameplay-customization-runtime.spec.ts',
  'tests/e2e/production-customization-realtime.spec.ts',
  'tests/e2e/production-table-management.spec.ts',
  'tests/e2e/routes/leaderboard-console.spec.ts',
].sort();

const REPORTS = [
  'table-management.json',
  'customization-realtime.json',
  'gameplay-customization-runtime.json',
  'leaderboard-console.json',
];

function step(name: string): string {
  const at = WORKFLOW.indexOf(`- name: ${name}`);
  if (at < 0) throw new Error(`workflow step not found: ${name}`);
  const lineStart = WORKFLOW.lastIndexOf('\n', at) + 1;
  const indent = WORKFLOW.slice(lineStart, at);
  const next = WORKFLOW.indexOf(`\n${indent}- name: `, at + 1);
  return next < 0 ? WORKFLOW.slice(at) : WORKFLOW.slice(at, next);
}

describe('focused Club Arena menu and pages correction certification', () => {
  it('uses one trusted default-branch dispatch and keeps the secret job behind main and Production', () => {
    const triggers = WORKFLOW.slice(WORKFLOW.indexOf('\non:'), WORKFLOW.indexOf('\npermissions:'));
    expect(triggers).toMatch(/^ {2}repository_dispatch:/m);
    expect(triggers).toContain('types: [certify-club-arena-menu-pages]');
    expect(triggers).not.toMatch(
      /^ {2}(?:workflow_dispatch|push|pull_request|schedule|workflow_run):/m
    );
    expect(WORKFLOW).toContain('${{ github.event.client_payload.required_sha }}');

    expect(step('Require refs/heads/main')).toContain(
      `if [ "$GITHUB_REF" != 'refs/heads/main' ]; then`
    );
    expect(WORKFLOW).toContain('needs: trusted-ref');
    expect(WORKFLOW).toContain("if: github.ref == 'refs/heads/main'");
    expect(WORKFLOW).toContain('environment: Production');
    expect(WORKFLOW).toContain('ref: main');
    expect(WORKFLOW).toContain('persist-credentials: false');
    expect(WORKFLOW).toContain('actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683');
    expect(WORKFLOW).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020');
    expect(WORKFLOW).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    expect(WORKFLOW).not.toMatch(/uses: actions\/(?:checkout|setup-node|upload-artifact)@v\d+/);
  });

  it('owns a unique non-cancelling lock separate from ordinary post-deploy E2E', () => {
    expect(WORKFLOW).toContain('group: club-arena-menu-pages-production-certification');
    expect(WORKFLOW).toContain('cancel-in-progress: false');
    expect(WORKFLOW).not.toContain('group: post-deploy-e2e-production');
  });

  it('runs exactly the four unresolved or changed correction specs', () => {
    const actual = Array.from(
      new Set(WORKFLOW.match(/tests\/e2e\/(?:routes\/)?[a-z0-9-]+\.spec\.ts/g) ?? [])
    ).sort();
    expect(actual).toEqual(EXPECTED_SPECS);

    for (const excluded of [
      'production-cashier.spec.ts',
      'production-cashier-statements.spec.ts',
      'club-lobby.spec.ts',
      'production-club-members.spec.ts',
      'production-customization-commerce.spec.ts',
      'hamburger-menu.spec.ts',
      'club-operations-exhaustive.spec.ts',
      'phase7-doors.spec.ts',
      'mobile-fit-audit.spec.ts',
      'stats-deep.spec.ts',
      'production-daily-missions.spec.ts',
      'production-live-table-realtime.spec.ts',
    ]) {
      expect(WORKFLOW).not.toContain(excluded);
    }
    expect(WORKFLOW).not.toContain('certify-cashier-contract.mjs');
    expect(WORKFLOW).not.toContain('SUPABASE_DB_PASSWORD');
    expect(WORKFLOW).not.toContain('--grep');
  });

  it('pins current protected-main HEAD to both correction floors and never fetches later', () => {
    const validation = step('Validate the requested protected-main revision');
    expect(validation).toContain('f06da04591561e62493a96984de759995817ffe5');
    expect(validation).toContain('646d37fb6bc2d232fd61c01b0bb389708092a2a9');
    expect(validation).toContain('HEAD_SHA=$(git rev-parse HEAD)');
    expect(validation).toContain('[ "$REQUIRED_SHA" = "$HEAD_SHA" ]');
    expect(WORKFLOW).not.toContain('git fetch');
    expect(WORKFLOW).not.toContain('git checkout');

    const selector = step('Select the exact live protected-main revision');
    expect(selector).toContain('https://ca-static.smarter.poker/build-info.json');
    expect(selector).toContain('https://smarter.poker/hub/club-arena/build-info.json');
    expect(selector).toContain('[ "$ORIGIN_SHA" = "$REQUIRED_SHA" ]');
    expect(selector).toContain('[ "$PUBLIC_SHA" = "$REQUIRED_SHA" ]');
    expect(selector).toContain('for attempt in $(seq 1 6); do');
    expect(selector).toContain('--max-time 10');
    expect(selector).toContain('sleep 10');
    expect(WORKFLOW.indexOf('- name: Install dependencies')).toBeGreaterThan(
      WORKFLOW.indexOf('- name: Select the exact live protected-main revision')
    );

    expect(WORKFLOW).toContain('production run 37381227013');
    expect(WORKFLOW).toContain('artifact 11379125260');
    expect(WORKFLOW).toContain('b6ae474fb086bdc7768dfb69efa10cf7dfa71bb7');
  });

  it('admits browsers only with cleanup headroom and scrubs fixture credentials', () => {
    expect(WORKFLOW).toContain('timeout-minutes: 180');
    expect(step('Start the cleanup-reserve clock')).toContain(
      'CERTIFICATE_JOB_STARTED_AT=$(date +%s)'
    );
    const browsers = step('Run the exact four-spec correction certificate');
    expect(browsers).toContain('local job_deadline=$((CERTIFICATE_JOB_STARTED_AT + 10800))');
    expect(browsers).toContain('local cleanup_reserve_seconds=3600');
    expect(browsers).toContain('require_suite_budget "$spec" "$suite_budget_seconds"');
    expect(browsers).toContain('budget_refused=1');
    expect(browsers).toContain('an earlier suite exhausted the cleanup-safe admission window');
    expect(browsers).not.toContain('timeout --signal=TERM');
    expect(browsers).toContain('tests/e2e/production-customization-realtime.spec.ts 1800');
    expect(browsers).toContain('tests/e2e/gameplay-customization-runtime.spec.ts 1800');
    expect(browsers).toContain('tests/e2e/production-table-management.spec.ts 1200');
    expect(browsers).toContain('tests/e2e/routes/leaderboard-console.spec.ts 600');

    expect(WORKFLOW).toContain('production-e2e-account.mjs create');
    expect(WORKFLOW).toContain('production-e2e-account.mjs prepare-staff');
    expect(WORKFLOW).toContain('production-e2e-account.mjs prepare-template-staff');
    expect(step('Hard-delete the isolated production E2E account')).toContain('if: always()');
    expect(step('Hard-delete the isolated production E2E account')).not.toContain(
      'steps.live.outputs.ready'
    );
    const scrub = step('Remove fixture credentials from later action environments');
    expect(scrub).toContain('if: always()');
    expect(scrub).toContain("echo 'SP_EMAIL='");
    expect(scrub).toContain("echo 'SP_PASS='");
    expect(scrub).toContain("echo 'E2E_TEST_ACCOUNT_FILE='");
    expect(WORKFLOW).toContain("E2E_REQUIRE_AUTH: '1'");
    expect(WORKFLOW).not.toMatch(/--retries=(?!0\b)\d+/);

    const counts = step('Require exact correction case counts');
    expect(counts).toContain(
      'e2e-report/table-management.json:production-table-management.spec.ts:10'
    );
    expect(counts).toContain(
      'e2e-report/customization-realtime.json:production-customization-realtime.spec.ts:1'
    );
    expect(counts).toContain(
      'e2e-report/gameplay-customization-runtime.json:gameplay-customization-runtime.spec.ts:1'
    );
    expect(counts).toContain(
      'e2e-report/leaderboard-console.json:routes/leaderboard-console.spec.ts:2'
    );
    expect(counts).toContain('totals.skipped === 0');
    expect(counts).toContain('totals.failed === 0');
    expect(counts).toContain('totals.flaky === 0');
    expect(counts).toContain("test.status === 'expected' && test.attempts === 1");
    expect(counts).toContain('e2e-report/exact-counts.json');

    const annotations = step('Name every failed test as an annotation');
    const honesty = step('Did every requested spec file actually verify production?');
    for (const report of REPORTS) {
      expect(annotations).toContain(`e2e-report/${report}`);
      expect(honesty).toContain(`e2e-report/${report}`);
    }
  });

  it('requires exact closing equality at both endpoints and makes every non-verdict red', () => {
    const releaseWindow = step('Require the exact release at both closing endpoints');
    expect(releaseWindow).toContain('https://ca-static.smarter.poker/build-info.json');
    expect(releaseWindow).toContain('https://smarter.poker/hub/club-arena/build-info.json');
    expect(releaseWindow).toContain('[ "$ORIGIN_SHA" != "$PUBLIC_SHA" ]');
    expect(releaseWindow).toContain('[ "$ORIGIN_SHA" != "$REQUIRED_SHA" ]');
    expect(releaseWindow).toContain('echo \'release_held=true\' >> "$GITHUB_OUTPUT"');
    expect(WORKFLOW).not.toContain('production-e2e-provenance.mjs release-window');

    const finalVerdict = step('Require a complete focused production verdict');
    expect(finalVerdict).toContain('if: always()');
    for (const requiredOutcome of [
      '${{ steps.account.outcome }}',
      '${{ steps.staff.outcome }}',
      '${{ steps.template.outcome }}',
      '${{ steps.browsers.outcome }}',
      '${{ steps.annotations.outcome }}',
      '${{ steps.honesty.outcome }}',
      '${{ steps.counts.outcome }}',
      '${{ steps.cleanup.outcome }}',
      '${{ steps.scrub.outcome }}',
      '${{ steps.compact.outcome }}',
    ]) {
      expect(finalVerdict).toContain(requiredOutcome);
    }
    expect(finalVerdict).toContain('${{ steps.release_window.outputs.release_held }}');
    expect(finalVerdict).toContain(`if [ "$outcome" != 'success' ]; then`);
    expect(finalVerdict).toContain(`if [ "$RELEASE_HELD" != 'true' ]; then`);
    expect(finalVerdict).toContain('echo \'certified=true\' >> "$GITHUB_OUTPUT"');
    expect(finalVerdict).toContain('exit 1');
    expect(WORKFLOW).toContain('certified: ${{ steps.final_verdict.outputs.certified }}');
    expect(
      WORKFLOW.indexOf('- name: Require a complete focused production verdict')
    ).toBeGreaterThan(WORKFLOW.indexOf('- name: Upload compact certification evidence'));
  });

  it('retains compact rerun-safe evidence and heavy diagnostics only on failure', () => {
    const compact = step('Upload compact certification evidence');
    expect(compact).toContain('id: compact');
    expect(compact).toContain('if: always()');
    expect(compact).toContain(
      'club-arena-menu-pages-json-${{ github.run_id }}-${{ github.run_attempt }}'
    );
    expect(compact).toContain('path: e2e-report/');
    expect(compact).toContain('retention-days: 3');

    const diagnostics = step('Upload failure diagnostics when produced');
    expect(diagnostics).toContain('failure() || cancelled()');
    expect(diagnostics).toContain(
      'club-arena-menu-pages-failure-${{ github.run_id }}-${{ github.run_attempt }}'
    );
    expect(diagnostics).toContain('test-results/');
    expect(diagnostics).toContain('retention-days: 3');
  });
});
