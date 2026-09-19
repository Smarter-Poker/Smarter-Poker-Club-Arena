import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
const frames = vi.hoisted(() => ({ render: vi.fn(() => true), cleanup: vi.fn() }));
vi.mock('../../src/components/games/sceneKit', async (original) => {
  const actual = await original<typeof import('../../src/components/games/sceneKit')>();
  const THREE = await import('three');
  return {
    ...actual,
    gameRenderer: (canvas: HTMLCanvasElement) => ({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      renderer: { domElement: canvas },
      ...frames,
    }),
  };
});
import CrashCurve from '../../src/components/crash/CrashCurve';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Crash result waits for the actual scene completion', () => {
  it('does not spend the remaining flight reveal while its tab is hidden', () => {
    let frame: FrameRequestCallback = () => {};
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    frames.render.mockReturnValue(true);
    const onSettled = vi.fn();
    render(
      <CrashCurve
        phase="cashed"
        growthK={0.12}
        capCents={10000}
        startedAtLocalMs={0}
        finalCents={257}
        cashoutCents={257}
        crashCents={950}
        autoCashoutCents={null}
        onSettled={onSettled}
      />
    );
    frame(100);
    frame(600);
    hidden = true;
    fireEvent(document, new Event('visibilitychange'));
    frame(11000);
    hidden = false;
    fireEvent(document, new Event('visibilitychange'));
    frame(11100);
    frame(13900);
    expect(onSettled).not.toHaveBeenCalled();
    frame(14000);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
  it.each([
    { phase: 'cashed' as const, before: 3300, after: 3600 },
    { phase: 'crashed' as const, before: 1100, after: 1400 },
  ])('holds $phase until its final frame is submitted', ({ phase, before, after }) => {
    let frame: FrameRequestCallback = () => {};
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const onSettled = vi.fn();
    render(
      <CrashCurve
        phase={phase}
        growthK={0.12}
        capCents={10000}
        startedAtLocalMs={0}
        finalCents={257}
        cashoutCents={257}
        crashCents={950}
        autoCashoutCents={null}
        onSettled={onSettled}
      />
    );
    frame(100);
    frame(before);
    expect(onSettled).not.toHaveBeenCalled();
    frames.render.mockReturnValue(false);
    frame(after);
    expect(onSettled).not.toHaveBeenCalled();
    frames.render.mockReturnValue(true);
    frame(after + 200);
    expect(onSettled).toHaveBeenCalledTimes(1);
    frame(after + 400);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
