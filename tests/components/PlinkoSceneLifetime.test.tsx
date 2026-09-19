import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as THREE from 'three';
const calls = vi.hoisted(() => ({
  create: vi.fn(),
  resize: vi.fn(),
  clean: vi.fn(),
  draw: vi.fn(() => true),
}));
vi.mock('../../src/components/games/sceneKit', async (original) => {
  const actual = await original<typeof import('../../src/components/games/sceneKit')>();
  return {
    ...actual,
    inscription: () => new THREE.Texture(),
    gameRenderer: (canvas: HTMLCanvasElement) => {
      calls.create();
      return {
        scene: new THREE.Scene(),
        camera: new THREE.PerspectiveCamera(),
        renderer: { domElement: canvas, setSize: calls.resize, render: vi.fn() },
        render: calls.draw,
        cleanup: calls.clean,
      };
    },
  };
});
import PlinkoBoard from '../../src/components/plinko/PlinkoBoard';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
describe('Plinko GPU resource lifetime', () => {
  it('gives a drop the full slower flight instead of finishing at the former two-second pace', () => {
    let frame: FrameRequestCallback = () => {};
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    calls.draw.mockReturnValue(true);
    const onLanded = vi.fn();
    render(
      <PlinkoBoard
        multipliersCents={[100]}
        path={Array(16).fill(1)}
        dropKey={1}
        restingSlot={null}
        onLanded={onLanded}
      />
    );
    frame(100);
    frame(2100);
    expect(onLanded).not.toHaveBeenCalled();
    frame(3900);
    expect(onLanded).toHaveBeenCalledTimes(1);
  });
  it('keeps its room and shaders when the first measured width or denomination changes', () => {
    const props = { multipliersCents: [100, 200], path: null, dropKey: 0, restingSlot: null };
    const view = render(<PlinkoBoard {...props} width={600} />);
    view.rerender(<PlinkoBoard {...props} width={280} />);
    view.rerender(<PlinkoBoard {...props} width={280} multipliersCents={[400, 800]} />);
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(calls.resize).toHaveBeenLastCalledWith(280, 316, false);
    expect(calls.clean).not.toHaveBeenCalled();
    view.unmount();
    expect(calls.clean).toHaveBeenCalledTimes(1);
  });

  it.each(['single', 'batch'])(
    'holds %s completion until its terminal frame is submitted',
    (mode) => {
      let frame: FrameRequestCallback = () => {};
      vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
        frame = callback;
        return 1;
      });
      vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
      calls.draw.mockReturnValue(false);
      const onLanded = vi.fn(),
        onProgress = vi.fn();
      render(
        <PlinkoBoard
          multipliersCents={[100]}
          path={mode === 'single' ? Array(16).fill(1) : null}
          batchPathBits={mode === 'batch' ? [65535, 0] : null}
          dropKey={1}
          restingSlot={null}
          onLanded={onLanded}
          onProgress={onProgress}
        />
      );
      frame(100);
      frame(4000);
      frame(4100);
      expect(onLanded).not.toHaveBeenCalled();
      expect(onProgress).not.toHaveBeenCalled();
      calls.draw.mockReturnValue(true);
      frame(4200);
      expect(onLanded).toHaveBeenCalledTimes(1);
      if (mode === 'batch') expect(onProgress).toHaveBeenLastCalledWith(2);
      frame(4300);
      expect(onLanded).toHaveBeenCalledTimes(1);
    }
  );
});
