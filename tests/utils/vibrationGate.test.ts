/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  VIBRATION GATE — one switch, one buzz
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ANIMATION/SOUND AUDIT 2026-08-20. Two defects, one gate:
 *
 *  1. SIX haptic implementations existed (utils/haptic, services/HapticService,
 *     SoundService.haptic, plus private copies in NumericKeypad,
 *     CashoutRequestModal and DepositWithdrawModal). Only ONE honoured both
 *     vibration switches; three honoured neither.
 *
 *  2. Sixteen call sites fired an explicit haptic AND a soundService.play*(),
 *     and every play method ends with its own haptic — so one event buzzed
 *     twice.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isVibrationAllowed,
  fireVibration,
  stopVibration,
  __resetVibrationCoalescing,
} from '../../src/utils/vibrationGate';

let fired: (number | number[])[] = [];

beforeEach(() => {
  fired = [];
  localStorage.clear();
  __resetVibrationCoalescing();
  vi.stubGlobal('navigator', {
    vibrate: (p: number | number[]) => {
      fired.push(p);
      return true;
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('vibration switches', () => {
  it('vibrates when neither switch has been set', () => {
    expect(isVibrationAllowed()).toBe(true);
    expect(fireVibration(10)).toBe(true);
    expect(fired).toEqual([10]);
  });

  it('is silenced by the SETTINGS switch', () => {
    localStorage.setItem('vibrationsEnabled', 'false');
    expect(fireVibration(10)).toBe(false);
    expect(fired).toEqual([]);
  });

  it('is silenced by the IN-TABLE switch — the one that used to be ignored', () => {
    localStorage.setItem('ca_vibration_enabled', 'false');
    expect(fireVibration(10)).toBe(false);
    expect(fired).toEqual([]);
  });

  it('stays silenced when only one of the two is off', () => {
    localStorage.setItem('vibrationsEnabled', 'true');
    localStorage.setItem('ca_vibration_enabled', 'false');
    expect(fireVibration(10)).toBe(false);
  });

  it('allows vibration when localStorage throws (private mode)', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(isVibrationAllowed()).toBe(true);
    spy.mockRestore();
  });

  it('reports unsupported when the device cannot vibrate', () => {
    vi.stubGlobal('navigator', {});
    expect(isVibrationAllowed()).toBe(false);
    expect(fireVibration(10)).toBe(false);
  });

  it('never throws when vibrate() throws (restricted webview)', () => {
    vi.stubGlobal('navigator', {
      vibrate: () => {
        throw new Error('blocked');
      },
    });
    expect(() => fireVibration(10)).not.toThrow();
    expect(fireVibration(10)).toBe(false);
  });
});

describe('coalescing — one event, one buzz', () => {
  it('drops a second equal buzz in the same instant', () => {
    // The real shape: an explicit haptic.light() plus SoundService's own.
    expect(fireVibration(10)).toBe(true);
    expect(fireVibration(10)).toBe(false);
    expect(fired).toEqual([10]);
  });

  it('lets the STRONGER intent through when both describe one instant', () => {
    expect(fireVibration(10)).toBe(true); // light
    expect(fireVibration([25, 20, 40])).toBe(true); // strong — should be felt
    expect(fired).toEqual([10, [25, 20, 40]]);
  });

  it('does not let a weaker buzz follow a stronger one', () => {
    expect(fireVibration([25, 20, 40])).toBe(true);
    expect(fireVibration(10)).toBe(false);
  });

  it('allows genuinely separate events once the window passes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
    expect(fireVibration(10)).toBe(true);
    // Flop cards are staggered 240ms apart — each must be felt.
    vi.setSystemTime(new Date('2026-08-20T12:00:00.240Z'));
    expect(fireVibration(10)).toBe(true);
    expect(fired).toEqual([10, 10]);
  });

  it('weighs only the BUZZ segments of a pattern, not the pauses', () => {
    // [10,50,30] is 40ms of buzz around a 50ms pause; [50] is 50ms of buzz.
    // Counting pauses would rank the first as stronger, which it is not.
    expect(fireVibration([10, 50, 30])).toBe(true);
    expect(fireVibration(50)).toBe(true);
  });

  it('coalescing never overrides the switches', () => {
    localStorage.setItem('ca_vibration_enabled', 'false');
    expect(fireVibration(10)).toBe(false);
    expect(fireVibration([25, 20, 40])).toBe(false);
    expect(fired).toEqual([]);
  });
});

describe('stopVibration', () => {
  it('cancels regardless of preference — stopping is always allowed', () => {
    localStorage.setItem('vibrationsEnabled', 'false');
    stopVibration();
    expect(fired).toEqual([0]);
  });
});
