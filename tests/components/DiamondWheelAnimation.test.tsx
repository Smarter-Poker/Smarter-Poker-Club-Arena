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
vi.mock('../../src/utils/animationSpeed', () => ({
  getAnimationSpeed: () => 1,
  prefersReducedMotion: () => false,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const rotorDegrees = (rotor: HTMLElement) =>
  Number(rotor.style.transform.match(/rotate\(([-\d.e]+)deg\)/)![1]);
describe('the wheel owes its complete visible reveal', () => {
  it('keeps both idle wheels moving slowly in opposite directions', () => {
    let callbacks: FrameRequestCallback[] = [];
    vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => {
      callbacks.push(fn);
      return callbacks.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const props = {
      segments: [],
      landingOrd: null,
      spinKey: 0,
      spinning: false,
      onLanded: vi.fn(),
    };
    const { container } = render(
      <>
        <DiamondWheel {...props} />
        <DiamondWheel {...props} upgraded idleDirection={-1} />
      </>
    );
    act(() => {
      const pending = callbacks;
      callbacks = [];
      pending.forEach((fn) => fn(50));
    });
    const rotors = container.querySelectorAll<HTMLElement>('[data-wheel-rotor]');
    expect(rotorDegrees(rotors[0])).toBeCloseTo(0.15);
    expect(rotorDegrees(rotors[1])).toBeCloseTo(-0.15);
    expect(sounds.playSpinStart).not.toHaveBeenCalled();
    expect(sounds.playSpinPeg).not.toHaveBeenCalled();
  });

  it('keeps the selected duration on a slow visible renderer instead of stretching every frame', () => {
    let frame: FrameRequestCallback | null = null;
    let now = 0;
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
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
    const { container } = render(
      <DiamondWheel segments={segments} landingOrd={3} spinKey={1} spinning onLanded={landed} />
    );
    const advance = (ms: number) =>
      act(() => {
        now += ms;
        const callback = frame!;
        frame = null;
        callback(now);
      });
    while (now + 200 < WHEEL_SPIN_MS) advance(200);
    expect(landed).not.toHaveBeenCalled();
    advance(WHEEL_SPIN_MS - now);
    expect(landed).toHaveBeenCalledTimes(1);
    // The rotor is a compositor layer: rotation is a CSS transform on the
    // HTML rotor, never an SVG attribute repainted on the main thread.
    expect(container.querySelector<HTMLElement>('[data-wheel-rotor]')!.style.transform).toBe(
      `rotate(${wheelLandingRotation(0, 2, 12)}deg)`
    );
    expect(sounds.playSpinResult).toHaveBeenCalledTimes(1);
    advance(500);
    expect(landed).toHaveBeenCalledTimes(1);
  });

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
