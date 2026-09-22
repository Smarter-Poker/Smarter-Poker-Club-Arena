/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BOARD HAS TO MAKE THE PRIZE LEGIBLE, AND ITS LANDING UNMISTAKABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-19: "DO A DEEP DIVE ONLINE AND SEE HOW OTHER PLINKO GAMES ARE
 * DISPLAYED ANIMATED AND SHOWN, AND MAKE ANY AND ALL IMPROVEMENT, ENHANCEMENTS
 * AND UPGRADES TO OURS AS THEY ARE NEEDED." He had played twenty games without
 * once seeing a 5x, 10x or 20x. The odds were the table's and the table is now
 * recalibrated; what the BOARD owes is that a high bucket reads hot before a
 * diamond is dropped, and that a landing in one is impossible to miss.
 *
 * The three.js scene does not rasterise under happy-dom, so this file pins the
 * PURE functions the presentation is derived from, the DOM the legend prints,
 * the peg field's own arithmetic, and the stylesheet's reduced-motion and
 * animation-speed contracts. Pixels are the e2e suite's job.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import PlinkoBoard, {
  BIG_WIN_CENTS,
  PLINKO_ROWS,
  PLINKO_SLOTS,
  bucketHeat,
  bucketInk,
  bucketTint,
  isBigWin,
  pathBitsSlot,
  pathBitsSteps,
  tallyLine,
} from '../../src/components/plinko/PlinkoBoard';
import { pegIndexAt, struckPegIndices } from '../../src/components/plinko/plinkoPegField';
import { PLINKO_TABLES } from '../../src/utils/diamondBonusPayout';

const CSS = readFileSync(
  join(__dirname, '../../src/components/plinko/PlinkoBoard.module.css'),
  'utf8'
);
const DIAMOND = PLINKO_TABLES[5].multipliersCents;
const SUPER = PLINKO_TABLES[4].multipliersCents;

const scenes = vi.hoisted(() => ({ create: vi.fn(), draw: vi.fn(() => true), clean: vi.fn() }));
const field = vi.hoisted(() => ({ light: vi.fn(), reveal: vi.fn(), dispose: vi.fn() }));
vi.mock('../../src/components/games/sceneKit', async (original) => {
  const actual = await original<typeof import('../../src/components/games/sceneKit')>();
  return {
    ...actual,
    inscription: () => new THREE.Texture(),
    gameRenderer: (canvas: HTMLCanvasElement) => {
      const scene = new THREE.Scene();
      scenes.create(scene);
      return {
        scene,
        camera: new THREE.PerspectiveCamera(),
        renderer: { domElement: canvas, setSize: vi.fn(), render: vi.fn() },
        render: scenes.draw,
        cleanup: scenes.clean,
      };
    },
  };
});
vi.mock('../../src/components/plinko/plinkoPegField', async (original) => {
  const actual = await original<typeof import('../../src/components/plinko/plinkoPegField')>();
  return {
    ...actual,
    // The pure arithmetic stays real; only the GPU field is a spy.
    plinkoPegField: () => ({ group: new THREE.Group(), ...field }),
  };
});

/** A rendered frame pump, so a rAF-driven scene can be stepped by hand. */
function frames() {
  let callback: FrameRequestCallback = () => {};
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((next) => {
    callback = next;
    return 1;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  return (at: number) => callback(at);
}
const reduceMotion = (on: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: on && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
};
const slotMesh = (scene: THREE.Scene, slot: number) =>
  scene.getObjectByName(`Plinko Slot ${slot + 1}`) as THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshPhysicalMaterial
  >;
const items = () =>
  within(screen.getByRole('list', { name: 'Plinko Payout Slots' })).getAllByRole('listitem');

afterEach(() => {
  cleanup();
  reduceMotion(false);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('the bucket colour scale is derived from the multiplier, not from the table', () => {
  it('runs cold to hot and never doubles back, on either open table', () => {
    for (const table of [DIAMOND, SUPER]) {
      const heats = table.map(bucketHeat);
      // Left half climbs to the edge, right half mirrors it: monotone in value.
      const sorted = [...table].sort((a, b) => a - b).map(bucketHeat);
      expect(sorted).toEqual([...sorted].sort((a, b) => a - b));
      for (let i = 0; i < table.length; i++)
        for (let j = 0; j < table.length; j++)
          if (table[i] < table[j]) expect(heats[i]).toBeLessThan(heats[j]);
    }
  });
  it('anchors the scale on the multiplier so 20x is the same red on both tables', () => {
    expect(bucketTint(2000)).toBe(bucketTint(2000));
    expect(bucketHeat(2000)).toBeGreaterThan(0.9);
    expect(bucketTint(DIAMOND[0])).toBe(bucketTint(SUPER[0]));
    // The Super table's floor genuinely pays more than the Diamond table's, and
    // the scale says so rather than restretching itself per table.
    expect(bucketHeat(52)).toBeGreaterThan(bucketHeat(8));
    expect(bucketHeat(8)).toBeLessThan(0.2);
    expect(bucketHeat(52)).toBeGreaterThan(0.2);
  });
  it('clamps outside the scale instead of producing a colour nobody chose', () => {
    expect(bucketHeat(0)).toBe(0);
    expect(bucketHeat(-1)).toBe(0);
    expect(bucketHeat(Number.NaN)).toBe(0);
    expect(bucketHeat(1_000_000)).toBe(1);
    expect(bucketTint(0)).toMatch(/^#[0-9a-f]{6}$/);
    expect(bucketTint(1_000_000)).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('paints the low middle cool and the high outside hot', () => {
    const rgb = (tint: string) =>
      [1, 3, 5].map((at) => Number.parseInt(tint.slice(at, at + 2), 16));
    const [coldR, , coldB] = rgb(bucketTint(8));
    const [hotR, , hotB] = rgb(bucketTint(2000));
    expect(coldB).toBeGreaterThan(coldR);
    expect(hotR).toBeGreaterThan(hotB);
    // A mid bucket is neither: green-dominant, between the two ends.
    const [, midG] = rgb(bucketTint(100));
    expect(midG).toBeGreaterThan(120);
  });
  it('lifts the engraved ink off the tint so a slot face stays readable', () => {
    const brightness = (colour: string) =>
      [1, 3, 5].reduce((sum, at) => sum + Number.parseInt(colour.slice(at, at + 2), 16), 0);
    for (const cents of [8, 52, 500, 2000])
      expect(brightness(bucketInk(cents))).toBeGreaterThan(brightness(bucketTint(cents)));
  });
});

describe('a landing of five times the drop or more is a different event', () => {
  it('draws the line at 5x and nowhere else', () => {
    expect(BIG_WIN_CENTS).toBe(500);
    expect(isBigWin(499)).toBe(false);
    expect(isBigWin(500)).toBe(true);
    expect(isBigWin(2000)).toBe(true);
    expect(isBigWin(Number.NaN)).toBe(false);
  });
  it('marks exactly the buckets Dan said he never sees, on both tables', () => {
    expect(DIAMOND.filter(isBigWin)).toEqual([
      2000, 2000, 2000, 1200, 500, 500, 1200, 2000, 2000, 2000,
    ]);
    expect(SUPER.filter(isBigWin)).toEqual([2000, 2000, 1500, 750, 750, 1500, 2000, 2000]);
  });
});

describe('the slot arithmetic stays the server-sealed arithmetic', () => {
  it('reads a slot as the popcount of the sealed path bits', () => {
    expect(pathBitsSlot(0)).toBe(0);
    expect(pathBitsSlot(0xffff)).toBe(PLINKO_ROWS);
    expect(pathBitsSlot(0b1011)).toBe(3);
    // Bits above the board are not part of the drop.
    expect(pathBitsSlot(0x1ffff)).toBe(PLINKO_ROWS);
    expect(PLINKO_SLOTS).toBe(PLINKO_ROWS + 1);
  });
  it('unpacks the same bits into one turn a row, lowest bit first', () => {
    expect(pathBitsSteps(0b1011, 4)).toEqual([1, 1, 0, 1]);
    expect(pathBitsSteps(38925)).toHaveLength(PLINKO_ROWS);
    const bits = 38925;
    expect(pathBitsSteps(bits).reduce((a, b) => a + b, 0)).toBe(pathBitsSlot(bits));
  });
  it('derives every struck peg from those same turns', () => {
    expect(pegIndexAt(0, 0)).toBe(0);
    expect(pegIndexAt(2, 1)).toBe(4);
    expect(struckPegIndices([1, 0, 1], 2)).toEqual([0, 2, 4]);
    expect(struckPegIndices([], -1)).toEqual([]);
    expect(struckPegIndices(pathBitsSteps(0xffff), 15)).toHaveLength(PLINKO_ROWS);
  });
});

describe('the running tally says what has landed so far', () => {
  it('names the count and the best multiplier, in Title Case, with no em dash', () => {
    expect(tallyLine(0, 10, -1)).toBe('');
    expect(tallyLine(3, 10, 2000)).toBe('3 Of 10 Landed. Best 20x.');
    expect(tallyLine(1, 1, 8)).toBe('1 Of 1 Landed. Best 0.08x.');
    expect(tallyLine(2, 10, -1)).toBe('2 Of 10 Landed.');
    expect(tallyLine(3, 10, 2000)).not.toContain('—');
  });
});

describe('the DOM legend carries the whole scale, so it survives a dead WebGL context', () => {
  it('prints every slot in Title Case with its own tint and heat', () => {
    render(<PlinkoBoard multipliersCents={DIAMOND} path={null} dropKey={0} restingSlot={null} />);
    const slots = items();
    expect(slots).toHaveLength(PLINKO_SLOTS);
    expect(slots[0]).toHaveTextContent('Slot 1');
    expect(slots[0]).toHaveTextContent('20x');
    expect(slots[8]).toHaveTextContent('0.08x');
    slots.forEach((slot, index) => {
      expect(slot.style.getPropertyValue('--slot-tint')).toBe(bucketTint(DIAMOND[index]));
      expect(Number(slot.style.getPropertyValue('--slot-heat'))).toBeCloseTo(
        bucketHeat(DIAMOND[index]),
        3
      );
    });
    // The value bar is a second channel; the printed multiplier always carries it too.
    expect(
      screen.getByText('Slots Run From Left To Right. The Hottest Colours Pay The Most.')
    ).toBeVisible();
  });
  it('marks the high buckets before anything is dropped, and the landed one when it is', () => {
    const props = { multipliersCents: SUPER, path: null, dropKey: 0 };
    const view = render(<PlinkoBoard {...props} restingSlot={null} />);
    const big = items().map((slot) => slot.getAttribute('data-big') === 'true');
    expect(big).toEqual(SUPER.map(isBigWin));
    expect(items().some((slot) => slot.hasAttribute('data-hit'))).toBe(false);
    // A low landing bounces its bucket. It does not get the win ring.
    view.rerender(<PlinkoBoard {...props} restingSlot={8} />);
    expect(items()[8]).toHaveAttribute('data-hit', 'true');
    expect(items()[8]).toHaveAttribute('aria-current', 'true');
    expect(items()[8]).not.toHaveAttribute('data-win');
    // A 20x landing gets both.
    view.rerender(<PlinkoBoard {...props} restingSlot={0} />);
    expect(items()[0]).toHaveAttribute('data-hit', 'true');
    expect(items()[0]).toHaveAttribute('data-win', 'big');
    expect(items()[8]).not.toHaveAttribute('data-hit');
  });
  it('keeps the board exempt from the global motion collapse and offers a live tally', () => {
    render(<PlinkoBoard multipliersCents={DIAMOND} path={null} dropKey={0} restingSlot={null} />);
    // reducedMotion.css exempts this subtree, so PlinkoBoard.module.css owns its
    // own collapse. Removing the attribute without moving the block is a bug.
    expect(document.querySelector('[data-motion="keep"]')).toBeTruthy();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
});

describe('the pegs a ball strikes light up, in a batch as well as a single drop', () => {
  it('lights one peg per ball in flight and lets go of them as they land', () => {
    const frame = frames();
    render(
      <PlinkoBoard
        multipliersCents={DIAMOND}
        path={null}
        batchPathBits={[0xffff, 0]}
        dropKey={7}
        restingSlot={null}
      />
    );
    frame(100);
    // The batch used to reveal nothing at all: the board went quiet for ten drops.
    expect(field.light).toHaveBeenCalled();
    const first = field.light.mock.calls.at(-1)![0] as number[];
    expect(first).toEqual([pegIndexAt(0, 0)]);
    frame(900);
    // Sixteen lit instances cannot hold ten whole trails, so a batch lights the
    // peg each ball is passing right now: one per ball, every frame.
    const later = field.light.mock.calls.at(-1)![0] as number[];
    expect(later.length).toBe(2);
    const rowOf = (index: number) => {
      let row = 0;
      while (pegIndexAt(row + 1, 0) <= index) row++;
      return row;
    };
    for (const index of later) {
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(136);
      // One drop turns right every row and the other turns left every row, so a
      // lit peg has to sit on one edge of its row or it is not on a sealed path.
      const rights = index - pegIndexAt(rowOf(index), 0);
      expect([0, rowOf(index)]).toContain(rights);
    }
    // And the right-turning drop really is down the right edge, not row zero.
    expect(
      later.some((index) => rowOf(index) > 0 && index === pegIndexAt(rowOf(index), rowOf(index)))
    ).toBe(true);
    frame(6000);
    expect(field.light).toHaveBeenLastCalledWith([]);
  });
  it('still hands the single drop its whole struck trail', () => {
    const frame = frames();
    render(
      <PlinkoBoard
        multipliersCents={DIAMOND}
        path={Array(PLINKO_ROWS).fill(1)}
        dropKey={3}
        restingSlot={null}
      />
    );
    frame(100);
    frame(2000);
    const path = field.reveal.mock.calls.at(-1)!;
    expect(path[0]).toEqual(Array(PLINKO_ROWS).fill(1));
    expect(path[1]).toBeGreaterThan(0);
  });
});

describe('a bucket reacts to the ball that lands in it', () => {
  it('squashes and flashes on a landing, and the win pulse only fires above 5x', () => {
    const frame = frames();
    render(
      <PlinkoBoard
        multipliersCents={DIAMOND}
        path={Array(PLINKO_ROWS).fill(1)}
        dropKey={11}
        restingSlot={null}
      />
    );
    const scene = scenes.create.mock.calls[0][0] as THREE.Scene;
    const ring = scene.getObjectByName('Plinko Win Ring')!;
    frame(100);
    expect(ring.visible).toBe(false);
    expect(slotMesh(scene, 16).scale.y).toBeCloseTo(1);
    // All sixteen turns right, so the drop lands in slot 16: a 20x on this table.
    frame(3900);
    const landedBucket = slotMesh(scene, 16);
    expect(DIAMOND[16]).toBe(2000);
    expect(landedBucket.material.emissiveIntensity).toBeGreaterThan(1);
    expect(ring.visible).toBe(true);
    expect(ring.position.x).toBeCloseTo((16 - 8) * 0.65);
    // A bucket nobody hit is untouched.
    expect(slotMesh(scene, 8).material.emissiveIntensity).toBe(0);
    expect(slotMesh(scene, 8).scale.y).toBeCloseTo(1);
    // Mid-bounce the bucket is genuinely squashed, and it settles back.
    frame(4000);
    expect(landedBucket.scale.y).toBeLessThan(1);
    expect(landedBucket.position.y).toBeLessThan(-4.55);
    frame(12000);
    expect(landedBucket.scale.y).toBeCloseTo(1);
    expect(landedBucket.position.y).toBeCloseTo(-4.55);
    expect(ring.visible).toBe(false);
  });
  it('gives each of the ten landings its own reaction as the batch comes down', () => {
    const frame = frames();
    const props = {
      multipliersCents: DIAMOND,
      path: null,
      batchPathBits: [0xffff, 0],
      dropKey: 12,
    };
    const view = render(<PlinkoBoard {...props} restingSlot={null} />);
    const scene = scenes.create.mock.calls[0][0] as THREE.Scene;
    frame(100);
    frame(3950);
    expect(slotMesh(scene, 16).material.emissiveIntensity).toBeGreaterThan(1);
    expect(slotMesh(scene, 0).material.emissiveIntensity).toBe(0);
    // The page books a chip off every landing, so the board re-renders between
    // beats. The tally is written into the DOM and must survive that.
    view.rerender(<PlinkoBoard {...props} restingSlot={16} />);
    expect(screen.getByRole('status')).toHaveTextContent('1 Of 2 Landed. Best 20x.');
    frame(4100);
    // The second drop is all left turns, so slot 0 reacts on its own beat.
    expect(slotMesh(scene, 0).material.emissiveIntensity).toBeGreaterThan(1);
    expect(screen.getByRole('status')).toHaveTextContent('2 Of 2 Landed. Best 20x.');
  });
  it('drops a ball released later from the top, and a released batch keeps its cadence', () => {
    // THE PLAYER RELEASES THE BALLS (Dan 2026-09-21, R6): the page grows the
    // batch as the player taps Drop or Drop All. A ball added six seconds in
    // must fall from the top now, not be back-dated to the batch start and
    // land without ever being seen.
    const frame = frames();
    const onProgress = vi.fn();
    const onLanded = vi.fn();
    const props = {
      multipliersCents: DIAMOND,
      path: null,
      dropKey: 21,
      restingSlot: null,
      onProgress,
      onLanded,
    };
    const view = render(<PlinkoBoard {...props} batchPathBits={[0xffff]} />);
    frame(100);
    frame(6000);
    // The one released ball has landed and the board says so, once.
    expect(onProgress).toHaveBeenLastCalledWith(1);
    expect(onLanded).toHaveBeenCalledTimes(1);
    expect(field.light).toHaveBeenLastCalledWith([]);
    // The player releases a second ball: it starts at row zero, six seconds in.
    view.rerender(<PlinkoBoard {...props} batchPathBits={[0xffff, 0]} />);
    frame(6100);
    expect(field.light).toHaveBeenLastCalledWith([pegIndexAt(0, 0)]);
    frame(7000);
    expect(field.light.mock.calls.at(-1)![0]).toHaveLength(1);
    expect(onLanded).toHaveBeenCalledTimes(1);
    // And two more at once come down one gap apart, so three are in flight together.
    view.rerender(<PlinkoBoard {...props} batchPathBits={[0xffff, 0, 0xffff, 0]} />);
    frame(7100);
    frame(7500);
    expect(field.light.mock.calls.at(-1)![0]).toHaveLength(3);
    frame(12000);
    expect(onProgress).toHaveBeenLastCalledWith(4);
    expect(onLanded).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('4 Of 4 Landed.');
  });
  it('collapses the motion under reduced motion and keeps the colour and the mark', () => {
    reduceMotion(true);
    const frame = frames();
    render(
      <PlinkoBoard
        multipliersCents={DIAMOND}
        path={null}
        batchPathBits={[0xffff, 0]}
        dropKey={13}
        restingSlot={16}
      />
    );
    const scene = scenes.create.mock.calls[0][0] as THREE.Scene;
    // Reduced motion also slows the frame budget to 150ms, so the first tick is
    // skipped: the whole batch then completes inside one frame, as it should.
    frame(100);
    frame(400);
    frame(700);
    const landedBucket = slotMesh(scene, 16);
    // No travel: the squash is the motion and it is gone.
    expect(landedBucket.scale.y).toBe(1);
    expect(landedBucket.position.y).toBeCloseTo(-4.55);
    // The meaning is not: the bucket is lit, the ring is up and the tally reads.
    expect(landedBucket.material.emissiveIntensity).toBeGreaterThan(1);
    expect(scene.getObjectByName('Plinko Win Ring')!.visible).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('Best 20x.');
    // And the final resting state is reached at once rather than over two seconds.
    expect((scene.getObjectByName('Plinko Drop Diamond') as THREE.Mesh).position.y).toBeCloseTo(
      -4.01
    );
  });
});

describe('the stylesheet obeys the animation laws it is bound by', () => {
  it('scales every animation it declares by the player animation speed', () => {
    const declared = [...CSS.matchAll(/animation:\s*([A-Za-z][\w-]*)\s+([^;]+);/g)];
    expect(declared.length).toBeGreaterThan(1);
    for (const [, name, rest] of declared) {
      expect(CSS, `@keyframes ${name} is missing`).toContain(`@keyframes ${name}`);
      expect(rest, `${name} ignores --animation-speed`).toContain('var(--animation-speed, 1)');
    }
  });
  it('collapses motion for reduced motion without switching an animation off', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('animation-duration: 1ms');
    expect(reduced).toContain('animation-iteration-count: 1');
    // `animation: none` would strand an element on a frame it never reached.
    expect(reduced).not.toContain('animation: none');
    expect(reduced).toContain("[data-hit='true']");
    expect(reduced).toContain("[data-win='big']");
  });
  it('carries no hover state and no em dash', () => {
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain(':hover');
    expect(CSS).not.toContain('—');
  });
  it('reads the tint and the heat off the element rather than hardcoding a table', () => {
    expect(CSS).toContain('var(--slot-tint');
    expect(CSS).toContain('var(--slot-heat');
    for (const table of [DIAMOND, SUPER])
      for (const cents of table) expect(CSS).not.toContain(bucketTint(cents).toUpperCase());
  });
});
