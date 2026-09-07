/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BOMB POT WHEEL FINISHES, AND GETS OUT OF THE WAY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-07, item 7D: a wheel-spinner reveal after the hand, showing how
 * many hands until the bomb pot.
 *
 * ── WHY THE FIRST TEST HERE IS THE RE-RENDER ONE ───────────────────────────
 * This component shipped with no test at all and a defect that a source-text
 * pin could never have seen: its effect listed `onDone` as a dependency, and
 * TablePage mounts it with an inline arrow, so EVERY parent render re-ran the
 * effect - cleanup cancelled every pending timer, then the `startedFor` guard
 * returned before rescheduling them. The chase froze, `onDone` never fired,
 * and a full-screen dim at z-index 99996 stayed over the felt for the rest of
 * the session. TablePage re-renders on every engine snapshot, so this was not
 * an edge case; it was the normal path.
 *
 * The first test reproduces that exact shape. It fails against the version
 * that lists `onDone` as a dependency and passes against the ref.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, screen } from '@testing-library/react';
import { useState } from 'react';
import BombPotWheel, {
  BOMB_WHEEL_CHASE_MS,
  BOMB_WHEEL_HOLD_MS,
  BOMB_WHEEL_MAX_HANDS,
  BOMB_WHEEL_MIN_HANDS,
} from '../../src/components/table/BombPotWheel';

const FULL = BOMB_WHEEL_CHASE_MS + BOMB_WHEEL_HOLD_MS + 200;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** The exact TablePage mount shape: an inline arrow, and a parent that
 *  re-renders on every engine snapshot. */
function Host({ hands, onDone, bump }: { hands: number | null; onDone: () => void; bump: number }) {
  const [, force] = useState(0);
  // `bump` changing is the parent re-rendering for reasons of its own.
  if (bump < 0) force(1);
  return <BombPotWheel handsAway={hands} onDone={() => onDone()} />;
}

describe('the reveal completes even though the parent re-renders under it', () => {
  it('THE REGRESSION: one parent re-render mid-chase must not cancel the reveal', async () => {
    const onDone = vi.fn();
    const { rerender } = render(<Host hands={4} onDone={onDone} bump={0} />);

    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    // The parent renders again - a new snapshot, a new inline arrow.
    rerender(<Host hands={4} onDone={onDone} bump={1} />);
    rerender(<Host hands={4} onDone={onDone} bump={2} />);

    await act(async () => {
      vi.advanceTimersByTime(FULL);
    });

    expect(onDone, 'the wheel froze and never released the felt').toHaveBeenCalledTimes(1);
  });

  it('completes with no re-render at all', async () => {
    const onDone = vi.fn();
    render(<BombPotWheel handsAway={3} onDone={onDone} />);
    await act(async () => {
      vi.advanceTimersByTime(FULL);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('stops on the ANSWER, and says it in words', async () => {
    render(<BombPotWheel handsAway={4} onDone={() => {}} />);
    await act(async () => {
      vi.advanceTimersByTime(BOMB_WHEEL_CHASE_MS + 10);
    });
    expect(screen.getByText('Bomb Pot In 4 Hands')).toBeTruthy();
  });

  it('says NEXT HAND rather than "In 1 Hands"', async () => {
    render(<BombPotWheel handsAway={1} onDone={() => {}} />);
    await act(async () => {
      vi.advanceTimersByTime(BOMB_WHEEL_CHASE_MS + 10);
    });
    expect(screen.getByText('Bomb Pot Next Hand')).toBeTruthy();
  });

  it('never says "double board" - every bomb pot is one (Dan 7D)', async () => {
    render(<BombPotWheel handsAway={2} onDone={() => {}} />);
    await act(async () => {
      vi.advanceTimersByTime(BOMB_WHEEL_CHASE_MS + 10);
    });
    expect(screen.getByTestId('bomb-pot-wheel').textContent).not.toMatch(/double board/i);
  });
});

describe('it draws nothing when there is nothing to reveal', () => {
  for (const bad of [null, 0, 6, 99, -1]) {
    it(`handsAway=${bad} renders no overlay`, async () => {
      render(<BombPotWheel handsAway={bad} onDone={() => {}} />);
      await act(async () => {
        vi.advanceTimersByTime(FULL);
      });
      expect(screen.queryByTestId('bomb-pot-wheel')).toBeNull();
    });
  }

  it('the window it accepts is exactly the 1-5 Dan named', () => {
    expect(BOMB_WHEEL_MIN_HANDS).toBe(1);
    expect(BOMB_WHEEL_MAX_HANDS).toBe(5);
  });
});

describe('it never strands a timer', () => {
  it('unmounting mid-chase leaves nothing pending', async () => {
    const onDone = vi.fn();
    const { unmount } = render(<BombPotWheel handsAway={5} onDone={onDone} />);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(FULL);
    });
    // A callback firing into an unmounted tree is how a "leave table" turns
    // into a setState-on-unmounted warning, or worse, a revived overlay.
    expect(onDone).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a new count supersedes the one in flight without double-firing', async () => {
    const onDone = vi.fn();
    const { rerender } = render(<BombPotWheel handsAway={5} onDone={onDone} />);
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    rerender(<BombPotWheel handsAway={2} onDone={onDone} />);
    await act(async () => {
      vi.advanceTimersByTime(FULL);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Bomb Pot In 5 Hands')).toBeNull();
  });
});
