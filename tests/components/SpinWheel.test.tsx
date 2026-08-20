/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN WHEEL — the draw is the product, and it must be honest
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two things matter more than the visuals here:
 *
 *  1. The wheel NEVER decides anything. The multiplier is a server fact
 *     (crypto-grade draw at tournament creation) and this component works
 *     backwards from it. Any client-side randomness in the outcome path would
 *     be a fairness defect, not a cosmetic one — so it is pinned.
 *
 *  2. The wheel always LANDS on the server's value. A wheel that stops
 *     visually on 100× while the tournament pays 2× would be far worse than no
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

/** Advance far enough to reach the result beat. */
function runToResult() {
  act(() => {
    vi.advanceTimersByTime(900 + 4200 + 50);
  });
}

describe('wheel layout', () => {
  it('alternates small and large so a near-miss is REAL, not staged', () => {
    const order = buildWheelOrder(DEFAULT_SPIN_TIERS);
    // Interleaved from both ends: smallest, largest, 2nd smallest, 2nd largest...
    // Note 2x sits directly beside 500x, which is the whole point: the most
    // common result is adjacent to the rarest, so the near-miss is a property
    // of the layout rather than something staged for effect.
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
        `${order[i].multiplier}x is surrounded by big tiers — a whole arc of the wheel would be unreachable excitement`
      ).toBe(false);
    }
  });

  it('keeps every tier — none may be silently dropped from the wheel', () => {
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
    expect(even).toHaveLength(4);

    const odd = buildWheelOrder([{ multiplier: 2 }, { multiplier: 5 }, { multiplier: 10 }]);
    expect(odd).toHaveLength(3);
  });

  it('bands tiers so bigger prizes read hotter', () => {
    expect(tierClass(2)).toBe('sw--base');
    expect(tierClass(3)).toBe('sw--base');
    expect(tierClass(5)).toBe('sw--mid');
    expect(tierClass(10)).toBe('sw--mid');
    expect(tierClass(25)).toBe('sw--big');
    expect(tierClass(50)).toBe('sw--big');
    expect(tierClass(100)).toBe('sw--mega');
  });
});

describe('SpinWheel — honesty', () => {
  it('lands on the SERVER value, every tier, exactly', () => {
    for (const tier of DEFAULT_SPIN_TIERS) {
      const { container, unmount } = render(
        <SpinWheel data={{ ...SPIN, multiplier: tier.multiplier }} onDone={() => {}} />
      );
      runToResult();
      // Scoped to the RESULT element, not the wheel: every segment carries a
      // label too, so an unscoped query would match the losing tiers as well.
      const headline = container.querySelector('.sw__mult')?.textContent;
      expect(headline, `server drew ${tier.multiplier}x`).toBe(`${tier.multiplier}×`);
      unmount();
    }
  });

  it('computes the prize from buy-in x multiplier, not from anything local', () => {
    render(<SpinWheel data={{ ...SPIN, buyIn: 5, multiplier: 10 }} onDone={() => {}} />);
    runToResult();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // 5 x 10 = 50
    expect(screen.getByText('50')).toBeTruthy();
  });

  it('never crashes on a multiplier that is not on the wheel', () => {
    expect(() => {
      render(<SpinWheel data={{ ...SPIN, multiplier: 7 }} onDone={() => {}} />);
      runToResult();
    }).not.toThrow();
  });

  it('contains no randomness in the outcome path', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/components/tournament/SpinWheel.tsx'),
      'utf8'
    );
    // Math.random anywhere in a component that decides where a PRIZE wheel
    // stops would be a fairness defect, not a cosmetic one.
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/crypto\.getRandomValues/);
  });
});

describe('SpinWheel — sequence', () => {
  it('renders nothing until a draw arrives', () => {
    const { container } = render(<SpinWheel data={null} onDone={() => {}} />);
    expect(container.querySelector('.sw')).toBeNull();
  });

  it('runs intro -> spinning -> result in order', () => {
    const { container } = render(<SpinWheel data={SPIN} onDone={() => {}} />);
    expect(container.querySelector('.sw--intro')).toBeTruthy();
    expect(soundService.playSpinStart).toHaveBeenCalledTimes(1);
    expect(soundService.playSpinTicking).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(950);
    });
    expect(container.querySelector('.sw--spinning')).toBeTruthy();
    expect(soundService.playSpinTicking).toHaveBeenCalledTimes(1);
    // The result must NOT have been announced while it is still turning.
    expect(soundService.playSpinMultiplierResult).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(4300);
    });
    expect(container.querySelector('.sw--result')).toBeTruthy();
    expect(soundService.playSpinMultiplierResult).toHaveBeenCalledWith(10);
  });

  it('passes the real spin duration to the ticking so they decelerate together', () => {
    render(<SpinWheel data={SPIN} onDone={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(950);
    });
    const ms = (soundService.playSpinTicking as any).mock.calls[0][0];
    expect(ms).toBeGreaterThan(1000);
  });

  it('turns a whole number of times before landing, so it cannot stop short', () => {
    const { container } = render(<SpinWheel data={SPIN} onDone={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(950);
    });
    const wheel = container.querySelector('.sw__wheel') as HTMLElement;
    const deg = Number(/rotate\((-?[\d.]+)deg\)/.exec(wheel.style.transform)?.[1]);
    // Six turns minus the offset to the winning segment.
    expect(deg).toBeGreaterThan(360 * 5);
    expect(deg).toBeLessThanOrEqual(360 * 6);
  });

  it('reports done and clears itself', () => {
    const onDone = vi.fn();
    render(<SpinWheel data={SPIN} onDone={onDone} />);
    act(() => {
      vi.advanceTimersByTime(900 + 4200 + 4300);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('stays silent on a background table', () => {
    render(<SpinWheel data={SPIN} onDone={() => {}} playSounds={false} />);
    act(() => {
      vi.advanceTimersByTime(950);
    });
    expect(soundService.playSpinStart).not.toHaveBeenCalled();
    expect(soundService.playSpinTicking).not.toHaveBeenCalled();
  });

  it('celebrates only the big tiers', () => {
    const { container, unmount } = render(
      <SpinWheel data={{ ...SPIN, multiplier: 2 }} onDone={() => {}} />
    );
    runToResult();
    expect(container.querySelector('.sw__confetti')).toBeNull();
    expect(screen.queryByText(/JACKPOT/)).toBeNull();
    unmount();

    const big = render(<SpinWheel data={{ ...SPIN, multiplier: 100 }} onDone={() => {}} />);
    runToResult();
    expect(big.container.querySelector('.sw__confetti')).toBeTruthy();
    expect(screen.getByText('MEGA JACKPOT')).toBeTruthy();
  });
});

describe('SpinWheel — locked tiers and payout splits', () => {
  it('shows a tier the pool cannot fund as LOCKED rather than hiding it', () => {
    const { container } = render(
      <SpinWheel data={{ ...SPIN, lockedMultipliers: [100, 500] }} onDone={() => {}} />
    );
    // Still on the wheel — a visible 500x you cannot win yet is anticipation.
    expect(container.querySelectorAll('.sw__seg').length).toBe(DEFAULT_SPIN_TIERS.length);
    expect(container.querySelectorAll('.sw__seg--locked').length).toBe(2);
  });

  it('marks nothing locked when the pool can fund everything', () => {
    const { container } = render(<SpinWheel data={SPIN} onDone={() => {}} />);
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
    expect(container.querySelectorAll('.sw__seg--locked').length).toBe(2);
  });

  it('names the CHEAPEST unlock, so the note is something reachable', () => {
    // 100x at 750 and 500x at 5,000 — the honest thing to advertise is the
    // one the club is closest to, not the biggest number on the wheel.
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
    const note = container.querySelector('.sw__status-locked');
    expect(note).toBeTruthy();
    expect(note!.textContent).toContain('100');
    expect(note!.textContent).toContain('750');
  });

  it('says nothing about unlocks when no threshold was recorded', () => {
    // Older Spins have no spin_locked_tiers at all, and a tier locked purely
    // on affordability may carry no usable threshold. Dim the segment, but
    // do not invent a number to promise.
    const { container } = render(
      <SpinWheel data={{ ...SPIN, lockedMultipliers: [500] }} onDone={() => {}} />
    );
    expect(container.querySelectorAll('.sw__seg--locked').length).toBe(1);
    expect(container.querySelector('.sw__status-locked')).toBeNull();
  });

  it('survives whatever the jsonb column hands back', () => {
    // A wheel that throws while a player watches their prize be decided is a
    // far worse failure than one that fails to dim a segment.
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

  it('shows all three places at 25x and above, with the real amounts', () => {
    const { container } = render(
      <SpinWheel data={{ ...SPIN, buyIn: 10, multiplier: 500 }} onDone={() => {}} />
    );
    runToResult();
    const amts = [...container.querySelectorAll('.sw__split-amt')].map((n) => n.textContent);
    // 10 x 500 = 5,000 pool -> 80/12/8
    expect(amts).toEqual(['4,000', '600', '400']);
  });

  it('shows two places at exactly 10x', () => {
    const { container } = render(
      <SpinWheel data={{ ...SPIN, buyIn: 10, multiplier: 10 }} onDone={() => {}} />
    );
    runToResult();
    const amts = [...container.querySelectorAll('.sw__split-amt')].map((n) => n.textContent);
    expect(amts).toEqual(['80', '20']);
  });
});

describe('SpinWheel — CSS contracts', () => {
  const css = readFileSync(
    resolve(__dirname, '../../src/components/tournament/SpinWheel.css'),
    'utf8'
  );

  it('namespaces every keyframe (global @keyframes namespace)', () => {
    const names = [...css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(5);
    for (const n of names) {
      expect(n, `${n} must be sw*-prefixed`).toMatch(/^sw/);
    }
  });

  it('decelerates on a curve with a long slow tail, not a plain ease-out', () => {
    // The whole illusion is here: the last segments must crawl past the
    // pointer readably. A linear or shallow curve gives the answer away early.
    const m = /transition-timing-function:\s*cubic-bezier\(([^)]+)\)/.exec(css);
    expect(m, 'expected an explicit cubic-bezier on .sw__wheel').toBeTruthy();
    const [, , , y2] = m![1].split(',').map((v) => Number(v.trim()));
    expect(y2).toBe(1);
  });

  it('still turns under reduced motion — the draw IS the product', () => {
    const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
    // Duration is cut, but the wheel must not have its transition removed.
    expect(reduced).toMatch(/\.sw__wheel\s*\{[^}]*transition-duration/);
    expect(reduced).not.toMatch(/\.sw__wheel\s*\{[^}]*transition:\s*none/);
  });
});
