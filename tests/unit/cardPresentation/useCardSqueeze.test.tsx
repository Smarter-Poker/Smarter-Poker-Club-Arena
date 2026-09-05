/**
 * ROUND 2 2026-09-05 — the hook the hand replay reveals through, and the
 * source pins that prove the replay actually uses it. The felt board has its
 * own effect (it also owns the newly-dealt window, the rabbit slots and the
 * sound cue); this is the small version for a surface that only reveals
 * card N of a list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import {
  useCardSqueeze,
  streetForCount,
  cardPresentationEngine,
  CARD_PRESENTATION_PROFILES,
} from '../../../src/presentation/cardPresentation';

const ROOT = path.resolve(__dirname, '../../..');
const replay = fs.readFileSync(path.join(ROOT, 'src/components/replay/HandReplay.tsx'), 'utf8');

describe('streetForCount', () => {
  it('maps a visible count to the street that just landed', () => {
    expect(streetForCount(0)).toBeNull();
    expect(streetForCount(2)).toBeNull();
    expect(streetForCount(3)).toBe('flop');
    expect(streetForCount(4)).toBe('turn');
    expect(streetForCount(5)).toBe('river');
  });
});

describe('useCardSqueeze', () => {
  let surface = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    surface += 1;
    cardPresentationEngine.forgetTable(`s${surface}`);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const run = (initial: number) =>
    renderHook(
      ({ visibleCount, handId }: { visibleCount: number; handId: string | number }) =>
        useCardSqueeze({ visibleCount, handId, surfaceId: `s${surface}`, mode: 'replay' }),
      { initialProps: { visibleCount: initial, handId: 1 as string | number } }
    );

  it('squeezes the card a forward step revealed, on the replay profile', () => {
    const { result, rerender } = run(3);
    expect(result.current.index).toBe(-1);
    act(() => rerender({ visibleCount: 4, handId: 1 }));
    expect(result.current.index).toBe(3);
    expect(result.current.profile).toBe(CARD_PRESENTATION_PROFILES.replayDesktop);
    act(() => rerender({ visibleCount: 5, handId: 1 }));
    expect(result.current.index).toBe(4);
  });

  it('the flop does not squeeze - it keeps its own fan', () => {
    const { result, rerender } = run(0);
    act(() => rerender({ visibleCount: 3, handId: 1 }));
    expect(result.current.index).toBe(-1);
  });

  it('stepping BACKWARD is not a reveal, and cancels anything in flight', () => {
    const { result, rerender } = run(4);
    act(() => rerender({ visibleCount: 5, handId: 1 }));
    expect(result.current.index).toBe(4);
    act(() => rerender({ visibleCount: 4, handId: 1 }));
    expect(result.current.index).toBe(-1);
    expect(cardPresentationEngine.activeCount).toBe(0);
  });

  it('re-stepping onto a card already revealed does not replay it (spec 15)', () => {
    const { result, rerender } = run(4);
    act(() => rerender({ visibleCount: 5, handId: 1 }));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.index).toBe(-1);
    act(() => rerender({ visibleCount: 4, handId: 1 }));
    act(() => rerender({ visibleCount: 5, handId: 1 }));
    expect(result.current.index).toBe(-1);
  });

  it('the markup is dropped after the profile window', () => {
    const { result, rerender } = run(4);
    act(() => rerender({ visibleCount: 5, handId: 1 }));
    expect(result.current.index).toBe(4);
    act(() => {
      vi.advanceTimersByTime(CARD_PRESENTATION_PROFILES.replayDesktop.durationMs + 200);
    });
    expect(result.current.index).toBe(-1);
  });

  it('another hand resets the lane rather than continuing the old one', () => {
    const { result, rerender } = run(4);
    act(() => rerender({ visibleCount: 5, handId: 1 }));
    expect(result.current.index).toBe(4);
    act(() => rerender({ visibleCount: 5, handId: 2 }));
    expect(result.current.index).toBe(-1);
    expect(cardPresentationEngine.activeCount).toBe(0);
  });

  it('unmount leaves nothing in the engine (spec 99, 100)', () => {
    const { rerender, unmount } = run(4);
    act(() => rerender({ visibleCount: 5, handId: 1 }));
    expect(cardPresentationEngine.activeCount).toBe(1);
    unmount();
    expect(cardPresentationEngine.activeCount).toBe(0);
  });
});

describe('the hand replay reveals through the shared squeeze', () => {
  it('uses the hook, the shared card and the shared bridge - not its own copy', () => {
    expect(replay).toContain('useCardSqueeze({');
    expect(replay).toContain("mode: 'replay'");
    expect(replay).toContain('<SqueezeCard');
    expect(replay).toContain('squeezeHostProps(');
    // the card renderer is still the app's own (spec 5, 52)
    expect(replay).toContain('<CardImage card={toCardImage(card)} size="xs" />');
    expect(replay).toContain('<CardBack size="xs" />');
  });

  it('the surface id keeps two replays on one page in separate lanes (spec 31)', () => {
    expect(replay).toMatch(/surfaceId: `replay:\$\{handData\?\.id \?\? handId \?\? 'demo'\}`/);
  });

  it('the hook sits above the early returns so hook order never changes', () => {
    const hookAt = replay.indexOf('useCardSqueeze({');
    const loadingReturn = replay.indexOf('if (isLoading) {');
    const noDataReturn = replay.indexOf('if (!handData) {');
    expect(hookAt).toBeGreaterThan(-1);
    expect(hookAt).toBeLessThan(loadingReturn);
    expect(hookAt).toBeLessThan(noDataReturn);
  });
});
