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
/** Contexts this scene has handed back, counted across every mount. */
const gpu = vi.hoisted(() => ({ contextLosses: 0 }));
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
      forceContextLoss() {
        gpu.contextLosses++;
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
import { DONKEY_SCALE, streetCenter, STREET_WIDTH } from '../../src/utils/crossingScene';

const ROAD = ROAD_LADDERS[CHOICE_MODE.crossing];
const sheet = readFileSync(
  join(__dirname, '../../src/components/games/ChoiceScene.module.css'),
  'utf8'
);
/** One rule's declarations, by selector. */
const rule = (selector: string) => {
  const at = sheet.indexOf(`${selector} {`);
  return at < 0 ? '' : sheet.slice(at, sheet.indexOf('}', at));
};
/** WCAG relative luminance, and the contrast between two opaque colours. */
const luminance = (hex: string) => {
  const channel = (from: number) => {
    const v = parseInt(hex.slice(from, from + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};
const contrast = (ink: string, plate: string) => {
  const [a, b] = [luminance(ink), luminance(plate)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};
const PRIZES = [2.17, 5.33, 15.2];
type SceneProps = Parameters<typeof ChoiceScene>[0];
let frame: FrameRequestCallback = () => {};
const fillText = vi.fn();
/** Every edge colour the scene has painted onto a street sign this test. */
const signInks: string[] = [];
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
  signInks.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect() {},
    strokeRect() {},
    fillText,
    set strokeStyle(ink: string) {
      signInks.push(ink);
    },
    get strokeStyle() {
      return '';
    },
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
  vi.unstubAllGlobals();
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
    // ...and the state the scene is showing, so the strip reads aloud the way
    // it is painted.
    expect(streets[0]).toHaveAccessibleName('Street 1 Pays 1.10x, 2.17 Chips, Crossed');
    expect(streets[1]).toHaveAccessibleName('Street 2 Pays 1.45x, 5.33 Chips');
    expect(streets[2]).toHaveAccessibleName('Street 3 Pays 1.85x, 15.20 Chips, Next');
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
    expect(screen.getByText('Bust')).toBeInTheDocument();
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
    expect(screen.getByText('Bust')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(ROAD.length);
  });
  it('keeps the bust flash and the street tints under reduced motion in the stylesheet', () => {
    const reduced = sheet.slice(sheet.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.bust,\s*\.bust span \{\s*animation: none;/);
    expect(reduced).toContain('.street {');
    expect(sheet).not.toContain(':hover');
    expect(sheet).not.toContain('—');
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
    // 500 ms: the 420 ms walk is done, but the car beside it is still braking.
    tick(600);
    expect(screen.getByText('Cash Out Value').nextElementSibling).toHaveTextContent('2.17 Chips');
    expect(scene.onMoment).not.toHaveBeenCalled();
    // 715 ms: the car has come to rest on the line, level with where a hit
    // would have landed. The street is crossed.
    tick(820);
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

/**
 * ONE ANNOUNCEMENT PER STREET (review 2026-09-22). The scene's readout was a
 * live region and its bust stamp a status with its own label, so between them
 * and the page's two nested status paragraphs a single hit was read out three
 * or four times, all of it before the car had moved. The scene announces
 * nothing now; the page has the one region, and it speaks each street when the
 * scene reaches it.
 */
describe('the scene leaves the announcement to the page', () => {
  it('carries no live region and no status role of its own', () => {
    motion(false);
    const { view } = mountScene({ phase: 'lost', picked: [0, 1, 2], payoutChips: 0.1 });
    const scene = view.container.querySelector('[data-phase]')!;
    expect(scene.querySelectorAll('[aria-live]')).toHaveLength(0);
    expect(scene.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(screen.getByText('Bust').closest('div')).toHaveAttribute('aria-hidden', 'true');
    // The words themselves stay on screen, where a sighted player reads them.
    expect(screen.getByText('Bust On Street 3')).toBeInTheDocument();
  });

  it('paints a street sign bust red only once the car has reached the donkey', () => {
    motion(false);
    const scene = mountScene({ phase: 'open', picked: [0] });
    tick(16);
    scene.update({ phase: 'lost', picked: [0, 1], payoutChips: 0.2 });
    tick(100);
    tick(600);
    // The sign painted on the road carries the same streetState the strip
    // does; neither may say it before the scene has got there.
    expect(signInks).not.toContain('#ff5b6e');
    tick(1000);
    tick(1100);
    expect(signInks).toContain('#ff5b6e');
  });

  it('names a street as the hit only once the car has reached the donkey', () => {
    motion(false);
    const scene = mountScene({ phase: 'open', picked: [0] });
    tick(50);
    scene.update({ phase: 'lost', picked: [0, 1], payoutChips: 0.2 });
    tick(100);
    tick(600);
    // Still the street ahead: the donkey is on it, the car has not arrived.
    expect(screen.getAllByRole('listitem')[1]).toHaveAccessibleName(
      'Street 2 Pays 1.45x, 5.33 Chips, Next'
    );
    tick(1000);
    expect(screen.getAllByRole('listitem')[1]).toHaveAccessibleName(
      'Street 2 Pays 1.45x, 5.33 Chips, Hit Here'
    );
  });
});

/**
 * WHAT A PHONE PAYS FOR EVERY FRAME (review 2026-09-22). This is the heaviest
 * of the four scenes: it built 771 meshes over 775 geometries, allocated a
 * fresh RoundedBoxGeometry or SphereGeometry for every one of them, gave every
 * car six materials of its own, cast nearly all of it into a 2048 shadow map,
 * drew every 16 ms behind modals and off screen alike, and left a live WebGL
 * context behind on every unmount - and the page mounts it again for every
 * round.
 */
/** One object in the scene graph, read the way the renderer reads it. */
type Node = {
  name?: string;
  visible?: boolean;
  material?: { color?: { getHex(): number } };
  position?: { x: number; z: number };
  geometry?: object;
  castShadow?: boolean;
  traverse(visit: (node: Node) => void): void;
};
/** The scene as it was, counted off these same mocks on the commit before this
 *  one: 739 distinct geometries, 771 meshes, 630 of them casting a shadow. */
const BEFORE = { geometries: 739, meshes: 771, casters: 630 };
const built = () => {
  const geometries = new Set<object>();
  let meshes = 0,
    casters = 0;
  (frames.scene as Node).traverse((node) => {
    if (!node.geometry) return;
    meshes++;
    geometries.add(node.geometry);
    if (node.castShadow) casters++;
  });
  return { geometries: geometries.size, meshes, casters };
};

describe('the crossing scene costs a phone less every frame', () => {
  it('builds the same road out of a fraction of the geometry, meshes and casters', () => {
    motion(false);
    mountScene({ phase: 'open', picked: [0] });
    tick(16);
    const now = built();
    expect(BEFORE.geometries / now.geometries).toBeGreaterThanOrEqual(5);
    expect(BEFORE.meshes / now.meshes).toBeGreaterThanOrEqual(3);
    expect(BEFORE.casters / now.casters).toBeGreaterThanOrEqual(3);
  });

  it('draws at thirty a second once the road has stopped moving', () => {
    motion(false);
    mountScene();
    // The opening walk, at sixty.
    for (let t = 16; t <= 1000; t += 8) tick(t);
    frames.render.mockClear();
    for (let t = 1008; t <= 2000; t += 8) tick(t);
    expect(frames.render.mock.calls.length).toBeLessThanOrEqual(34);
  });

  it('draws at sixty a second while the collision is playing', () => {
    motion(false);
    const scene = mountScene({ phase: 'open', picked: [0] });
    tick(16);
    scene.update({ phase: 'lost', picked: [0, 1], payoutChips: 0.2 });
    frames.render.mockClear();
    for (let t = 24; t <= 1016; t += 8) tick(t);
    expect(frames.render.mock.calls.length).toBeGreaterThanOrEqual(55);
  });

  it('draws nothing while it is paused, and still settles on its own schedule', () => {
    motion(false);
    const scene = mountScene({ phase: 'lost', picked: [0, 1], payoutChips: 0.1, paused: true });
    tick(16);
    tick(1600);
    expect(frames.render).not.toHaveBeenCalled();
    expect(scene.onSettled).toHaveBeenCalledTimes(1);
  });

  it('draws nothing while it is scrolled off screen, and still settles', () => {
    motion(false);
    let watch: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          watch = callback;
        }
        observe() {}
        disconnect() {}
      }
    );
    const scene = mountScene({ phase: 'lost', picked: [0, 1], payoutChips: 0.1 });
    watch!([{ isIntersecting: false }]);
    frames.render.mockClear();
    tick(16);
    tick(1600);
    expect(frames.render).not.toHaveBeenCalled();
    expect(scene.onSettled).toHaveBeenCalledTimes(1);
  });

  it('hands the WebGL context back when the round leaves the screen', () => {
    motion(false);
    const before = gpu.contextLosses;
    const scene = mountScene({ phase: 'open', picked: [0] });
    tick(16);
    scene.view.unmount();
    expect(gpu.contextLosses).toBe(before + 1);
  });

  it('redraws only when something changes under reduced motion', () => {
    motion(true);
    const scene = mountScene({ phase: 'open', picked: [0] });
    // Reduced motion already slows the loop to ten frames a second; now it
    // draws on none of them until the round, the road or the size changes.
    tick(120);
    expect(frames.render).toHaveBeenCalledTimes(1);
    for (let t = 220; t <= 1100; t += 100) tick(t);
    expect(frames.render).toHaveBeenCalledTimes(1);
    scene.update({ phase: 'open', picked: [0, 1] });
    tick(1200);
    expect(frames.render).toHaveBeenCalledTimes(2);
  });
});

/**
 * A ROAD-CROSSING GAME LIVES IN THE MOMENT BETWEEN COMMITTING AND KNOWING
 * (review 2026-09-22). The loop never read props.busy, so the donkey stood
 * still through every network wait; and crossingTrafficVisible clears the
 * current lane and the next one, so a safe street was a hop across an empty
 * street. There was never a car to time a crossing against.
 */
/**
 * Every car standing on one street this frame. The scene keeps the street the
 * donkey is crossing clear of traffic, so a visible car on it is the one that
 * came for this crossing and nothing else.
 */
const onStreet = (street: number) =>
  (frames.scene as Node & { children: Node[] }).children
    .map((child) => child as Node & { children?: Node[] })
    .filter(
      (node) =>
        node.visible &&
        node.position &&
        Math.abs(node.position.x - streetCenter(street)) < 0.01 &&
        node.children?.some((part) => part.material?.color)
    );
/** Every colour a car is painted, in the order its parts were merged. */
const paintOf = (car: Node & { children?: Node[] }) =>
  car.children?.map((part) => part.material?.color?.getHex()).filter((hex) => hex !== undefined);
const donkeyX = () =>
  (
    frames.scene as Node & {
      getObjectByName(name: string): { parent: { position: { x: number } } };
    }
  ).getObjectByName('walking-leg-0').parent.position.x;

describe('every street gets a beat', () => {
  it('steps the donkey to the kerb while the answer is in flight, and no further', () => {
    motion(false);
    const scene = mountScene({ phase: 'open', picked: [0] });
    tick(16);
    const standing = donkeyX();
    scene.update({ phase: 'open', picked: [0], moving: true });
    tick(150);
    tick(300);
    const leaning = donkeyX();
    expect(leaning).toBeGreaterThan(standing);
    // Never into the lane it is about to cross.
    expect(leaning - standing).toBeLessThanOrEqual(STREET_WIDTH / 2 - 0.2);
    // A move the server never answers eases the donkey back to where it stood.
    scene.update({ phase: 'open', picked: [0], moving: false });
    tick(400);
    tick(700);
    expect(donkeyX()).toBeCloseTo(standing, 5);
  });

  it('sends the same car, in the same paint, on a safe street and on a hit', () => {
    motion(false);
    const safe = mountScene({ phase: 'open', picked: [0] });
    tick(16);
    safe.update({ phase: 'open', picked: [0, 1] });
    tick(100);
    tick(400);
    const [onSafe, ...alsoSafe] = onStreet(2);
    expect(onSafe).toBeDefined();
    expect(alsoSafe).toHaveLength(0);
    const safePaint = paintOf(onSafe);
    cleanup();
    const lost = mountScene({ phase: 'open', picked: [0] });
    tick(16);
    lost.update({ phase: 'lost', picked: [0, 1], payoutChips: 0.2 });
    tick(100);
    tick(400);
    const [onHit, ...alsoHit] = onStreet(2);
    expect(onHit).toBeDefined();
    expect(alsoHit).toHaveLength(0);
    // The same paint, on the same line, at the same moment of the crossing.
    expect(paintOf(onHit)).toEqual(safePaint);
    expect(onHit.position!.z).toBeCloseTo(onSafe.position!.z, 10);
    expect(onHit.position!.x).toBeCloseTo(onSafe.position!.x, 10);
  });
});

/**
 * #SMARTERCASINOREALISM FOR WHAT THE ROAD ITSELF SHOWS (review 2026-09-22).
 * The straight-road pass restyled the street tints, the strip and the bust
 * type. Outside that the scene still had a navy sky, candy-coloured traffic, a
 * gold car, a gold flash and a cartoon squash on every hit, and its two
 * overlays were glass pills on navy. The standard is black first, blue only as
 * energy, gold only for value. Nothing is added here; the same geometry and
 * the same two plates are restyled.
 */
describe('the road wears the Smarter.Poker palette', () => {
  it('drives obsidian traffic on an obsidian road under one blue rim light', () => {
    motion(false);
    mountScene({ phase: 'open', picked: [0] });
    tick(16);
    const scene = frames.scene as Node & { background?: { getHex(): number }; children: Node[] };
    expect(scene.background?.getHex()).toBe(0x05070a);
    const paints = new Set<number>();
    scene.children
      .map((child) => child as Node & { children?: Node[] })
      .forEach((node) =>
        node.children?.forEach((part) => {
          const hex = part.material?.color?.getHex();
          if (hex !== undefined) paints.add(hex);
        })
      );
    // No candy blue, no maroon, no amber, and nothing gold on the road.
    for (const banished of [0x246bad, 0x8b3441, 0xb7a23a, 0x9a4a1f, 0xe4a233])
      expect(paints.has(banished)).toBe(false);
    expect(paints.has(0x0f1114)).toBe(true);
  });

  it('turns the donkey over instead of squashing it flat', () => {
    motion(false);
    const scene = mountScene({ phase: 'open', picked: [0] });
    tick(16);
    scene.update({ phase: 'lost', picked: [0, 1], payoutChips: 0.2 });
    tick(100);
    // Well past the strike, and halfway through the fall.
    tick(1100);
    const donkey = (
      frames.scene as Node & {
        getObjectByName(name: string): {
          parent: { rotation: { x: number }; scale: { y: number }; position: { z: number } };
        };
      }
    ).getObjectByName('walking-leg-0').parent;
    expect(Math.abs(donkey.rotation.x)).toBeGreaterThan(0.5);
    expect(donkey.position.z).toBeLessThan(-0.2);
    // The sculpt keeps its own proportions all the way down.
    expect(donkey.scale.y).toBeCloseTo(DONKEY_SCALE, 10);
  });

  it('plates the caption and the readout in obsidian, with gold on the value alone', () => {
    for (const plate of ['.caption', '.readout']) {
      expect(rule(plate)).toContain('background: rgb(5 7 10 / 90%)');
      expect(rule(plate)).toContain('border-radius: 4px');
      expect(rule(plate)).toContain('var(--realism-gunmetal-lit, #3a4756)');
      expect(rule(plate)).toContain('var(--realism-bevel');
    }
    expect(rule('.readoutValue')).toContain('var(--realism-gold, #ffc93c)');
    expect(rule('.caption')).not.toContain('gold');
    expect(rule('.readoutLabel,\n.readoutNote')).toContain('var(--realism-muted, #7f8c9b)');
    // Every word on a plate is readable on it.
    for (const ink of ['#b8c3cd', '#7f8c9b', '#ffc93c', '#e4e7ec'])
      expect(contrast(ink, '#05070a')).toBeGreaterThanOrEqual(4.5);
  });

  it('stamps the bust without a spin, and flashes on the frame of the hit', () => {
    expect(rule('.bust span')).toContain('animation: bust-stamp 0.15s ease-out both');
    expect(rule('.bust span')).not.toContain('rotate(');
    expect(rule('.bust span')).not.toContain('animation-delay');
    const flash = sheet.slice(sheet.indexOf('@keyframes bust-flash'));
    expect(flash.slice(0, flash.indexOf('}\n}'))).toMatch(
      /0% \{\s*background: rgb\(240 40 73 \/ 30%\);/
    );
  });
});
