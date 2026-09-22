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

/** The scene graph the component builds, captured as it hands it to the renderer. */
type Graph = {
  getObjectByName(name: string): { parent: { position: { x: number } } | null } | undefined;
};
const frames = vi.hoisted(() => ({
  render: vi.fn(() => true),
  dispose: vi.fn(),
  scene: null as unknown,
}));
vi.mock('../../src/components/games/gpuFrameRenderer', () => ({
  gpuFrameRenderer: (_renderer: unknown, scene: unknown) => {
    frames.scene = scene;
    return frames;
  },
}));
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
import ChoiceScene, {
  hazardBand,
  streetHazard,
  streetMultiplier,
} from '../../src/components/games/ChoiceScene';
import { CHOICE_MODE, ROAD_LADDERS } from '../../src/utils/diamondChoiceMath';
import { streetCenter } from '../../src/utils/crossingScene';

const ROAD = ROAD_LADDERS[CHOICE_MODE.crossing];
const PRIZES = [2.17, 5.33, 15.2];
type SceneProps = Parameters<typeof ChoiceScene>[0];
let frame: FrameRequestCallback = () => {};
const fillText = vi.fn();
/** One animation frame, flushed the way the browser flushes it: the scene may
 *  advance its own presentation state on any frame it draws. */
const tick = (at: number) => act(() => frame(at));
/** What the OS says about reduced motion, stated by every test that depends on
 *  it: the scene reads the preference once per mount, so a test that inherited
 *  it from the test before would prove nothing. */
const motion = (reduced: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: reduced && query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent: () => false,
      }) as MediaQueryList
  );
function mountScene(props: Partial<SceneProps> = {}) {
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
  const onMoment = vi.fn();
  const scene = (extra: Partial<SceneProps>) => (
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
      onMoment={onMoment}
      prizes={PRIZES}
      betChips={1}
      {...props}
      {...extra}
    />
  );
  const view = render(scene({}));
  return {
    view,
    onSettled,
    onMoment,
    update: (next: Partial<SceneProps>) => view.rerender(scene(next)),
  };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
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
    tick(100);
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
    tick(100);
    tick(1000);
    expect(onSettled).not.toHaveBeenCalled();
    tick(1600);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
  it('collapses the collision to its final frame under reduced motion and keeps the bust', () => {
    motion(true);
    const { onSettled } = mountScene({ phase: 'lost', picked: [0, 1], payoutChips: 0.1 });
    tick(100);
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

/**
 * THE SCENE OWNS THE REVEAL (review 2026-09-22). fn_choice_act answers about
 * three quarters of a second before the car reaches the donkey. Every HTML
 * surface used to flip on that answer, so the caption, the readout, the stamp
 * and the strip all told the player the result while the donkey was still
 * standing in the road. The scene now prints what it is SHOWING and hands the
 * page one beat per street, on the frame that shows it.
 */
describe('the scene owns the reveal', () => {
  it('keeps the readout and the strip on the open street until the car arrives', () => {
    motion(false);
    const scene = mountScene({ phase: 'open', picked: [0] });
    tick(50);
    scene.update({ phase: 'lost', picked: [0, 1], payoutChips: 0.2 });
    tick(100);
    // 500 ms of scene time: the donkey has walked, the car has not arrived
    // (collisionAt puts the strike at 745 ms).
    tick(600);
    expect(screen.queryByText('Bust')).toBeNull();
    expect(screen.queryByText('Bust On Street 2')).toBeNull();
    expect(screen.getByText('Cash Out Value').nextElementSibling).toHaveTextContent('2.17 Chips');
    expect(screen.getAllByRole('listitem')[1]).toHaveAttribute('data-state', 'next');
    expect(scene.onMoment).not.toHaveBeenCalled();
    tick(1000);
    expect(screen.getByText('Bust')).toBeInTheDocument();
    expect(screen.getByText('Bust On Street 2').nextElementSibling).toHaveTextContent(
      '0.20 Chips Kept'
    );
    expect(screen.getAllByRole('listitem')[1]).toHaveAttribute('data-state', 'crash');
    expect(scene.onMoment.mock.calls).toEqual([['hit', 2]]);
    tick(1100);
    expect(scene.onMoment).toHaveBeenCalledTimes(1);
  });

  it('raises the cash-out value on the frame the donkey lands, not when the answer arrives', () => {
    motion(false);
    const scene = mountScene({ phase: 'open', picked: [0] });
    tick(50);
    scene.update({ phase: 'open', picked: [0, 1] });
    tick(100);
    expect(screen.getByText('Cash Out Value').nextElementSibling).toHaveTextContent('2.17 Chips');
    tick(300);
    expect(screen.getByText('Cash Out Value').nextElementSibling).toHaveTextContent('2.17 Chips');
    expect(scene.onMoment).not.toHaveBeenCalled();
    // 500 ms: the 420 ms walk is done.
    tick(600);
    expect(screen.getByText('Cash Out Value').nextElementSibling).toHaveTextContent('5.33 Chips');
    expect(screen.getByText('Safe On Street 2 · Your Move')).toBeInTheDocument();
    expect(scene.onMoment.mock.calls).toEqual([['landed', 2]]);
  });

  it('gives the beat at once under reduced motion, with no frame to wait for', () => {
    motion(true);
    const scene = mountScene({ phase: 'open', picked: [0] });
    scene.update({ phase: 'lost', picked: [0, 1], payoutChips: 0.2 });
    expect(scene.onMoment.mock.calls).toEqual([['hit', 2]]);
    expect(screen.getByText('Bust On Street 2')).toBeInTheDocument();
  });

  it('stands a resumed open round on its own street instead of walking it from the kerb', () => {
    motion(false);
    mountScene({ phase: 'open', picked: [0, 1, 2] });
    tick(100);
    const donkey = (frames.scene as Graph).getObjectByName('walking-leg-0');
    expect(donkey?.parent?.position.x).toBeCloseTo(streetCenter(3) - 0.12, 5);
  });
});
