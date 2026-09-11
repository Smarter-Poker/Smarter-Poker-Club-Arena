import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod } from '../helpers/sourceWindow';

/**
 * THE OUTGOING ENGINE'S LOG SURVIVES THE DEPLOY (2026-09-07).
 *
 * The engine container is replaced every hour, and `docker rm` deletes its
 * json-file log with it. On 2026-09-07 the engine was unreachable for a minute
 * at 16:52 and came back inside an off-schedule break; by the time anyone
 * looked, the container that did it had been replaced twice and its log was
 * gone. engine-up.sh now dumps the outgoing container's full log, compressed,
 * to /var/log/club-arena-engine before removing the container.
 */
const ROOT = resolve(__dirname, '../..');
const sh = readFileSync(resolve(ROOT, 'server/scripts/engine-up.sh'), 'utf8');
const wf = readFileSync(resolve(ROOT, '.github/workflows/auto-deploy-hetzner.yml'), 'utf8');

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
    expect(fn).toMatch(/docker logs -t "\$c" 2>&1 \| gzip/);
    expect(fn).toMatch(/mkdir -p "\$LOG_DIR"/);
    // The call site tolerates failure.
    expect(sh).toMatch(/save_outgoing_log "\$CONTAINER" \|\| log "WARN/);
  });

  it('keeps the logs bounded by age and by size, and never deletes the newest', () => {
    const fn = sliceMethod(sh, 'save_outgoing_log() {');
    expect(fn).toMatch(/-mtime \+"\$LOG_KEEP_DAYS" -delete/);
    expect(fn).toMatch(/-gt "\$LOG_KEEP_MB"/);
    const keepNewest = fn.match(
      /\[\s*"\$\(ls -1 "\$LOG_DIR"\/engine-\*\.log\.gz 2>\/dev\/null \| wc -l\)"\s+-gt 1\s*\]\s*\|\|\s*break/
    );
    expect(keepNewest, 'size retention must stop when only the newest log remains').not.toBeNull();
    const selectOldest = fn.indexOf(
      'oldest="$(ls -1tr "$LOG_DIR"/engine-*.log.gz 2>/dev/null | head -1)"'
    );
    const removeOldest = fn.indexOf('rm -f "$oldest"');
    expect(selectOldest, 'retention must select the oldest timestamped log').toBeGreaterThan(-1);
    expect(removeOldest, 'retention must remove only the selected oldest log').toBeGreaterThan(
      selectOldest
    );
  });

  it('the deploy names the saved file in its own log', () => {
    expect(wf).toMatch(/ls -1t \/var\/log\/club-arena-engine\/engine-\*\.log\.gz/);
  });
});
