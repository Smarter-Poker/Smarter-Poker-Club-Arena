import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// Hosted client checks use Node 20; production preflight remains pinned to Node 22.
// Both execute the real controller and target with native inspector APIs.

describe('actual isolated legacy checkpoint transport', () => {
  it.each([
    ['success', 'SIGUSR1, cached ESM singleton, one guarded call and same-process closure'],
    ['connection', 'one cleanup-only connection after a real failed initial handshake'],
    ['exception', 'static error reporting without target exception or private result fields'],
    ['timeout', 'unknown nonretryable outcome for a never-settling guarded call'],
    ['disconnect', 'unknown outcome and cleanup-only reconnect after in-flight disconnect'],
    ['zero', 'zero instances refuse checkpoint invocation'],
    ['two', 'multiple instances refuse checkpoint invocation'],
    ['preexisting', 'an inspector owned by another caller remains untouched'],
    ['cleanup_close_timeout', 'missing close notification stays unknown without a competing close'],
  ])(
    '%s: %s',
    (scenario) => {
      const result = spawnSync(
        process.execPath,
        [
          ...(process.versions.node.startsWith('20.') ? ['--experimental-websocket'] : []),
          '--max-old-space-size=96',
          resolve('tests/operations/legacy-checkpoint-transport.mjs'),
          scenario,
          pathToFileURL(resolve('server/scripts/legacy-engine-checkpoint.mjs')).href,
        ],
        {
          encoding: 'utf8',
          timeout: 12000,
          maxBuffer: 32768,
          env: { PATH: dirname(process.execPath), TZ: 'UTC' },
        }
      );
      expect(result.error?.message ?? null, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        scenario,
        sameProcessAliveAfterCleanup: true,
        portClosed: true,
        normalExit: true,
      });
    },
    15000
  );
});
