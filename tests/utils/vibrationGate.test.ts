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

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  iOS: THE PLATFORM WITH NO VIBRATION API (2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Apple has never shipped `navigator.vibrate` in WebKit, so before this every
 * haptic in Club Arena was silently dead on iPhone and iPad - the turn alert,
 * the keypad, the card-slide peel. The gate refused at the capability check
 * before any fallback could run.
 *
 * The fallback is the one thing that does buzz on iOS: toggling a native
 * `<input type="checkbox" switch>`. It is the mechanism behind
 * ios-vibrator-pro-max (ISC) WITHOUT that library's global body reparent and
 * MutationObservers, which this app cannot afford.
 */
describe('iOS, where navigator.vibrate does not exist', () => {
  const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

  function asIphone() {
    // No `vibrate` key at all - that is what an iPhone actually looks like.
    vi.stubGlobal('navigator', { userAgent: IPHONE, maxTouchPoints: 5 });
  }

  function switchClicks(): number {
    const el = document.querySelector('input[type="checkbox"][switch]');
    return el ? Number((el as HTMLElement).dataset.clicks || 0) : -1;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    __resetVibrationCoalescing();
  });

  it('buzzes through the switch element instead of giving up', () => {
    asIphone();
    // Count real clicks on whatever element the gate creates.
    const observed: string[] = [];
    const realClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function () {
      observed.push(this.tagName);
    };
    try {
      expect(fireVibration(10)).toBe(true);
      expect(observed).toContain('INPUT');
      const input = document.querySelector('input[type="checkbox"][switch]');
      expect(input).toBeTruthy();
      expect(input?.getAttribute('switch')).toBe('');
    } finally {
      HTMLElement.prototype.click = realClick;
    }
    void switchClicks;
  });

  it('still obeys BOTH switches - either one off means silent', () => {
    asIphone();
    for (const key of ['vibrationsEnabled', 'ca_vibration_enabled']) {
      document.body.innerHTML = '';
      __resetVibrationCoalescing();
      localStorage.clear();
      localStorage.setItem(key, 'false');
      expect(fireVibration(10), key).toBe(false);
      expect(document.querySelector('input[switch]'), key).toBeNull();
    }
    localStorage.clear();
  });

  it('does not build the element on a desktop, which has the real API', () => {
    // Desktop Chromium HAS navigator.vibrate; it just returns false (no motor).
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141 Safari/537.36',
      maxTouchPoints: 0,
      vibrate: () => false,
    });
    expect(fireVibration(10)).toBe(true); // took the native path
    expect(document.querySelector('input[switch]')).toBeNull();
  });

  it('an Android phone keeps using the real API, untouched', () => {
    const calls: (number | number[])[] = [];
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36',
      maxTouchPoints: 5,
      vibrate: (p: number | number[]) => {
        calls.push(p);
        return true;
      },
    });
    expect(fireVibration([15, 30, 15])).toBe(true);
    expect(calls).toEqual([[15, 30, 15]]);
    expect(document.querySelector('input[switch]')).toBeNull();
  });

  it('never throws, even with no body to attach to', () => {
    asIphone();
    const body = document.body;
    Object.defineProperty(document, 'body', { value: null, configurable: true });
    try {
      expect(() => fireVibration(10)).not.toThrow();
      expect(fireVibration(10)).toBe(false);
    } finally {
      Object.defineProperty(document, 'body', { value: body, configurable: true });
    }
  });
});
