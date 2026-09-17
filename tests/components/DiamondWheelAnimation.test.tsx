import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DiamondWheel from '../../src/components/wheel/DiamondWheel';
import {
  WHEEL_SPIN_MS,
  wheelLandingRotation,
  wheelPegTimes,
} from '../../src/utils/diamondWheelMotion';
import type { WheelSegment } from '../../src/services/DiamondWheelService';
const sounds = vi.hoisted(() => ({
  playSpinStart: vi.fn(),
  playSpinTicking: vi.fn(),
  playSpinPeg: vi.fn(),
  playSpinResult: vi.fn(),
}));
vi.mock('../../src/services/SoundService', () => ({ soundService: sounds }));
vi.mock('../../src/utils/animationSpeed', () => ({ getAnimationSpeed: () => 1 }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
describe('the wheel owes its complete visible reveal', () => {
  it('keeps the result and matching peg sounds pending during a hidden tab', () => {
    let frame: FrameRequestCallback | null = null;
    let now = 0;
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => {
      frame = fn;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const landed = vi.fn();
    const segments = Array.from(
      { length: 12 },
      (_, i) =>
        ({ ord: i + 1, kind: 'chips', amount: 1, weight: 1, label: '1 Chip' }) as WheelSegment
    );
    render(
      <DiamondWheel segments={segments} landingOrd={3} spinKey={1} spinning onLanded={landed} />
    );
    const advance = (ms: number) =>
      act(() => {
        now += ms;
        const callback = frame!;
        frame = null;
        callback(now);
      });
    for (let i = 0; i < 20; i++) advance(50);
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    const heard = sounds.playSpinPeg.mock.calls.length;
    advance(60000);
    expect(sounds.playSpinPeg).toHaveBeenCalledTimes(heard);
    expect(landed).not.toHaveBeenCalled();
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    for (let i = 0; i < WHEEL_SPIN_MS / 50 - 20; i++) advance(50);
    expect(landed).toHaveBeenCalledTimes(1);
    expect(sounds.playSpinStart).toHaveBeenCalledTimes(1);
    expect(sounds.playSpinResult).toHaveBeenCalledTimes(1);
    expect(sounds.playSpinPeg).toHaveBeenCalledTimes(
      wheelPegTimes(0, wheelLandingRotation(0, 2, 12), 12, WHEEL_SPIN_MS).length
    );
    advance(500);
    expect(landed).toHaveBeenCalledTimes(1);
  });
});
