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
    expect(engineSignalCode).toContain(
      'node scripts/ci/classify-engine-release.mjs | tee -a "$GITHUB_OUTPUT"'
    );
    expect(engineSignalCode).not.toContain('git diff --quiet');
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
