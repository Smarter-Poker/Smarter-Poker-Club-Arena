/**
 * LAW: ENGINE RECOVERY IS CAUSAL, NEVER A PERIODIC MUTATION.
 *
 * The old 60-second systemd timer could start, recreate, relabel, retag, or
 * restart the engine based on a sampled observation. That was a second owner
 * racing the release transaction. Exact desired restoration now belongs only
 * to the transaction or its ExecStopPost recovery while the engine lock is
 * already held. The historical script filename remains solely because it is
 * part of the frozen release-v1 generation protocol.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');
const installer = read('server/scripts/install-engine-supervisor.sh');
const recovery = read('server/scripts/engine-supervisor.sh');
const transaction = read('server/scripts/engine-release-transaction.sh');
const execStopPost = read('server/scripts/engine-release-recover.sh');
const verifier = read('server/scripts/verify-recovery-stack.sh');
const prometheus = read('infra/monitoring/prometheus.yml');
const compose = read('infra/monitoring/docker-compose.yml');
const monitoringDeploy = read('infra/monitoring/deploy.sh');
const recoveryRules = read('infra/monitoring/recovery-rules.yml');

describe('periodic engine mutation is retired at installation', () => {
  it('never generates or enables the old service and timer', () => {
    expect(installer).not.toContain('cat > "$UNIT_STAGE/club-arena-supervisor.service"');
    expect(installer).not.toContain('cat > "$UNIT_STAGE/club-arena-supervisor.timer"');
    expect(installer).not.toContain('systemctl enable --now club-arena-supervisor.timer');
  });

  it('removes every old installation edge and proves it inactive', () => {
    expect(installer).toContain('systemctl disable --now club-arena-supervisor.timer');
    expect(installer).toContain('/etc/systemd/system/club-arena-supervisor.service');
    expect(installer).toContain('/etc/systemd/system/club-arena-supervisor.timer');
    expect(installer).toContain(
      '/etc/systemd/system/timers.target.wants/club-arena-supervisor.timer'
    );
    expect(installer).toContain('! systemctl is-active --quiet "$retired_unit"');
    expect(installer).toContain('! systemctl is-enabled --quiet "$retired_unit"');
    expect(verifier).toContain(
      'periodic engine supervisor service, timer, and enablement are absent'
    );
  });

  it('removes the exact retired heartbeat and sampling artifacts durably', () => {
    const retirement = installer.slice(
      installer.indexOf('# Retire every installation edge for the old periodic mutator.'),
      installer.indexOf('systemctl enable --now club-arena-verify.timer')
    );
    for (const retiredArtifact of [
      '/var/lib/node-exporter-textfile/club_arena_supervisor.prom',
      '/var/lib/club-arena/supervisor-fails',
      '/var/lib/club-arena/recoveries',
      '/var/lib/club-arena/last-started-at',
      '/var/lib/club-arena/last-container-id',
      '/var/lib/club-arena/boot-churn',
      '/var/lib/club-arena/restarting-samples',
    ]) {
      expect(retirement).toContain(retiredArtifact);
    }
    expect(retirement).toContain('fsync_paths /var/lib/club-arena');
    expect(retirement).toContain('fsync_paths /var/lib/node-exporter-textfile');
  });
});

describe('the frozen recovery entrypoint has exactly one causal mode', () => {
  it('requires force, exact health, caller-held lock, and an absolute deadline', () => {
    for (const authority of [
      'ENGINE_SUPERVISOR_FORCE_DESIRED',
      'ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH',
      'ENGINE_SUPERVISOR_LOCK_HELD',
      'ENGINE_RECOVERY_DEADLINE_EPOCH',
    ]) {
      expect(recovery).toContain(authority);
    }
    expect(recovery).toContain(
      "die 'one-shot recovery requires force-desired, exact-health, and caller-held-lock authority'"
    );
    expect(recovery).toContain('prove_exact_desired_recovery');
  });

  it('fails closed before consulting Docker when causal authority is absent', () => {
    const denied = spawnSync('bash', [resolve(root, 'server/scripts/engine-supervisor.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ENGINE_SUPERVISOR_FORCE_DESIRED: '0',
        ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH: '0',
        ENGINE_SUPERVISOR_LOCK_HELD: '0',
        ENGINE_RECOVERY_DEADLINE_EPOCH: '0',
      },
    });
    expect(denied.status).toBe(1);
    expect(denied.stdout).toContain(
      'one-shot recovery requires force-desired, exact-health, and caller-held-lock authority'
    );
  });

  it('contains no sampling counters, heartbeat, cache-tag repair, or autonomous classifier', () => {
    for (const retiredMechanism of [
      'FAIL_THRESHOLD',
      'BOOT_GRACE_SEC',
      'CHURN_THRESHOLD',
      'RESTARTING_THRESHOLD',
      'club_arena_supervisor_last_run_timestamp_seconds',
      'club_arena_supervisor_recoveries_total',
      'classify-running',
      'docker tag',
    ]) {
      expect(recovery).not.toContain(retiredMechanism);
    }
  });

  it('is called only with the complete authority envelope', () => {
    for (const caller of [transaction, execStopPost]) {
      expect(caller).toContain('ENGINE_SUPERVISOR_FORCE_DESIRED=1');
      expect(caller).toContain('ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH=1');
      expect(caller).toContain('ENGINE_SUPERVISOR_LOCK_HELD=1');
      expect(caller).toContain('ENGINE_RECOVERY_DEADLINE_EPOCH=');
    }
  });
});

describe('monitoring observes the recovery contract instead of a mutating heartbeat', () => {
  it('loads, mounts, and deploys recovery rules under their truthful name', () => {
    expect(existsSync(resolve(root, 'infra/monitoring/supervisor-rules.yml'))).toBe(false);
    expect(prometheus).toContain('/etc/prometheus/recovery-rules.yml');
    expect(compose).toContain('./recovery-rules.yml:/etc/prometheus/recovery-rules.yml:ro');
    expect(monitoringDeploy).toContain('recovery-rules.yml');
    expect(recoveryRules).toContain('- name: club-arena-recovery');
    expect(recoveryRules).toContain('- alert: RecoveryStackDegraded');
    expect(recoveryRules).toContain('- alert: RecoveryStackUnverified');
  });

  it('has no alert or verification dependency on the retired heartbeat', () => {
    expect(recoveryRules).not.toContain('club_arena_supervisor_');
    expect(verifier).not.toContain('club_arena_supervisor_last_run_timestamp_seconds');
    expect(verifier).not.toContain('supervisor heartbeat');
  });
});
