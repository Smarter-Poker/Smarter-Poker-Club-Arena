import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startMotionBudget,
  isMotionLite,
  setMotionLite,
  MOTION_ATTR,
  MOTION_LITE,
  __resetMotionBudget,
} from '../../src/utils/motionBudget';

/**
 * The value of this module is entirely in NOT firing wrongly. Shedding motion on
 * a device that was fine is a silent downgrade nobody reports; failing to shed
 * it on a device that is drowning is the bug it exists to prevent. So the tests
 * are mostly about the ways a naive version would be fooled.
 */

/** Drives rAF with a scripted list of frame deltas, in ms. */
function runFrames(deltas: number[]) {
  let now = 0;
  let queued: ((t: number) => void) | null = null;
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    queued = cb;
    return 1;
  });
  vi.stubGlobal('performance', { now: () => now });

  startMotionBudget();

  for (const d of deltas) {
    if (!queued) break;
    now += d;
    const cb = queued;
    queued = null;
    cb(now);
  }
}

beforeEach(() => {
  __resetMotionBudget();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  __resetMotionBudget();
});

describe('motion budget', () => {
  it('leaves a healthy 60fps device alone', () => {
    runFrames(Array(70).fill(16));
    expect(isMotionLite(), 'a 60fps device must keep its ambient motion').toBe(false);
  });

  it('sheds ambient motion on a sustained sub-30fps device', () => {
    runFrames(Array(70).fill(40));
    expect(isMotionLite()).toBe(true);
    expect(document.documentElement.getAttribute(MOTION_ATTR)).toBe(MOTION_LITE);
  });

  it('is not fooled by a single catastrophic frame', () => {
    // One 900ms GC pause in an otherwise perfect run. A mean would be dragged
    // over the threshold by this; the median is not, which is the whole reason
    // the median is used.
    const frames = Array(70).fill(16);
    frames[30] = 900;
    runFrames(frames);
    expect(isMotionLite(), 'one spike must not demote a healthy device').toBe(false);
  });

  it('does not measure a hidden tab', () => {
    // A backgrounded tab is throttled to roughly 1fps by the browser. Measuring
    // through that would demote every device the moment a player switches tab.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    runFrames(Array(70).fill(1000));
    expect(isMotionLite(), 'a hidden tab is throttled, not slow').toBe(false);
  });

  it('samples once — later seats are free', () => {
    let rafCalls = 0;
    let now = 0;
    let queued: ((t: number) => void) | null = null;
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      rafCalls++;
      queued = cb;
      return 1;
    });
    vi.stubGlobal('performance', { now: () => now });

    // Nine seats all calling it, as they do.
    for (let i = 0; i < 9; i++) startMotionBudget();
    expect(rafCalls, 'nine seats must not start nine samplers').toBe(1);

    // Drain and confirm it still completes.
    for (let i = 0; i < 70 && queued; i++) {
      now += 16;
      const cb = queued;
      queued = null;
      cb(now);
    }
    expect(isMotionLite()).toBe(false);
  });

  it('exposes a manual override that CSS can key off', () => {
    setMotionLite(true);
    expect(document.documentElement.getAttribute(MOTION_ATTR)).toBe(MOTION_LITE);
    setMotionLite(false);
    expect(document.documentElement.hasAttribute(MOTION_ATTR)).toBe(false);
  });
});
