/**
 * LAW: a lease warning quietens under a flood, but never goes permanently
 * silent.
 *
 * Every lease warning was written as `if (xErrors <= 3)`. Those counters only
 * increment, so after the third occurrence in a process lifetime the path is
 * silent for the life of that process. The cap had a real reason - a failing
 * heartbeat recurs every five seconds and would drown the log - but "quiet" and
 * "silent" were collapsed into one thing.
 *
 * It cost a night. On 2026-09-12 the ownership lease renewal loop stopped and
 * every cash table was killed by its own twenty second proof watchdog and
 * re-claimed, 26,129 times in 2h10m, 1,483 hands abandoned mid-play at tables
 * holding nine of nine seats. The container log carried NOT ONE `[lease]` line
 * across the entire run. That happened to be because the heartbeat was never
 * called at all - but the log could not have distinguished that from "failing
 * every five seconds since the third attempt", and the first reading of the
 * evidence had to be checked another way to find out which.
 *
 * The flood protection is kept and the permanence is dropped: the first three
 * print, then at most one a minute, carrying how many were held back since the
 * last one. A recurring failure is visible within sixty seconds, forever.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { throttledLeaseWarning, _resetLeaseWarnThrottleForTests } from './leaseWarningThrottle.js';

const MIN = 60_000;

beforeEach(() => _resetLeaseWarnThrottleForTests());

describe('a lease warning never goes permanently silent', () => {
  it('prints the first three, as it always did', () => {
    for (let i = 0; i < 3; i += 1) {
      expect(throttledLeaseWarning('k', 'boom', 1000 + i)).toBe('boom');
    }
  });

  it('goes quiet inside the window instead of flooding', () => {
    for (let i = 0; i < 3; i += 1) throttledLeaseWarning('k', 'boom', 1000);
    for (let i = 0; i < 200; i += 1) {
      expect(throttledLeaseWarning('k', 'boom', 1000 + i * 10)).toBeNull();
    }
  });

  it('SPEAKS AGAIN after the quiet window, and says how many it held', () => {
    // This is the assertion the old `<= 3` could never satisfy.
    for (let i = 0; i < 3; i += 1) throttledLeaseWarning('k', 'boom', 1000);
    for (let i = 0; i < 11; i += 1) throttledLeaseWarning('k', 'boom', 1000 + i);
    const spoken = throttledLeaseWarning('k', 'boom', 1000 + MIN);
    expect(spoken).toBe('boom (11 more since the last of these)');
  });

  it('still speaks on the thousandth failure, hours in', () => {
    let spoke = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (throttledLeaseWarning('k', 'boom', i * 5_000) !== null) spoke += 1;
    }
    // 1000 failures five seconds apart is 83 minutes. A cap of three would have
    // spoken 3 times and then never again.
    expect(spoke).toBeGreaterThan(80);
  });

  it('one noisy reason does not silence a different one', () => {
    for (let i = 0; i < 50; i += 1) throttledLeaseWarning('rpc_error', 'a', 1000 + i);
    expect(throttledLeaseWarning('rpc_threw', 'b', 1000)).toBe('b');
  });

  it('no capped warning survives in either lease path', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    for (const f of ['tableLease.ts', 'tournamentLease.ts']) {
      const src = readFileSync(resolve(here, f), 'utf8');
      const code = src
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n');
      expect(code, f).not.toMatch(/Errors\s*<=\s*\d/);
    }
  });
});
