import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
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
      const scene = new THREE.Scene();
      calls.create(scene);
      return {
        scene,
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
  it('renders faceted diamonds on the saved path with one shared drop geometry and material', () => {
    let frame: FrameRequestCallback = () => {};
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const view = render(
      <PlinkoBoard
        multipliersCents={[100]}
        path={Array(16).fill(1)}
        dropKey={1}
        restingSlot={null}
      />
    );
    const scene = calls.create.mock.calls[0][0] as THREE.Scene;
    const diamond = scene.getObjectByName('Plinko Drop Diamond') as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshPhysicalMaterial
    >;
    expect(diamond.geometry.type).toBe('BufferGeometry');
    expect(diamond.geometry.index).toBeNull();
    expect(diamond.geometry.getAttribute('color').count).toBe(
      diamond.geometry.getAttribute('position').count
    );
    diamond.geometry.computeBoundingBox();
    expect(diamond.geometry.boundingBox!.min.y).toBeCloseTo(-0.29);
    expect(diamond.geometry.boundingBox!.max.y).toBeCloseTo(0.16);
    expect(diamond.material.vertexColors).toBe(true);
    expect(diamond.material.flatShading).toBe(true);
    const drops = scene.children.filter(
      (child): child is THREE.Mesh =>
        child instanceof THREE.Mesh && child.geometry === diamond.geometry
    );
    expect(drops).toHaveLength(33);
    expect(drops.every((drop) => drop.material === diamond.material)).toBe(true);
    frame(100);
    frame(2000);
    expect(diamond.position.x).toBeGreaterThan(0);
    expect(diamond.position.y).toBeGreaterThan(-4.01);
    frame(3900);
    expect(diamond.position.x).toBeCloseTo(5.2);
    expect(diamond.position.y).toBeCloseTo(-4.01);
    view.rerender(
      <PlinkoBoard
        multipliersCents={[100]}
        path={null}
        batchPathBits={[0, 65535]}
        dropKey={2}
        restingSlot={null}
      />
    );
    frame(4000);
    frame(4700);
    expect(drops.filter((drop) => drop.visible)).toHaveLength(2);
    view.unmount();
    expect(calls.clean).toHaveBeenCalledTimes(1);
  });
  it('shows every exact multiplier in a readable ordered legend and marks the landed slot', () => {
    const multipliers = [
      13000, 2500, 900, 400, 200, 100, 60, 30, 20, 30, 60, 100, 200, 400, 900, 2500, 13000,
    ];
    const props = { multipliersCents: multipliers, path: null, dropKey: 0, restingSlot: null };
    const view = render(<PlinkoBoard {...props} width={280} />);
    const slots = within(screen.getByRole('list', { name: 'Plinko Payout Slots' })).getAllByRole(
      'listitem'
    );
    expect(slots).toHaveLength(17);
    expect(slots[0]).toHaveTextContent('Slot 1');
    expect(slots[0]).toHaveTextContent('130x');
    expect(slots[8]).toHaveTextContent('0.2x');
    expect(slots[16]).toHaveTextContent('130x');
    expect(slots.some((slot) => slot.hasAttribute('aria-current'))).toBe(false);
    view.rerender(<PlinkoBoard {...props} width={280} restingSlot={8} />);
    expect(slots[8]).toHaveAttribute('aria-current', 'true');
    view.rerender(
      <PlinkoBoard {...props} width={680} multipliersCents={multipliers.map((n) => n * 2)} />
    );
    expect(slots[0]).toHaveTextContent('260x');
    expect(slots[8]).toHaveTextContent('0.4x');
    expect(calls.create).toHaveBeenCalledTimes(1);
  });
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
