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

const COUNTDOWN_MS = 3 * 750;
const CHASE_MS = 4200;

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
    vi.advanceTimersByTime(COUNTDOWN_MS + CHASE_MS + 50);
  });
}

/** Advance past the countdown so the disc is on screen and chasing. */
function runToChase() {
  act(() => {
    vi.advanceTimersByTime(COUNTDOWN_MS + 50);
  });
}

describe('disc layout', () => {
  it('alternates small and large so a near-miss is REAL, not staged', () => {
    const order = buildWheelOrder(DEFAULT_SPIN_TIERS);
    // Interleaved from both ends: smallest, largest, 2nd smallest, 2nd
    // largest... 2x sits directly beside 500x, which is the whole point: the
    // most common result is adjacent to the rarest, so the chase runner walks
    // through the jackpot on its way to almost every ordinary result.
    expect(order.map((t) => t.multiplier)).toEqual([2, 500, 3, 100, 4, 50, 5, 25, 10]);
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
      const times = chaseSchedule(9, target, 4200);
      // Last step index modulo segment count IS the target.
      expect((times.length - 1) % 9).toBe(target);
      // And the schedule decelerates: every gap >= the one before it.
      for (let i = 2; i < times.length; i++) {
        expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(times[i - 1] - times[i - 2] - 1);
      }
      // All inside the allotted time.
      expect(times[times.length - 1]).toBeLessThanOrEqual(4200);
    }
  });

  it('computes the prize from buy-in x multiplier, not from anything local', () => {
    render(<SpinWheel data={{ ...SPIN, multiplier: 25, buyIn: 3 }} onDone={() => {}} />);
    runToResult();
    act(() => {
      vi.advanceTimersByTime(1200);
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

    act(() => {
      vi.advanceTimersByTime(760);
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

  it('passes the real chase duration to the ticking so they decelerate together', () => {
    render(<SpinWheel data={SPIN} onDone={() => {}} />);
    runToChase();
    expect(soundService.playSpinTicking).toHaveBeenCalledWith(CHASE_MS);
  });

  it('reports done and clears itself', () => {
    const onDone = vi.fn();
    const { container } = render(<SpinWheel data={SPIN} onDone={onDone} />);
    runToResult();
    act(() => {
      vi.advanceTimersByTime(4200 + 100);
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

  it('the losers drain to grey once the winner settles', () => {
    const { container } = render(<SpinWheel data={SPIN} onDone={() => {}} />);
    runToResult();
    const spent = container.querySelectorAll('.sw__seg--spent');
    expect(spent.length).toBe(DEFAULT_SPIN_TIERS.length - 1);
  });
});

describe('locked tiers and payout splits', () => {
  it('shows a tier the pool cannot fund as LOCKED rather than hiding it', () => {
    const { container } = render(
      <SpinWheel data={{ ...SPIN, lockedMultipliers: [100, 500] }} onDone={() => {}} />
    );
    runToChase();
    // Still on the disc — a visible 500x you cannot win yet is anticipation.
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
            { multiplier: 100, reason: 'threshold', unlocksAt: 750 },
            { multiplier: 500, reason: 'threshold', unlocksAt: 5000 },
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
            { multiplier: 500, reason: 'threshold', unlocksAt: 5000 },
            { multiplier: 100, reason: 'threshold', unlocksAt: 750 },
          ],
        }}
        onDone={() => {}}
      />
    );
    runToChase();
    const note = container.querySelector('.sw__status-locked');
    expect(note).toBeTruthy();
    expect(note!.textContent).toContain('100');
    expect(note!.textContent).toContain('750');
  });

  it('says nothing about unlocks when no threshold was recorded', () => {
    const { container } = render(
      <SpinWheel data={{ ...SPIN, lockedMultipliers: [500] }} onDone={() => {}} />
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
