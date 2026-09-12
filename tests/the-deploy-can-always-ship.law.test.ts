import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const triggerBlock = (yaml: string) =>
  yaml.slice(yaml.indexOf('\non:'), yaml.indexOf('\nconcurrency:'));
const uncommented = (source: string) =>
  source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const engine = read('.github/workflows/auto-deploy-hetzner.yml');
const engineCode = uncommented(engine);
const transaction = read('server/scripts/engine-release-transaction.sh');
const transactionCode = uncommented(transaction);
const engineSignal = read('.github/workflows/stage-engine-release.yml');
const engineSignalCode = uncommented(engineSignal);
const publisher = read('.github/workflows/publish-club-arena.yml');
const audit = read('.github/workflows/production-integrity-audit.yml');
const starvation = read('.github/scripts/check-engine-deploy-starvation.mjs');

describe('the engine deploy has one fail-closed Hetzner authority', () => {
  it('accepts only the default-branch exact-SHA repository event', () => {
    const triggers = triggerBlock(engine);
    expect(triggers).toMatch(/^\s{2}repository_dispatch:/m);
    expect(triggers).toContain('types: [deploy-club-arena-engine]');
    expect(triggers).not.toMatch(/^\s{2}schedule:/m);
    expect(triggers).not.toMatch(/^\s{2}workflow_dispatch:/m);
    expect(triggers).not.toMatch(/^\s{2}push:/m);
  });

  it('requires a lowercase full ref_sha for every repository dispatch', () => {
    expect(engineCode).toContain("REQUESTED_SHA: ${{ github.event.client_payload.ref_sha || '' }}");
    expect(engineCode).toMatch(/\[\[ "\$REQUESTED_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
    expect(engineCode).toContain('client_payload.ref_sha must be one full lowercase commit SHA');
    expect(engineCode).toContain('ref: ${{ github.event.client_payload.ref_sha }}');
    expect(engineCode).toContain('git log "$MAIN_SHA" -1 --format=%H');
    expect(engineCode).toContain('[ "$RESOLVED_SHA" = "$LATEST_REQUIRED" ]');
    expect(transactionCode).toContain('[ "$latest" = "$SHA" ]');
    expect(transactionCode).toContain('target $SHA is stale; protected main requires $latest');
  });

  it('immediately sends every protected-main server SHA into the owning release lane', () => {
    const triggers = engineSignal.slice(
      engineSignal.indexOf('\non:'),
      engineSignal.indexOf('\npermissions:')
    );
    expect(triggers).toMatch(/^\s{2}push:$/m);
    expect(triggers).toContain('branches: [main]');
    expect(triggers).not.toMatch(/^\s+paths(?:-ignore)?:/m);
    expect(triggers).not.toMatch(
      /^\s{2}(?:schedule|workflow_dispatch|repository_dispatch|pull_request|pull_request_target|workflow_run):/m
    );
    expect(engineSignal).toMatch(/^permissions:\s*\{\}\s*$/m);
    expect(engineSignal).toMatch(/^\s{2}detect:\s*$/m);
    expect(engineSignal).toContain('fetch-depth: 0');
    expect(engineSignalCode).toContain('BEFORE_SHA: ${{ github.event.before }}');
    expect(engineSignalCode).toContain('git diff --quiet "$BEFORE_SHA" "$AFTER_SHA" --');
    expect(engineSignalCode).toContain('RELEASE_REQUIRED=true');
    expect(engineSignalCode).toContain('Previous commit is missing or unreadable; failing closed');
    expect(engineSignal).toContain("if: needs.detect.outputs.release_required == 'true'");
    expect(engineSignal).toMatch(/^\s{6}contents:\s*write\s*$/m);
    expect(engineSignalCode).toContain('GH_TOKEN: ${{ github.token }}');
    expect(engineSignalCode).toContain('REF_SHA: ${{ needs.detect.outputs.target_sha }}');
    expect(engineSignalCode).toMatch(/\[\[ "\$REF_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
    expect(engineSignalCode).toContain('-f event_type=deploy-club-arena-engine');
    expect(engineSignalCode).toContain('-F "client_payload[ref_sha]=$REF_SHA"');
    const signalJob = engineSignalCode.slice(engineSignalCode.indexOf('\n  signal:'));
    expect(signalJob).not.toMatch(
      /secrets\.|create-github-app-token|\bgit\s|\bssh\b|\brsync\b|actions\/checkout|\.env|\|\|\s*true/
    );
  });

  it('proves checkout identity and protected-main ancestry before touching the host', () => {
    expect(engineCode).toContain('[ "$RESOLVED_SHA" = "$REQUESTED_SHA" ]');
    expect(engineCode).toContain(
      "git fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main'"
    );
    expect(engineCode).toContain('git merge-base --is-ancestor "$RESOLVED_SHA" "$MAIN_SHA"');
    const hostTouch = engineCode.indexOf('name: Establish pinned ephemeral SSH transport');
    expect(hostTouch).toBeGreaterThan(engineCode.indexOf('[ "$LATEST_REQUIRED" = "$SHA" ]'));
  });

  it('has no force path around the maintenance certificate', () => {
    expect(engineCode).not.toMatch(/github\.event\.inputs/);
    expect(engineCode).not.toMatch(/force=true|inputs\.force/);
    const gate = transaction.slice(
      transaction.indexOf('maintenance_certificate()'),
      transaction.indexOf('validate_candidate_image()')
    );
    expect(gate).toContain('readyForRestart');
    expect(gate).toContain('durableConfirmed');
    expect(gate).toContain('unparkedTables');
    expect(gate).toContain('MIN_BREAK_MS');
    expect(gate).not.toContain('skip=true');
    expect(transaction).toContain(
      "die 'the engine did not present a restart certificate with enough proof time remaining'"
    );
    expect(gate).not.toMatch(/skipping the break gate/i);
  });

  it('makes every no-cutover result explicit', () => {
    expect(engine).toContain('case "$RESULT" in sealed|already-released)');
    expect(engine).toContain('[ "$UNIT_RESULT" = success ] && [ "$RESULT_SHA" = "$SHA" ]');
    expect(engine).toContain("steps.release.outputs.result || 'not completed'");
    expect(engine).toContain("steps.verify.outputs.verified || 'false'");
    expect(engine).toContain("STRICT_RECEIPT: '1'");
  });
});

describe('the static publisher is event-driven and independent', () => {
  it('has no timer, workflow dispatch, or self-retry chain', () => {
    const triggers = triggerBlock(publisher);
    const code = uncommented(publisher);
    expect(triggers).toMatch(/^\s{2}push:/m);
    expect(triggers).toMatch(/^\s{2}repository_dispatch:/m);
    expect(triggers).not.toMatch(/^\s{2}schedule:/m);
    expect(triggers).not.toMatch(/^\s{2}workflow_dispatch:/m);
    expect(code).not.toMatch(/Converge - chain another publish/);
    expect(code).not.toMatch(/repos\/\$\{\{ github\.repository \}\}\/dispatches/);
  });

  it('does not wait on or share a concurrency group with the engine deploy', () => {
    const publishGroup = publisher.match(/^concurrency:\n\s*group:\s*(.+)$/m)?.[1]?.trim();
    const engineGroup = engine.match(/^concurrency:\n\s*group:\s*(.+)$/m)?.[1]?.trim();
    expect(publishGroup).toBeTruthy();
    expect(engineGroup).toBeTruthy();
    expect(publishGroup).not.toBe(engineGroup);
    expect(uncommented(publisher)).not.toMatch(/needs:.*hetzner/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A PROOF THAT ONLY SUCCEEDS WHEN NOTHING IS MERGING IS NOT A GATE (2026-09-12)
//
// `source_target_is_current` required the release target to be the TIP of
// server/** on protected main, and re-required it after the image build and
// every sixty seconds of the wait for the break. Any engine merge inside that
// window killed the release. Releases take 10-60 minutes (they wait for the
// hourly break); engine merges arrived every 13-22 minutes. So each release
// was killed by its own successor and the successor by ITS successor:
// 14 consecutive releases shipped nothing between 00:21Z and 04:46Z on
// 2026-09-12, every one recorded as "release ended without complete production
// proof" while the engine was healthy throughout. Run 34673869399 is the whole
// mechanism in one line - it finished its image build and died on
// "target 240b3394b... is stale; protected main requires 96c00643d...", a
// commit that had merged thirteen minutes after it started.
//
// Standing down is still right while the newer commit can actually reach the
// break. It cannot from inside the break window, so standing down there gives
// the break to nobody. These pins are the difference between those two cases.
// ───────────────────────────────────────────────────────────────────────────
describe('supersession defers a release, it does not starve one', () => {
  const gate = transactionCode.slice(
    transactionCode.indexOf('source_target_is_current() {'),
    transactionCode.indexOf('parse_health_instance_for_sha()')
  );

  it('still stands a superseded target down outside the break window', () => {
    // Unchanged behaviour and unchanged words for the common case. The design
    // notes this serves - an obsolete candidate must not wait for or consume
    // the next table break, and must free its workflow and host resources
    // promptly - are still satisfied whenever a successor can get there.
    expect(gate).toContain('die "target $SHA is stale; protected main requires $latest"');
    expect(gate).toMatch(/BREAK_END_EPOCH:-0\} +" *-le 0|BREAK_END_EPOCH:-0\}" -le 0/);
    expect(gate).toContain('"$(seconds_to_next_break)" -gt "$SUPERSESSION_YIELD_SECONDS"');
  });

  it('the yield window is shorter than one break period and longer than a build', () => {
    const yieldS = Number(transaction.match(/^SUPERSESSION_YIELD_SECONDS=(\d+)$/m)![1]);
    // Measured 2026-09-12 on run 34673869399: 800s from run creation to
    // cutover-ready, plus 60-180s for stage-engine-release to detect the push
    // and dispatch it. Below that arrival time, a commit merging now provably
    // cannot reach this break.
    expect(yieldS).toBeGreaterThanOrEqual(600);
    // Above one break period it would span two breaks and never stand anything
    // down, which is the opposite bug.
    expect(yieldS).toBeLessThan(3600);
  });

  it('refuses the escape unless forward-only ordering is proved, not assumed', () => {
    // The tip check was carrying this property incidentally. Now that the tip
    // check is not absolute, the property is stated and proved in its own
    // right, and the escape FAILS CLOSED when it cannot be proved.
    expect(gate).toContain('"$RELEASE_SEAL" get high-water-sha');
    expect(gate).toContain('git -C "$REPO_DIR" merge-base --is-ancestor "$high_water" "$SHA"');
    expect(gate).toContain(
      'die "target $SHA is superseded by $latest and the sealed high-water release is unreadable"'
    );
    expect(gate).toContain(
      'die "target $SHA is superseded by $latest and does not contain the sealed high-water release $high_water"'
    );
  });

  it('leaves every other release proof exactly where it was', () => {
    // The escape must never become "ship it anyway". Protected-main
    // containment, the maintenance certificate and the cutover proofs are
    // untouched, and there is still no force input anywhere.
    expect(gate).toContain('die "target $SHA is no longer contained in protected main"');
    expect(transactionCode).toContain('prove_rollback_readiness');
    expect(transactionCode).toContain('validate_candidate_image');
    expect(engineCode).not.toMatch(/force=true|inputs\.force/);
  });

  it('records every override where it can be counted afterwards', () => {
    // An override nobody can count becomes the normal path without anyone
    // deciding that it should.
    expect(gate).toContain('echo "ENGINE_RELEASE_SUPERSEDED_BY=$latest"');
    expect(transactionCode).toContain(
      'SEAL_REASON="$SEAL_REASON; shipped inside the break window while superseded by $SUPERSEDED_BY"'
    );
    expect(transactionCode).toContain('--reason "$SEAL_REASON"');
  });
});

describe('a run that ships nothing says so, and says which half failed', () => {
  it('does not record a stand-down as a failed production proof', () => {
    // One sentence used to cover every non-shipping path, and it named the
    // production proof - the half that had not even run. Step 7 (the durable
    // intake) is where all fourteen died; `verify` never executed.
    expect(engineCode).toContain('classify_release_failure');
    expect(engineCode).toContain('echo "result=superseded" >> "$GITHUB_OUTPUT"');
    expect(engineCode).toContain('echo "superseded_by=$stale" >> "$GITHUB_OUTPUT"');
    expect(engineCode).toContain("needs.deploy.outputs.release_result == 'superseded'");
    expect(engineCode).toContain("needs.deploy.outputs.release_result == 'not completed'");
    expect(engineCode).toContain(
      'the release sealed but production identity could not be independently proved'
    );
  });

  it('annotates NOT DEPLOYED on every non-shipping path', () => {
    expect(engine).toContain('name: Say plainly when nothing shipped');
    expect(engineCode).toContain('::warning title=NOT DEPLOYED::');
    const step = engine.slice(engine.indexOf('name: Say plainly when nothing shipped'));
    expect(step).toMatch(/if: always\(\)/);
    expect(step).toContain('SHIPPED: ${{ needs.deploy.outputs.shipped }}');
  });
});

describe('the starvation alarm exists and has a reader', () => {
  it('is wired into the hourly production audit, not a cron of its own', () => {
    // CLAUDE.md 10.85 (never the Claude scheduler) and the estate cron
    // governance: no net-new schedule: trigger. It hangs off the hourly audit
    // that already asks the engine question, on GitHub's pool, so it never
    // shares a failure domain with the box it is watching.
    expect(audit).toContain('node .github/scripts/check-engine-deploy-starvation.mjs');
    // No net-new cron: it rides the one hourly schedule this workflow already has.
    expect(audit.match(/^\s*schedule:$/gm)?.length).toBe(1);

    const starvationJob = audit.slice(
      audit.indexOf('\n  engine_deploy_starvation:'),
      audit.indexOf('\n  chip_conservation:')
    );
    expect(starvationJob).toContain('runs-on: ubuntu-latest');
    expect(starvationJob).toContain('name: The engine pipeline is not starving');
    expect(starvationJob).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    // Read-only, like every other database reader in this workflow.
    expect(starvationJob).toMatch(/^\s{6}contents:\s*read\s*$/m);
    expect(starvationJob).not.toMatch(/^\s{6}(?:issues|actions|contents):\s*write\s*$/m);

    // It is a SIBLING of `engine:`, never a step inside it. `engine:` is the
    // credential-free provenance observer and
    // tests/engine-watchdog-asks-production.test.ts refuses any GH_TOKEN or
    // DATABASE_URL there. Putting the ledger reader in that job is what broke
    // CI on the first cut of this change.
    const engineJob = audit.slice(audit.indexOf('\n  engine:'), audit.indexOf('\n  live_drift:'));
    expect(engineJob).toContain('runs-on: ubuntu-latest');
    expect(engineJob).not.toMatch(/GH_TOKEN|DATABASE_URL/);
  });

  it('fires on both a count and a span, and can say it does not know', () => {
    // Attempts alone pages on a normal merge burst; time alone pages on a
    // quiet weekend. Only both together mean "production is refusing commits".
    expect(starvation).toMatch(/export const ATTEMPTS_THRESHOLD = \d+;/);
    expect(starvation).toMatch(/export const SPAN_MINUTES_THRESHOLD = \d+;/);
    expect(starvation).toContain(
      'attempts >= ATTEMPTS_THRESHOLD && spanMinutes >= SPAN_MINUTES_THRESHOLD'
    );
    expect(starvation).toContain('::warning title=ENGINE DEPLOY STARVATION UNKNOWN::');
    expect(starvation).toContain('::error title=ENGINE DEPLOY STARVATION::');
    // Read-only. It has no authority to fix what it finds.
    expect(starvation).not.toMatch(/dispatches|workflow_dispatch|rerun|INSERT |UPDATE |DELETE /);
  });

  it('keeps the measurement next to the threshold it justifies', () => {
    // CLAUDE.md 10.84: derive a threshold, do not guess one, and write the
    // measurement beside it.
    expect(starvation).toContain('2026-09-01 14:58Z to 2026-09-12 05:00Z');
    expect(starvation).toContain('94 episodes');
    expect(starvation).toContain('30 attempts / 739.4 minutes');
  });
});
