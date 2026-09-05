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
    expect(replay).toContain('<CardImage card={c} size="sm" />');
    expect(replay).toContain('<CardBack size="sm" />');
  });

  it('every board gets its own lane, so run 2 never cancels run 1 (spec 81)', () => {
    // The hook is called inside ReplayBoard - one component per board - and
    // is handed that board's index. Calling it once in Felt and reusing the
    // answer would put every run on one lane.
    expect(replay).toContain('function ReplayBoard(');
    expect(replay).toMatch(/boardIndex,\s*\n\s*mode: 'replay',/);
    expect(replay).toContain('boardIndex={bi}');
    // and it is NOT called inside a .map(), which React forbids
    const hookAt = replay.indexOf('useCardSqueeze({');
    const boardStart = replay.indexOf('function ReplayBoard(');
    const feltStart = replay.indexOf('function Felt(');
    expect(hookAt).toBeGreaterThan(boardStart);
    expect(hookAt).toBeLessThan(feltStart);
  });

  it('the wrapper is always rendered, so the row cannot reflow mid-reveal', () => {
    // `hr-felt__card` wraps the card whether or not it is squeezing.
    expect(replay).toMatch(
      /className=\{`hr-felt__card\$\{host \? ` \$\{host\.className\}` : ''\}`\}/
    );
    const css = fs.readFileSync(path.join(ROOT, 'src/components/replay/HandReplay.css'), 'utf8');
    expect(css).toContain('.hr-felt__card {');
    expect(css).toContain('display: inline-flex');
    expect(css).toContain('position: relative');
  });

  it('a different hand resets the lane rather than continuing the last one', () => {
    expect(replay).toContain("String(model.handNumber ?? model.playedAt ?? 'replay')");
  });
});
