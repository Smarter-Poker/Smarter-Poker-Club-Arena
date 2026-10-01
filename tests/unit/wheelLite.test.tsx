import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DiamondWheel from '../../src/components/wheel/DiamondWheel';
import {
  WHEEL_MIN_FRAMES,
  createWheelFrameWatch,
  resetWheelLite,
  wheelStartsLite,
} from '../../src/components/wheel/wheelLite';

const analytics = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../../src/lib/analytics', () => analytics);
vi.mock('../../src/services/SoundService', () => ({
  soundService: {
    playSpinStart: vi.fn(),
    playSpinTicking: vi.fn(),
    playSpinPeg: vi.fn(),
    playSpinResult: vi.fn(),
  },
}));

afterEach(() => {
  resetWheelLite();
  cleanup();
  vi.restoreAllMocks();
});

const nav = (deviceMemory?: number) => ({ deviceMemory }) as unknown as Navigator;

describe('the wheel on a cheap phone', () => {
  it('starts lite on 2 GB or less, and not where memory is unknown or ample', () => {
    expect(wheelStartsLite(nav(1))).toBe(true);
    expect(wheelStartsLite(nav(2))).toBe(true);
    expect(wheelStartsLite(nav(4))).toBe(false);
    expect(wheelStartsLite(nav(undefined))).toBe(false);
  });

  it('turns lite once a spin proves slow, and only once', () => {
    const watch = createWheelFrameWatch();
    let turned = 0;
    for (let i = 0; i < WHEEL_MIN_FRAMES - 1; i++) if (watch.frame(i % 2 ? 50 : 16)) turned++;
    expect(turned).toBe(0);
    if (watch.frame(50)) turned++;
    for (let i = 0; i < 10; i++) if (watch.frame(50)) turned++;
    expect(turned).toBe(1);
    // Every wheel after that, this visit, starts lite.
    expect(wheelStartsLite(nav(8))).toBe(true);
  });

  it('never turns lite on a smooth spin', () => {
    const watch = createWheelFrameWatch();
    for (let i = 0; i < 200; i++) expect(watch.frame(i % 10 === 0 ? 40 : 16.7)).toBe(false);
    expect(wheelStartsLite(nav(8))).toBe(false);
  });

  it('marks the wheel lite from its first paint on a small phone', () => {
    Object.defineProperty(navigator, 'deviceMemory', { value: 2, configurable: true });
    try {
      const { container } = render(
        <DiamondWheel
          segments={[]}
          landingOrd={null}
          spinKey={0}
          spinning={false}
          onLanded={() => {}}
        />
      );
      expect(container.querySelector('[data-motion="keep"]')).toHaveAttribute('data-lite');
    } finally {
      Reflect.deleteProperty(navigator, 'deviceMemory');
    }
  });
});

describe('a spin reports how the phone drew it', () => {
  it('sends one wheel summary on unmount, counting spin frames only', () => {
    let frame: FrameRequestCallback | null = null;
    let now = 0;
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => {
      frame = fn;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const segments = Array.from({ length: 12 }, (_, i) => ({
      ord: i + 1,
      kind: 'chips' as const,
      amount: 1,
      weight: 1,
      label: '1 Chip',
    }));
    const { unmount } = render(
      <DiamondWheel
        segments={segments as never}
        landingOrd={3}
        spinKey={1}
        spinning
        onLanded={() => {}}
      />
    );
    for (let i = 0; i < 60 && frame; i++)
      act(() => {
        now += 20;
        const callback = frame!;
        frame = null;
        callback(now);
      });
    expect(analytics.capture).not.toHaveBeenCalled();
    unmount();
    expect(analytics.capture).toHaveBeenCalledTimes(1);
    expect(analytics.capture).toHaveBeenCalledWith(
      'diamond_scene_session',
      expect.objectContaining({ game: 'wheel', software: false, start_tier: 0, fps: 50 })
    );
  });
});
