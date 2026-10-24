import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const transaction = readFileSync(resolve('server/scripts/engine-release-transaction.sh'), 'utf8');
const up = readFileSync(resolve('server/scripts/engine-up.sh'), 'utf8');

describe('the owning release prepares an unstarted candidate before the cutover', () => {
  it('executes the real guarded run-spec with isolated durable Docker state', () => {
    const result = spawnSync('python3', [resolve('tests/engine-stopped-candidate.test.py')], {
      encoding: 'utf8',
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain('Ran 5 tests');
  }, 30_000);

  it('keeps preparation before announcements and consumes only original certified authority', () => {
    const built = transaction.indexOf("|| die 'bounded immutable engine image build failed'");
    const prepared = transaction.indexOf('ENGINE_UP_PREPARE_STOPPED=1', built);
    const certificate = transaction.indexOf('prove_rollback_readiness\n', prepared);
    const token = transaction.indexOf('"$RELEASE_SEAL" prepare', certificate);
    const cutover = transaction.indexOf('bounded_break_command 75 env', token);
    expect(prepared).toBeGreaterThan(built);
    expect(certificate).toBeGreaterThan(prepared);
    expect(token).toBeGreaterThan(certificate);
    expect(cutover).toBeGreaterThan(token);
    expect(transaction.slice(cutover, cutover + 290)).toContain('ENGINE_UP_STAGED_RUN="$RUN_ID"');
    expect(transaction).toContain('BREAK_CUTOVER_PROOF_SECONDS=150');
    expect(transaction).toContain('BREAK_ROLLBACK_RESERVE_SECONDS=135');
    expect(up).toContain('flock -w 180 9');
    expect(up).toContain('docker stop -t 45 "$CONTAINER"');
    const preparation = up.slice(
      up.indexOf('if [ "$PREPARE_STOPPED" = 1 ]; then'),
      up.indexOf('log "replacing $CONTAINER')
    );
    expect(preparation).toContain('docker create');
    expect(preparation).not.toMatch(/docker (start|run|stop|exec) /);
    expect(up).toContain('phase create-start');
    expect(up).toContain('phase start-start');
  });
});
