import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deviceLabel,
  qualityTierLabel,
  reportText,
  silentSwitchSummary,
  smoothness,
  vibrationHint,
  vibrationSummary,
} from '../../src/components/device/deviceReport';
import { QUALITY_STORAGE_KEY } from '../../src/components/games/qualityGovernor';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1';

afterEach(() => vi.unstubAllGlobals());

describe('the device check says what the device can do, in words', () => {
  it('names the device', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE, maxTouchPoints: 5 });
    expect(deviceLabel()).toBe('IPhone Or IPad Browser (Safari 26.5)');
    vi.stubGlobal('navigator', {
      userAgent: IPHONE.replace(/ Version\/26\.5/, ''),
      maxTouchPoints: 5,
    });
    expect(deviceLabel()).toBe('IPhone Or IPad Browser (Reports IOS 18.6)');
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile',
      maxTouchPoints: 5,
    });
    expect(deviceLabel()).toBe('Android Browser');
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'ios' });
    expect(deviceLabel()).toBe('Club Arena App On IPhone');
  });

  it('says honestly what vibration can do, and warns only where it is limited', () => {
    expect(vibrationSummary('app')).toMatch(/^Full/);
    expect(vibrationSummary('vibrate-api')).toMatch(/^Full/);
    expect(vibrationSummary('ios-taps')).toMatch(/^Taps Only/);
    expect(vibrationSummary('none')).toMatch(/^None/);
    expect(vibrationHint('ios-taps')).toBe('On IPhone Browsers, Buttons Buzz As You Tap Them.');
    expect(vibrationHint('none')).toBe('This Browser Cannot Vibrate.');
    expect(vibrationHint('app')).toBeNull();
    vi.stubGlobal('navigator', { maxTouchPoints: 5, vibrate: () => true });
    expect(vibrationHint('vibrate-api')).toBeNull();
    vi.stubGlobal('navigator', { maxTouchPoints: 0, vibrate: () => true });
    expect(vibrationHint('vibrate-api')).toBe('Buzzes On Phones With A Vibration Motor.');
  });

  it('says how the silent switch treats game sound', () => {
    expect(silentSwitchSummary(null, true)).toBe('Not Applicable On This Browser');
    expect(silentSwitchSummary('playback', true)).toBe('Heard With The Silent Switch On');
    expect(silentSwitchSummary('ambient', true)).toBe('Muted When The Silent Switch Is On');
    expect(silentSwitchSummary('playback', false)).toBe('Sounds Are Off In Settings');
  });

  it('names the quality tier the Diamond games settled on', () => {
    expect(qualityTierLabel(null)).toBe('Full (2x Pixels, Shadows)');
    const store = { getItem: (k: string) => (k === QUALITY_STORAGE_KEY ? '3' : null) };
    expect(qualityTierLabel(store)).toBe('Low (No Shadows) (1x Pixels)');
  });

  it('measures smoothness from frame stamps', () => {
    const steady = Array.from({ length: 61 }, (_, i) => i * (1000 / 60));
    expect(smoothness(steady)).toEqual({ fps: 60, slowShare: 0 });
    const choppy = [0, 16, 32, 100, 116, 132, 200];
    const r = smoothness(choppy)!;
    expect(r.slowShare).toBeCloseTo(2 / 6, 5);
    expect(smoothness([0, 16])).toBeNull();
  });

  it('writes a report a player can paste back', () => {
    expect(
      reportText([
        ['Device', 'Android Browser'],
        ['Vibration', 'Full'],
      ])
    ).toBe('Club Arena Device Check\nDevice: Android Browser\nVibration: Full');
  });
});
