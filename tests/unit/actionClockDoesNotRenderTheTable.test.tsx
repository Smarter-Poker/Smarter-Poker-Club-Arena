/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE COUNTDOWN MUST NOT RENDER THE PAGE THAT CONTAINS IT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ─── THE DEFECT THIS PINS ────────────────────────────────────────────────────
 *
 * `useTableTimer` held the countdown in React state, and TablePage is the
 * component that calls it. So every publication re-ran a fifteen-thousand-line
 * render body and, through it, up to nine SeatSlots, the community board, the
 * pot, the HUD and the action panel — for the whole of ANY player's turn, on a
 * phone, with as many as four tables open at once.
 *
 * MEASURED on the code as it stood before this change, with a harness shaped
 * exactly like TablePage's use of the hook (destructure the numbers, render
 * them), one 20 second turn cost:
 *
 *     20 renders of the page.        <-- 1Hz, after the 2026-08-25 pass that
 *                                       dropped publication from ~30Hz. Before
 *                                       that pass the same turn cost ~600.
 *
 * After: ZERO. The number is published into an ActionClockStore and read by the
 * leaves that display it, so the page is not on its path at all.
 *
 * ─── WHAT EACH TEST HERE IS FOR ──────────────────────────────────────────────
 *
 *   1. the page renders ONCE (its mount) and never again for a whole turn;
 *   2. the clock is nonetheless running — the store publishes ~20 times across
 *      the same turn, so this is not "the countdown stopped";
 *   3. a leaf that subscribes DOES see every one of those publications, so the
 *      numeral on screen still ticks;
 *   4. a leaf that is not on the clock (`enabled: false` — the eight seats that
 *      are not acting) does not render at all.
 *
 * requestAnimationFrame is stubbed to never call back, as in the sibling spec:
 * everything is driven by the watchdog interval, which is the hidden-tab case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import * as React from 'react';
import { useTableTimer } from '../../src/hooks/useTableTimer';
import { useActionClockSeconds, type ActionClockStore } from '../../src/hooks/actionClockStore';

let rafSpy: ReturnType<typeof vi.spyOn>;
let cafSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
  cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
});

afterEach(() => {
  rafSpy.mockRestore();
  cafSpy.mockRestore();
  vi.useRealTimers();
});

/** One 20 second turn, advanced in 100ms slices so nothing is batched away. */
const TURN_MS = 20_000;
const SLICE_MS = 100;
const runOneTurn = () => {
  for (let i = 0; i < TURN_MS / SLICE_MS; i += 1) {
    act(() => void vi.advanceTimersByTime(SLICE_MS));
  }
};

describe('the action clock and the page that owns it', () => {
  it('renders the page ZERO times across a 20 second turn, while the clock keeps running', () => {
    let pageRenders = 0;
    let publications = 0;
    let store: ActionClockStore | null = null;
    const deadline = Date.now() + TURN_MS;

    /**
     * Shaped like TablePage: it calls the hook, keeps the store, and mounts a
     * leaf that shows the number. What it deliberately does NOT do is read the
     * number itself — that is the whole change.
     */
    function Page() {
      pageRenders += 1;
      const { clock } = useTableTimer({
        isActiveTurn: true,
        isHeroTurn: true,
        onTimeout: () => {},
        turnDeadlineMs: deadline,
        activeSeatKey: 3,
      });
      store = clock;
      return <Numeral clock={clock} />;
    }

    function Numeral({ clock }: { clock: ActionClockStore }) {
      const seconds = useActionClockSeconds(clock) ?? 0;
      return <span>{Math.ceil(seconds) || 0}s</span>;
    }

    render(<Page />);
    const afterMount = pageRenders;

    const unsubscribe = store!.subscribe(() => {
      publications += 1;
    });
    runOneTurn();
    unsubscribe();

    // THE ASSERTION THIS FILE EXISTS FOR. Twenty before, zero now.
    expect(pageRenders - afterMount).toBe(0);

    // ...and the clock genuinely ran. Twenty whole-second transitions, give or
    // take the one that lands on the boundary of the loop.
    expect(publications).toBeGreaterThanOrEqual(19);
    expect(publications).toBeLessThanOrEqual(23);
  });

  it('the leaf that displays the countdown DOES re-render, once per whole second', () => {
    let leafRenders = 0;
    const deadline = Date.now() + TURN_MS;

    function Page() {
      const { clock } = useTableTimer({
        isActiveTurn: true,
        isHeroTurn: true,
        onTimeout: () => {},
        turnDeadlineMs: deadline,
        activeSeatKey: 3,
      });
      return <Numeral clock={clock} />;
    }

    function Numeral({ clock }: { clock: ActionClockStore }) {
      leafRenders += 1;
      const seconds = useActionClockSeconds(clock) ?? 0;
      return <span>{Math.ceil(seconds) || 0}s</span>;
    }

    render(<Page />);
    const afterMount = leafRenders;
    runOneTurn();

    expect(leafRenders - afterMount).toBeGreaterThanOrEqual(19);
    expect(leafRenders - afterMount).toBeLessThanOrEqual(23);
  });

  it('a subscriber that is not on the clock never renders at all', () => {
    /* This is the eight seats that are not acting. `enabled: false` makes the
       snapshot `undefined` on every publication, React compares it with
       Object.is, and the component is left alone. */
    let idleRenders = 0;
    const deadline = Date.now() + TURN_MS;

    function Page() {
      const { clock } = useTableTimer({
        isActiveTurn: true,
        isHeroTurn: true,
        onTimeout: () => {},
        turnDeadlineMs: deadline,
        activeSeatKey: 3,
      });
      return <IdleSeat clock={clock} />;
    }

    function IdleSeat({ clock }: { clock: ActionClockStore }) {
      idleRenders += 1;
      const seconds = useActionClockSeconds(clock, false);
      return <span>{seconds === undefined ? 'idle' : 'acting'}</span>;
    }

    const { container } = render(<Page />);
    const afterMount = idleRenders;
    runOneTurn();

    expect(idleRenders - afterMount).toBe(0);
    expect(container.textContent).toBe('idle');
  });

  it('four concurrent tables keep four independent clocks', () => {
    /* MultiTablePage runs up to four TablePages at once. The store is created
       per hook instance for exactly this reason — a module singleton would have
       all four tables writing over each other's countdown. */
    const now = Date.now();
    const stores: ActionClockStore[] = [];

    function Table({ seconds }: { seconds: number }) {
      const { clock } = useTableTimer({
        isActiveTurn: true,
        isHeroTurn: false,
        onTimeout: () => {},
        turnDeadlineMs: now + seconds * 1000,
        activeSeatKey: seconds,
      });
      stores.push(clock);
      return null;
    }

    render(
      <>
        <Table seconds={20} />
        <Table seconds={15} />
        <Table seconds={10} />
        <Table seconds={5} />
      </>
    );

    expect(new Set(stores).size).toBe(4);
    expect(stores.map((s) => s.getSnapshot().seconds)).toEqual([20, 15, 10, 5]);

    act(() => void vi.advanceTimersByTime(6000));
    expect(stores.map((s) => s.getSnapshot().seconds)).toEqual([14, 9, 4, 0]);
  });
});
