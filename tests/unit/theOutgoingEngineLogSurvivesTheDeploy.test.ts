import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod } from '../helpers/sourceWindow';

/**
 * THE OUTGOING ENGINE'S LOG SURVIVES THE DEPLOY (2026-09-07).
 *
 * An exact release cutover replaces the engine container, and `docker rm`
 * deletes its json-file log with it. On 2026-09-07 the engine was unreachable for a minute
 * at 16:52 and came back inside an off-schedule break; by the time anyone
 * looked, the container that did it had been replaced twice and its log was
 * gone. engine-up.sh now dumps the outgoing container's full log, compressed,
 * to /var/log/club-arena-engine before removing the container.
 */
const ROOT = resolve(__dirname, '../..');
const sh = readFileSync(resolve(ROOT, 'server/scripts/engine-up.sh'), 'utf8');

describe('engine-up.sh saves the outgoing log before it removes the container', () => {
  it('calls save_outgoing_log after docker stop and before docker rm', () => {
    const stop = sh.indexOf('docker stop -t 45 "$CONTAINER"');
    const save = sh.indexOf('save_outgoing_log "$CONTAINER"');
    const rm = sh.indexOf('docker rm "$CONTAINER"');
    expect(stop).toBeGreaterThan(-1);
    expect(save, 'save_outgoing_log is not called').toBeGreaterThan(stop);
    expect(rm, 'docker rm must come after the log is saved').toBeGreaterThan(save);
  });

  it('the dump is timestamped, compressed, and can never stop the deploy', () => {
    const fn = sliceMethod(sh, 'save_outgoing_log() {');
    expect(fn).toMatch(/docker logs -t "\$1" 2>&1 \| gzip -6 > "\$2"/);
    expect(fn).toMatch(/mkdir -p "\$LOG_DIR"/);
    // The call site tolerates failure.
    expect(sh).toMatch(/save_outgoing_log "\$CONTAINER" \|\| log "WARN/);
  });

  it('keeps the logs bounded by age and by size, and never deletes the newest', () => {
    const fn = sliceMethod(sh, 'save_outgoing_log() {');
    expect(fn).toMatch(/-mtime \+"\$LOG_KEEP_DAYS" -delete/);
    expect(fn).toMatch(/-gt "\$LOG_KEEP_MB"/);
    expect(fn).toMatch(/wc -l\)" -gt 1 \] \|\| break/);
  });

  it('the durable release log names the exact saved file', () => {
    expect(sh).toContain('log "saved the outgoing log to $out');
  });
});
