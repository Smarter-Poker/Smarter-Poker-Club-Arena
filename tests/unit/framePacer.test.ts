/**
 * HOW OFTEN A DIAMOND SCENE DRAWS (2026-10-01): every display frame while it
 * moves, about 30 a second between rounds, nothing at all once parked, and
 * awake again on any tap, key or change in what it shows.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFramePacer,
  DISPLAY_FRAME_MS,
  PARK_AFTER_MS,
  SETTLE_GRACE_MS,
  SETTLED_FRAME_MS,
} from '../../src/components/games/framePacer';
import { signTextureScale } from '../../src/components/games/ChoiceScene';

let clock = 0;
const pacers: Array<{ dispose(): void }> = [];
const make = (reducedMs = 150) => {
  clock = 0;
  const pacer = createFramePacer({ reducedMs, now: () => clock });
  pacers.push(pacer);
  return pacer;
};
afterEach(() => pacers.splice(0).forEach((p) => p.dispose()));

describe('the frame pacer', () => {
  it('draws every display frame while the scene moves, and the grace after it', () => {
    const pacer = make();
    expect(pacer.pace(10, { reduced: false, moving: true, signature: 'a' })).toBe(0);
    expect(
      pacer.pace(10 + SETTLE_GRACE_MS - 1, { reduced: false, moving: false, signature: 'a' })
    ).toBe(0);
    expect(
      pacer.pace(10 + SETTLE_GRACE_MS + 1, { reduced: false, moving: false, signature: 'a' })
    ).toBe(SETTLED_FRAME_MS);
  });

  it('parks a settled, untouched scene, and wakes it on a tap or a new signature', () => {
    const pacer = make();
    pacer.pace(0, { reduced: false, moving: false, signature: 'idle' });
    expect(
      pacer.pace(PARK_AFTER_MS + 5, { reduced: false, moving: false, signature: 'idle' })
    ).toBe(Number.POSITIVE_INFINITY);
    expect(pacer.parked).toBe(true);
    clock = PARK_AFTER_MS + 10;
    window.dispatchEvent(new Event('pointerdown'));
    expect(
      pacer.pace(PARK_AFTER_MS + 11, { reduced: false, moving: false, signature: 'idle' })
    ).toBe(SETTLED_FRAME_MS);
    expect(pacer.parked).toBe(false);
    // Parked again later, then a new round starts with no tap (an auto run).
    expect(
      pacer.pace(2 * PARK_AFTER_MS + 20, { reduced: false, moving: false, signature: 'idle' })
    ).toBe(Number.POSITIVE_INFINITY);
    expect(
      pacer.pace(2 * PARK_AFTER_MS + 21, { reduced: false, moving: false, signature: 'round-2' })
    ).toBe(SETTLED_FRAME_MS);
  });

  it('keeps the scene own slow pace under reduced motion, and parks it too', () => {
    const pacer = make(180);
    expect(pacer.pace(0, { reduced: true, moving: true, signature: 'a' })).toBe(180);
    expect(pacer.pace(SETTLE_GRACE_MS + 1, { reduced: true, moving: false, signature: 'a' })).toBe(
      180
    );
    expect(
      pacer.pace(PARK_AFTER_MS + SETTLE_GRACE_MS, { reduced: true, moving: false, signature: 'a' })
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it('hands the governor a real frame interval, never zero or infinity', () => {
    const pacer = make();
    expect(pacer.governorInterval(0)).toBe(DISPLAY_FRAME_MS);
    expect(pacer.governorInterval(SETTLED_FRAME_MS)).toBe(SETTLED_FRAME_MS);
    expect(pacer.governorInterval(Number.POSITIVE_INFINITY)).toBe(DISPLAY_FRAME_MS);
  });

  it('stops listening when disposed', () => {
    const pacer = make();
    pacer.pace(0, { reduced: false, moving: false, signature: 'a' });
    pacer.dispose();
    clock = PARK_AFTER_MS + 10;
    window.dispatchEvent(new Event('keydown'));
    expect(pacer.pace(PARK_AFTER_MS + 11, { reduced: false, moving: false, signature: 'a' })).toBe(
      Number.POSITIVE_INFINITY
    );
  });
});

describe('the Donkey Cross street signs', () => {
  it('are painted at twice the size on a sharp screen, and as before on a 1x one', () => {
    expect(signTextureScale(1)).toBe(1);
    expect(signTextureScale(undefined)).toBe(1);
    expect(signTextureScale(2)).toBe(2);
    expect(signTextureScale(3)).toBe(2);
  });
});
