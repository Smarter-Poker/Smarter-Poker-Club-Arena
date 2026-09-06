/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN-IT INTRO — the draw is the product, and it must be honest
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * v2 (2026-08-20): the presentation moved to the PokerBros grammar Dan
 * supplied on video — countdown, then a chase-light around a coloured disc
 * that decelerates onto the winner. The two things that matter more than any
 * visual survive the redesign and are pinned here:
 *
 *  1. The intro NEVER decides anything. The multiplier is a server fact
 *     (reserve-gated draw at game start) and this component works backwards
 *     from it. Any client-side randomness in the outcome path would be a
 *     fairness defect, not a cosmetic one.
 *
 *  2. The chase always ENDS on the server's value. A disc whose light settles
 *     on 100x while the tournament pays 2x would be far worse than no
 *     animation at all.
 */

import React from 'react';
import { SPIN_REVEAL } from '../../src/config/spinSpec';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import SpinWheel, {
  buildWheelOrder,
  tierClass,
  chaseSchedule,
  DEFAULT_SPIN_TIERS,
  parseLockedTiers,
} from '../../src/components/tournament/SpinWheel';

vi.mock('../../src/services/SoundService', () => ({
  soundService: {
    playSpinStart: vi.fn(),
    playSpinTicking: vi.fn(),
    playSpinCountdownLight: vi.fn(),
    playSpinMultiplierResult: vi.fn(),
    isEnabled: () => true,
  },
  haptic: { light: vi.fn(), medium: vi.fn(), strong: vi.fn(), jackpot: vi.fn() },
}));

import { soundService } from '../../src/services/SoundService';

const SPIN = {
  multiplier: 10,
  buyIn: 5,
  tiers: DEFAULT_SPIN_TIERS,
};

/**
 * Timings come from the SPEC, never from literals repeated here.
 *
 * They used to be hand-copied (3 x 750, 4200), which meant this file agreed
 * with an OLD component and would have gone on passing while the real
 * component and the engine drifted apart. A test that pins yesterday's numbers
 * is worse than no test: it reports green on a table that deals cards over its
 * own result card.
 */
const COUNTDOWN_MS = SPIN_REVEAL.COUNTDOWN_MS;
const CHASE_MS = SPIN_REVEAL.SPIN_MS;
/** The winner's outline flashes alone, then the prize is read. */
const RESULT_MS = SPIN_REVEAL.WINNER_FLASH_MS + SPIN_REVEAL.RESULT_HOLD_MS;
/**
 * Dan 2026-08-21: "ONE SECOND LATER, A 3...2...1... COUNT DOWN CLOCK MUST
 * BEGIN WITH A WHEEL SPIN." The reveal now opens with a one-second beat before
 * the count — the felt dims and the beam lands first (PokerBros reference) —
 * so every timeline in this file starts one second later than it used to.
 * Sourced from the spec rather than repeated as a literal.
 */
const LEAD_IN_MS = SPIN_REVEAL.LEAD_IN_MS;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
    ],
  });
});

afterEach(() => vi.useRealTimers());

/** Advance past countdown + chase into the result beat. */
function runToResult() {
  act(() => {
    vi.advanceTimersByTime(LEAD_IN_MS + COUNTDOWN_MS + CHASE_MS + 50);
  });
}

/** Advance past the countdown so the disc is on screen and chasing. */
function runToChase() {
  act(() => {
    vi.advanceTimersByTime(LEAD_IN_MS + COUNTDOWN_MS + 50);
  });
}

describe('disc layout', () => {
  it('alternates small and large so a near-miss is REAL, not staged', () => {
    const order = buildWheelOrder(DEFAULT_SPIN_TIERS);
    // Interleaved from both ends: smallest, largest, 2nd smallest, 2nd
    // largest... 2x sits directly beside the top tier, which is the whole
    // point: the most common result is adjacent to the rarest, so the chase
    // runner walks through the jackpot on its way to almost every ordinary
    // result. Eight tiers since the 500x was retired (2026-08-21) — the layout
    // is derived from the spec, so it re-interleaved on its own.
    expect(order.map((t) => t.multiplier)).toEqual([2, 100, 3, 50, 4, 25, 5, 10]);
  });

  it('every big tier has a small neighbour, so no dead zone exists', () => {
    const order = buildWheelOrder(DEFAULT_SPIN_TIERS);
    const big = (m: number) => m >= 25;
    for (let i = 0; i < order.length; i++) {
      if (!big(order[i].multiplier)) continue;
      const prev = order[(i - 1 + order.length) % order.length].multiplier;
      const next = order[(i + 1) % order.length].multiplier;
      expect(
        big(prev) && big(next),
        `${order[i].multiplier}x is surrounded by big tiers — a whole arc of the disc would be unreachable excitement`
      ).toBe(false);
    }
  });

  it('keeps every tier — none may be silently dropped from the disc', () => {
    const order = buildWheelOrder(DEFAULT_SPIN_TIERS);
    expect(order).toHaveLength(DEFAULT_SPIN_TIERS.length);
    expect(new Set(order.map((t) => t.multiplier))).toEqual(
      new Set(DEFAULT_SPIN_TIERS.map((t) => t.multiplier))
    );
  });

  it('handles an odd and an even ladder without duplicating the middle', () => {
    const even = buildWheelOrder([
      { multiplier: 2 },
      { multiplier: 5 },
      { multiplier: 10 },
      { multiplier: 50 },
    ]);
    expect(even.map((t) => t.multiplier)).toEqual([2, 50, 5, 10]);
    const odd = buildWheelOrder([{ multiplier: 2 }, { multiplier: 5 }, { multiplier: 10 }]);
    expect(odd.map((t) => t.multiplier)).toEqual([2, 10, 5]);
  });

  it('bands tiers so bigger prizes read hotter', () => {
    expect(tierClass(2)).toBe('sw--base');
    expect(tierClass(5)).toBe('sw--mid');
    expect(tierClass(25)).toBe('sw--big');
    expect(tierClass(100)).toBe('sw--mega');
    expect(tierClass(500)).toBe('sw--mega');
  });

  it('gives neighbouring segments different colours', () => {
    const { container } = render(<SpinWheel data={SPIN} onDone={() => {}} />);
    runToChase();
    const segs = [...container.querySelectorAll('.sw__seg')];
    expect(segs.length).toBe(DEFAULT_SPIN_TIERS.length);
    for (let i = 0; i < segs.length; i++) {
      const mine = [...segs[i].classList].find((c) => /^sw__seg--c\d$/.test(c));
      const next = [...segs[(i + 1) % segs.length].classList].find((c) => /^sw__seg--c\d$/.test(c));
      expect(mine, `segment ${i} has no colour class`).toBeTruthy();
      if (i + 1 < segs.length) {
        expect(mine).not.toBe(next);
      }
    }
  });
});

describe('the chase is honest', () => {
  it('ENDS on the SERVER value, every tier, exactly', () => {
    for (const tier of DEFAULT_SPIN_TIERS) {
      const { container, unmount } = render(
        <SpinWheel data={{ ...SPIN, multiplier: tier.multiplier }} onDone={() => {}} />
      );
      runToResult();
      const winner = container.querySelector('.sw__seg--winner .sw__seg-label');
      expect(winner?.textContent, `server drew ${tier.multiplier}x`).toBe(String(tier.multiplier));
      // The hub shows the same answer.
      expect(container.querySelector('.sw__hub-mult')?.textContent).toBe(`${tier.multiplier}×`);
      unmount();
    }
  });

  it('the schedule lands the runner on the target by construction', () => {
    for (let target = 0; target < 9; target++) {
      const times = chaseSchedule(9, target, CHASE_MS);
      // Last step index modulo segment count IS the target.
      expect((times.length - 1) % 9).toBe(target);
      // And the schedule decelerates: every gap >= the one before it.
      for (let i = 2; i < times.length; i++) {
        expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(times[i - 1] - times[i - 2] - 1);
      }
      // All inside the allotted time.
      expect(times[times.length - 1]).toBeLessThanOrEqual(CHASE_MS);
    }
  });

  it('computes the prize from buy-in x multiplier, not from anything local', () => {
    render(<SpinWheel data={{ ...SPIN, multiplier: 25, buyIn: 3 }} onDone={() => {}} />);
    runToResult();
    act(() => {
      vi.advanceTimersByTime(LEAD_IN_MS + 1200);
    });
    expect(screen.getByText('75')).toBeTruthy(); // 3 x 25
  });

  it('never crashes on a multiplier that is not on the disc', () => {
    const { container } = render(<SpinWheel data={{ ...SPIN, multiplier: 7 }} onDone={() => {}} />);
    runToResult();
    // Lands on the nearest tier (5) rather than exploding mid-table.
    expect(container.querySelector('.sw__seg--winner')).toBeTruthy();
  });

  it('contains no randomness in the outcome path', () => {
    // Comments quote the rule they enforce ("No Math.random touches the
    // outcome"), so strip them before scanning the actual code.
    const src = readFileSync(
      resolve(__dirname, '../../src/components/tournament/SpinWheel.tsx'),
      'utf8'
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    expect(src).not.toMatch(/Math\.random/);
  });
});

describe('sequence', () => {
  it('renders nothing until a draw arrives', () => {
    const { container } = render(<SpinWheel data={null} onDone={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('runs countdown -> chase -> result in order', () => {
    const { container } = render(<SpinWheel data={SPIN} onDone={() => {}} />);
    // Countdown first: the big number, no disc yet.
    expect(container.querySelector('.sw--countdown')).toBeTruthy();
    expect(container.querySelector('.sw__count')?.textContent).toBe('3');
    expect(container.querySelector('.sw__disc')).toBeNull();

    // One light per second, derived — not the old hand-copied 750ms step.
    act(() => {
      vi.advanceTimersByTime(LEAD_IN_MS + COUNTDOWN_MS / 3 + 10);
    });
    expect(container.querySelector('.sw__count')?.textContent).toBe('2');

    runToChase();
    expect(container.querySelector('.sw--chase')).toBeTruthy();
    expect(container.querySelector('.sw__disc')).toBeTruthy();
    expect(container.querySelector('.sw__hub-brand')?.textContent).toBe('SPIN-IT');

    act(() => {
      vi.advanceTimersByTime(CHASE_MS + 50);
    });
    expect(container.querySelector('.sw--result')).toBeTruthy();
    expect(container.querySelector('.sw__seg--winner')).toBeTruthy();
  });

  it('the chase actually moves the light between segments', () => {
    const { container } = render(<SpinWheel data={SPIN} onDone={() => {}} />);
    runToChase();
    const seen = new Set<string>();
    // Sample through the chase window and collect which segment is lit.
    for (let i = 0; i < 40; i++) {
      act(() => {
        vi.advanceTimersByTime(CHASE_MS / 40);
      });
      const lit = container.querySelector('.sw__seg--lit .sw__seg-label');
      if (lit?.textContent) seen.add(lit.textContent);
    }
    // A chase that never visits at least a handful of tiers is a blink, not
    // a chase.
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it("hands the ticking the light's OWN schedule, so a click is a peg crossed", () => {
    // Dan 2026-08-21: "CLICKING SOUNDS AS IT PASSES." A duration alone let the
    // sound invent its own tick spacing and hope it tracked the light; the two
    // then drifted apart on any easing change. Passing the same array the
    // component animates from makes "as it passes" literally true.
    render(<SpinWheel data={SPIN} onDone={() => {}} />);
    runToChase();
    expect(soundService.playSpinTicking).toHaveBeenCalledTimes(1);
    const [durationMs, schedule] = (
      soundService.playSpinTicking as unknown as {
        mock: { calls: [number, number[]][] };
      }
    ).mock.calls[0];
    expect(durationMs).toBe(CHASE_MS);
    expect(Array.isArray(schedule)).toBe(true);
    const target = buildWheelOrder(DEFAULT_SPIN_TIERS).findIndex(
      (t) => t.multiplier === SPIN.multiplier
    );
    expect(schedule).toEqual(chaseSchedule(DEFAULT_SPIN_TIERS.length, target, CHASE_MS));
    // Every click lands inside the chase, and they only ever spread apart.
    expect(schedule[schedule.length - 1]).toBeLessThanOrEqual(CHASE_MS);
    for (let i = 2; i < schedule.length; i++) {
      expect(schedule[i] - schedule[i - 1]).toBeGreaterThanOrEqual(
        schedule[i - 1] - schedule[i - 2]
      );
    }
  });

  it('reports done and clears itself', () => {
    const onDone = vi.fn();
    const { container } = render(<SpinWheel data={SPIN} onDone={onDone} />);
    runToResult();
    act(() => {
      vi.advanceTimersByTime(LEAD_IN_MS + COUNTDOWN_MS + CHASE_MS + 100);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(container.firstChild).toBeNull();
  });

  it('stays silent on a background table', () => {
    render(<SpinWheel data={SPIN} onDone={() => {}} playSounds={false} />);
    runToResult();
    expect(soundService.playSpinStart).not.toHaveBeenCalled();
    expect(soundService.playSpinTicking).not.toHaveBeenCalled();
    expect(soundService.playSpinMultiplierResult).not.toHaveBeenCalled();
  });

  it('celebrates only the big tiers', () => {
    const small = render(<SpinWheel data={{ ...SPIN, multiplier: 3 }} onDone={() => {}} />);
    runToResult();
    expect(small.container.querySelector('.sw__confetti')).toBeNull();
    expect(screen.queryByText(/JACKPOT/)).toBeNull();
    small.unmount();

    const big = render(<SpinWheel data={{ ...SPIN, multiplier: 100 }} onDone={() => {}} />);
    runToResult();
    expect(big.container.querySelector('.sw__confetti')).toBeTruthy();
    expect(screen.getByText('MEGA JACKPOT')).toBeTruthy();
  });

  it('the landing lights the WINNER and leaves every loser alone', () => {
    // Dan 2026-08-21: "DON'T HIGHLIGHT THE ENTIRE WHEEL. JUST THE WINNING
    // MULTIPLIER."
    //
    // This test used to assert the opposite — that all eight losers drained to
    // grey. Between that and a halo behind the disc and a wash over the
    // winner, the landing read as "the wheel lit up" rather than "this
    // multiplier won". Dimming seven segments is still a statement about seven
    // segments, so the drain is gone and the assertion is inverted: nothing
    // may be marked spent, and the only thing that changes is the winner.
    const { container } = render(<SpinWheel data={SPIN} onDone={() => {}} />);
    runToResult();
    expect(container.querySelectorAll('.sw__seg--spent').length).toBe(0);
    expect(container.querySelectorAll('.sw__seg--winner').length).toBe(1);
    // The neon outline is two stacked strokes on one path — a halo under a
    // core. One stroke alone reads as a border, not as neon.
    expect(container.querySelector('.sw__edge--halo')).toBeTruthy();
    expect(container.querySelector('.sw__edge--core')).toBeTruthy();
  });

  it('the outline traces the WHOLE wedge, not just the arc along the rim', () => {
    // "THE OUTLINE OF THE WINNING CARD NEEDS TO BE HIGHLIGHTED WITH NEON AND
    // FLASHING, NOT JUST THE TOP." An arc-only path is one M and one A; a
    // closed wedge also has the two radial sides and the point at the hub.
    const { container } = render(<SpinWheel data={SPIN} onDone={() => {}} />);
    runToResult();
    const d = container.querySelector('.sw__edge--core')?.getAttribute('d') ?? '';
    expect(d).toMatch(/^M/);
    expect(d, 'no line segments: this is an arc, not a wedge').toContain('L');
    expect(d, 'not closed: the point at the hub is missing').toContain('Z');
    expect(d).toContain('A');
  });

  it('the disc is real geometry, so a wedge can carry a gradient', () => {
    // Dan's verdict on the CSS-triangle version: "FLAT AND BORING, WITH NO
    // DEPTH OR 3D LOOK AND FEEL". A clip-path triangle cannot hold a fill
    // gradient, which is why every segment was one flat colour.
    const { container } = render(<SpinWheel data={SPIN} onDone={() => {}} />);
    runToChase();
    expect(container.querySelector('svg.sw__svg')).toBeTruthy();
    expect(container.querySelectorAll('path.sw__seg-face').length).toBe(DEFAULT_SPIN_TIERS.length);
    // A peg per segment: the clicking needs a visible thing to be striking.
    expect(container.querySelectorAll('circle.sw__peg').length).toBe(DEFAULT_SPIN_TIERS.length);
    expect(container.querySelector('.sw__rim')).toBeTruthy();
  });

  it('the starting tree fills red, yellow, green above the numeral', () => {
    // "IT SHOULD BE RED, YELLOW GREEN FOR THE COUNT DOWN" and "MOVE THE RED
    // LIGHT, UP HIGHER SO ITS NOT BEING OVERLAPPED BY THE NUMBERS".
    const { container } = render(<SpinWheel data={SPIN} onDone={() => {}} />);
    expect(container.querySelectorAll('.sw__lamp').length).toBe(3);
    expect(container.querySelectorAll('.sw__lamp--on').length).toBe(0);

    act(() => {
      vi.advanceTimersByTime(LEAD_IN_MS + 10);
    });
    expect(container.querySelectorAll('.sw__lamp--on').length).toBe(1);
    expect(container.querySelector('.sw__count--3')).toBeTruthy();
    expect(soundService.playSpinCountdownLight).toHaveBeenCalledWith(0);

    act(() => {
      vi.advanceTimersByTime(COUNTDOWN_MS / 3);
    });
    expect(container.querySelectorAll('.sw__lamp--on').length).toBe(2);
    expect(container.querySelector('.sw__count--2')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(COUNTDOWN_MS / 3);
    });
    expect(container.querySelectorAll('.sw__lamp--on').length).toBe(3);
    expect(container.querySelector('.sw__count--1')).toBeTruthy();
    expect(soundService.playSpinCountdownLight).toHaveBeenCalledWith(2);
  });
});

describe('locked tiers and payout splits', () => {
  it('shows a tier the pool cannot fund as LOCKED rather than hiding it', () => {
    const { container } = render(
      <SpinWheel data={{ ...SPIN, lockedMultipliers: [50, 100] }} onDone={() => {}} />
    );
    runToChase();
    // Still on the disc — a visible 100x you cannot win yet is anticipation.
    expect(container.querySelectorAll('.sw__seg').length).toBe(DEFAULT_SPIN_TIERS.length);
    expect(container.querySelectorAll('.sw__seg--locked').length).toBe(2);
  });

  it('marks nothing locked when the pool can fund everything', () => {
    const { container } = render(<SpinWheel data={SPIN} onDone={() => {}} />);
    runToChase();
    expect(container.querySelectorAll('.sw__seg--locked').length).toBe(0);
    expect(container.querySelector('.sw__status-locked')).toBeNull();
  });

  it('dims the same segments from the richer lockedTiers form', () => {
    const { container } = render(
      <SpinWheel
        data={{
          ...SPIN,
          lockedTiers: [
            { multiplier: 50, reason: 'threshold', unlocksAt: 750 },
            { multiplier: 100, reason: 'threshold', unlocksAt: 1500 },
          ],
        }}
        onDone={() => {}}
      />
    );
    runToChase();
    expect(container.querySelectorAll('.sw__seg--locked').length).toBe(2);
  });

  it('names the CHEAPEST unlock, so the note is something reachable', () => {
    const { container } = render(
      <SpinWheel
        data={{
          ...SPIN,
          lockedTiers: [
            { multiplier: 100, reason: 'threshold', unlocksAt: 1500 },
            { multiplier: 50, reason: 'threshold', unlocksAt: 750 },
          ],
        }}
        onDone={() => {}}
      />
    );
    runToChase();
    const note = container.querySelector('.sw__status-locked');
    expect(note).toBeTruthy();
    expect(note!.textContent).toContain('50');
    expect(note!.textContent).toContain('750');
  });

  it('says nothing about unlocks when no threshold was recorded', () => {
    const { container } = render(
      <SpinWheel data={{ ...SPIN, lockedMultipliers: [100] }} onDone={() => {}} />
    );
    runToChase();
    expect(container.querySelectorAll('.sw__seg--locked').length).toBe(1);
    expect(container.querySelector('.sw__status-locked')).toBeNull();
  });

  it('survives whatever the jsonb column hands back', () => {
    expect(parseLockedTiers(null)).toEqual([]);
    expect(parseLockedTiers(undefined)).toEqual([]);
    expect(parseLockedTiers('not json')).toEqual([]);
    expect(parseLockedTiers('{}')).toEqual([]);
    expect(parseLockedTiers([{ nope: 1 }])).toEqual([]);
    expect(parseLockedTiers('[{"multiplier":500,"reason":"threshold","unlocksAt":5000}]')).toEqual([
      { multiplier: 500, reason: 'threshold', unlocksAt: 5000 },
    ]);
    // unlocksAt of 0 is "no threshold", not "unlocks for free".
    expect(parseLockedTiers([{ multiplier: 100, unlocksAt: 0 }])).toEqual([
      { multiplier: 100, reason: undefined, unlocksAt: undefined },
    ]);
  });

  it('says who cashes — only first place below 10x', () => {
    const { container } = render(<SpinWheel data={{ ...SPIN, multiplier: 5 }} onDone={() => {}} />);
    runToResult();
    expect(container.querySelectorAll('.sw__split').length).toBe(1);
  });

  it('shows two places at exactly 10x', () => {
    const { container } = render(
      <SpinWheel data={{ ...SPIN, multiplier: 10 }} onDone={() => {}} />
    );
    runToResult();
    expect(container.querySelectorAll('.sw__split').length).toBe(2);
  });

  it('shows all three places at 25x and above, with the real amounts', () => {
    const { container } = render(
      <SpinWheel data={{ ...SPIN, multiplier: 25, buyIn: 1 }} onDone={() => {}} />
    );
    runToResult();
    const splits = [...container.querySelectorAll('.sw__split-amt')].map((el) => el.textContent);
    // 25 pool at 80/12/8.
    expect(splits).toEqual(['20', '3', '2']);
  });
});

describe('CSS hygiene', () => {
  it('namespaces every keyframe (global @keyframes namespace)', () => {
    const css = readFileSync(
      resolve(__dirname, '../../src/components/tournament/SpinWheel.css'),
      'utf8'
    );
    // Anchored to line start: the header comment SAYS "@keyframes is a
    // global namespace", and an unanchored regex reads "is" as a name.
    const names = [...css.matchAll(/^@keyframes\s+([A-Za-z0-9_-]+)/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(n.startsWith('sw'), `keyframe ${n} is not sw-prefixed`).toBe(true);
    }
  });

  it('keeps the table visible: a vignette and a beam, never a blackout', () => {
    const css = readFileSync(
      resolve(__dirname, '../../src/components/tournament/SpinWheel.css'),
      'utf8'
    );
    // The reference's whole point: the felt dims, it does not disappear.
    expect(css).toMatch(/\.sw__dim/);
    expect(css).toMatch(/\.sw__beam/);
    expect(css).not.toMatch(/backdrop-filter:\s*blur/);
  });
});

describe('phase 6 presentation hardening', () => {
  it('contains a reveal in a multi-table tile and does not claim modal focus', () => {
    render(<SpinWheel data={SPIN} contained onDone={() => {}} />);
    const region = screen.getByRole('region', { name: 'Spin Multiplier Draw' });
    expect(region.classList.contains('sw--contained')).toBe(true);
    expect(region.getAttribute('aria-modal')).toBeNull();
  });

  it('distributes every celebration piece across its actual piece count', () => {
    const { container } = render(
      <SpinWheel data={{ ...SPIN, multiplier: 100 }} onDone={() => {}} />
    );
    runToResult();
    const pieces = [...container.querySelectorAll<HTMLElement>('.sw__conf')];
    expect(pieces.length).toBeGreaterThan(2);
    expect(
      pieces.every((piece) => piece.style.getPropertyValue('--sw-count') === String(pieces.length))
    ).toBe(true);
    expect(
      Math.max(
        ...pieces.map((piece) => Number.parseInt(piece.style.getPropertyValue('--sw-delay')))
      )
    ).toBeLessThanOrEqual(720);
  });

  it('holds a reduced-motion result until the shared deal deadline', () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    const done = vi.fn();
    const now = Date.now();
    render(
      <SpinWheel
        data={{ ...SPIN, revealAtMs: now, revealDeadlineMs: now + 10_000 }}
        onDone={done}
      />
    );
    act(() => vi.advanceTimersByTime(900));
    expect(screen.getByRole('region', { name: 'Spin Multiplier Draw' })).toBeTruthy();
    expect(done).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(9_200));
    expect(done).toHaveBeenCalledOnce();
    window.matchMedia = original;
  });

  it('joins a late shared reveal at the result without flashing countdown', () => {
    const now = Date.now();
    const { container } = render(
      <SpinWheel
        data={{ ...SPIN, revealAtMs: now - 14_000, revealDeadlineMs: now + 2_600 }}
        onDone={() => {}}
      />
    );
    expect(container.querySelector('.sw--result')).toBeTruthy();
    expect(container.querySelector('.sw--countdown')).toBeNull();
  });
});
