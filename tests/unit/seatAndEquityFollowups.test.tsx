/**
 * SEAT + ALL-IN PERCENTAGE FOLLOW-UPS (2026-10-04)
 *
 * Six defects found reviewing the same day's ring / win-percentage / reconnect
 * work. Each block names the defect it pins.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EquityBadgeLayer, type EquityBadge } from '../../src/components/table/EquityBadgeLayer';
import { placeEquityBadges, type Box } from '../../src/lib/equityBadgePlacement';
import SeatSlot from '../../src/components/table/SeatSlot';
import { sliceCssRule } from '../helpers/sourceWindow';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const stripCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const stripTs = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

// ============================================================================
// A fake felt with real layout numbers. happy-dom lays nothing out, so every
// box is declared here in the LAYER'S OWN layout px and the stubs answer the
// way a browser does: offsetWidth/Height in layout px, getBoundingClientRect
// in painted px (layout x the ancestor scale, from the layer's painted origin).
// ============================================================================

const LAYER_BOX: Box = { left: 0, top: 0, width: 400, height: 600 };
const SEAT_BOX: Box = { left: 160, top: 300, width: 80, height: 110 };
const BADGE_SIZE = { width: 90, height: 56 };
const PAGE_ORIGIN = { left: 100, top: 50 };
const ORDER: EquityBadge['order'] = ['above', 'right', 'left', 'below'];
const BADGES: EquityBadge[] = [{ seatNumber: 1, equity: 50, order: ORDER }];
const NO_BADGES: EquityBadge[] = [];

const world = { scale: 1, card: { left: 0, top: 0, width: 0, height: 0 } as Box, layerReads: 0 };

function layoutBox(el: Element): Box {
  if (el.classList.contains('equity-layer')) return LAYER_BOX;
  if (el.classList.contains('seat-wrapper')) return SEAT_BOX;
  if (el.classList.contains('equity-layer__slot')) return { left: 0, top: 0, ...BADGE_SIZE };
  if (el.classList.contains('seat__card')) return world.card;
  return { left: 0, top: 0, width: 0, height: 0 };
}

function installLayout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains('equity-layer')) world.layerReads += 1;
    const b = layoutBox(this);
    const left = PAGE_ORIGIN.left + b.left * world.scale;
    const top = PAGE_ORIGIN.top + b.top * world.scale;
    const width = b.width * world.scale;
    const height = b.height * world.scale;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return layoutBox(this).width;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return layoutBox(this).height;
  });
}

function Felt({ badges, revealed = false }: { badges: EquityBadge[]; revealed?: boolean }) {
  return (
    <div className="table-scaler">
      <div className="seat-wrapper" data-seat-wrapper="1">
        <div
          className={`seat__cards seat__cards--opponent${revealed ? ' seat__cards--revealed' : ''}`}
        >
          <div className="seat__card" />
        </div>
        <div className="seat__avatar" />
      </div>
      <EquityBadgeLayer badges={badges} />
    </div>
  );
}

const slotOf = (container: HTMLElement) =>
  container.querySelector('.equity-layer__slot') as HTMLElement;

beforeEach(() => {
  world.scale = 1;
  world.card = { left: 0, top: 0, width: 0, height: 0 };
  world.layerReads = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('1. a badge is placed in the layer own px, whatever an ancestor transform does', () => {
  /* Multi-table TILE VIEW draws the table page under transform: scale(0.5).
     The rects were scaled px, `left/top` are unscaled layout px: every badge
     landed halfway between the layer's corner and its seat. */
  const [expected] = placeEquityBadges(
    [{ key: '1', seat: SEAT_BOX, size: BADGE_SIZE, order: ORDER }],
    [],
    { width: LAYER_BOX.width }
  );

  it.each([1, 0.5, 0.75])('scale %f: the slot is where the unscaled layout puts it', (scale) => {
    world.scale = scale;
    installLayout();
    const { container } = render(<Felt badges={BADGES} />);
    const slot = slotOf(container);
    expect(slot.getAttribute('data-equity-spot')).toBe('above');
    expect(slot.style.left).toBe(`${expected.left}px`);
    expect(slot.style.top).toBe(`${expected.top}px`);
    // The numbers themselves, so the pin does not lean on the helper alone:
    // centred on the seat (160 + 40 - 45), 22px of air above it (300 - 22 - 56).
    expect(expected.left).toBe(155);
    expect(expected.top).toBe(222);
  });

  it('a displayed card is avoided in the same units at scale 0.5', () => {
    world.scale = 0.5;
    // Face-up from the start, sitting in the layout-px box "above" would take.
    world.card = { left: 180, top: 230, width: 30, height: 40 };
    installLayout();
    const { container } = render(
      <Felt revealed badges={[{ seatNumber: 1, equity: 50, order: ['above', 'right'] }]} />
    );
    expect(slotOf(container).getAttribute('data-equity-spot')).toBe('right');
  });

  it('the clamp width is the layer layout width, not its painted width', () => {
    world.scale = 0.5;
    installLayout();
    // Painted width is 200; a 'right' badge at layout x 246 must not be
    // clamped back to 200 - 2 - 90.
    const { container } = render(
      <Felt badges={[{ seatNumber: 1, equity: 50, order: ['right'] }]} />
    );
    expect(slotOf(container).style.left).toBe(`${SEAT_BOX.left + SEAT_BOX.width + 6}px`);
  });
});

describe('2. the badges are re-measured when the felt says something moved', () => {
  class FakeResizeObserver {
    static made: FakeResizeObserver[] = [];
    observed: Element[] = [];
    disconnected = false;
    constructor(public cb: () => void) {
      FakeResizeObserver.made.push(this);
    }
    observe(el: Element) {
      this.observed.push(el);
    }
    unobserve() {}
    disconnect() {
      this.disconnected = true;
    }
  }
  class FakeMutationObserver {
    static made: FakeMutationObserver[] = [];
    observed: Array<{ el: Node; options: MutationObserverInit }> = [];
    disconnected = false;
    constructor(public cb: (records: Array<{ target: Node }>) => void) {
      FakeMutationObserver.made.push(this);
    }
    observe(el: Node, options: MutationObserverInit) {
      this.observed.push({ el, options });
    }
    takeRecords() {
      return [];
    }
    disconnect() {
      this.disconnected = true;
    }
  }

  beforeEach(() => {
    FakeResizeObserver.made = [];
    FakeMutationObserver.made = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('MutationObserver', FakeMutationObserver);
    installLayout();
  });

  it('observes the felt only while badges are shown, and lets go after', () => {
    const { container, rerender } = render(<Felt badges={NO_BADGES} />);
    expect(FakeResizeObserver.made).toHaveLength(0);
    expect(FakeMutationObserver.made).toHaveLength(0);

    rerender(<Felt badges={BADGES} />);
    const scope = container.querySelector('.table-scaler')!;
    expect(FakeResizeObserver.made).toHaveLength(1);
    expect(FakeResizeObserver.made[0].observed).toEqual([scope]);
    expect(FakeMutationObserver.made).toHaveLength(1);
    expect(FakeMutationObserver.made[0].observed).toEqual([
      { el: scope, options: { subtree: true, attributes: true, attributeFilter: ['class'] } },
    ]);

    // A new percentage each street must not rebuild the observers.
    rerender(<Felt badges={[{ ...BADGES[0], equity: 72 }]} />);
    expect(FakeResizeObserver.made).toHaveLength(1);
    expect(FakeMutationObserver.made).toHaveLength(1);

    rerender(<Felt badges={NO_BADGES} />);
    expect(FakeResizeObserver.made[0].disconnected).toBe(true);
    expect(FakeMutationObserver.made[0].disconnected).toBe(true);
  });

  it('lets go on unmount too', () => {
    const { unmount } = render(<Felt badges={BADGES} />);
    unmount();
    expect(FakeResizeObserver.made[0].disconnected).toBe(true);
    expect(FakeMutationObserver.made[0].disconnected).toBe(true);
  });

  it('a hand being tabled moves the badge off it; the settled size is the one avoided', () => {
    const { container } = render(<Felt badges={BADGES} />);
    const row = container.querySelector('.seat__cards') as HTMLElement;
    const card = container.querySelector('.seat__card') as HTMLElement;
    const avatar = container.querySelector('.seat__avatar') as HTMLElement;
    const mo = FakeMutationObserver.made[0];
    expect(slotOf(container).getAttribute('data-equity-spot')).toBe('above');

    // A class change that is not a card row: no layout read at all.
    const before = world.layerReads;
    act(() => mo.cb([{ target: avatar }]));
    expect(world.layerReads).toBe(before);

    // SeatSlot tables the hand: the row gains --revealed. At that instant the
    // cards are still at the START of their 0.2s grow, clear of the badge.
    world.card = { left: 300, top: 500, width: 10, height: 14 };
    row.classList.add('seat__cards--revealed');
    act(() => mo.cb([{ target: row }]));
    expect(world.layerReads).toBeGreaterThan(before);
    expect(slotOf(container).getAttribute('data-equity-spot')).toBe('above');

    // The transition ends with the face-up card under the badge's spot.
    world.card = { left: 180, top: 230, width: 30, height: 40 };
    act(() => {
      card.dispatchEvent(new Event('transitionend', { bubbles: true }));
    });
    const spot = slotOf(container).getAttribute('data-equity-spot');
    expect(spot).not.toBe('above');

    // And the class change alone is enough when the size does not animate.
    world.card = { left: 300, top: 500, width: 10, height: 14 };
    act(() => mo.cb([{ target: row }]));
    expect(slotOf(container).getAttribute('data-equity-spot')).toBe('above');
  });

  it('the felt changing size re-measures without any window resize', () => {
    const { container } = render(<Felt badges={BADGES} />);
    const before = world.layerReads;
    world.scale = 0.5;
    act(() => FakeResizeObserver.made[0].cb());
    expect(world.layerReads).toBeGreaterThan(before);
    expect(slotOf(container).style.left).toBe('155px');
  });

  it('a transitionend from anything but a seat card is ignored', () => {
    const { container } = render(<Felt badges={BADGES} />);
    const before = world.layerReads;
    act(() => {
      container
        .querySelector('.seat__avatar')!
        .dispatchEvent(new Event('transitionend', { bubbles: true }));
    });
    expect(world.layerReads).toBe(before);
  });

  it('still renders and places where neither observer exists', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    vi.stubGlobal('MutationObserver', undefined);
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { container, unmount } = render(<Felt badges={BADGES} />);
    expect(slotOf(container).style.left).toBe('155px');
    expect(add.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(1);
    unmount();
    expect(remove.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(1);
  });

  it('no polling and no timers in the layer', () => {
    const src = stripTs(read('src/components/table/EquityBadgeLayer.tsx'));
    expect(src).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
    // With a ResizeObserver the window listener is not used at all.
    expect(src).toMatch(/new ResizeObserver\(/);
    expect(src).toMatch(/new MutationObserver\(/);
  });
});

// ============================================================================
// 3 + 4. The countdown ring stylesheet
// ============================================================================

const SEAT_CSS = stripCss(read('src/components/table/SeatSlot.css'));

describe('3. the last-five-seconds pulse rests at 0%/100% and flares at 50%', () => {
  /* The animation waits on a positive delay with `both` fill, so the 0% frame
     is what the ring wears for the whole turn. It was the FLARED frame. */
  const at = SEAT_CSS.indexOf('@keyframes spTimerFlash');
  const block = SEAT_CSS.slice(at, SEAT_CSS.indexOf('}\n}', at) + 3);
  const frames = new Map(
    [...block.matchAll(/((?:\d+%\s*,?\s*)+)\{([^}]*)\}/g)].map((m) => [
      m[1].replace(/\s+/g, ''),
      m[2],
    ])
  );

  it('has exactly a resting frame and a flare frame', () => {
    expect(at).toBeGreaterThan(-1);
    expect([...frames.keys()].sort()).toEqual(['0%,100%', '50%']);
  });

  it('the resting frame is the plain ring: full opacity, no filter of its own', () => {
    const rest = frames.get('0%,100%')!;
    expect(rest).toMatch(/opacity:\s*1\s*;/);
    expect(rest).not.toMatch(/filter|brightness|drop-shadow/);
  });

  it('the flare is at 50%', () => {
    const flare = frames.get('50%')!;
    const brightness = Number(/brightness\(([\d.]+)\)/.exec(flare)?.[1]);
    expect(brightness).toBeGreaterThan(1);
    expect(flare).toMatch(/drop-shadow\(/);
  });

  it('the arc never reads as gone: no frame below 60% opacity', () => {
    const opacities = [...block.matchAll(/opacity:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    expect(opacities.length).toBeGreaterThan(0);
    expect(Math.min(...opacities)).toBeGreaterThanOrEqual(0.6);
  });

  it('reduced motion gets that same resting ring', () => {
    const reduced = SEAT_CSS.slice(SEAT_CSS.indexOf('}\n}', at));
    expect(reduced).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.seat--active \.seat__timer-ring \{\s*animation: none;/
    );
  });
});

describe('4. the border-linear ring is gated on the construct it uses', () => {
  const dAt = SEAT_CSS.indexOf('--sp-ring-d:');
  const gateAt = SEAT_CSS.lastIndexOf('@supports', dAt);
  const condition = SEAT_CSS.slice(gateAt, SEAT_CSS.indexOf('{', gateAt)).replace(/\s+/g, ' ');

  it('asks for atan2() of container units as a conic-gradient stop, in a var-free declaration', () => {
    expect(dAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    expect(condition).toMatch(/\(\s*background:\s*conic-gradient\(/);
    expect(condition).toMatch(/atan2\([^;]*cqw[^;]*cqh/);
    expect(condition).toMatch(/clamp\(/);
    expect(condition).toMatch(/container-type:\s*size/);
    // A var() would make the test declaration valid at parse time whatever
    // the engine thinks of the stop - the exact hole being closed.
    expect(condition).not.toMatch(/var\(/);
    // The two unrelated questions it used to ask.
    expect(condition).not.toMatch(/rotate:\s*atan2\(1px, 1px\)/);
    expect(condition).not.toMatch(/\(width:\s*1cqw\)/);
  });

  it('a browser that fails the gate keeps the angle-linear ring, declared before it', () => {
    const arcAt = SEAT_CSS.indexOf('.seat--active .seat__timer-ring-arc {');
    expect(arcAt).toBeGreaterThan(-1);
    expect(arcAt).toBeLessThan(gateAt);
    const arc = sliceCssRule(SEAT_CSS, '.seat--active .seat__timer-ring-arc {');
    expect(arc).toMatch(/--sp-ring-edge:\s*calc\(100% - var\(--timer-progress, 100%\)\)/);
    expect(arc).toMatch(/conic-gradient\(/);
    // ...and that fallback empties at the deadline: the one keyframe drives it.
    expect(SEAT_CSS).toMatch(/@keyframes spTimerRingShrink \{[^@]*to \{\s*--timer-progress: 0%;/);
  });
});

// ============================================================================
// 5. No start stamp: the ring's length comes from the deadline
// ============================================================================

const NOW = new Date('2026-10-04T00:00:00Z').getTime();
const player = {
  id: 'p1',
  name: 'HERO',
  stack: 1000,
  status: 'active' as const,
  showCards: false,
  isHero: true,
};
const seat = (extra: Record<string, unknown>) => (
  <SeatSlot
    seatNumber={1}
    player={player}
    position={'BTN' as never}
    isActive
    lastAction={null as never}
    {...extra}
  />
);
const info = (c: HTMLElement) => c.querySelector('.seat__info') as HTMLElement;
const TIMER_VARS = [
  '--sp-timer-duration',
  '--sp-timer-yellow-duration',
  '--sp-timer-delay',
  '--sp-timer-flash-delay',
  '--sp-timer-flash-count',
] as const;
const timerVars = (el: HTMLElement) =>
  Object.fromEntries(TIMER_VARS.map((v) => [v, el.style.getPropertyValue(v)]));
/** Lit fraction `ms` after the node mounted (linear, fill forwards). */
const lit = (el: HTMLElement, ms: number) => {
  const duration = parseFloat(el.style.getPropertyValue('--sp-timer-duration')) * 1000;
  const delay = parseFloat(el.style.getPropertyValue('--sp-timer-delay')) * 1000;
  return 1 - Math.min(1, Math.max(0, (ms - delay) / duration));
};

describe('5. with no start stamp the ring spans the time to the deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('a deadline 30s away draws a 30s ring, not a 15s one', () => {
    const { container } = render(seat({ turnDeadlineMs: NOW + 30_000 }));
    const el = info(container);
    expect(el.style.getPropertyValue('--sp-timer-duration')).toBe('30.000s');
    expect(el.style.getPropertyValue('--sp-timer-delay')).toBe('-0.000s');
    expect(lit(el, 15_000)).toBeCloseTo(1 / 2, 6);
    expect(lit(el, 30_000)).toBe(0);
  });

  it('never shorter than the 15s shot clock: a late join is a part-spent 15s ring', () => {
    const { container } = render(seat({ turnDeadlineMs: NOW + 9_000 }));
    const el = info(container);
    expect(el.style.getPropertyValue('--sp-timer-duration')).toBe('15.000s');
    expect(lit(el, 0)).toBeCloseTo(9 / 15, 6);
    expect(lit(el, 9_000)).toBeCloseTo(0, 6);
  });

  it('never longer than the plausible band', () => {
    const { container } = render(seat({ turnDeadlineMs: NOW + 900_000 }));
    expect(info(container).style.getPropertyValue('--sp-timer-duration')).toBe('180.000s');
  });

  it('is frozen: re-rendering every second does not shorten or re-time it', () => {
    const turn = { turnDeadlineMs: NOW + 30_000 };
    const { container, rerender } = render(seat({ ...turn, timerProgress: 100 }));
    const node = info(container);
    const seeded = timerVars(node);
    for (let second = 1; second <= 29; second++) {
      vi.setSystemTime(NOW + second * 1_000);
      rerender(seat({ ...turn, timerProgress: 100 - second }));
      expect(info(container)).toBe(node);
      expect(timerVars(info(container)), `after ${second}s`).toEqual(seeded);
    }
  });

  it('an extension draws a ring that ends at the NEW deadline, and stays frozen after', () => {
    const { container, rerender } = render(seat({ turnDeadlineMs: NOW + 15_000 }));
    expect(info(container).style.getPropertyValue('--sp-timer-duration')).toBe('15.000s');

    // 12s in, the time bank moves the deadline to 30s from now.
    vi.setSystemTime(NOW + 12_000);
    const extended = { turnDeadlineMs: NOW + 12_000 + 30_000 };
    rerender(seat({ ...extended, timerProgress: 100 }));
    const el = info(container);
    // Was: 15.000s - a full ring gone in fifteen seconds with thirty to go.
    expect(el.style.getPropertyValue('--sp-timer-duration')).toBe('30.000s');
    expect(el.style.getPropertyValue('--sp-timer-delay')).toBe('-0.000s');
    expect(lit(el, 30_000)).toBe(0);
    expect(lit(el, 29_999)).toBeGreaterThan(0);

    const seeded = timerVars(el);
    vi.setSystemTime(NOW + 20_000);
    rerender(seat({ ...extended, timerProgress: 60 }));
    expect(info(container)).toBe(el);
    expect(timerVars(info(container))).toEqual(seeded);
  });

  it('a stamped turn is untouched: deadline minus start, as before', () => {
    const { container } = render(
      seat({ turnStartTimeMs: NOW - 6_000, turnDeadlineMs: NOW + 29_000 })
    );
    const el = info(container);
    expect(el.style.getPropertyValue('--sp-timer-duration')).toBe('35.000s');
    expect(el.style.getPropertyValue('--sp-timer-delay')).toBe('-6.000s');
  });
});

// ============================================================================
// 6. The socket-down line is shown whole
// ============================================================================

describe('6. the connection banner is never cut off (Dan 2026-10-04)', () => {
  /* "THE 'RECONNECTING YOUR SEAT' NEEDS TO BE FULLY DISPLAYED AND NOT CUT OFF
      WHEN YOU ARE ACTUALLY HAVING CONNECTION ISSUES." Fixed for the toast in
     DisconnectToast.css; the socket-down banner had the identical bug. */
  const CSS = stripCss(read('src/components/table/TableConnectionBanner.css'));
  const rule = sliceCssRule(CSS, '.table-conn-banner {');

  it('pins both edges and centres with auto margins, so it can be 92% of the felt', () => {
    expect(rule).toMatch(/(?<![\w-])left:\s*4%/);
    expect(rule).toMatch(/(?<![\w-])right:\s*4%/);
    expect(rule).toMatch(/margin-inline:\s*auto/);
    expect(rule).toMatch(/width:\s*fit-content/);
    expect(rule).toMatch(/max-width:\s*min\(92%, 420px\)/);
    expect(rule).not.toMatch(/left:\s*50%/);
    expect(rule).toMatch(/transform:\s*translateY\(-100%\)/);
  });

  it('wraps instead of clipping: no nowrap, no ellipsis, no hidden overflow anywhere', () => {
    expect(rule).toMatch(/white-space:\s*normal/);
    expect(CSS).not.toMatch(/white-space:\s*nowrap/);
    expect(CSS).not.toMatch(/text-overflow/);
    expect(CSS).not.toMatch(/overflow:\s*hidden/);
    const label = sliceCssRule(CSS, '.table-conn-banner__label {');
    expect(label).not.toMatch(/overflow|ellipsis|nowrap/);
  });

  it('the entry animation carries the Y offset and no sideways term', () => {
    const at = CSS.indexOf('@keyframes table-conn-banner-in');
    const frames = CSS.slice(at, CSS.indexOf('}\n}', at) + 3);
    expect(frames).toMatch(/from \{[^}]*transform:\s*translateY\(calc\(-100% - 6px\)\)/);
    expect(frames).toMatch(/to \{[^}]*transform:\s*translateY\(-100%\)/);
    expect(CSS).not.toMatch(/-50%/);
    expect(CSS).not.toMatch(/translate\(/);
  });

  it('keeps its look and stays untappable', () => {
    expect(rule).toMatch(/border-top:\s*1px solid #000/);
    expect(rule).toMatch(/border-bottom:\s*1px solid #000/);
    expect(rule).toMatch(/pointer-events:\s*none/);
    expect(rule).toMatch(/top:\s*calc\(var\(--sp-brand-top,\s*56%\)\s*-\s*0\.5%\)/);
  });
});
