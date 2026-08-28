/**
 * The hero shot-clock timeout must fire ONCE per turn, not once per frame.
 *
 * The RAF loop in useTableTimer subscribes once (empty dep array) and so must
 * read every changing value through a ref. `turnDeadlineMs` was read as a prop
 * from inside that closure, freezing it at its mount value - and the initial
 * table state carries no `actionTimerDeadline`, so the frozen value is
 * `undefined`. The guard then compared `heroFiredRef.current !== undefined`
 * while the assignment stored `undefined ?? 0` = `0`. `0 !== undefined` is
 * always true, so the latch never latched: `onTimeout` ran on every frame once
 * the clock reached zero, opening the time-bank sheet ~60x a second and firing
 * an activateTimeBank request each time.
 *
 * It was masked by TablePage passing `isHeroTurn: isHeroTurnContext &&
 * !timeBankActive` - the first timeout set timeBankActive and the next frame
 * saw isHeroTurnRef false. That `&&` was removed on 2026-08-23 (it also blinded
 * the hook for the whole of a running bank), which took the brake off.
 *
 * This is a source-level test on purpose: the bug is a closure capture, and a
 * render test would need sixty real animation frames to show it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../../src/hooks/useTableTimer.ts'), 'utf8');

/**
 * The RAF effect body: from the tick loop to the effect's dependency array.
 *
 * 2026-08-28: this used to locate the end by the literal `}, []);` plus its
 * trailing comment. The effect is now GATED on the presence of a deadline
 * (`[hasDeadline, publish]`) so four mounted tables no longer run four
 * permanent rAF loops for tables where nobody is on the clock — see the note
 * beside `hasDeadline` in the hook. The locator moved with it; every
 * assertion below is unchanged, because the closure-capture rule this file
 * exists to pin is unaffected by the gate.
 */
const rafEffect = (() => {
  const start = SRC.indexOf('const tick = (now: number)');
  const end = SRC.indexOf('}, [hasDeadline, publish]);');
  expect(start, 'tick loop not found').toBeGreaterThan(-1);
  expect(end, 'the RAF effect not found').toBeGreaterThan(start);
  return SRC.slice(start, end);
})();

describe('hero timeout latch', () => {
  it('reads the deadline through a ref, never the frozen prop', () => {
    // A prop read inside a once-only effect is frozen at mount. This is the
    // whole bug.
    expect(rafEffect).toContain('turnDeadlineRef.current');
    expect(
      rafEffect.includes('!== turnDeadlineMs'),
      'the latch compares the frozen prop; it must compare the ref'
    ).toBe(false);
  });

  it('compares the same value it stores, so the latch can actually latch', () => {
    // The original stored `turnDeadlineMs ?? 0` and compared against the raw
    // `turnDeadlineMs`. When that is undefined the two can never be equal.
    expect(rafEffect).toMatch(/const deadlineNow = turnDeadlineRef\.current \?\? 0;/);
    expect(rafEffect).toMatch(/heroFiredRef\.current !== deadlineNow/);
    expect(rafEffect).toMatch(/heroFiredRef\.current = deadlineNow;/);
  });

  it('keeps the ref assigned on every render', () => {
    // Declaring the ref is not enough; it has to track the prop.
    expect(SRC).toMatch(/turnDeadlineRef\.current = turnDeadlineMs;/);
  });

  it('runs the drivers only while a deadline exists, and settles the ring when it goes', () => {
    // PERF 2026-08-28: four mounted tables used to mean four permanent rAF
    // loops plus four 500ms watchdogs, three of them for tables with nobody
    // on the clock. Gated on PRESENCE, not value, so a new deadline on a
    // table that already has one does not restart the drivers mid-turn.
    expect(SRC).toMatch(/const hasDeadline = Boolean\(turnDeadlineMs\);/);
    expect(SRC).toMatch(/if \(!hasDeadline\) \{[\s\S]*?publish\(true\);[\s\S]*?return;/);
  });
});
