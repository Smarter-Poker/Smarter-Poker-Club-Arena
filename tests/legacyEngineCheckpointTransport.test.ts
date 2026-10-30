import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// Hosted client checks use Node 20; production preflight remains pinned to Node 22.
// The fixture also accepts Node 26, which is what the Mac running the local
// prechecks is on - see the allowlist in
// tests/operations/legacy-checkpoint-transport.mjs. Before that was widened,
// all twelve of these failed on that machine at the version assert, before any
// inspector work ran at all, and the failure was being written off as a Node
// incompatibility that it never was.
// Both execute the real controller and target with native inspector APIs.

describe('actual isolated legacy checkpoint transport', () => {
  it.each([
    [
      'engine_census',
      'all registered and detached concrete engines travel by native object identity',
    ],
    ['census_counts', 'native projected group sizes survive refusal without another census'],
    ['census_counts_unknown', 'malformed native metadata remains unknown, never zero'],
    ['census_counts_zero', 'only actual empty native arrays report zero owners'],
    ['success', 'SIGUSR1, cached ESM singleton, one guarded call and same-process closure'],
    ['connection', 'one cleanup-only connection after a real failed initial handshake'],
    ['exception', 'static error reporting without target exception or private result fields'],
    ['protocol_error', 'a CDP error answer names its operation, method and inspector error'],
    ['timeout', 'unknown nonretryable outcome for a never-settling guarded call'],
    ['early_timeout', 'an early native timer cannot report an unspent request slice as exhausted'],
    ['disconnect', 'unknown outcome and cleanup-only reconnect after in-flight disconnect'],
    ['zero', 'zero instances refuse checkpoint invocation'],
    ['two', 'multiple instances refuse checkpoint invocation'],
    ['preexisting', 'an inspector owned by another caller remains untouched'],
    ['cleanup_close_timeout', 'missing close notification stays unknown without a competing close'],
    ['refusal', 'validated native refusal and counts survive successful inspector cleanup'],
    ['refusal_cleanup_timeout', 'cleanup refusal retains the original native refusal evidence'],
    ['malformed_refusal', 'unrecognized or wrongly typed summary values cannot become diagnostics'],
    [
      'memory_refusal',
      'insufficient native heap refuses before any census or guard and closes its inspector',
    ],
    ['deadline_expired', 'an expired absolute entry deadline opens no inspector'],
    ['deadline_future', 'a caller cannot supply more than the absolute forty seconds'],
    [
      'shared_deadline_exhausted',
      'census exhaustion preserves cleanup and never invokes the guard',
    ],
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
          env: {
            PATH: dirname(process.execPath),
            TZ: 'UTC',
            TMPDIR: process.env.TMPDIR ?? process.env.RUNNER_TEMP,
          },
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

  it('shares unused entry time with one native census of all five concrete owners', () => {
    const result = spawnSync(
      process.execPath,
      [
        ...(process.versions.node.startsWith('20.') ? ['--experimental-websocket'] : []),
        resolve('tests/operations/legacy-checkpoint-transport.mjs'),
        'shared_deadline',
        pathToFileURL(resolve('server/scripts/legacy-engine-checkpoint.mjs')).href,
      ],
      {
        encoding: 'utf8',
        timeout: 40000,
        maxBuffer: 32768,
        env: {
          PATH: dirname(process.execPath),
          TZ: 'UTC',
          TMPDIR: process.env.TMPDIR ?? process.env.RUNNER_TEMP,
        },
      }
    );
    expect(result.error?.message ?? null, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      scenario: 'shared_deadline',
      portClosed: true,
      normalExit: true,
    });
  }, 45000);
});
