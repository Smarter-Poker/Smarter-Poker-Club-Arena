/**
 * The hero shot-clock timeout must fire ONCE per turn, not once per frame.
 *
 * The deadline callback in useTableTimer must
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
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const SRC = readFileSync(resolve(__dirname, '../../src/hooks/useTableTimer.ts'), 'utf8');

/** The same latch invariants, now in the deadline-aligned callback. */
const driverCallback = sliceEnclosingBlock(SRC, 'const deadlineNow = turnDeadlineRef.current');

describe('hero timeout latch', () => {
  it('reads the deadline through a ref, never the frozen prop', () => {
    // A prop read inside a once-only effect is frozen at mount. This is the
    // whole bug.
    expect(driverCallback).toContain('turnDeadlineRef.current');
    expect(
      driverCallback.includes('!== turnDeadlineMs'),
      'the latch compares the frozen prop; it must compare the ref'
    ).toBe(false);
  });

  it('compares the same value it stores, so the latch can actually latch', () => {
    // The original stored `turnDeadlineMs ?? 0` and compared against the raw
    // `turnDeadlineMs`. When that is undefined the two can never be equal.
    expect(driverCallback).toMatch(/const deadlineNow = turnDeadlineRef\.current \?\? 0;/);
    expect(driverCallback).toMatch(/heroFiredRef\.current !== deadlineNow/);
    expect(driverCallback).toMatch(/heroFiredRef\.current = deadlineNow;/);
  });

  it('keeps the ref assigned on every render', () => {
    // Declaring the ref is not enough; it has to track the prop.
    expect(SRC).toMatch(/turnDeadlineRef\.current = turnDeadlineMs;/);
  });

  it('runs the drivers only while a deadline exists, and settles the ring when it goes', () => {
    // An absent deadline must not leave a permanent background driver.
    // A new deadline may re-arm the bounded callback without inventing time.
    expect(SRC).toMatch(/const hasDeadline = Boolean\(turnDeadlineMs\);/);
    expect(SRC).toMatch(/if \(!hasDeadline\) \{[\s\S]*?publish\(true\);[\s\S]*?return;/);
  });
});
