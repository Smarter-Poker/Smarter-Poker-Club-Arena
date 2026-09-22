/**
 * Donkey Cross reads like the leading road-crossing games (Dan 2026-09-19):
 * every street prints the multiplier it pays, the streets ahead read more
 * dangerous the further they are, the cash-out value is the loudest number on
 * the scene, and a loss is a brief, unmistakable bust rather than a dead pause.
 * Reduced motion collapses the motion and keeps every one of those meanings.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const frames = vi.hoisted(() => ({ render: vi.fn(() => true), dispose: vi.fn() }));
/** Set by a case that wants a renderer able to compile its programs off the
 *  main thread. Left undefined, the mock is a renderer WITHOUT compileAsync -
 *  which is the guard every other case in this file exercises. */
const gpu = vi.hoisted(() => ({
  compileAsync: undefined as undefined | ((scene: unknown, camera: unknown) => Promise<unknown>),
}));
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
      get compileAsync() {
        return gpu.compileAsync;
      }
    },
    PMREMGenerator: class {
      fromScene() {
        return { texture: new actual.Texture(), dispose() {} };
      }
      dispose() {}
    },
  };
});
import ChoiceScene, {
  hazardBand,
  streetHazard,
  streetMultiplier,
} from '../../src/components/games/ChoiceScene';
import { CHOICE_MODE, ROAD_LADDERS } from '../../src/utils/diamondChoiceMath';

const ROAD = ROAD_LADDERS[CHOICE_MODE.crossing];
const PRIZES = [2.17, 5.33, 15.2];
let frame: FrameRequestCallback = () => {};
const fillText = vi.fn();
function mountScene(props: Partial<Parameters<typeof ChoiceScene>[0]> = {}) {
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect() {},
    strokeRect() {},
    fillText,
  } as unknown as CanvasRenderingContext2D);
  const onSettled = vi.fn();
  const view = render(
    <ChoiceScene
      game="crossing"
      roundId="round-1"
      picked={[]}
      mines={null}
      phase="idle"
      roadEnd={null}
      busy={false}
      onPick={() => {}}
      onSettled={onSettled}
      prizes={PRIZES}
      betChips={1}
      {...props}
    />
  );
  return { view, onSettled };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  gpu.compileAsync = undefined;
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FIRST FRAME IS NOT A SHADER COMPILE (2026-09-22)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every material here is a MeshPhysicalMaterial under a shadow-casting light,
 * so the first renderer.render() compiles and links the whole program set on
 * the main thread - inside the first animation frame, which lands while the
 * Double Down offer is animating in. compileAsync hands that work to the
 * driver, and the scene simply submits no frame until it is done.
 */
describe('the scene waits for its programs instead of compiling them in frame one', () => {
  it('submits no frame until the compile answers, and keeps its clock running', async () => {
    let ready!: () => void;
    gpu.compileAsync = vi.fn(
      () =>
        new Promise((done) => {
          ready = () => done(null);
        })
    );
    const { onSettled } = mountScene({ phase: 'lost', picked: [0, 1, 2], payoutChips: 0.1 });
    expect(gpu.compileAsync).toHaveBeenCalledTimes(1);
    frame(100);
    frame(1000);
    frame(1600);
    expect(frames.render).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
    await act(async () => ready());
    // The bust ran to its end while nothing was submitted, so the very first
    // frame that IS submitted is already the settled one.
    frame(1700);
    expect(frames.render).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('draws anyway when the compile never answers', () => {
    vi.useFakeTimers();
    gpu.compileAsync = vi.fn(() => new Promise(() => {}));
    mountScene();
    frame(100);
    expect(frames.render).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    frame(1600);
    expect(frames.render).toHaveBeenCalled();
  });

  it('draws when the driver refuses the compile', async () => {
    gpu.compileAsync = vi.fn(() => Promise.reject(new Error('no parallel shader compile')));
    mountScene();
    await act(async () => {});
    frame(100);
    expect(frames.render).toHaveBeenCalled();
  });

  it('draws immediately on a renderer with no compileAsync at all', () => {
    mountScene();
    frame(100);
    expect(frames.render).toHaveBeenCalled();
  });
});

describe('every street prints what it pays', () => {
  it('lists the twelve streets of the one road, 1.10x up to 20.00x, in the strip', () => {
    mountScene({ phase: 'open', picked: [0, 1] });
    const streets = screen.getAllByRole('listitem');
    expect(streets).toHaveLength(ROAD.length);
    expect(streets.map((s) => s.querySelector('strong')?.textContent)).toEqual(
      ROAD.map(streetMultiplier)
    );
    expect(streets[0]).toHaveTextContent('1.10x');
    expect(streets[ROAD.length - 1]).toHaveTextContent('20.00x');
    // The prize for reaching a street is on the street too, in chips.
    expect(streets[0]).toHaveAccessibleName('Street 1 Pays 1.10x, 2.17 Chips');
    expect(streets[2]).toHaveAccessibleName('Street 3 Pays 1.85x, 15.20 Chips');
  });
  it('paints the multiplier on every three-dimensional street sign as well', () => {
    mountScene({ phase: 'open', picked: [0] });
    frame(100);
    const printed = fillText.mock.calls.map((call) => call[0]);
    expect(printed).toContain('START');
    expect(printed).toContain('STREET 1');
    expect(printed).toContain('1.10x');
    expect(printed).toContain('STREET 12');
    expect(printed).toContain('20.00x');
    expect(printed).not.toContain('STREET 13');
  });
  it('marks the street the donkey stands on, the next one, and the ones already crossed', () => {
    mountScene({ phase: 'open', picked: [0, 1] });
    const streets = screen.getAllByRole('listitem');
    expect(streets[0]).toHaveAttribute('data-state', 'crossed');
    expect(streets[1]).toHaveAttribute('data-state', 'current');
    expect(streets[1]).toHaveAttribute('aria-current', 'step');
    expect(streets[2]).toHaveAttribute('data-state', 'next');
    expect(streets[3]).toHaveAttribute('data-state', 'ahead');
  });
});

describe('the road ahead reads more dangerous the further it goes', () => {
  it('rises from the calm first street to the fourth band at the last', () => {
    mountScene({ phase: 'open', picked: [0] });
    const bands = screen
      .getAllByRole('listitem')
      .map((street) => Number(street.getAttribute('data-hazard')));
    expect(bands[0]).toBe(0);
    expect(bands[bands.length - 1]).toBe(3);
    for (let i = 1; i < bands.length; i++) expect(bands[i]).toBeGreaterThanOrEqual(bands[i - 1]);
    expect(new Set(bands).size).toBe(4);
  });
  it('derives one hazard from the street index and the length of the road', () => {
    expect(streetHazard(0, 12)).toBe(0);
    expect(streetHazard(11, 12)).toBe(1);
    expect(streetHazard(0, 1)).toBe(0);
    expect(hazardBand(0)).toBe(0);
    expect(hazardBand(0.49)).toBe(1);
    expect(hazardBand(1)).toBe(3);
  });
});

describe('the cash-out value is the loudest number', () => {
  it('shows the chips the player can book now and what the next street adds', () => {
    mountScene({ phase: 'open', picked: [0, 1] });
    expect(screen.getByText('Cash Out Value').nextElementSibling).toHaveTextContent('5.33 Chips');
    expect(screen.getByText('Next Street Pays 1.85x For 15.20 Chips')).toBeInTheDocument();
  });
  it('shows what the first street pays and the reach of the road before Start', () => {
    mountScene();
    expect(screen.getByText('First Street Pays').nextElementSibling).toHaveTextContent(
      '2.17 Chips At 1.10x'
    );
    expect(screen.getByText('12 Streets Up To 20.00x')).toBeInTheDocument();
  });
  it('shows the booked chips and the counterfactual on a win', () => {
    mountScene({ phase: 'cashed', picked: [0, 1], payoutChips: 5.33, roadEnd: 4 });
    expect(screen.getByText('Booked At Street 2').nextElementSibling).toHaveTextContent(
      '5.33 Chips'
    );
    expect(screen.getByText('The Donkey Would Have Reached Street 4')).toBeInTheDocument();
  });
});

describe('a loss is a brief, clear bust', () => {
  it('stamps the bust, keeps the guaranteed chips on screen and settles within a second and a half', () => {
    const { onSettled } = mountScene({ phase: 'lost', picked: [0, 1, 2], payoutChips: 0.1 });
    expect(screen.getByRole('status', { name: 'Bust On Street 3' })).toBeInTheDocument();
    expect(screen.getByText('Bust On Street 3').nextElementSibling).toHaveTextContent(
      '0.10 Chips Kept'
    );
    expect(screen.getByText('The Guaranteed Minimum Is Yours')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')[2]).toHaveAttribute('data-state', 'crash');
    frame(100);
    frame(1000);
    expect(onSettled).not.toHaveBeenCalled();
    frame(1600);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
  it('collapses the collision to its final frame under reduced motion and keeps the bust', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('prefers-reduced-motion'),
          media: query,
          addEventListener() {},
          removeEventListener() {},
          addListener() {},
          removeListener() {},
          onchange: null,
          dispatchEvent: () => false,
        }) as MediaQueryList
    );
    const { onSettled } = mountScene({ phase: 'lost', picked: [0, 1], payoutChips: 0.1 });
    frame(100);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status', { name: 'Bust On Street 2' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(ROAD.length);
  });
  it('keeps the bust flash and the street tints under reduced motion in the stylesheet', () => {
    const css = readFileSync(
      join(__dirname, '../../src/components/games/ChoiceScene.module.css'),
      'utf8'
    );
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.bust,\s*\.bust span \{\s*animation: none;/);
    expect(reduced).toContain('.street {');
    expect(css).not.toContain(':hover');
    expect(css).not.toContain('—');
  });
});
