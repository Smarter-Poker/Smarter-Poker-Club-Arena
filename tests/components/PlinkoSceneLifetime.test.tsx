import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as THREE from 'three';
const calls = vi.hoisted(() => ({ create: vi.fn(), resize: vi.fn(), clean: vi.fn() }));
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
        cleanup: calls.clean,
      };
    },
  };
});
import PlinkoBoard from '../../src/components/plinko/PlinkoBoard';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('Plinko GPU resource lifetime', () => {
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
});
