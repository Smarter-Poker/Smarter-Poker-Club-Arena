import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DiamondWheel from '../../src/components/wheel/DiamondWheel';
import {
  WHEEL_SPIN_MS,
  wheelLandingRotation,
  wheelPointerDeflection,
} from '../../src/utils/diamondWheelMotion';
import type { WheelSegment } from '../../src/services/DiamondWheelService';

// Owner ruling 2026-09-21, R7: "the bottom wheel should be slowly rotating
// like the upper wheel until it is spun. It should not be fixed." The main
// wheel holds its landed prize only while the receipt is being revealed, then
// drifts on from that very angle, and the next spin leaves from wherever the
// drift has carried it. Nothing snaps back to zero.

const sounds = vi.hoisted(() => ({
  playSpinStart: vi.fn(),
  playSpinTicking: vi.fn(),
  playSpinPeg: vi.fn(),
  playSpinResult: vi.fn(),
}));
vi.mock('../../src/services/SoundService', () => ({ soundService: sounds }));
const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock('../../src/utils/animationSpeed', () => ({
  getAnimationSpeed: () => 1,
  prefersReducedMotion: () => motion.reduced,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  motion.reduced = false;
});

const segments = Array.from(
  { length: 12 },
  (_, i) => ({ ord: i + 1, kind: 'chips', amount: 1, weight: 1, label: '1 Chip' }) as WheelSegment
);
const IDLE_DEGREES_PER_SECOND = 3;

function clock() {
  let frame: FrameRequestCallback | null = null;
  let now = 0;
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => {
    frame = fn;
    return 1;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  const advance = (ms: number) =>
    act(() => {
      now += ms;
      const callback = frame;
      frame = null;
      callback?.(now);
    });
  return { advance, scheduled: () => frame !== null, time: () => now };
}
const degrees = (rotor: Element) =>
  Number((rotor as HTMLElement).style.transform.match(/rotate\(([-\d.e]+)deg\)/)![1]);

describe('the main wheel idles like the upper wheel until it is spun', () => {
  it('holds the landed prize through the reveal, then drifts on from that angle once the receipt clears', () => {
    const { advance, scheduled } = clock();
    const landed = vi.fn();
    const view = render(
      <DiamondWheel segments={segments} landingOrd={3} spinKey={1} spinning onLanded={landed} />
    );
    const rotor = view.container.querySelector('[data-wheel-rotor]')!;
    const frame = view.container.querySelector('[data-phase]')!;
    while (!landed.mock.calls.length) advance(100);
    const landedAngle = wheelLandingRotation(0, 2, 12);
    expect(degrees(rotor)).toBe(landedAngle);

    // The page keeps the receipt while the reveal is open: the wheel holds
    // and its frame loop goes quiet.
    view.rerender(
      <DiamondWheel
        segments={segments}
        landingOrd={3}
        spinKey={1}
        spinning={false}
        onLanded={landed}
      />
    );
    advance(100);
    advance(2000);
    expect(degrees(rotor)).toBe(landedAngle);
    expect(frame).toHaveAttribute('data-phase', 'landed');
    expect(scheduled()).toBe(false);

    // Acknowledged: the receipt is cleared and the drift resumes from the
    // landed angle at the upper wheel's 3 degrees per second.
    view.rerender(
      <DiamondWheel
        segments={segments}
        landingOrd={null}
        spinKey={1}
        spinning={false}
        onLanded={landed}
      />
    );
    expect(scheduled()).toBe(true);
    advance(0);
    advance(1000);
    expect(degrees(rotor)).toBeCloseTo(landedAngle + IDLE_DEGREES_PER_SECOND, 5);
    expect(frame).toHaveAttribute('data-phase', 'idle');
    expect(view.container.querySelector('[data-winner]')).toBeNull();
    advance(1000);
    expect(degrees(rotor)).toBeCloseTo(landedAngle + 2 * IDLE_DEGREES_PER_SECOND, 5);
    expect(sounds.playSpinResult).toHaveBeenCalledTimes(1);
  });

  it('starts the next spin from the drifted angle instead of snapping to zero', () => {
    const { advance } = clock();
    const landed = vi.fn();
    const view = render(
      <DiamondWheel
        segments={segments}
        landingOrd={null}
        spinKey={0}
        spinning={false}
        onLanded={landed}
      />
    );
    const rotor = view.container.querySelector('[data-wheel-rotor]')!;
    advance(0);
    advance(5000);
    const drifted = degrees(rotor);
    expect(drifted).toBeCloseTo(15, 5);
    view.rerender(
      <DiamondWheel segments={segments} landingOrd={7} spinKey={1} spinning onLanded={landed} />
    );
    advance(0);
    expect(degrees(rotor)).toBeCloseTo(drifted, 5);
    advance(16);
    expect(degrees(rotor)).toBeGreaterThan(drifted);
    expect(degrees(rotor)).toBeLessThan(drifted + 1);
    while (!landed.mock.calls.length) advance(100);
    expect(degrees(rotor)).toBe(wheelLandingRotation(drifted, 6, 12));
    expect(sounds.playSpinStart).toHaveBeenCalledTimes(1);
  });

  it('holds while holdResult says so even without a receipt, and pauses the drift under a reveal', () => {
    const { advance, scheduled } = clock();
    const landed = vi.fn();
    const view = render(
      <DiamondWheel segments={segments} landingOrd={3} spinKey={1} spinning onLanded={landed} />
    );
    const rotor = view.container.querySelector('[data-wheel-rotor]')!;
    while (!landed.mock.calls.length) advance(100);
    const landedAngle = degrees(rotor);
    view.rerender(
      <DiamondWheel
        segments={segments}
        landingOrd={null}
        spinKey={1}
        spinning={false}
        holdResult
        onLanded={landed}
      />
    );
    advance(0);
    advance(3000);
    expect(degrees(rotor)).toBe(landedAngle);
    view.rerender(
      <DiamondWheel
        segments={segments}
        landingOrd={null}
        spinKey={1}
        spinning={false}
        paused
        onLanded={landed}
      />
    );
    advance(0);
    advance(3000);
    expect(degrees(rotor)).toBe(landedAngle);
    expect(scheduled()).toBe(false);
    view.rerender(
      <DiamondWheel
        segments={segments}
        landingOrd={null}
        spinKey={1}
        spinning={false}
        onLanded={landed}
      />
    );
    advance(0);
    advance(1000);
    expect(degrees(rotor)).toBeCloseTo(landedAngle + IDLE_DEGREES_PER_SECOND, 5);
  });

  it('never shortens an owed spin because the reveal of the previous one is still paused', () => {
    const { advance } = clock();
    const landed = vi.fn();
    render(
      <DiamondWheel
        segments={segments}
        landingOrd={5}
        spinKey={2}
        spinning
        paused
        onLanded={landed}
      />
    );
    advance(0);
    while ((advance(200), performance.now() + 200 < WHEEL_SPIN_MS));
    expect(landed).not.toHaveBeenCalled();
    advance(WHEEL_SPIN_MS);
    expect(landed).toHaveBeenCalledTimes(1);
  });

  it('stops the drift where it is while the wheel is off screen, and marks the frame', () => {
    let notify: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      }
    );
    const { advance, scheduled } = clock();
    const view = render(
      <DiamondWheel
        segments={segments}
        landingOrd={null}
        spinKey={0}
        spinning={false}
        onLanded={vi.fn()}
      />
    );
    const rotor = view.container.querySelector('[data-wheel-rotor]')!;
    const frame = view.container.firstElementChild!;
    advance(0);
    advance(2000);
    expect(degrees(rotor)).toBeCloseTo(6, 5);
    act(() => notify!([{ isIntersecting: false }]));
    advance(0);
    advance(5000);
    expect(degrees(rotor)).toBeCloseTo(6, 5);
    expect(frame.hasAttribute('data-offscreen')).toBe(true);
    expect(scheduled()).toBe(false);
    // Only the newest entry counts: a stale one must not strand the wheel.
    act(() => notify!([{ isIntersecting: false }, { isIntersecting: true }]));
    expect(frame.hasAttribute('data-offscreen')).toBe(false);
    advance(0);
    advance(1000);
    expect(degrees(rotor)).toBeCloseTo(9, 5);
    vi.unstubAllGlobals();
  });

  it('freezes the drift while the tab is hidden and carries on when it comes back', () => {
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const { advance } = clock();
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const view = render(
      <DiamondWheel
        segments={segments}
        landingOrd={null}
        spinKey={0}
        spinning={false}
        onLanded={vi.fn()}
      />
    );
    const rotor = view.container.querySelector('[data-wheel-rotor]')!;
    advance(0);
    advance(3000);
    expect(degrees(rotor)).toBeCloseTo(9, 5);
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    advance(30000);
    expect(degrees(rotor)).toBeCloseTo(9, 5);
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    advance(0);
    advance(1000);
    expect(degrees(rotor)).toBeCloseTo(12, 5);
  });

  it('collapses the idle drift, and only the drift, under prefers-reduced-motion', () => {
    motion.reduced = true;
    const { advance, scheduled } = clock();
    const landed = vi.fn();
    const view = render(
      <DiamondWheel
        segments={segments}
        landingOrd={null}
        spinKey={0}
        spinning={false}
        onLanded={landed}
      />
    );
    const rotor = view.container.querySelector('[data-wheel-rotor]')!;
    advance(0);
    advance(4000);
    expect(degrees(rotor)).toBe(0);
    expect(scheduled()).toBe(false);
    view.rerender(
      <DiamondWheel segments={segments} landingOrd={2} spinKey={1} spinning onLanded={landed} />
    );
    advance(0);
    while (!landed.mock.calls.length) advance(100);
    expect(degrees(rotor)).toBe(wheelLandingRotation(0, 1, 12));
  });
});

describe('with Web Animations the idle drift leaves the main thread entirely', () => {
  type Stub = {
    keyframes: Keyframe[];
    options: KeyframeAnimationOptions;
    cancel: () => void;
    currentTime: number | null;
    cancelled: boolean;
  };
  function stubAnimate() {
    const started: Stub[] = [];
    // happy-dom has no Web Animations; the wheel falls back to its frame loop
    // there, which the tests above pin. Stub the API to pin the compositor path.
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (
      keyframes: Keyframe[],
      options: KeyframeAnimationOptions
    ) {
      const stub: Stub = {
        keyframes,
        options,
        currentTime: 0,
        cancelled: false,
        cancel() {
          stub.cancelled = true;
        },
      };
      started.push(stub);
      return stub as unknown as Animation;
    };
    return started;
  }
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  });

  it('drifts the rotor and pointer as infinite compositor animations and schedules no frames', () => {
    const started = stubAnimate();
    const { advance, scheduled } = clock();
    const view = render(
      <DiamondWheel
        segments={segments}
        landingOrd={null}
        spinKey={0}
        spinning={false}
        onLanded={vi.fn()}
      />
    );
    advance(0);
    expect(scheduled()).toBe(false);
    const [rotor, pointer] = started;
    expect(rotor.keyframes).toEqual([
      { transform: 'rotate(0deg)' },
      { transform: 'rotate(360deg)' },
    ]);
    expect(rotor.options).toMatchObject({
      duration: 120000,
      iterations: Infinity,
      easing: 'linear',
    });
    // One sector (30 degrees at 3 degrees per second) of pawl deflection, repeated.
    expect(pointer.options).toMatchObject({ duration: 10000, iterations: Infinity });
    expect(pointer.keyframes[0]).toEqual({
      offset: 0,
      transform: `rotate(${wheelPointerDeflection(0, 12, 1)}deg)`,
    });
    expect(pointer.keyframes.at(-1)!.offset).toBe(1);
    expect(pointer.keyframes.at(-1)!.transform).toBe(
      `rotate(${wheelPointerDeflection(30, 12, 1)}deg)`
    );
    expect(pointer.keyframes.some((frame) => frame.transform === 'rotate(0deg)')).toBe(true);
    expect(view.container.querySelector<HTMLElement>('[data-wheel-rotor]')!.style.transform).toBe(
      'rotate(0deg)'
    );
  });

  it('starts the next spin from the angle the drift has reached and cancels the drift', () => {
    const started = stubAnimate();
    const { advance } = clock();
    const landed = vi.fn();
    const view = render(
      <DiamondWheel
        segments={segments}
        landingOrd={null}
        spinKey={0}
        spinning={false}
        onLanded={landed}
      />
    );
    advance(0);
    started[0].currentTime = 20000; // 20 s of drift: 60 degrees
    view.rerender(
      <DiamondWheel segments={segments} landingOrd={7} spinKey={1} spinning onLanded={landed} />
    );
    expect(started[0].cancelled).toBe(true);
    expect(started[1].cancelled).toBe(true);
    const rotor = view.container.querySelector<HTMLElement>('[data-wheel-rotor]')!;
    advance(0);
    expect(degrees(rotor)).toBeCloseTo(60, 5);
    while (!landed.mock.calls.length) advance(100);
    expect(degrees(rotor)).toBe(wheelLandingRotation(60, 6, 12));
    expect(started).toHaveLength(2);
  });

  it('freezes the drift where it is while paused and resumes from there', () => {
    const started = stubAnimate();
    const { advance, scheduled } = clock();
    const view = render(
      <DiamondWheel
        segments={segments}
        landingOrd={null}
        spinKey={0}
        spinning={false}
        onLanded={vi.fn()}
      />
    );
    advance(0);
    started[0].currentTime = 5000;
    view.rerender(
      <DiamondWheel
        segments={segments}
        landingOrd={null}
        spinKey={0}
        spinning={false}
        paused
        onLanded={vi.fn()}
      />
    );
    advance(0);
    const rotor = view.container.querySelector<HTMLElement>('[data-wheel-rotor]')!;
    expect(started[0].cancelled).toBe(true);
    expect(degrees(rotor)).toBeCloseTo(15, 5);
    expect(scheduled()).toBe(false);
    view.rerender(
      <DiamondWheel
        segments={segments}
        landingOrd={null}
        spinKey={0}
        spinning={false}
        onLanded={vi.fn()}
      />
    );
    advance(0);
    expect(started).toHaveLength(4);
    expect(started[2].keyframes[0]).toEqual({ transform: 'rotate(15deg)' });
  });
});
