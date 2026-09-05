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
  iosWebkitVersion,
  isIosHapticSupported,
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
  /*
   * DAN TESTED THE FIRST VERSION OF THIS AND FELT NOTHING. Every pin below is
   * one of the four things that was wrong, read out of ios-vibrator-pro-max
   * @3.0.3's own source (dist/vibration.js, dist/methods/click-grant,
   * dist/utils/supported-versions.js) rather than out of a description of it:
   *
   *   it clicked the INPUT, not the LABEL
   *   it flipped `.checked` before clicking, so the control ended where it began
   *   it appended an off-screen label to document.body; the trigger is DETACHED
   *   it had no version floor, so it returned true on an iPhone that cannot buzz
   *
   * A test that only asserted "some element got clicked" passed against all
   * four. These assert the specific thing each time.
   */
  const IPHONE_SAFARI =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
  // A home-screen install: no "Version/", no "Safari". This is the shape most
  // likely to be holding a table, and the first version could not read it.
  const IPHONE_PWA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

  function asIphone(ua = IPHONE_SAFARI) {
    // No `vibrate` key at all - that is what an iPhone actually looks like.
    vi.stubGlobal('navigator', { userAgent: ua, maxTouchPoints: 5 });
  }

  /** Record every element the gate clicks, by tag. */
  function recordClicks(): { tags: string[]; targets: HTMLElement[]; restore: () => void } {
    const tags: string[] = [];
    const targets: HTMLElement[] = [];
    const real = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function (this: HTMLElement) {
      tags.push(this.tagName);
      targets.push(this);
    };
    return { tags, targets, restore: () => (HTMLElement.prototype.click = real) };
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    __resetVibrationCoalescing();
  });

  it('CLICKS THE LABEL, NOT THE INPUT', () => {
    asIphone();
    const rec = recordClicks();
    try {
      expect(fireVibration(10)).toBe(true);
      expect(rec.tags).toEqual(['LABEL']);
      expect(rec.tags).not.toContain('INPUT');
    } finally {
      rec.restore();
    }
  });

  it('the label wraps a native switch input that is display:none', () => {
    asIphone();
    const rec = recordClicks();
    try {
      fireVibration(10);
      const label = rec.targets[0];
      const input = label.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.getAttribute('switch')).toBe('');
      expect(input.getAttribute('style')).toContain('display: none');
    } finally {
      rec.restore();
    }
  });

  it('NEVER touches .checked - the click is the whole state change', () => {
    asIphone();
    const rec = recordClicks();
    try {
      fireVibration(10);
      const input = rec.targets[0].querySelector('input') as HTMLInputElement;
      // click() is stubbed here, so nothing has toggled it. If the gate were
      // setting `.checked` itself, this would be true - and on a real device
      // the click that followed would toggle it straight back to where it was.
      expect(input.checked).toBe(false);
    } finally {
      rec.restore();
    }
  });

  it('THE TRIGGER IS DETACHED - nothing is added to the document', () => {
    asIphone();
    const rec = recordClicks();
    try {
      fireVibration(10);
      expect(document.querySelector('input[switch]')).toBeNull();
      expect(document.querySelector('label')).toBeNull();
      expect(rec.targets[0].isConnected).toBe(false);
    } finally {
      rec.restore();
    }
  });

  it('reads the version out of a PWA user agent, which has no Version/ token', () => {
    asIphone(IPHONE_PWA);
    expect(iosWebkitVersion()).toBeCloseTo(18.5, 5);
    expect(isIosHapticSupported()).toBe(true);
    const rec = recordClicks();
    try {
      expect(fireVibration(10)).toBe(true);
      expect(rec.tags).toEqual(['LABEL']);
    } finally {
      rec.restore();
    }
  });

  it('REFUSES below the version floor rather than reporting a buzz that did not happen', () => {
    // 18.3: the click-inside-a-gesture path does not work there. The only
    // thing that would is the body reparent we have deliberately refused, so
    // the honest answer is false.
    asIphone(IPHONE_PWA.replace('18_5', '18_3'));
    expect(iosWebkitVersion()).toBeCloseTo(18.3, 5);
    expect(isIosHapticSupported()).toBe(false);
    expect(fireVibration(10)).toBe(false);

    __resetVibrationCoalescing();
    asIphone(IPHONE_PWA.replace('18_5', '18_4'));
    expect(isIosHapticSupported()).toBe(true);
    expect(fireVibration(10)).toBe(true);
  });

  it('an iPad reporting a Mac user agent is still recognised', () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
      maxTouchPoints: 5,
    });
    expect(iosWebkitVersion()).toBeCloseTo(18.5, 5);
    expect(fireVibration(10)).toBe(true);
  });

  it('still obeys BOTH switches - either one off means silent', () => {
    for (const key of ['vibrationsEnabled', 'ca_vibration_enabled']) {
      __resetVibrationCoalescing();
      localStorage.clear();
      localStorage.setItem(key, 'false');
      asIphone();
      const rec = recordClicks();
      try {
        expect(fireVibration(10), key).toBe(false);
        expect(rec.tags, key).toEqual([]);
      } finally {
        rec.restore();
      }
    }
    localStorage.clear();
  });

  it('does not take the iOS path on a desktop, which has the real API', () => {
    // Desktop Chromium HAS navigator.vibrate; it just returns false (no motor).
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141 Safari/537.36',
      maxTouchPoints: 0,
      vibrate: () => false,
    });
    const rec = recordClicks();
    try {
      expect(fireVibration(10)).toBe(true); // took the native path
      expect(rec.tags).toEqual([]);
    } finally {
      rec.restore();
    }
    expect(iosWebkitVersion()).toBeNull();
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
    expect(iosWebkitVersion()).toBeNull();
  });

  it('a multi-pulse pattern clicks once per pulse, capped at three', () => {
    vi.useFakeTimers();
    asIphone();
    const rec = recordClicks();
    try {
      expect(fireVibration([10, 20, 10, 20, 10, 20, 10])).toBe(true);
      expect(rec.tags).toEqual(['LABEL']); // the first is synchronous
      vi.advanceTimersByTime(1000);
      expect(rec.tags.length).toBe(3);
      expect(rec.tags.every((t) => t === 'LABEL')).toBe(true);
    } finally {
      rec.restore();
      vi.useRealTimers();
    }
  });

  it('never throws, and does not need a body to attach to', () => {
    asIphone();
    const body = document.body;
    Object.defineProperty(document, 'body', { value: null, configurable: true });
    const rec = recordClicks();
    try {
      // The trigger is detached, so a missing body is simply not its problem.
      expect(() => fireVibration(10)).not.toThrow();
      expect(rec.tags).toEqual(['LABEL']);
    } finally {
      rec.restore();
      Object.defineProperty(document, 'body', { value: body, configurable: true });
    }
  });
});
