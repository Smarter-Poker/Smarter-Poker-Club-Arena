/** The engine release owns one absolute clock from job entry through cleanup. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..');
const workflow = readFileSync(resolve(root, '.github/workflows/auto-deploy-hetzner.yml'), 'utf8');
const observer = readFileSync(resolve(root, 'server/scripts/observe-engine-release.sh'), 'utf8');

const between = (start: string, end: string): string => {
  const from = workflow.indexOf(start);
  const to = workflow.indexOf(end, from + start.length);
  expect(from, `missing workflow marker: ${start}`).toBeGreaterThan(-1);
  expect(to, `missing workflow marker: ${end}`).toBeGreaterThan(from);
  return workflow.slice(from, to);
};

describe('the Hetzner release has one absolute wall-clock budget', () => {
  const budget = between(
    '- name: Establish one absolute deploy-job deadline',
    '- name: Checkout the exact workflow control'
  );
  const dispatch = between(
    '- name: Dispatch the staged SHA',
    '- name: Independently prove the sealed local'
  );
  const proof = between(
    '- name: Independently prove the sealed local',
    '- name: Record append-only deployment receipt'
  );
  const receipt = between(
    '- name: Record append-only deployment receipt',
    '- name: Publish release summary'
  );
  const cleanup = workflow.slice(workflow.indexOf('- name: Remove exact staging'));

  it('starts before checkout, stops before the Actions timeout, and reserves ten minutes', () => {
    const deploy = workflow.indexOf('\n  deploy:');
    const firstStep = workflow.indexOf('\n    steps:', deploy);
    const budgetStep = workflow.indexOf(
      '- name: Establish one absolute deploy-job deadline',
      firstStep
    );
    const checkout = workflow.indexOf('- name: Checkout the exact workflow control', firstStep);
    expect(budgetStep).toBeGreaterThan(firstStep);
    expect(budgetStep).toBeLessThan(checkout);

    const jobSeconds = Number(budget.match(/DEPLOY_JOB_BUDGET_SECONDS=(\d+)/)?.[1]);
    const reserveSeconds = Number(budget.match(/POST_RELEASE_RESERVE_SECONDS=(\d+)/)?.[1]);
    expect(jobSeconds).toBeLessThanOrEqual(200 * 60);
    expect(reserveSeconds).toBeGreaterThanOrEqual(10 * 60);
    expect(budget).toContain(
      'RELEASE_DISPATCH_DEADLINE_EPOCH=$((RELEASE_JOB_DEADLINE_EPOCH - POST_RELEASE_RESERVE_SECONDS))'
    );
    expect(budget).toContain('>> "$GITHUB_ENV"');
  });

  it('makes intake, observation, and uncertain reattachment share the absolute cutoff', () => {
    const observerMaximum = Number(observer.match(/\[ "\$OBSERVE_SECONDS" -le (\d+) \]/)?.[1]);
    expect(dispatch).not.toContain('SECONDS +');
    expect(dispatch).not.toContain('remaining + 30');
    expect(dispatch.match(/RELEASE_DISPATCH_DEADLINE_EPOCH - \$\(date \+%s\)/g)).toHaveLength(3);
    expect(observerMaximum).toBeGreaterThan(0);
    expect(dispatch).toContain(`local observer_max_seconds=${observerMaximum}`);
    expect(dispatch).toContain('local observer_transport_grace_seconds=5');
    expect(dispatch).toContain('[ "$remaining" -gt $((observer_transport_grace_seconds * 2)) ]');
    expect(dispatch).toContain(
      'transport_timeout=$((remaining - observer_transport_grace_seconds))'
    );
    expect(dispatch).toContain(
      '[ "$transport_timeout" -gt $((observer_max_seconds + observer_transport_grace_seconds)) ]'
    );
    expect(dispatch).toContain(
      'transport_timeout=$((observer_max_seconds + observer_transport_grace_seconds))'
    );
    expect(dispatch).toContain(
      'observe_seconds=$((transport_timeout - observer_transport_grace_seconds))'
    );
    expect(dispatch).toContain(
      "ENGINE_RELEASE_OBSERVE_SECONDS='$observe_seconds' ENGINE_RELEASE_INVOCATION_WAIT_SECONDS='$invocation_wait'"
    );
    expect(dispatch).not.toContain("ENGINE_RELEASE_OBSERVE_SECONDS='$transport_timeout'");
    expect(dispatch).toContain(
      '[ "$invocation_wait" -le "$observe_seconds" ] || invocation_wait="$observe_seconds"'
    );
    expect(dispatch.indexOf('observe_seconds=$((transport_timeout')).toBeLessThan(
      dispatch.indexOf("ENGINE_RELEASE_OBSERVE_SECONDS='$observe_seconds'")
    );
    expect(dispatch).toContain('timeout --signal=TERM --kill-after=5s "${transport_timeout}s"');
    expect(dispatch).toContain('DISPATCH_FINALIZE_RESERVE_SECONDS=15');
  });

  it('puts remote Docker, database, and public proof inside the proof deadline', () => {
    const outerSsh = proof.indexOf(
      'timeout --signal=TERM --kill-after=5s "${REMOTE_PROOF_TIMEOUT}s"'
    );
    const dockerInspect = proof.indexOf('docker container inspect', outerSsh);
    const remoteEnd = proof.indexOf('          REMOTE\n          )"', dockerInspect);
    expect(outerSsh).toBeGreaterThan(-1);
    expect(dockerInspect).toBeGreaterThan(outerSsh);
    expect(remoteEnd).toBeGreaterThan(dockerInspect);
    expect(proof).toContain('RELEASE_PROOF_DEADLINE_EPOCH - $(date +%s)');
    expect(proof).toContain('timeout --signal=TERM --kill-after=1s 62s');
    expect(proof).toMatch(
      /timeout --signal=TERM --kill-after=2s "\$\{PUBLIC_TIMEOUT\}s"[\s\\]*\n\s*curl -fsS/
    );
    expect(proof).toContain('PUBLIC_PARSE_TIMEOUT=$((PARSE_REMAINING - 1))');
  });

  it('fails a receipt that cannot fit while bounding dependency setup and the write', () => {
    expect(receipt).toContain('if: always()');
    expect(receipt).toContain('RELEASE_RECEIPT_DEADLINE_EPOCH - $(date +%s)');
    expect(receipt).toContain(
      "echo '::error::strict deployment receipt cannot run inside its absolute budget'"
    );
    expect(receipt).toMatch(/timeout[\s\S]*npm install pg@8/);
    expect(receipt).toMatch(/timeout[\s\S]*node scripts\/ci\/record-engine-deploy-attempt\.mjs/);
    expect(receipt).toContain("STRICT_RECEIPT: '1'");
  });

  it('bounds remote cleanup and arms local credential cleanup first', () => {
    const trap = cleanup.indexOf('trap cleanup_local_credentials EXIT');
    const remoteTimeout = cleanup.indexOf(
      'timeout --signal=TERM --kill-after=5s "${REMOTE_CLEANUP_TIMEOUT}s"'
    );
    expect(cleanup).toContain('if: always()');
    expect(cleanup).toContain('RELEASE_REMOTE_CLEANUP_DEADLINE_EPOCH - $(date +%s)');
    expect(trap).toBeGreaterThan(-1);
    expect(remoteTimeout).toBeGreaterThan(trap);
    expect(cleanup).toContain('rm -rf -- "${SSH_DIR:-$RUNNER_TEMP/club-arena-ssh-$RUN_KEY}"');
    expect(cleanup).toContain(
      'echo "::error::remote staging cleanup failed inside its absolute budget ($REMOTE_CLEANUP_RC)"'
    );
  });
});
