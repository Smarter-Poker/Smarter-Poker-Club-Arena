import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

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
});
