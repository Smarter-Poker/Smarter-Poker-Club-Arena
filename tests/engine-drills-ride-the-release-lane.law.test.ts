/**
 * ENGINE DRILLS RIDE THE RELEASE LANE (2026-10-17)
 *
 * docs/runbooks/maintenance-break-fire-drill.md retired the workstation crash
 * drill (root SSH, an ad hoc container kill) and allowed a live drill only as a
 * reviewed default-branch repository event with the release transaction's own
 * controls. The Diamond launch audit could not close DA08 (failover) or DA10
 * (rollback/restore) without one: the seal had an audited rollback mode that
 * nothing called, and Ruling 24 (one engine, no standby) makes the supervisor
 * restart the only failover there is.
 *
 * .github/workflows/engine-drill.yml is that event. It has no mechanism of its
 * own: install-engine-drill.sh binds a drill to one run key with a root-only
 * record, the unchanged durable intake takes the run key, and
 * engine-release-transaction.sh runs the drill through the same certificate,
 * lock, break deadline, rollback readiness, seal and recovery trap as any
 * release. These pins keep it that way. The shell itself executes in
 * tests/operations/engine-drill-admission.py against real Git histories.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const code = (source: string) =>
  source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const workflow = read('.github/workflows/engine-drill.yml');
const workflowCode = code(workflow);
const transaction = read('server/scripts/engine-release-transaction.sh');
const transactionCode = code(transaction);
const installer = read('server/scripts/install-engine-drill.sh');
const recovery = read('server/scripts/engine-release-recover.sh');
const packager = read('server/scripts/install-engine-supervisor.sh');
const seal = read('server/scripts/engine-release-seal.py');
const runbook = read('docs/runbooks/maintenance-break-fire-drill.md');

// Each step must occur after the one before it (a step may also appear earlier,
// e.g. prove_rollback_readiness in the legacy-checkpoint branch).
const inOrder = (source: string, steps: string[]) => {
  let from = 0;
  for (const step of steps) {
    const at = source.indexOf(step, from);
    expect(at, `${step} after offset ${from}`).toBeGreaterThanOrEqual(0);
    from = at + step.length;
  }
};

const between = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return source.slice(from, to);
};

describe('the drill is a reviewed default-branch event, never a workstation', () => {
  it('runs only from its exact repository event, one drill at a time', () => {
    const triggers = between(workflow, '\non:', '\npermissions:');
    expect(triggers).toContain('repository_dispatch:');
    expect(triggers).toContain('types: [drill-club-arena-engine]');
    expect(workflow).not.toMatch(/^\s*workflow_dispatch:/m);
    expect(workflow).not.toMatch(/^\s*schedule:/m);
    expect(workflow).not.toMatch(/^\s*(push|pull_request|workflow_run):/m);
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(workflow).toContain('group: club-arena-engine-drill');
    expect(workflow).toContain('cancel-in-progress: false');
  });

  it('admits only a named drill of an exact protected-main SHA with a stated reason', () => {
    const admit = between(workflowCode, 'name: Prove the drill request is exact', 'engine-doors:');
    expect(admit).toContain('crash|rollback|rollforward) ;;');
    expect(admit).toContain('[[ "$REQUESTED_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(admit).toContain('12 <= len(value) <= 128');
    expect(admit).toContain('git merge-base --is-ancestor "$REQUESTED_SHA" "$MAIN_SHA"');
    expect(admit).toContain('git merge-base --is-ancestor "$CONTROL_SHA" "$MAIN_SHA"');
  });

  it('proves every production door strictly, a rollback included, before touching the host', () => {
    const doors = between(workflowCode, 'engine-doors:', '\n  drill:');
    expect(doors).toContain("ROLLBACK_REQUESTED: 'false'");
    expect(doors).not.toContain("ROLLBACK_REQUESTED: 'true'");
    expect(doors).toContain('node scripts/ci/check-engine-doors-exist.mjs');
    expect(workflowCode).toContain('needs: [admit, engine-doors]');
  });

  it('binds the drill before the unchanged intake and never writes a deploy receipt', () => {
    expect(workflowCode).toContain('"$STAGE/server/scripts/install-engine-drill.sh"');
    expect(workflowCode).not.toContain('install-engine-intake.sh');
    expect(workflowCode).not.toContain('record-engine-deploy-attempt');
    expect(workflowCode).not.toContain('run-post-deploy-e2e');
    expect(workflowCode).not.toContain('deploy-club-arena-engine');
    expect(workflowCode).toContain('observe-engine-release.sh');
  });

  it('accepts only the receipt each drill can honestly produce, then proves identity itself', () => {
    expect(workflowCode).toContain('crash:already-released|rollback:sealed|rollforward:sealed) ;;');
    expect(workflowCode).toContain('/var/lib/club-arena/engine-drill-results/$RUN_KEY.json');
    expect(workflowCode).toContain('expected = "crash-recovered" if mode == "crash" else "sealed"');
    const verify = between(workflowCode, 'name: Independently prove', 'name: Remove exact staging');
    // Independent of the transaction, and without reading engine configuration
    // (engine-release-seal.law: only the deploy may name the engine .env).
    expect(verify).toContain('l.get("role")=="leader" and l.get("holder")==i');
    expect(workflowCode).not.toMatch(/server\/\.env/);
    expect(verify).toContain('[ "$PUBLIC_INSTANCE" = "$LOCAL_INSTANCE" ]');
  });
});

describe('the transaction runs a drill under every release control', () => {
  it('takes its mode only from the root-owned record bound to this run key', () => {
    // The receipt writer's `DRILL_MODE="$DRILL_MODE" ... python3` is an
    // environment pass-through to one child, not an assignment.
    const assignments = (transactionCode.match(/^\s*DRILL_MODE=.*$/gm) ?? []).filter(
      (line) => !line.includes('DRILL_MODE="$DRILL_MODE"')
    );
    expect(assignments.map((line) => line.trim())).toEqual([
      "DRILL_MODE=''",
      'DRILL_MODE="${DRILL_LINES[1]}"',
    ]);
    const record = between(
      transactionCode,
      'DRILL_FILE="$REQUEST_ROOT/$RUN_ID.drill"',
      'SEAL_MODE=deploy'
    );
    expect(record).toContain('[ "$(stat -c \'%u:%a\' "$DRILL_FILE")" = \'0:600\' ]');
    expect(record).toContain('[ "${DRILL_LINES[2]}" = "$SHA" ]');
    expect(record).toContain('[ "${DRILL_LINES[3]}" = "$CONTROL_SHA" ]');
  });

  it('prepares the audited rollback mode only for a rollback drill', () => {
    const mapping = between(transactionCode, 'SEAL_MODE=deploy', "DRILL_PREVIOUS_DESIRED=''");
    expect(mapping.match(/SEAL_MODE=rollback/g)).toHaveLength(1);
    expect(mapping).toContain('if [ "$DRILL_MODE" = rollback ]; then\n  SEAL_MODE=rollback');
    expect(transactionCode).toContain('--mode "$SEAL_MODE"');
    expect(transactionCode).not.toMatch(/--mode rollback/);
  });

  it('crashes the engine only past the locked certificate and rollback readiness, before any prepare', () => {
    const loop = transactionCode.slice(
      transactionCode.indexOf("acquire_engine_lock 'maintenance cutover'")
    );
    inOrder(loop, [
      'drill_preconditions',
      'BREAK_REMAINING_MS="$(maintenance_certificate "$BREAK_LOCKED_MIN_BREAK_MS")"',
      'persist_break_deadline',
      'prove_rollback_readiness',
      'validate_candidate_image',
      'run_crash_drill',
      '"$RELEASE_SEAL" prepare',
    ]);
    // The only prepare comes after the only crash branch.
    expect(transactionCode.match(/"\$RELEASE_SEAL" prepare/g)).toHaveLength(1);
    expect(loop.indexOf('"$RELEASE_SEAL" prepare')).toBeGreaterThan(
      loop.indexOf('run_crash_drill')
    );
    expect(transactionCode.match(/^\s+run_crash_drill$/gm)).toHaveLength(1);
  });

  it('arms recovery before the kill and proves a new leader before any receipt', () => {
    const crash = between(transactionCode, 'run_crash_drill() {', '\ncreate_image_lease() {');
    inOrder(crash, [
      'pre_instance="$(exact_runtime_instance)"',
      'MUTATION_STARTED=1',
      'kill -KILL "$pre_pid"',
      '[ "$restarts" -gt "$pre_restarts" ]',
      '[ "$new_instance" != "$pre_instance" ]',
      '"$DATABASE_PROOF" --env-file "$ENV_FILE" --sha "$SHA" --instance-id "$new_instance"',
      '[ "$(date +%s)" -lt "$BREAK_END_EPOCH" ]',
      'MUTATION_STARTED=0',
      'persist_result already-released "$final_instance"',
      'record_drill_receipt crash-recovered "$final_instance"',
    ]);
    expect(crash).not.toContain('docker stop');
    expect(crash).not.toContain('docker restart');
    expect(crash).not.toContain('RELEASE_SEAL" prepare');
    expect(crash).not.toContain('RELEASE_SEAL" commit');
  });

  it('never spends the off-cycle window and never asks a release to stand aside', () => {
    const request = between(transactionCode, 'request_recovery_window() {', '\n}');
    const drillReturn = request.indexOf('[ -z "${DRILL_MODE:-}" ] || return 0');
    expect(drillReturn).toBeGreaterThan(0);
    expect(drillReturn).toBeLessThan(request.indexOf('recovery_window_reason'));
    expect(transactionCode).toContain('if [ -z "${DRILL_MODE:-}" ] && URGENT_HIGH_WATER=');
    const marker = between(
      transactionCode,
      'if [ -n "${DRILL_MODE:-}" ]; then\n  echo',
      'while :; do'
    );
    expect(marker).toContain('elif printf');
    expect(marker).toContain('"$AWAITING_CERTIFICATE_FILE"');
  });

  it('admits an older rollback target only by its own stricter rule', () => {
    const gate = between(
      transactionCode,
      'source_target_is_current() {',
      'parse_health_instance_for_sha()'
    );
    expect(gate).not.toContain('get desired-sha');
    expect(gate).toContain(
      'if [ "${DRILL_MODE:-}" = rollback ]; then\n    drill_rollback_admission'
    );
    const rule = between(transactionCode, 'drill_rollback_admission() {', '\n}');
    expect(rule).toContain('"$DRILL_ENGINE_FLOOR_SHA" "$DRILL_TOURNAMENT_FLOOR_SHA"');
    expect(rule).toContain('merge-base --is-ancestor "$SHA" "$high_water"');
    expect(rule).toContain('attest-committed-sha --sha "$SHA"');
    expect(transactionCode).toContain(
      'DRILL_ENGINE_FLOOR_SHA=86aab0e645b1842e83fca808cf956c9733af66ba'
    );
    expect(transactionCode).toContain(
      'DRILL_TOURNAMENT_FLOOR_SHA=ab9e626376c96b9ce2b74a45833428f0875450d3'
    );
  });
});

describe('the host plumbing stays inside the existing release lane', () => {
  it('verifies its own bytes, binds before the request exists, and execs the unchanged intake', () => {
    expect(installer).toContain('"$STAGE/server/scripts/install-engine-drill.sh"');
    expect(installer).toContain(
      'for script in install-engine-drill.sh install-engine-intake.sh; do'
    );
    expect(installer).toContain(
      "die 'this run key already has a release request and no drill record'"
    );
    expect(installer).toContain('exec "$STAGE/server/scripts/install-engine-intake.sh"');
    expect(packager).toMatch(/REQUIRED_FILES=\([\s\S]*\n {2}install-engine-drill\.sh\n[\s\S]*\)/);
  });

  it('retires the drill record only after the request', () => {
    const request = recovery.indexOf('bounded_recovery_command 10 rm -f -- "$REQUEST_FILE"');
    const drill = recovery.indexOf('bounded_recovery_command 10 rm -f -- "$DRILL_FILE"');
    expect(request).toBeGreaterThan(0);
    expect(drill).toBeGreaterThan(request);
  });

  it('answers whether a commit was ever sealed here without writing anything', () => {
    const attest = between(seal, 'def cmd_attest_committed_sha(', '\ndef cmd_abort(');
    expect(attest).not.toContain('write_state');
    expect(attest).not.toContain('audit(');
    expect(seal).toContain('commands.add_parser("attest-committed-sha")');
  });

  it('names the route in the runbook that required it', () => {
    expect(runbook).toContain('.github/workflows/engine-drill.yml');
    expect(runbook).toContain('drill-club-arena-engine');
    expect(runbook).not.toContain('Until that controlled path exists');
  });

  it('executes the real drill shell against real Git histories', () => {
    const result = spawnSync(
      'python3',
      [resolve(__dirname, 'operations/engine-drill-admission.py')],
      // Measured ~4s solo; a generous cap so contention reports diagnostics.
      { encoding: 'utf8', timeout: 150_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 180_000);
});
