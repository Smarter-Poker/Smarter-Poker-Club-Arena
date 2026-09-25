/**
 * A DROP THE BOARD CANNOT DRAW LANDS AT ONCE.
 *
 * Owner ruling, 2026-09-21: no game may require a player to check anything,
 * and no page may hold a player on something that cannot progress. The Plinko
 * page holds its exits while its drops fall and books the batch on screen when
 * the board says they have landed. The board used to say so only from a frame
 * it had drawn, so without WebGL (a renderer that cannot start, or a context
 * lost mid-drop) the batch never landed: the page held every exit on a result
 * the server had already booked, and the only way on was to press Show
 * Results. CrashCurve has always settled a round it cannot draw; the board
 * now does the same, once per drop, and a context that comes back never flies
 * or lands that drop a second time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as THREE from 'three';
const scenes = vi.hoisted(() => ({
  fail: false,
  draw: vi.fn(() => true),
  clean: vi.fn(),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/games/sceneKit', async (original) => {
  const actual = await original<typeof import('../../src/components/games/sceneKit')>();
  return {
    ...actual,
    inscription: () => new THREE.Texture(),
    gameRenderer: (canvas: HTMLCanvasElement) => {
      if (scenes.fail) throw new Error('No WebGL');
      return {
        scene: new THREE.Scene(),
        camera: new THREE.PerspectiveCamera(),
        renderer: { domElement: canvas, setSize: vi.fn(), render: vi.fn() },
        render: scenes.draw,
        cleanup: scenes.clean,
      };
    },
  };
});
import PlinkoBoard from '../../src/components/plinko/PlinkoBoard';

const BATCH = [0, 65535, 21845];
let frame: FrameRequestCallback = () => {};
beforeEach(() => {
  scenes.fail = false;
  scenes.draw.mockReturnValue(true);
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function board(
  props: Partial<Parameters<typeof PlinkoBoard>[0]> & {
    onLanded: () => void;
    onProgress?: (landed: number) => void;
  }
) {
  return (
    <PlinkoBoard
      multipliersCents={Array(17).fill(100)}
      path={null}
      dropKey={7}
      batchPathBits={null}
      restingSlot={null}
      {...props}
    />
  );
}

describe('a Plinko drop the scene cannot draw', () => {
  it('lands the whole batch at once when the renderer cannot start, and only once', () => {
    scenes.fail = true;
    const onLanded = vi.fn(),
      onProgress = vi.fn();
    const view = render(board({ onLanded, onProgress }));
    expect(screen.getByText(/The 3D Scene Is Unavailable/)).toBeInTheDocument();
    // Nothing to land before the page hands it a batch.
    expect(onLanded).not.toHaveBeenCalled();
    view.rerender(board({ onLanded, onProgress, batchPathBits: BATCH }));
    expect(onProgress).toHaveBeenLastCalledWith(BATCH.length);
    expect(onLanded).toHaveBeenCalledTimes(1);
    // The page never has to press Show Results to be let go.
    expect(screen.queryByText(/Use Show Results/)).not.toBeInTheDocument();
    view.rerender(board({ onLanded, onProgress, batchPathBits: BATCH }));
    expect(onLanded).toHaveBeenCalledTimes(1);
    // The next batch is a new drop, and lands at once too.
    view.rerender(board({ onLanded, onProgress, batchPathBits: [4, 8], dropKey: 8 }));
    expect(onProgress).toHaveBeenLastCalledWith(2);
    expect(onLanded).toHaveBeenCalledTimes(2);
  });

  it('lands a single drop at once when the renderer cannot start', () => {
    scenes.fail = true;
    const onLanded = vi.fn();
    render(board({ onLanded, path: Array(16).fill(1) }));
    expect(onLanded).toHaveBeenCalledTimes(1);
  });

  it('lands the batch at once when the context is lost mid-drop, and a restored context never lands it again', () => {
    const onLanded = vi.fn(),
      onProgress = vi.fn();
    const { container } = render(board({ onLanded, onProgress, batchPathBits: BATCH }));
    frame(100);
    frame(1500);
    expect(onLanded).not.toHaveBeenCalled();
    const canvas = container.querySelector('canvas')!;
    scenes.draw.mockReturnValue(false);
    fireEvent(canvas, new Event('webglcontextlost'));
    expect(onProgress).toHaveBeenLastCalledWith(BATCH.length);
    expect(onLanded).toHaveBeenCalledTimes(1);
    // The context comes back and the frames run on past the flight's end.
    fireEvent(canvas, new Event('webglcontextrestored'));
    scenes.draw.mockReturnValue(true);
    for (let at = 1600; at <= 12000; at += 100) frame(at);
    expect(onLanded).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith(BATCH.length);
  });

  it('never lands a drop twice when the context is lost after the scene landed it', () => {
    const onLanded = vi.fn();
    const { container } = render(board({ onLanded, batchPathBits: BATCH }));
    frame(100);
    for (let at = 200; at <= 12000; at += 100) frame(at);
    expect(onLanded).toHaveBeenCalledTimes(1);
    fireEvent(container.querySelector('canvas')!, new Event('webglcontextlost'));
    expect(onLanded).toHaveBeenCalledTimes(1);
  });
});
