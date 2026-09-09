import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOW = readFileSync(
  resolve(__dirname, '../../.github/workflows/update-hetzner-env.yml'),
  'utf8'
);
const CUTOVER = readFileSync(
  resolve(__dirname, '../../server/scripts/engine-up-with-maintenance-certificate.sh'),
  'utf8'
);

function step(name: string): string {
  const start = WORKFLOW.indexOf(`- name: ${name}`);
  if (start < 0) throw new Error(`workflow step not found: ${name}`);
  const next = WORKFLOW.indexOf('\n      - name: ', start + 1);
  return next < 0 ? WORKFLOW.slice(start) : WORKFLOW.slice(start, next);
}

function runnableShell(workflow: string): string {
  const lines = workflow.split('\n');
  const bodies: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^(\s*)run:\s*\|\s*$/);
    if (!match) continue;
    const runIndent = match[1].length;
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (line.trim() === '') {
        bodies.push('');
        continue;
      }
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= runIndent) {
        index -= 1;
        break;
      }
      const shellLine = line.slice(runIndent + 2);
      if (!shellLine.trimStart().startsWith('#')) bodies.push(shellLine);
    }
  }

  return bodies.join('\n');
}

function logicalCommands(shell: string): string[] {
  return shell
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

describe('the env utility cannot bypass the maintenance cutover gate', () => {
  const shell = runnableShell(WORKFLOW);
  const commands = logicalCommands(shell);

  it('has no runnable raw Docker replacement or lifecycle shortcut', () => {
    expect(shell).not.toMatch(/\bdocker\s+(?:run|stop|start|restart|unpause|rm)\b/);
  });

  it('never invokes engine-up directly', () => {
    const mentions = commands.filter((command) => command.includes('/engine-up.sh'));
    expect(mentions).toHaveLength(2);
    for (const command of mentions) {
      expect(command).toContain('ENGINE_UP_SCRIPT=');
      expect(command).toContain('/engine-up-with-maintenance-certificate.sh');
      expect(command.indexOf('/engine-up-with-maintenance-certificate.sh')).toBeGreaterThan(
        command.indexOf('/engine-up.sh')
      );
    }
  });
});

describe('the env restart has one bounded, stateful certificate transaction', () => {
  const update = step('Update the value');
  const restart = step('Restart inside an exact durable maintenance window');
  const verify = step('Verify');
  const guarantee = step('GUARANTEE the exact current engine is running');
  const transactionCleanup = step('Remove run-scoped environment transaction files');

  it('stages candidate and rollback bytes without modifying the canonical boot source', () => {
    expect(WORKFLOW).toContain('ENV_CANDIDATE: /opt/club-arena/server/.env.candidate.');
    expect(WORKFLOW).toContain('ENV_ROLLBACK: /opt/club-arena/server/.env.rollback.');
    expect(WORKFLOW).toContain(
      'ENV_ROLLBACK_SENTINEL: /opt/club-arena/server/.env.pending-rollback'
    );
    expect(update.match(/cp -p /g) ?? []).toHaveLength(2);
    expect(update).toContain("'$ENV_ROLLBACK'");
    expect(update).toContain("'$ENV_CANDIDATE'");
    expect(update).toContain('cmp -s');
    expect(update).toContain('canonical .env changed while the candidate was staged');
    expect(update).not.toMatch(/mv .*"\\\$ENV_FILE"/);
    expect(update).toContain("sync -f '$ENV_ROLLBACK' '$ENV_CANDIDATE'");
    expect(update).toContain('canonical .env is unchanged');
    expect(WORKFLOW).toContain('[[ "$KEY" =~ ^[A-Z_][A-Z0-9_]*$ ]]');
    expect(update).not.toMatch(/echo[^\n]*\$SECRET_VALUE/);
    expect(update).not.toContain('set -x');
  });

  it('promotes only inside the verified lock-held transaction and rolls back with old env bytes', () => {
    expect(restart).toContain('ENV_FILE=$ENV_CANDIDATE');
    expect(restart).toContain('ROLLBACK_ENV_FILE=$ENV_ROLLBACK');
    expect(restart).toContain('CERTIFICATE_ENV_FILE=$ENV_ROLLBACK');
    expect(CUTOVER).toContain(
      'ENV_ROLLBACK_SENTINEL="/opt/club-arena/server/.env.pending-rollback"'
    );
    expect(restart).toContain('PROMOTE_ENV_FILE_TO=$REPO_DIR/server/.env');
    expect(restart).toContain('PUBLIC_HEALTH_URL=$ENGINE_URL/health');
    expect(restart).toContain('timeout --foreground --signal=TERM --kill-after=180s 600s env');

    const invoke = CUTOVER.slice(
      CUTOVER.indexOf('invoke_engine_up()'),
      CUTOVER.indexOf('exact_port_binding()')
    );
    expect(invoke).toMatch(
      /wait_for_exact_engine "\$TARGET_IMAGE_ID"[\s\S]*?promote_environment_if_requested[\s\S]*?commit_mutation_transaction/
    );
    expect(CUTOVER).toContain('ENV_FILE="$recovery_env_file"');
    expect(CUTOVER).toContain('recovery_env_file="$ENV_ROLLBACK_SENTINEL"');
    expect(CUTOVER).toContain('ENGINE_UP_RESTART_POLICY=always');
    expect(CUTOVER).toContain('ENGINE_UP_RESTART_POLICY="$target_restart_policy"');
    expect(CUTOVER).toContain('target_restart_policy="no"');
    expect(CUTOVER).toContain(
      'wait_for_public_engine "${REQUIRED_DATABASE_VERSION:-$VERIFIED_HEALTH_VERSION}"'
    );
    expect(CUTOVER).toMatch(
      /if \[ "\$ENV_PROMOTION_STARTED" = "1" \]; then[\s\S]*?restore_canonical_environment/
    );
    expect(CUTOVER).toContain('cmp -s "$ROLLBACK_ENV_FILE" "$PROMOTE_ENV_FILE_TO"');
    expect(CUTOVER).toContain(
      '$(dirname "$ROLLBACK_ENV_FILE")" = "$(dirname "$PROMOTE_ENV_FILE_TO")'
    );
    expect(CUTOVER).toContain('durable_copy_replace "$ENV_FILE" "$PROMOTE_ENV_FILE_TO"');
    expect(CUTOVER).toContain('os.fsync(descriptor)');
    expect(CUTOVER).toContain(
      "os.open(os.path.dirname(path), os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))"
    );
    expect(CUTOVER).toContain('docker update --restart always "$CONTAINER"');
    expect(CUTOVER).toContain('committed restart=always for the verified canonical environment');
    expect(CUTOVER).toContain('ensure-only recovery cannot claim a staged environment promotion');
    expect(CUTOVER).toContain('a paused container did not boot from the staged environment');
    expect(CUTOVER).toContain('a stopped container did not boot from the staged environment');
    const begin = CUTOVER.slice(
      CUTOVER.indexOf('begin_mutation_transaction()'),
      CUTOVER.indexOf('commit_mutation_transaction()')
    );
    expect(begin.indexOf('trap on_mutation_exit EXIT')).toBeLessThan(
      begin.indexOf('durable_copy_replace "$ROLLBACK_ENV_FILE" "$ENV_ROLLBACK_SENTINEL"')
    );
    expect(
      begin.indexOf('durable_copy_replace "$ROLLBACK_ENV_FILE" "$ENV_ROLLBACK_SENTINEL"')
    ).toBeLessThan(begin.indexOf('MUTATION_STARTED=1'));
    const commit = CUTOVER.slice(
      CUTOVER.indexOf('commit_mutation_transaction()'),
      CUTOVER.indexOf('restore_canonical_environment()')
    );
    expect(commit.indexOf('remove_env_rollback_sentinel_durably')).toBeLessThan(
      commit.indexOf('MUTATION_STARTED=0')
    );
  });

  it('serializes cleanup behind the same host lock before deleting exact run-scoped files', () => {
    expect(transactionCleanup).toContain('if: always()');
    expect(transactionCleanup).toContain('exec 9>/var/lock/club-arena-engine-up.lock');
    expect(transactionCleanup).toContain('flock -w 360 9');
    expect(transactionCleanup).toContain('RESTART_STATE: ${{ steps.restart.outputs.state }}');
    expect(transactionCleanup).toContain('GUARANTEE_OUTCOME: ${{ steps.guarantee.outcome }}');
    expect(transactionCleanup).toContain(
      'completed:* | clean_refused:* | :* | *:success) SAFE_TO_DELETE=true'
    );
    expect(transactionCleanup).toContain("cmp -s '$ENV_ROLLBACK' '$REPO_DIR/server/.env'");
    expect(transactionCleanup).toContain('if [ "\\$SAFE_TO_DELETE" = true ]');
    expect(transactionCleanup).toContain("if [ -e '$ENV_ROLLBACK_SENTINEL' ]");
    expect(transactionCleanup).toContain(
      'preserving the run-scoped rollback snapshot because terminal environment state was not proved'
    );
    expect(transactionCleanup).toContain("rm -f -- '$ENV_CANDIDATE' '$ENV_CANDIDATE.new'");
    expect(transactionCleanup).toContain("'$ENV_CANDIDATE.replace'");
    expect(transactionCleanup).toContain("'$ENV_ROLLBACK' '$ENV_ROLLBACK.replace'");
    expect(transactionCleanup).not.toContain('.env*');
    const deletion = transactionCleanup
      .split('\n')
      .filter((line) => line.includes('rm -f --') || /^\s+'\$ENV_/.test(line))
      .join('\n');
    expect(deletion).not.toContain("'$REPO_DIR/server/.env'");
    expect(deletion).not.toContain('club-arena-engine:current');
    expect(deletion).not.toContain('/var/lib/club-arena');
    expect(deletion).not.toContain('restart-policy');
    expect(deletion).not.toContain('ENV_ROLLBACK_SENTINEL');
  });

  it('waits at most one hourly cycle and retries only a clean pre-mutation refusal', () => {
    expect(WORKFLOW).toMatch(/timeout-minutes:\s*(?:8[0-9]|9[0-9]|[1-9][0-9]{2,})/);
    expect(restart).toContain('WAIT_BUDGET_SECONDS=3900');
    expect(restart).toContain('MIN_BREAK_LEFT_MS=180000');
    expect(restart).toMatch(/if \[ "\$WRAPPER_STATUS" -eq 75 \]/);
    expect(restart).toContain('state=clean_refused');
    expect(restart).toMatch(/state=clean_refused[\s\S]*?exit 75/);
    expect(restart).toMatch(/state=clean_refused[\s\S]*?exit 75[\s\S]*?sleep 15/);
  });

  it('records completed, attempted-mutation and unknown-transport outcomes separately', () => {
    expect(restart).toMatch(/WRAPPER_STATUS" -eq 0[\s\S]*?state=completed[\s\S]*?exit 0/);
    expect(restart).toMatch(
      /WRAPPER_STATUS" -eq 76[\s\S]*?state=mutation_attempted[\s\S]*?else[\s\S]*?state=transport_unknown/
    );
    expect(verify).toContain('steps.restart.outputs.state');
    expect(verify).toContain('= "completed"');
  });

  it('never turns a clean refusal into a mutation in the final guarantee', () => {
    expect(guarantee).toContain("steps.restart.outputs.state == 'completed'");
    expect(guarantee).toContain("steps.restart.outputs.state == 'mutation_attempted'");
    expect(guarantee).toContain("steps.restart.outputs.state == 'transport_unknown'");
    expect(guarantee).not.toContain("steps.restart.outputs.state != 'clean_refused'");
    expect(guarantee).toContain('RECOVER_IF_NOT_RUNNING=1 ENSURE_RUNNING_ONLY=1');
    expect(guarantee).toContain('/engine-supervisor.sh');
    expect(guarantee.indexOf('/engine-supervisor.sh')).toBeLessThan(
      guarantee.indexOf('/engine-up-with-maintenance-certificate.sh')
    );
    expect(guarantee).toContain('/engine-up-with-maintenance-certificate.sh');
    expect(guarantee).not.toContain('|| true');
  });
});
