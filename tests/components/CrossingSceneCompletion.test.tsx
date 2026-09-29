import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const frames = vi.hoisted(() => ({ render: vi.fn(() => false), dispose: vi.fn() }));
vi.mock('../../src/components/games/gpuFrameRenderer', () => ({ gpuFrameRenderer: () => frames }));
vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>();
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = document.createElement('canvas');
      shadowMap = {};
      setPixelRatio() {}
      setSize() {}
      render() {}
      dispose() {}
      forceContextLoss() {}
    },
    PMREMGenerator: class {
      fromScene() {
        return { texture: new actual.Texture(), dispose() {} };
      }
      dispose() {}
    },
  };
});
import ChoiceScene from '../../src/components/games/ChoiceScene';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Crossing terminal frame ownership', () => {
  it('reveals the full remaining route before completing a booked win', () => {
    let frame: FrameRequestCallback = () => {};
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillRect() {},
      strokeRect() {},
      fillText() {},
    } as unknown as CanvasRenderingContext2D);
    frames.render.mockReturnValue(true);
    const onSettled = vi.fn();
    render(
      <ChoiceScene
        game="crossing"
        roundId="booked"
        picked={[0]}
        mines={null}
        phase="cashed"
        roadEnd={8}
        busy={false}
        onPick={() => {}}
        onSettled={onSettled}
      />
    );
    frame(100);
    frame(600);
    frame(3200);
    expect(onSettled).not.toHaveBeenCalled();
    frame(3400);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
  it.each(['open', 'lost'] as const)(
    'holds %s completion until the terminal frame is submitted',
    (phase) => {
      let frame: FrameRequestCallback = () => {};
      vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
        frame = callback;
        return 1;
      });
      vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        fillRect() {},
        strokeRect() {},
        fillText() {},
      } as unknown as CanvasRenderingContext2D);
      frames.render.mockReturnValue(false);
      const onSettled = vi.fn();
      const view = render(
        <ChoiceScene
          game="crossing"
          picked={[0]}
          mines={null}
          phase={phase}
          roadEnd={null}
          busy={false}
          onPick={() => {}}
          onSettled={onSettled}
        />
      );
      frame(100);
      frame(4000);
      frame(4100);
      expect(onSettled).not.toHaveBeenCalled();
      frames.render.mockReturnValue(true);
      frame(4200);
      expect(onSettled).toHaveBeenCalledTimes(1);
      frame(4300);
      expect(onSettled).toHaveBeenCalledTimes(1);
      view.unmount();
      expect(frames.dispose).toHaveBeenCalledTimes(1);
    }
  );

  /**
   * The scene holds a street's beat for the frame that shows it, so a context
   * that never submits a frame could hold the result for good. Completion
   * itself still waits however long its terminal frame takes (the case above
   * holds through 4.1 s): only a beat nobody can see gets a deadline, and it
   * ends on the existing failed path rather than in a second watchdog.
   */
  it('hands a beat nobody can see to the failed path after eight seconds', () => {
    let frame: FrameRequestCallback = () => {};
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillRect() {},
      strokeRect() {},
      fillText() {},
    } as unknown as CanvasRenderingContext2D);
    frames.render.mockReturnValue(false);
    const onSettled = vi.fn();
    const onMoment = vi.fn();
    const scene = (extra: Partial<Parameters<typeof ChoiceScene>[0]>) => (
      <ChoiceScene
        game="crossing"
        roundId="stuck"
        picked={[0]}
        mines={null}
        phase="open"
        roadEnd={null}
        busy={false}
        onPick={() => {}}
        onSettled={onSettled}
        onMoment={onMoment}
        {...extra}
      />
    );
    const view = render(scene({}));
    act(() => frame(100));
    view.rerender(scene({ phase: 'lost', picked: [0, 1], payoutChips: 0.2 }));
    // The hit is armed here, and 100 ms of visible time accrues per frame.
    act(() => frame(200));
    for (let t = 300; t <= 8000; t += 100) act(() => frame(t));
    expect(onSettled).not.toHaveBeenCalled();
    expect(onMoment).not.toHaveBeenCalled();
    expect(screen.queryByText(/Animation Is Unavailable/)).toBeNull();
    act(() => frame(8100));
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onMoment.mock.calls).toEqual([['hit', 2]]);
    expect(screen.getByText(/Animation Is Unavailable/)).toBeInTheDocument();
    act(() => frame(8200));
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
