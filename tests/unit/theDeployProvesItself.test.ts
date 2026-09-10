/** The durable Hetzner transaction must prove every release before sealing it. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const WF = read('.github/workflows/auto-deploy-hetzner.yml');
const TRANSACTION = read('server/scripts/engine-release-transaction.sh');
const OBSERVER = read('server/scripts/observe-engine-release.sh');
const INSTALLER = read('server/scripts/install-engine-supervisor.sh');

describe('the durable engine release proves itself', () => {
  it('certifies an already-running exact release synchronously instead of trusting HTTP alone', () => {
    const lock = TRANSACTION.indexOf("acquire_engine_lock 'duplicate certification'");
    const freshness = TRANSACTION.indexOf('source_target_is_current', lock);
    const runtime = TRANSACTION.indexOf('EXACT_INSTANCE="$(exact_runtime_instance)"', freshness);
    const certify = TRANSACTION.indexOf('emit_already_released "$EXACT_INSTANCE"', runtime);
    expect(lock).toBeGreaterThan(-1);
    expect(freshness).toBeGreaterThan(lock);
    expect(runtime).toBeGreaterThan(freshness);
    expect(certify).toBeGreaterThan(runtime);

    const duplicateProof = TRANSACTION.slice(
      TRANSACTION.indexOf('emit_already_released()'),
      TRANSACTION.indexOf('create_image_lease()')
    );
    expect(duplicateProof).toContain('"$DATABASE_PROOF"');
    expect(duplicateProof).toContain('persist_result already-released');
  });

  it('proves candidate identity before commit and proves it again before the durable result', () => {
    const database = TRANSACTION.indexOf('"$DATABASE_PROOF" --env-file');
    const precommitLocal = TRANSACTION.indexOf('PRECOMMIT_LOCAL_INSTANCE=', database);
    const precommitPublic = TRANSACTION.indexOf('PRECOMMIT_PUBLIC_INSTANCE=', precommitLocal);
    const commit = TRANSACTION.indexOf('"$RELEASE_SEAL" commit', precommitPublic);
    const finalLocal = TRANSACTION.indexOf('FINAL_LOCAL_INSTANCE=', commit);
    const finalPublic = TRANSACTION.indexOf('FINAL_PUBLIC_INSTANCE=', finalLocal);
    const receipt = TRANSACTION.indexOf('persist_result sealed', finalPublic);
    expect(database).toBeGreaterThan(-1);
    expect(precommitLocal).toBeGreaterThan(database);
    expect(precommitPublic).toBeGreaterThan(precommitLocal);
    expect(commit).toBeGreaterThan(precommitPublic);
    expect(finalLocal).toBeGreaterThan(commit);
    expect(finalPublic).toBeGreaterThan(finalLocal);
    expect(receipt).toBeGreaterThan(finalPublic);
    expect(TRANSACTION).toContain('trap recover_on_exit EXIT');
  });

  it('the database is told a deploy shipped only after exact cutover and proof success', () => {
    expect(WF).toMatch(
      /SHIPPED: .*steps\.release\.outputs\.result == 'sealed'.*steps\.verify\.outputs\.verified == 'true'/
    );
    expect(WF).toContain("steps.release.outputs.result == 'already-released'");
    expect(WF).toContain('[ "$UNIT_RESULT" = success ] && [ "$RESULT_SHA" = "$SHA" ]');
    expect(WF).toContain('case "$RESULT" in sealed|already-released)');
    expect(WF).toContain("STRICT_RECEIPT: '1'");
    expect(WF).not.toMatch(/SHIPPED:.*!= 'failure'/);
  });

  it('the workflow, observer, systemd unit, and transaction budgets fit inside one another', () => {
    const workflowSeconds =
      Math.max(...[...WF.matchAll(/timeout-minutes: (\d+)/g)].map((match) => Number(match[1]))) *
      60;
    const observeSeconds = Number(
      OBSERVER.match(/OBSERVE_SECONDS="\$\{ENGINE_RELEASE_OBSERVE_SECONDS:-(\d+)\}"/)![1]
    );
    const handoffSeconds = Number(
      OBSERVER.match(
        /INVOCATION_WAIT_SECONDS="\$\{ENGINE_RELEASE_INVOCATION_WAIT_SECONDS:-(\d+)\}"/
      )![1]
    );
    const transactionSeconds = Number(
      TRANSACTION.match(/MAX_RUNTIME_SECONDS="\$\{ENGINE_RELEASE_MAX_RUNTIME_SECONDS:-(\d+)\}"/)![1]
    );
    const unitSeconds = Number(INSTALLER.match(/TimeoutStartSec=(\d+)min/)![1]) * 60;
    expect(unitSeconds).toBeGreaterThanOrEqual(transactionSeconds);
    expect(observeSeconds).toBeGreaterThanOrEqual(unitSeconds);
    expect(workflowSeconds).toBeGreaterThanOrEqual(handoffSeconds + observeSeconds + 20 * 60);
  });
});
