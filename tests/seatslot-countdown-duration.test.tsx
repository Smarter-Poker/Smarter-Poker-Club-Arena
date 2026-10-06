/**
 * Dan 2026-08-19, bug list item 11: "the yellow countdown clock must take a
 * full 15 seconds."
 *
 * The ring is a pure-CSS animation whose duration SeatSlot derives as
 * (turnDeadlineMs - turnStartTimeMs). TablePage's ACTION_TIMER_STARTED handler
 * used to record only the DEADLINE, leaving turnStartTimeMs undefined/stale -
 * so the duration collapsed and the ring drained almost instantly. That was
 * fixed by recording the start time alongside the deadline; this test pins the
 * consumer end of that contract so a future handler change cannot quietly
 * collapse it again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import SeatSlot from '../src/components/table/SeatSlot';

const NOW = new Date('2026-08-19T00:00:00Z').getTime();

const player = {
  id: 'p1',
  name: 'HERO',
  stack: 1000,
  status: 'active' as const,
  showCards: false,
  isHero: true,
};

function renderSeat(extra: Record<string, unknown>) {
  const { container } = render(
    <SeatSlot
      seatNumber={1}
      player={player}
      position={'BTN' as never}
      isActive
      lastAction={null as never}
      {...extra}
    />
  );
  return container.querySelector('.seat__info') as HTMLElement | null;
}

const durationSeconds = (el: HTMLElement | null) => {
  const raw = el?.style.getPropertyValue('--sp-timer-duration') ?? '';
  return parseFloat(raw.replace('s', ''));
};
const delaySeconds = (el: HTMLElement | null) => {
  const raw = el?.style.getPropertyValue('--sp-timer-delay') ?? '';
  return parseFloat(raw.replace('s', ''));
};
const yellowSeconds = (el: HTMLElement | null) => {
  const raw = el?.style.getPropertyValue('--sp-timer-yellow-duration') ?? '';
  return parseFloat(raw.replace('s', ''));
};

describe('SeatSlot countdown ring duration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('spans the FULL 15 seconds on a normal turn', () => {
    const info = renderSeat({ turnStartTimeMs: NOW, turnDeadlineMs: NOW + 15_000 });
    expect(durationSeconds(info)).toBe(15);
    expect(yellowSeconds(info)).toBe(15);
  });

  it('does not collapse when the start time is missing', () => {
    // The regression shape: deadline recorded, start time not. Even then the
    // ring must fall back to a full turn rather than draining instantly.
    const info = renderSeat({ turnDeadlineMs: NOW + 15_000 });
    expect(durationSeconds(info)).toBe(15);
  });

  it('picks up mid-turn at the right position instead of restarting', () => {
    // 6s already elapsed: the ring still spans 15s but is offset by -6s.
    const info = renderSeat({ turnStartTimeMs: NOW - 6_000, turnDeadlineMs: NOW + 9_000 });
    expect(durationSeconds(info)).toBe(15);
    const delay = parseFloat(
      (info?.style.getPropertyValue('--sp-timer-delay') ?? '').replace('s', '')
    );
    expect(delay).toBeCloseTo(-6, 1);
  });

  it('yellow still owns only the first 15s when a time bank extends the turn', () => {
    const info = renderSeat({ turnStartTimeMs: NOW, turnDeadlineMs: NOW + 35_000 });
    expect(durationSeconds(info)).toBe(35);
    expect(yellowSeconds(info)).toBe(15);
  });

  it('never emits a sub-second duration', () => {
    const info = renderSeat({ turnStartTimeMs: NOW, turnDeadlineMs: NOW + 10 });
    expect(durationSeconds(info)).toBeGreaterThanOrEqual(1);
  });

  it('a turn first painted late joins at its TRUE position and still spans 15s (owner 2026-10-04)', () => {
    /* REWRITTEN 2026-10-04. This was "absorbs first-paint latency: the ring
       starts FULL and ends at the deadline (item 10, 2026-08-26)", and it
       pinned duration 13.8s / delay 0 for a turn painted 1.2s late: the
       latency was subtracted from the DURATION so the ring started full and
       drained over what was left.

       Owner 2026-10-04: "THE NEON BLUE DISAPPEARING COUNT DOWN CLOCK IS NOT
       ACCURATE... YOU NEED TO SLOW IT DOWN SO IT TAKES 15 SECONDS TO
       DISAPPEAR, IT CURRENTLY GOES AWAY WAY TO FAST."

       A ring squeezed into 13.8s (or 12s after a 3s deal hold) drains up to
       25% faster than a fifteen-second clock, on every turn painted late.
       And the "part-drained, empties early" symptom item 10 was chasing was
       never latency: it was the delay being rewritten on every render, which
       ran the ring at double speed (see the block below). So the ring now
       always spans the engine's whole turn and joins it where the engine
       really is. It ends at the deadline either way. */
    const info = renderSeat({ turnStartTimeMs: NOW - 1_200, turnDeadlineMs: NOW + 13_800 });
    expect(durationSeconds(info)).toBe(15);
    expect(delaySeconds(info)).toBeCloseTo(-1.2, 3);
  });
});

// ============================================================================
// OWNER RULING 2026-10-04
// ============================================================================
//
//   "THE NEON BLUE DISAPPEARING COUNT DOWN CLOCK IS NOT ACCURATE... YOU NEED
//    TO SLOW IT DOWN SO IT TAKES 15 SECONDS TO DISAPPEAR, IT CURRENTLY GOES
//    AWAY WAY TO FAST."
//
// Fifth report of the same sentence. The four earlier fixes each pinned the
// values SeatSlot emits on its FIRST render and every one of those pins was
// green while the ring emptied in 7.5 seconds, because the bug lived in the
// SECOND render: `--sp-timer-delay` was `-(elapsed)`, recomputed every time
// the seat rendered, and the acting seat renders once a second. A browser
// re-times a running CSS animation when its delay changes, so the ring's
// position became (time since mount) + (elapsed at last render) = twice the
// real elapsed time. Measured in Chromium: empty at 7.5s of 15.
//
// These tests render the seat MORE THAN ONCE.

/** Where the pure-CSS ring is, `msSincePaint` after the node mounted. 1 = full. */
function litFraction(el: HTMLElement | null, msSincePaint: number): number {
  const duration = durationSeconds(el) * 1000;
  const delay = delaySeconds(el) * 1000;
  // animation-timing-function is `linear` (pinned below), fill is `forwards`.
  const progress = Math.min(1, Math.max(0, (msSincePaint - delay) / duration));
  return 1 - progress;
}

const TIMER_VARS = [
  '--sp-timer-duration',
  '--sp-timer-yellow-duration',
  '--sp-timer-delay',
  '--sp-timer-flash-delay',
  '--sp-timer-flash-count',
] as const;

const timerVars = (el: HTMLElement | null) =>
  Object.fromEntries(TIMER_VARS.map((v) => [v, el?.style.getPropertyValue(v) ?? '']));

function seat(extra: Record<string, unknown>) {
  return (
    <SeatSlot
      seatNumber={1}
      player={player}
      position={'BTN' as never}
      isActive
      lastAction={null as never}
      {...extra}
    />
  );
}

describe('the countdown ring is seeded once per turn and then left to the browser (owner 2026-10-04)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('THE ROOT CAUSE: re-rendering the acting seat every second does not move the clock', () => {
    const turn = { turnStartTimeMs: NOW, turnDeadlineMs: NOW + 15_000 };
    const { container, rerender } = render(seat({ ...turn, timerProgress: 100 }));
    const node = container.querySelector('.seat__info') as HTMLElement;
    const seeded = timerVars(node);
    expect(seeded['--sp-timer-duration']).toBe('15.000s');
    expect(seeded['--sp-timer-delay']).toBe('-0.000s');

    // What production does: the action clock store publishes a new whole
    // second, the acting seat re-renders. Fourteen times a turn.
    for (let second = 1; second <= 14; second++) {
      vi.setSystemTime(NOW + second * 1_000);
      rerender(seat({ ...turn, timerProgress: Math.round(100 - (second / 15) * 100) }));
      const now = container.querySelector('.seat__info') as HTMLElement;
      // Same node: the animation was not restarted...
      expect(now).toBe(node);
      // ...and not re-timed: every variable that times it is exactly what it
      // was seeded with. Before the fix --sp-timer-delay read -1.000s,
      // -2.000s, ... here, and the browser doubled the clock.
      expect(timerVars(now), `after ${second}s`).toEqual(seeded);
    }
  });

  it('duration is exactly 15.000s on a fresh 15s turn', () => {
    const info = renderSeat({ turnStartTimeMs: NOW, turnDeadlineMs: NOW + 15_000 });
    expect(info?.style.getPropertyValue('--sp-timer-duration')).toBe('15.000s');
    expect(info?.style.getPropertyValue('--sp-timer-delay')).toBe('-0.000s');
  });

  it('drains at a constant rate: half lit at 7.5s, a third at 10s, none at 15s', () => {
    const info = renderSeat({ turnStartTimeMs: NOW, turnDeadlineMs: NOW + 15_000 });
    expect(litFraction(info, 0)).toBe(1);
    expect(litFraction(info, 7_500)).toBeCloseTo(1 / 2, 6);
    expect(litFraction(info, 10_000)).toBeCloseTo(1 / 3, 6);
    expect(litFraction(info, 14_999)).toBeGreaterThan(0);
    expect(litFraction(info, 15_000)).toBe(0);
    // Constant: every second takes the same slice of the border.
    for (let t = 0; t < 15_000; t += 1_000) {
      expect(litFraction(info, t) - litFraction(info, t + 1_000)).toBeCloseTo(1 / 15, 6);
    }
  });

  it.each([0, 300, 1_200, 2_600, 6_000, 12_000, 14_500])(
    'a turn first painted %ims late ends exactly at the engine deadline, at the 15s rate',
    (late) => {
      // Latency, the deal hold, a reconnect, a tab waking up. The player
      // never sees time they do not have (the ring is empty AT the deadline)
      // and the ring never runs faster than the clock it stands for.
      const deadline = NOW - late + 15_000;
      const info = renderSeat({ turnStartTimeMs: NOW - late, turnDeadlineMs: deadline });
      const msToDeadline = deadline - NOW;
      expect(durationSeconds(info)).toBe(15);
      expect(litFraction(info, msToDeadline)).toBeCloseTo(0, 6);
      expect(litFraction(info, msToDeadline - 1)).toBeGreaterThan(0);
      expect(litFraction(info, 0)).toBeCloseTo(1 - late / 15_000, 6);
      if (msToDeadline >= 1_000) {
        expect(litFraction(info, 0) - litFraction(info, 1_000)).toBeCloseTo(1 / 15, 6);
      }
    }
  );

  it('with no start stamp the ring still ends at the deadline', () => {
    // Only the deadline is known and 9s of it are left: the ring joins 6s in.
    const info = renderSeat({ turnDeadlineMs: NOW + 9_000 });
    expect(durationSeconds(info)).toBe(15);
    expect(litFraction(info, 9_000)).toBeCloseTo(0, 6);
    expect(litFraction(info, 0)).toBeCloseTo(9 / 15, 6);
  });

  it('a time-bank extension keeps the node and the seed, and only lengthens the clock', () => {
    const { container, rerender } = render(
      seat({ turnStartTimeMs: NOW, turnDeadlineMs: NOW + 15_000 })
    );
    const node = container.querySelector('.seat__info') as HTMLElement;
    vi.setSystemTime(NOW + 12_000);
    rerender(seat({ turnStartTimeMs: NOW, turnDeadlineMs: NOW + 35_000 }));
    const after = container.querySelector('.seat__info') as HTMLElement;
    expect(after).toBe(node); // not restarted
    expect(after.style.getPropertyValue('--sp-timer-delay')).toBe('-0.000s'); // seed untouched
    expect(durationSeconds(after)).toBe(35);
    // The animation has been running 12s; on the longer clock that is the
    // true position, and it runs out at the new deadline.
    expect(litFraction(after, 12_000)).toBeCloseTo(1 - 12 / 35, 6);
    expect(litFraction(after, 35_000)).toBe(0);
  });

  it('a seat that leaves the clock and comes back takes a FRESH reading', () => {
    // The node remounts (the animation restarts from local time zero), so a
    // seed left over from the first mount would draw 4 seconds the player no
    // longer has.
    const turn = { turnStartTimeMs: NOW, turnDeadlineMs: NOW + 15_000 };
    const { container, rerender } = render(seat(turn));
    rerender(seat({ ...turn, isActive: false }));
    expect(container.querySelector('.seat__timer-ring')).toBeNull();
    vi.setSystemTime(NOW + 4_000);
    rerender(seat(turn));
    const info = container.querySelector('.seat__info') as HTMLElement;
    expect(delaySeconds(info)).toBeCloseTo(-4, 3);
    expect(litFraction(info, 11_000)).toBeCloseTo(0, 6);
  });

  it('the last-five-seconds pulse is seeded once too', () => {
    const info = renderSeat({ turnStartTimeMs: NOW, turnDeadlineMs: NOW + 15_000 });
    expect(info?.style.getPropertyValue('--sp-timer-flash-delay')).toBe('10.000s');
    expect(info?.style.getPropertyValue('--sp-timer-flash-count')).toBe('10');
    // Joined with 3s left: already inside the window, six half-second beats.
    const late = renderSeat({ turnStartTimeMs: NOW - 12_000, turnDeadlineMs: NOW + 3_000 });
    expect(late?.style.getPropertyValue('--sp-timer-flash-delay')).toBe('-2.000s');
    expect(late?.style.getPropertyValue('--sp-timer-flash-count')).toBe('6');
  });

  it('draws the ring as a real, decorative element only while the seat is on the clock', () => {
    const { container, rerender } = render(
      seat({ turnStartTimeMs: NOW, turnDeadlineMs: NOW + 15_000 })
    );
    const ring = container.querySelector('.seat__info > .seat__timer-ring');
    expect(ring).not.toBeNull();
    expect(ring?.getAttribute('aria-hidden')).toBe('true');
    expect(ring?.querySelector('.seat__timer-ring-arc')).not.toBeNull();
    rerender(seat({ isActive: false }));
    expect(container.querySelector('.seat__timer-ring')).toBeNull();
  });
});

// ============================================================================
// THE STYLESHEET HALF OF THE SAME RULING
// ============================================================================

describe('the ring stylesheet drains linearly and never hides the arc (owner 2026-10-04)', () => {
  const CSS = readFileSync(resolve(__dirname, '../src/components/table/SeatSlot.css'), 'utf8');
  const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (selector: string) => {
    const at = CODE.indexOf(selector);
    expect(at, `${selector} rule missing`).toBeGreaterThan(-1);
    return CODE.slice(at, CODE.indexOf('}', at) + 1);
  };

  it('the shrink has no easing: linear, and nothing overrides it', () => {
    // 2026-08-21 to 2026-10-04 this rule carried
    // `animation-timing-function: linear(0, 0.75 66.6%, 1)`: three quarters of
    // the arc gone in the first ten seconds.
    const rule = block('.seat--active .seat__info {');
    expect(rule).toMatch(
      /spTimerRingShrink var\(--sp-timer-duration, 15s\) linear var\(--sp-timer-delay, 0s\) forwards/
    );
    expect(rule).not.toMatch(/animation-timing-function/);
    expect(rule).not.toMatch(/linear\(|cubic-bezier|steps\(|ease/);
    // Nowhere in the sheet, either: a later rule could re-time the same node.
    expect(CODE).not.toMatch(/linear\(0, 0\.75/);
    for (const m of CODE.matchAll(/([^{}]*)\{[^{}]*animation-timing-function[^{}]*\}/g)) {
      expect(m[1], 'a rule re-times the countdown ring').not.toMatch(/seat__info|seat__timer-ring/);
    }
  });

  it('the keyframe is a straight line from full to empty', () => {
    const at = CODE.indexOf('@keyframes spTimerRingShrink');
    const frames = CODE.slice(at, CODE.indexOf('}\n}', at) + 3);
    expect(frames.replace(/\s+/g, ' ')).toBe(
      '@keyframes spTimerRingShrink { from { --timer-progress: 100%; --sp-timer-spent: 0; } to { --timer-progress: 0%; --sp-timer-spent: 1; } }'
    );
    expect(CODE).toMatch(
      /@property --sp-timer-spent \{\s*syntax: '<number>';\s*inherits: true;\s*initial-value: 0;\s*\}/
    );
  });

  it('the sweep is linear along the BORDER, not in angle, on every plate shape', () => {
    // A conic sweep that is linear in angle moves 3.6x to 5.2x faster along
    // the border at the corners of this plate than at 12 o'clock. The shipped
    // rule converts "fraction of border spent" to an angle with atan2() over
    // container units. This evaluates THAT rule's own text, then measures
    // the border it leaves lit with independent geometry.
    /* 2026-10-04: the gate was `(width: 1cqw) and (rotate: atan2(1px, 1px))`,
       two questions about things the rule does not use. It now tests the
       real construct (atan2 of container units as a conic stop); located here
       by the block that declares --sp-ring-d so the pin follows the rule,
       whatever the condition reads. The condition itself is pinned in
       tests/unit/seatAndEquityFollowups.test.tsx, block 4. */
    const ringD = CODE.indexOf('--sp-ring-d:');
    expect(ringD).toBeGreaterThan(-1);
    const supportsAt = CODE.lastIndexOf('@supports', ringD);
    expect(supportsAt).toBeGreaterThan(-1);
    const supports = CODE.slice(supportsAt);
    const d = supports.match(/--sp-ring-d:\s*([^;]+);/)?.[1];
    const edge = supports.match(/--sp-ring-edge:\s*([^;]+);/)?.[1];
    expect(d?.replace(/\s+/g, ' ')).toBe('calc(var(--sp-timer-spent, 0) * (200cqw + 200cqh))');
    expect(edge).toBeTruthy();

    const toJs = (css: string) =>
      css
        .replace(/var\(--sp-ring-d\)/g, 'd')
        .replace(/var\(--sp-timer-spent, 0\)/g, 'spent')
        .replace(/(\d+(?:\.\d+)?)cqw/g, '($1 * W / 100)')
        .replace(/(\d+(?:\.\d+)?)cqh/g, '($1 * H / 100)')
        .replace(/\b0px\b/g, '0')
        .replace(/\bcalc\(/g, '(');
    const edgeDeg = new Function(
      'spent',
      'W',
      'H',
      `const atan2 = (y, x) => (Math.atan2(y, x) * 180) / Math.PI;
       const clamp = (lo, v, hi) => Math.max(lo, Math.min(v, hi));
       const d = ${toJs(d!)};
       return ${toJs(edge!)};`
    ) as (spent: number, W: number, H: number) => number;

    /** Border length, clockwise from 12 o'clock, to where a ray at `deg` leaves the box. */
    const borderAt = (deg: number, W: number, H: number) => {
      const P = 2 * (W + H);
      // The five atan2 terms sum to 360 less a few ulps at spent = 1.
      if (deg >= 360 - 1e-9) return P;
      const t = (deg * Math.PI) / 180;
      const dx = Math.sin(t);
      const dy = -Math.cos(t);
      const k = Math.min(
        dx === 0 ? Infinity : W / 2 / Math.abs(dx),
        dy === 0 ? Infinity : H / 2 / Math.abs(dy)
      );
      const x = dx * k;
      const y = dy * k;
      const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
      if (near(y, -H / 2) && x >= -1e-9) return x;
      if (near(x, W / 2)) return W / 2 + (y + H / 2);
      if (near(y, H / 2)) return W / 2 + H + (W / 2 - x);
      if (near(x, -W / 2)) return W / 2 + H + W + (H / 2 - y);
      return W / 2 + 2 * H + W + (x + W / 2);
    };

    // Desktop hero plate, desktop villain, three phone breakpoints, a square.
    for (const [W, H] of [
      [102, 50],
      [100, 48],
      [79, 45],
      [70, 43],
      [58, 40],
      [60, 60],
    ]) {
      expect(edgeDeg(0, W, H)).toBeCloseTo(0, 6);
      expect(edgeDeg(1, W, H)).toBeCloseTo(360, 6);
      for (let i = 0; i <= 300; i++) {
        const spent = i / 300;
        const lit = 1 - borderAt(edgeDeg(spent, W, H), W, H) / (2 * (W + H));
        expect(lit, `${W}x${H} at ${(spent * 15).toFixed(2)}s`).toBeCloseTo(1 - spent, 5);
      }
      // The owner's two reference points, on the border itself.
      expect(1 - borderAt(edgeDeg(7.5 / 15, W, H), W, H) / (2 * (W + H))).toBeCloseTo(1 / 2, 5);
      expect(1 - borderAt(edgeDeg(10 / 15, W, H), W, H) / (2 * (W + H))).toBeCloseTo(1 / 3, 5);
    }
  });

  it('clockwise from 12 o clock, neon blue, on a size container, with a no-easing fallback', () => {
    const ring = block('.seat--active .seat__timer-ring {');
    expect(ring).toMatch(/container-type:\s*size/);
    expect(ring).toMatch(/inset:\s*-3px/);
    const arc = block('.seat--active .seat__timer-ring-arc {');
    // Fallback for a browser without cq units / CSS trig: linear in angle.
    expect(arc).toMatch(/--sp-ring-edge:\s*calc\(100% - var\(--timer-progress, 100%\)\)/);
    // Dark first, neon after the edge = consumed clockwise from 12 o'clock.
    expect(arc.replace(/\s+/g, ' ')).toContain(
      'conic-gradient( from 0deg, transparent 0%, transparent var(--sp-ring-edge), var(--timer-color, #00e5ff) var(--sp-ring-edge), var(--timer-color, #00e5ff) 100% )'
    );
    expect(arc).not.toMatch(/transition/);
    // The pseudo-element ring is gone; two rings must never run at once.
    expect(CODE).not.toMatch(/\.seat__info::before/);
  });

  it('the last-five-seconds pulse never lets the arc read as gone', () => {
    // It used to blink the whole ring to 20% opacity for the final third of
    // the clock, when only a short arc is left to see.
    const at = CODE.indexOf('@keyframes spTimerFlash');
    const frames = CODE.slice(at, CODE.indexOf('}\n}', at) + 3);
    const opacities = [...frames.matchAll(/opacity:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    expect(opacities.length).toBeGreaterThan(0);
    expect(Math.min(...opacities)).toBeGreaterThanOrEqual(0.6);
    expect(Math.max(...opacities)).toBe(1);
    // And it still exists: the 2026-08-21 request to flash stands.
    expect(block('.seat--active .seat__timer-ring {')).toMatch(
      /animation:\s*spTimerFlash 0\.5s ease-in-out var\(--sp-timer-flash-delay, 999s\)\s*var\(--sp-timer-flash-count, 0\) both/
    );
  });
});
