import { spawnSync } from 'node:child_process';
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
    expect(engineCode).toContain('[[ "$LATEST_REQUIRED" =~ ^[0-9a-f]{40}$ ]]');
    expect(transactionCode).toContain('"$RELEASE_SEAL" get high-water-sha');
    expect(transactionCode).toContain('target $SHA does not contain the sealed high-water release');
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
    expect(hostTouch).toBeGreaterThan(
      engineCode.indexOf('git merge-base --is-ancestor "$CONTROL_SHA" "$MAIN_SHA"')
    );
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

// A protected-main merge is distinct from a sealed forward release. Execute
// the real shell gates against disposable Git histories, including an advance
// of high-water between admission checks. No host or Docker process is used.
describe('forward releases remain valid when protected main advances', () => {
  const gate = transactionCode.slice(
    transactionCode.indexOf('source_target_is_current() {'),
    transactionCode.indexOf('parse_health_instance_for_sha()')
  );

  it('executes source, control, ancestry and stale-high-water cases', () => {
    const result = spawnSync(
      'python3',
      [resolve(__dirname, 'operations/engine-release-forward-admission.py')],
      { encoding: 'utf8', timeout: 120000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 125000);

  it('requires high-water ancestry for every normal target before admission', () => {
    expect(gate).toContain('"$RELEASE_SEAL" get high-water-sha');
    expect(gate).not.toContain('get desired-sha');
    expect(gate).toContain('git -C "$REPO_DIR" merge-base --is-ancestor "$high_water" "$SHA"');
    expect(gate).toContain('die "target $SHA cannot prove the sealed high-water release"');
    expect(gate).toContain(
      'die "target $SHA does not contain the sealed high-water release $high_water"'
    );
    expect(gate).not.toContain('SUPERSESSION_YIELD_SECONDS');
  });

  it('retains containment, maintenance, image and rollback proofs', () => {
    expect(gate).toContain('die "target $SHA is no longer contained in protected main"');
    expect(transactionCode).toContain('prove_rollback_readiness');
    expect(transactionCode).toContain('validate_candidate_image');
    expect(engineCode).not.toMatch(/force=true|inputs\.force/);
  });

  it('records the newer unshipped engine without claiming it was released', () => {
    expect(gate).toContain('echo "ENGINE_RELEASE_SUPERSEDED_BY=$latest"');
    expect(transactionCode).toContain(
      'SEAL_REASON="$SEAL_REASON; forward release behind protected-main engine $SUPERSEDED_BY"'
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
