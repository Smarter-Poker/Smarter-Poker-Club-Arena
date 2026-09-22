/**
 * The road comes back, and nothing it shows outruns the round (review
 * 2026-09-21).
 *
 * A browser can take the WebGL context away (a GPU reset, a tab in the
 * background) and give it back. The scene used to stay "unavailable" for good
 * after that and release every later reveal before a single frame of it was
 * drawn. After a booked win it could not light a "next" street, and its
 * caption never says the next street is clear: the next street is sealed, and
 * the traffic on screen does not decide it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const frames = vi.hoisted(() => ({ render: vi.fn(() => true), dispose: vi.fn() }));
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

type SceneProps = Parameters<typeof ChoiceScene>[0];
let frame: FrameRequestCallback = () => {};
const base = (onSettled: () => void): SceneProps => ({
  game: 'crossing',
  roundId: 'round-1',
  picked: [0],
  mines: null,
  phase: 'open',
  roadEnd: null,
  busy: false,
  onPick: () => {},
  onSettled,
  prizes: [2.2, 2.9, 3.7],
  betChips: 2,
});
function mountScene(props: Partial<SceneProps> = {}) {
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
  const onSettled = vi.fn();
  const view = render(<ChoiceScene {...base(onSettled)} {...props} />);
  return {
    onSettled,
    canvas: () => view.container.querySelector('canvas')!,
    update: (next: Partial<SceneProps>) =>
      view.rerender(<ChoiceScene {...base(onSettled)} {...props} {...next} />),
  };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('a context the browser gives back is drawn on again', () => {
  it('drops the unavailable notice and holds the next reveal for its own animation', () => {
    const scene = mountScene();
    frame(100);
    frame(700);
    expect(scene.onSettled).toHaveBeenCalledTimes(1);
    act(() => {
      scene.canvas().dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    });
    expect(screen.getByText(/Animation Is Unavailable/)).toBeInTheDocument();
    act(() => {
      scene.canvas().dispatchEvent(new Event('webglcontextrestored'));
    });
    expect(screen.queryByText(/Animation Is Unavailable/)).toBeNull();
    scene.onSettled.mockClear();
    frames.render.mockClear();
    scene.update({ phase: 'lost', picked: [0, 1], payoutChips: 0.2 });
    // Not released before a frame of the strike is drawn...
    expect(scene.onSettled).not.toHaveBeenCalled();
    for (let t = 800; t <= 1400; t += 16) frame(t);
    expect(frames.render).toHaveBeenCalled();
    expect(scene.onSettled).not.toHaveBeenCalled();
    // ...and released once it has played out.
    for (let t = 1416; t <= 3000; t += 16) frame(t);
    expect(scene.onSettled).toHaveBeenCalledTimes(1);
  });

  it('still releases every reveal at once while the context stays lost', () => {
    const scene = mountScene();
    frame(100);
    act(() => {
      scene.canvas().dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    });
    scene.onSettled.mockClear();
    scene.update({ phase: 'lost', picked: [0, 1], payoutChips: 0.2 });
    expect(scene.onSettled).toHaveBeenCalledTimes(1);
  });
});

describe('the scene never promises the next street', () => {
  it('asks for the move instead of calling the next street clear', () => {
    mountScene({ phase: 'open', picked: [] });
    expect(screen.getByText('Start · Your Move')).toBeInTheDocument();
    cleanup();
    mountScene({ phase: 'open', picked: [0, 1] });
    expect(screen.getByText('Safe On Street 2 · Your Move')).toBeInTheDocument();
    expect(screen.queryByText(/Next Street Clear/)).toBeNull();
  });

  it('lights no next street in the strip once a win is booked', () => {
    mountScene({ phase: 'cashed', picked: [0, 1], payoutChips: 2.9, roadEnd: 5 });
    const streets = screen.getAllByRole('listitem');
    expect(streets[1]).toHaveAttribute('data-state', 'crossed');
    expect(streets.filter((street) => street.getAttribute('data-state') === 'next')).toHaveLength(
      0
    );
  });
});
