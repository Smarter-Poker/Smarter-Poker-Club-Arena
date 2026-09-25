/**
 * THE GLASS OVER THE FLIGHT (Dan 2026-09-19, directive 3: "DO A DEEP DIVE
 * ONLINE AND SEE HOW OTHER CRASH ... GAMES ARE DISPLAYED ANIMATED AND SHOWN,
 * AND MAKE ANY AND ALL IMPROVEMENT, ENHANCEMENTS AND UPGRADES TO OURS").
 *
 * Aviator, Stake Crash and Roobet Crash share one grammar, and each pin here
 * is one of its sentences: the multiplier is the hero and reads two decimals
 * in a colour that warms as it climbs; the axes follow the flight instead of
 * jumping; the head carries a marker; the auto cash-out and the guaranteed
 * floor are drawn where they happen; a crash flashes red once and freezes the
 * curve; a cash-out pins a green marker. The scene is the 3D flight it always
 * was, so the renderer is stubbed the way CrashSceneCompletion stubs it and
 * the glass is read straight off the DOM the frame loop places.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const frames = vi.hoisted(() => ({ render: vi.fn(() => true), cleanup: vi.fn(), fail: false }));
const motion = vi.hoisted(() => ({ reduced: false, speed: 1 }));
vi.mock('../../src/utils/animationSpeed', () => ({
  getAnimationSpeed: () => motion.speed,
  prefersReducedMotion: () => motion.reduced,
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/games/sceneKit', async (original) => {
  const actual = await original<typeof import('../../src/components/games/sceneKit')>();
  const THREE = await import('three');
  return {
    ...actual,
    gameRenderer: (canvas: HTMLCanvasElement, width: number, height: number) => {
      if (frames.fail) throw new Error('No WebGL');
      return {
        scene: new THREE.Scene(),
        camera: new THREE.PerspectiveCamera(38, width / height, 0.1, 150),
        renderer: { domElement: canvas },
        render: frames.render,
        cleanup: frames.cleanup,
      };
    },
  };
});
import CrashCurve, {
  CRASH_FLASH_MS,
  floorCents,
  tickerHeat,
  tickerLabel,
  type CrashCurveProps,
} from '../../src/components/crash/CrashCurve';
import CrashPointsStrip, { crashBand } from '../../src/components/games/CrashPointsStrip';
import { crashMultiplierCents } from '../../src/utils/diamondGamesFairness';

const CSS = readFileSync(
  resolve(__dirname, '../../src/components/crash/CrashCurve.module.css'),
  'utf8'
);

/** One frame at a time, the way the scene completion test drives the loop. */
function clock() {
  let frame: FrameRequestCallback = () => {};
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  return {
    tick(now: number) {
      act(() => {
        frame(now);
      });
    },
  };
}
const base: CrashCurveProps = {
  phase: 'idle',
  growthK: 0.12,
  capCents: 10000,
  startedAtLocalMs: null,
  replayElapsedMs: 0,
  finalCents: null,
  cashoutCents: null,
  crashCents: null,
  autoCashoutCents: null,
  width: 371,
  height: 310,
};
const hero = (root: HTMLElement) => root.querySelector('[data-heat]') as HTMLElement;
const shown = (root: HTMLElement, selector: string) =>
  Array.from(root.querySelectorAll<SVGElement>(selector)).filter(
    (node) => node.getAttribute('visibility') !== 'hidden'
  );
const labels = (root: HTMLElement, selector: string) =>
  shown(root, selector).map((node) => node.textContent);
const at = (node: Element | null | undefined, attr: string) => Number(node?.getAttribute(attr));
const tick = (root: HTMLElement, cents: number) => root.querySelector(`[data-tick="${cents}"]`)!;
/** The elapsed milliseconds at which the curve reads a multiplier, for growth 0.12. */
const secondsTo = (cents: number) => Math.round((Math.log(cents / 100) / 0.12) * 1000);

beforeEach(() => {
  motion.reduced = false;
  motion.speed = 1;
  frames.fail = false;
  frames.render.mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('the multiplier is the hero', () => {
  it('prints the figure the page holds, two decimals always, in tabular digits', () => {
    clock();
    const { container, rerender } = render(
      <CrashCurve {...base} phase="open" startedAtLocalMs={0} tickerCents={250} />
    );
    expect(hero(container)).toHaveTextContent('2.50x');
    expect(
      CSS.slice(CSS.indexOf('.ticker {'), CSS.indexOf('}', CSS.indexOf('.ticker {')))
    ).toContain('font-variant-numeric: tabular-nums');
    expect(tickerLabel(257)).toBe('2.57x');
    expect(tickerLabel(100)).toBe('1.00x');
    rerender(<CrashCurve {...base} phase="open" startedAtLocalMs={0} tickerCents={1234} />);
    expect(hero(container)).toHaveTextContent('12.34x');
  });

  it('warms as it climbs: calm to 2x, warm to 5x, hot past it', () => {
    clock();
    expect([
      tickerHeat(100),
      tickerHeat(199),
      tickerHeat(200),
      tickerHeat(499),
      tickerHeat(500),
    ]).toEqual(['calm', 'calm', 'warm', 'warm', 'hot']);
    const { container, rerender } = render(
      <CrashCurve {...base} phase="open" startedAtLocalMs={0} tickerCents={150} />
    );
    expect(hero(container)).toHaveAttribute('data-heat', 'calm');
    rerender(<CrashCurve {...base} phase="open" startedAtLocalMs={0} tickerCents={260} />);
    expect(hero(container)).toHaveAttribute('data-heat', 'warm');
    rerender(<CrashCurve {...base} phase="open" startedAtLocalMs={0} tickerCents={640} />);
    expect(hero(container)).toHaveAttribute('data-heat', 'hot');
    for (const heat of ['warm', 'hot']) expect(CSS).toContain(`.ticker[data-heat='${heat}']`);
  });

  it('reads the crash point in red when the round is lost, and the booked multiplier in green when it is won', () => {
    clock();
    const { container, rerender } = render(
      <CrashCurve {...base} phase="crashed" finalCents={232} crashCents={232} />
    );
    expect(hero(container)).toHaveTextContent('2.32x');
    expect(hero(container)).toHaveAttribute('data-phase', 'crashed');
    expect(CSS).toContain(".ticker[data-phase='crashed']");
    rerender(
      <CrashCurve {...base} phase="cashed" finalCents={257} cashoutCents={257} crashCents={950} />
    );
    expect(hero(container)).toHaveTextContent('2.57x');
    expect(hero(container)).toHaveAttribute('data-phase', 'cashed');
    expect(CSS).toContain(".ticker[data-phase='cashed']");
    rerender(<CrashCurve {...base} phase="idle" />);
    expect(hero(container)).toHaveTextContent('1.00x');
  });

  it('follows the scene clock only when the page hands it nothing, as a replay does', () => {
    const { tick: frame } = clock();
    const { container } = render(<CrashCurve {...base} phase="open" replayElapsedMs={8000} />);
    frame(100);
    expect(hero(container)).toHaveTextContent(tickerLabel(crashMultiplierCents(0.12, 8000, 10000)));
    expect(hero(container)).toHaveTextContent('2.61x');
  });

  it('hands the page the very figure it prints, every drawn frame, without a render (R20)', () => {
    const { tick: frame } = clock();
    const onTick = vi.fn();
    const { container, rerender } = render(
      <CrashCurve {...base} phase="open" replayElapsedMs={100} onTick={onTick} />
    );
    frame(100);
    const at100 = crashMultiplierCents(0.12, 100, 10000);
    expect(onTick).toHaveBeenLastCalledWith(at100);
    expect(hero(container)).toHaveTextContent(tickerLabel(at100));
    rerender(<CrashCurve {...base} phase="open" replayElapsedMs={8000} onTick={onTick} />);
    const drawn = frames.render.mock.calls.length;
    frame(8000);
    const at8000 = crashMultiplierCents(0.12, 8000, 10000);
    expect(onTick).toHaveBeenLastCalledWith(at8000);
    expect(hero(container)).toHaveTextContent(tickerLabel(at8000));
    expect(hero(container).dataset.heat).toBe(tickerHeat(at8000));
    // The figure went from the loop to the text node: one scene frame, no render of it.
    expect(frames.render.mock.calls.length - drawn).toBe(1);
  });
  it('holds the figure the page freezes while a cash-out is pending', () => {
    const { tick: frame } = clock();
    const { container, rerender } = render(
      <CrashCurve {...base} phase="open" replayElapsedMs={8000} />
    );
    frame(100);
    expect(hero(container)).toHaveTextContent('2.61x');
    rerender(<CrashCurve {...base} phase="open" replayElapsedMs={12000} tickerCents={261} />);
    frame(200);
    expect(hero(container)).toHaveTextContent('2.61x');
    // Released again: the clock's figure returns on the next frame, never an older one.
    rerender(<CrashCurve {...base} phase="open" replayElapsedMs={12000} />);
    expect(hero(container)).toHaveTextContent('2.61x');
    frame(300);
    expect(hero(container)).toHaveTextContent(
      tickerLabel(crashMultiplierCents(0.12, 12000, 10000))
    );
  });
  it('stops its loop while the tab is hidden and resumes when it is shown', () => {
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const requested: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      requested.push(callback);
      return requested.length;
    });
    const cancelled = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    render(<CrashCurve {...base} phase="open" startedAtLocalMs={0} />);
    const scheduled = () => requested.length;
    act(() => requested[scheduled() - 1](100));
    const before = scheduled();
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(cancelled).toHaveBeenCalled();
    // A frame that still fires while hidden does no work and schedules nothing.
    act(() => requested[before - 1](5000));
    expect(scheduled()).toBe(before);
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(scheduled()).toBe(before + 1);
  });
  it('stays up, with its axes, when WebGL cannot draw the flight', () => {
    frames.fail = true;
    const { tick: frame } = clock();
    const { container, getByText } = render(
      <CrashCurve {...base} phase="open" startedAtLocalMs={0} tickerCents={257} />
    );
    expect(getByText(/The 3D Scene Is Unavailable/)).toBeInTheDocument();
    expect(hero(container)).toHaveTextContent('2.57x');
    frame(100);
    expect(labels(container, '[data-tick-label]')).toEqual(['1.00x', '2.00x']);
  });
});

describe('the axes follow the flight', () => {
  it('starts with the lines a fresh climb needs and lets the higher ones in as it goes, sliding rather than jumping', () => {
    const { tick: frame } = clock();
    const { container, rerender } = render(
      <CrashCurve {...base} phase="open" replayElapsedMs={0} tickerCents={100} />
    );
    frame(100);
    expect(labels(container, '[data-tick-label]')).toEqual(['1.00x', '2.00x']);
    expect(labels(container, '[data-second-label]')).toEqual(['2s', '4s', '6s', '8s', '10s']);
    const baseline = at(tick(container, 100), 'y1');
    const twoAtStart = at(tick(container, 200), 'y1');
    expect(twoAtStart).toBeLessThan(baseline);
    // The flight reaches 12x: the scale has to grow to 5.00x and 10.00x.
    const twelve = secondsTo(1200);
    rerender(<CrashCurve {...base} phase="open" replayElapsedMs={twelve} tickerCents={1200} />);
    frame(140);
    const twoAfterOneFrame = at(tick(container, 200), 'y1');
    for (let now = 180; now <= 3000; now += 40) frame(now);
    const twoSettled = at(tick(container, 200), 'y1');
    expect(labels(container, '[data-tick-label]')).toEqual(['1.00x', '2.00x', '5.00x', '10.00x']);
    // As the axis grows the 2.00x line slides down towards the launch line.
    expect(twoSettled).toBeGreaterThan(twoAtStart);
    // One 40ms frame moves it part of the way, never all of it.
    expect(twoAfterOneFrame).toBeGreaterThan(twoAtStart);
    expect(twoAfterOneFrame - twoAtStart).toBeLessThan((twoSettled - twoAtStart) * 0.5);
    // The seconds axis compresses with it, from 2s steps to 5s steps.
    expect(labels(container, '[data-second-label]')).toEqual(['5s', '10s', '15s', '20s']);
    // The launch line never moves: 1.00x is always where the flight begins.
    expect(at(tick(container, 100), 'y1')).toBe(baseline);
  });

  it('snaps the scale under reduced motion, so nothing glides', () => {
    motion.reduced = true;
    const { tick: frame } = clock();
    const { container, rerender } = render(
      <CrashCurve {...base} phase="open" replayElapsedMs={0} tickerCents={100} />
    );
    // The reduced-motion cadence is slower, so the baseline is read off a frame
    // the loop has actually painted: a line that is merely absent reads as 0.
    frame(100);
    frame(300);
    const twoAtStart = at(tick(container, 200), 'y1');
    expect(twoAtStart).toBeGreaterThan(0);
    rerender(
      <CrashCurve {...base} phase="open" replayElapsedMs={secondsTo(1200)} tickerCents={1200} />
    );
    frame(500);
    const twoAfterOneFrame = at(tick(container, 200), 'y1');
    for (let now = 800; now <= 4000; now += 200) frame(now);
    expect(at(tick(container, 200), 'y1')).toBe(twoAfterOneFrame);
    expect(twoAfterOneFrame).toBeGreaterThan(twoAtStart);
  });

  it('carries a marker at the head of the curve that climbs with it', () => {
    const { tick: frame } = clock();
    const { container, rerender } = render(
      <CrashCurve {...base} phase="open" replayElapsedMs={0} tickerCents={100} />
    );
    frame(100);
    const head = container.querySelector('[data-marker="head"]')!;
    expect(head.getAttribute('visibility')).not.toBe('hidden');
    const x0 = at(head, 'cx'),
      y0 = at(head, 'cy');
    rerender(<CrashCurve {...base} phase="open" replayElapsedMs={5000} tickerCents={182} />);
    frame(140);
    expect(at(head, 'cx')).toBeGreaterThan(x0);
    expect(at(head, 'cy')).toBeLessThan(y0);
    rerender(<CrashCurve {...base} phase="idle" />);
    frame(180);
    expect(head.getAttribute('visibility')).toBe('hidden');
  });
});

describe('what the player set is drawn where it happens', () => {
  it('draws the auto cash-out as a labelled line on the very line the head crosses at that multiplier', () => {
    const { tick: frame } = clock();
    const { container, rerender } = render(
      <CrashCurve
        {...base}
        phase="open"
        replayElapsedMs={0}
        tickerCents={100}
        autoCashoutCents={200}
      />
    );
    frame(100);
    const auto = container.querySelector('[data-line="auto"]')!;
    expect(auto.getAttribute('visibility')).not.toBe('hidden');
    expect(labels(container, '[data-line-label="auto"]')).toEqual(['Auto 2.00x']);
    expect(at(auto, 'y1')).toBe(at(tick(container, 200), 'y1'));
    rerender(
      <CrashCurve
        {...base}
        phase="open"
        replayElapsedMs={0}
        tickerCents={100}
        autoCashoutCents={null}
      />
    );
    frame(140);
    expect(auto.getAttribute('visibility')).toBe('hidden');
  });

  it('draws the guaranteed floor below the launch line at its payout equivalent, only when that maps onto the axis', () => {
    expect(floorCents(1, 2)).toBe(50);
    expect(floorCents(0.1, 1)).toBe(10);
    expect(floorCents(0, 1)).toBeNull();
    expect(floorCents(1, null)).toBeNull();
    const { tick: frame } = clock();
    const { container, rerender } = render(
      <CrashCurve
        {...base}
        phase="open"
        replayElapsedMs={0}
        tickerCents={100}
        minimumPayoutChips={1}
        betChips={2}
      />
    );
    frame(100);
    const floor = container.querySelector('[data-line="floor"]')!;
    expect(floor.getAttribute('visibility')).not.toBe('hidden');
    expect(labels(container, '[data-line-label="floor"]')).toEqual(['Guaranteed 1.00 Chips']);
    // A Super floor is half the stake: below 1.00x, so beneath the launch line, inside the frame.
    expect(at(floor, 'y1')).toBeGreaterThan(at(tick(container, 100), 'y1'));
    expect(at(floor, 'y1')).toBeLessThan(310 - 20);
    // A tenth floor sits too far below a fresh axis to be drawn.
    rerender(
      <CrashCurve
        {...base}
        phase="open"
        replayElapsedMs={0}
        tickerCents={100}
        minimumPayoutChips={0.1}
        betChips={1}
      />
    );
    frame(140);
    expect(floor.getAttribute('visibility')).toBe('hidden');
    // A floor equal to the stake is the launch line itself.
    rerender(
      <CrashCurve
        {...base}
        phase="open"
        replayElapsedMs={0}
        tickerCents={100}
        minimumPayoutChips={2}
        betChips={2}
      />
    );
    frame(180);
    expect(floor.getAttribute('visibility')).not.toBe('hidden');
    expect(at(floor, 'y1')).toBe(at(tick(container, 100), 'y1'));
  });
});

describe('the two moments', () => {
  it('flashes red once on a crash, for a wash that follows Animation Speed, and freezes the curve at the crash point', () => {
    motion.speed = 2;
    const { tick: frame } = clock();
    const { container } = render(
      <CrashCurve {...base} phase="crashed" finalCents={232} crashCents={232} />
    );
    const flash = container.querySelector('[class*="flash"]') as HTMLElement;
    expect(flash).not.toBeNull();
    expect(flash.style.animationDuration).toBe(`${CRASH_FLASH_MS * 2}ms`);
    expect(flash).not.toHaveAttribute('data-reduced');
    expect(CSS).toContain('@keyframes crashFlash');
    frame(100);
    const crash = container.querySelector('[data-marker="crash"]')!;
    expect(crash.getAttribute('visibility')).not.toBe('hidden');
    expect(container.querySelector('[data-marker="head"]')!.getAttribute('visibility')).toBe(
      'hidden'
    );
    for (let now = 140; now <= 3000; now += 40) frame(now);
    const x = at(crash, 'cx'),
      y = at(crash, 'cy');
    frame(3040);
    frame(6000);
    expect([at(crash, 'cx'), at(crash, 'cy')]).toEqual([x, y]);
    expect(hero(container)).toHaveTextContent('2.32x');
  });

  it('pins a green marker at the cash-out multiplier while the flight goes on to the crash point', () => {
    const { tick: frame } = clock();
    const { container } = render(
      <CrashCurve {...base} phase="cashed" finalCents={257} cashoutCents={257} crashCents={950} />
    );
    frame(100);
    const cash = container.querySelector('[data-marker="cash"]')!;
    const crash = container.querySelector('[data-marker="crash"]')!;
    expect(cash.getAttribute('visibility')).not.toBe('hidden');
    expect(labels(container, '[data-marker-label="cash"]')).toEqual(['Cashed 2.57x']);
    expect(crash.getAttribute('visibility')).toBe('hidden');
    for (let now = 140; now <= 3600; now += 40) frame(now);
    expect(crash.getAttribute('visibility')).not.toBe('hidden');
    expect(labels(container, '[data-marker-label="crash"]')).toEqual(['Crashed 9.50x']);
    // The booked marker stays put: the crash is further up the curve.
    expect(at(crash, 'cx')).toBeGreaterThan(at(cash, 'cx'));
    expect(hero(container)).toHaveTextContent('2.57x');
  });

  it('keeps both moments static under reduced motion', () => {
    motion.reduced = true;
    const { tick: frame } = clock();
    const { container, rerender } = render(
      <CrashCurve {...base} phase="crashed" finalCents={232} crashCents={232} />
    );
    const flash = container.querySelector('[class*="flash"]') as HTMLElement;
    expect(flash).toHaveAttribute('data-reduced', 'true');
    expect(flash.style.animationDuration).toBe('');
    expect(CSS).toContain(".flash[data-reduced='true']");
    /* §10.6: reduced motion collapses MOTION, never MEANING. The wash stops
       animating and stays on screen at a readable opacity, so the round still
       says it was lost. A switch-off that also took the colour away would be
       the bug this pin exists to catch. */
    const reducedWash = CSS.slice(
      CSS.indexOf(".flash[data-reduced='true']"),
      CSS.indexOf('}', CSS.indexOf(".flash[data-reduced='true']"))
    );
    expect(reducedWash).toContain('animation: none');
    expect(Number(/opacity:\s*([\d.]+)/.exec(reducedWash)?.[1])).toBeGreaterThan(0);
    /* Reduced motion paints the glass on its own slower cadence, so the
       baseline is taken once the crash point is ON it. STATIC means placed and
       then unmoving; an absent attribute reads as 0 through getAttribute and
       would pin the marker as missing, which is the one thing the law forbids. */
    frame(100);
    frame(300);
    const crash = container.querySelector('[data-marker="crash"]')!;
    expect(crash.getAttribute('visibility')).not.toBe('hidden');
    const x = at(crash, 'cx'),
      y = at(crash, 'cy');
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    frame(600);
    frame(3000);
    expect([at(crash, 'cx'), at(crash, 'cy')]).toEqual([x, y]);
    rerender(
      <CrashCurve {...base} phase="cashed" finalCents={257} cashoutCents={257} crashCents={950} />
    );
    frame(3200);
    // No replay to wait for: the booked marker and the crash point are both there at once.
    expect(labels(container, '[data-marker-label="cash"]')).toEqual(['Cashed 2.57x']);
    expect(labels(container, '[data-marker-label="crash"]')).toEqual(['Crashed 9.50x']);
    const cash = container.querySelector('[data-marker="cash"]')!;
    const cx = at(cash, 'cx'),
      cy = at(cash, 'cy');
    expect(cx).toBeGreaterThan(0);
    expect(cy).toBeGreaterThan(0);
    frame(3400);
    frame(8000);
    expect([at(cash, 'cx'), at(cash, 'cy')]).toEqual([cx, cy]);
  });
});

describe('the history strip', () => {
  it('colours each crash point by band: red under 2x, green from 2x, gold from 10x', () => {
    expect([crashBand(199), crashBand(200), crashBand(999), crashBand(1000)]).toEqual([
      'low',
      'mid',
      'mid',
      'high',
    ]);
    const { getByRole } = render(
      <CrashPointsStrip
        points={[
          { crash_cents: 150, cashed: false, at: 'a' },
          { crash_cents: 250, cashed: true, at: 'b' },
          { crash_cents: 1200, cashed: true, at: 'c' },
        ]}
      />
    );
    const items = Array.from(getByRole('list').querySelectorAll('[role="listitem"]'));
    expect(items[0]).toHaveClass('sc-ink--red');
    expect(items[1]).toHaveClass('sc-ink--green');
    expect(items[2]).toHaveClass('sc-ink--gold');
    expect(items.map((item) => item.getAttribute('data-band'))).toEqual(['low', 'mid', 'high']);
  });

  it('prints nothing when the host has no rounds yet', () => {
    const { container } = render(<CrashPointsStrip points={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

/**
 * THE CAP IS SAID AND THE ROAD NOT TAKEN IS SHOWN (Dan 2026-09-25: "the
 * multiplier should be 25x max and that should be displayed to the user so
 * they know thats the max they can get ... if a user books the win it should
 * show them how high it would have gone").
 */
describe('the cap and the would-have-gone plate', () => {
  it('prints the cap as a permanent chip and draws it on the axis once the scale reaches it', () => {
    const { tick: frame } = clock();
    const { container, rerender } = render(
      <CrashCurve {...base} capCents={2500} phase="open" replayElapsedMs={0} tickerCents={100} />
    );
    expect(container.querySelector('[data-cap="2500"]')).toHaveTextContent('Max 25.00x');
    frame(100);
    const cap = container.querySelector('[data-line="cap"]')!;
    expect(cap.getAttribute('visibility')).toBe('hidden');
    rerender(
      <CrashCurve
        {...base}
        capCents={2500}
        phase="open"
        replayElapsedMs={secondsTo(2200)}
        tickerCents={2200}
      />
    );
    for (let now = 140; now <= 3000; now += 40) frame(now);
    expect(labels(container, '[data-line-label="cap"]')).toEqual(['Max 25.00x']);
    // Above the 20.00x line, below the top of the axis.
    expect(at(cap, 'y1')).toBeLessThan(at(tick(container, 2000), 'y1'));
    expect(at(cap, 'y1')).toBeGreaterThan(0);
  });

  it('raises the plate the moment a booked replay reaches the crash point, and not before', () => {
    const { tick: frame } = clock();
    const { container } = render(
      <CrashCurve
        {...base}
        capCents={2500}
        phase="cashed"
        finalCents={257}
        cashoutCents={257}
        crashCents={950}
      />
    );
    const plate = container.querySelector('[data-reveal="would-have-gone"]') as HTMLElement;
    expect(plate).toHaveTextContent('It Would Have Gone To 9.50x');
    expect(plate).toHaveTextContent('You Booked 2.57x');
    frame(100);
    frame(2000);
    expect(plate.dataset.shown).toBeUndefined();
    for (let now = 2040; now <= 3600; now += 40) frame(now);
    expect(plate.dataset.shown).toBe('true');
    expect(plate.style.animationDuration).toBe('520ms');
    expect(CSS).toContain('@keyframes revealIn');
  });

  it('says when it crashed right after the booking, and when the cap came first', () => {
    const { tick: frame } = clock();
    const { container, rerender } = render(
      <CrashCurve
        {...base}
        capCents={2500}
        phase="cashed"
        finalCents={257}
        cashoutCents={257}
        crashCents={258}
      />
    );
    const plate = () => container.querySelector('[data-reveal="would-have-gone"]')!;
    expect(plate()).toHaveTextContent('It Crashed Right After You Booked');
    rerender(
      <CrashCurve
        {...base}
        capCents={2500}
        phase="cashed"
        finalCents={410}
        cashoutCents={410}
        crashCents={3000}
      />
    );
    expect(plate()).toHaveTextContent('It Would Have Gone To The 25.00x Max');
    expect(plate()).toHaveTextContent('You Booked 4.10x');
    rerender(
      <CrashCurve
        {...base}
        capCents={2500}
        phase="cashed"
        finalCents={2500}
        cashoutCents={2500}
        crashCents={3000}
      />
    );
    expect(plate()).toHaveTextContent('Booked At The 25.00x Max');
    expect(hero(container)).toHaveTextContent('25.00x');
    frame(100);
    rerender(<CrashCurve {...base} capCents={2500} phase="idle" />);
    expect(container.querySelector('[data-reveal="would-have-gone"]')).toBeNull();
  });

  it('keeps the plate under reduced motion, static and immediate', () => {
    motion.reduced = true;
    const { tick: frame } = clock();
    const { container } = render(
      <CrashCurve
        {...base}
        capCents={2500}
        phase="cashed"
        finalCents={257}
        cashoutCents={257}
        crashCents={950}
      />
    );
    const plate = container.querySelector('[data-reveal="would-have-gone"]') as HTMLElement;
    expect(plate).toHaveAttribute('data-reduced', 'true');
    expect(plate.style.animationDuration).toBe('');
    frame(100);
    frame(300);
    expect(plate.dataset.shown).toBe('true');
    expect(CSS).toContain(".reveal[data-reduced='true'][data-shown='true']");
  });
});
