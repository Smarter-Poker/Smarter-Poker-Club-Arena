/**
 * A CARD MUST SHOW THE NUMBERS IT IS GIVEN, INCLUDING THE ONES THAT ARRIVE LATE.
 *
 * Dan, 2026-08-22: "THE 'LEVELS' AND THE 'ACTIVE' HAVE A BUG THAT MUST BE
 * FIXED, AND THEN PREVENT IT FROM REGRESSING OR BREAKING AGAIN!"
 *
 * The bug, and why nothing else in the suite could have caught it:
 *
 * Every club and union card read LEVEL 1 and ACTIVE 0, permanently, while
 * MEMBERS was correct. The data was never wrong - production had SHARK CLUB at
 * 588 members, level 29, 112 seated. What was wrong is that `Carousel` cached
 * each rendered card in a ref keyed on identity ALONE, and never invalidated
 * that cache when `renderItem` changed.
 *
 * The lobby's first paint happens BEFORE the stats query resolves, so
 * CarouselSection rendered its `?? 1` / `?? 0` fallbacks and that node was
 * cached. When the stats landed, `renderItem` got a new identity - and the
 * cache handed back the frozen node anyway. The 20-second poll then fetched
 * correct numbers forever without being able to display one of them. MEMBERS
 * escaped only because ITS fallback (already-loaded club.member_count) happened
 * to be the right answer.
 *
 * Everything about this is invisible to a data-layer test: the query is right,
 * the props are right, the component is right. It only shows up if you assert
 * on the DOM AFTER a prop change. So that is what this file does, and it is the
 * single thing standing between the lobby and a silent repeat.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { Carousel } from '../../src/components/carousel/Carousel';

interface Club {
  id: string;
  name: string;
}

const CLUBS: Club[] = [
  { id: 'a', name: 'SHARK CLUB' },
  { id: 'b', name: 'Club JAQK' },
  { id: 'c', name: 'Midway Union' },
];

interface Stats {
  level: number;
  active: number;
}

/** jsdom reports clientWidth 0, which would collapse the responsive sizing. */
function withTrackWidth(px: number) {
  return vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => px);
}

/** A stand-in for ClubCardPanel: the two stats that were frozen, on a card. */
function statsCard(club: Club, stats: Record<string, Stats>) {
  const s = stats[club.id];
  return (
    <div data-testid={`card-${club.id}`}>
      <span data-testid={`level-${club.id}`}>{s?.level ?? 1}</span>
      <span data-testid={`active-${club.id}`}>{s?.active ?? 0}</span>
    </div>
  );
}

function renderWithStats(stats: Record<string, Stats>) {
  return (
    <Carousel
      items={CLUBS}
      getKey={(c: Club) => c.id}
      /* A NEW function identity per stats object, exactly as CarouselSection's
         useCallback produces when `clubStats` changes. A test that passed a
         stable renderItem here would prove nothing at all. */
      renderItem={(c: Club) => statsCard(c, stats)}
      visibleCards={3}
      spacingRatio={0.94}
      edgeScale={0.8}
      ariaLabel="Your Clubs"
    />
  );
}

/** Read a stat off a POSITIONED card, not off the invisible measuring sizer. */
function statOf(kind: 'level' | 'active', id: string): string {
  return (
    document
      .querySelector(`.sp-carousel__item [data-testid="${kind}-${id}"]`)
      ?.textContent?.trim() ?? ''
  );
}

describe('late-arriving stats reach the card', () => {
  it('replaces the LEVEL 1 / ACTIVE 0 first paint once real stats land', () => {
    const spy = withTrackWidth(928);

    // First paint: the stats fetch has not resolved. This is the state the old
    // cache froze forever.
    const { rerender } = render(renderWithStats({}));
    expect(statOf('level', 'a')).toBe('1');
    expect(statOf('active', 'a')).toBe('0');

    // Stats arrive - the real production numbers for SHARK CLUB.
    act(() => {
      rerender(renderWithStats({ a: { level: 29, active: 112 } }));
    });

    expect(statOf('level', 'a')).toBe('29');
    expect(statOf('active', 'a')).toBe('112');

    spy.mockRestore();
    cleanup();
  });

  it('updates EVERY card, not just the centred one', () => {
    // The off-centre cards are the ones a cache is most likely to strand: they
    // are rendered with isActive false and never asked for again.
    const spy = withTrackWidth(928);
    const { rerender } = render(renderWithStats({}));

    act(() => {
      rerender(
        renderWithStats({
          a: { level: 29, active: 112 },
          b: { level: 29, active: 135 },
          c: { level: 30, active: 377 },
        })
      );
    });

    expect(statOf('level', 'b')).toBe('29');
    expect(statOf('active', 'b')).toBe('135');
    expect(statOf('level', 'c')).toBe('30');
    expect(statOf('active', 'c')).toBe('377');

    spy.mockRestore();
    cleanup();
  });

  it('keeps following the numbers on every later poll, not just the first', () => {
    // The stats effect re-fetches every 20 seconds. A cache that invalidates
    // once and then re-freezes is the same bug with a longer fuse.
    const spy = withTrackWidth(928);
    const { rerender } = render(renderWithStats({ a: { level: 29, active: 112 } }));
    expect(statOf('active', 'a')).toBe('112');

    act(() => {
      rerender(renderWithStats({ a: { level: 29, active: 118 } }));
    });
    expect(statOf('active', 'a')).toBe('118');

    act(() => {
      rerender(renderWithStats({ a: { level: 30, active: 96 } }));
    });
    expect(statOf('level', 'a')).toBe('30');
    expect(statOf('active', 'a')).toBe('96');

    spy.mockRestore();
    cleanup();
  });

  it('still reuses cached nodes when renderItem is stable', () => {
    // The cache exists for a real reason: `visible` recomputes on every frame
    // of a drag and each card is a heavy lazy panel. Proving the fix did not
    // simply delete the optimisation is part of the contract - otherwise the
    // next person to profile a drag reintroduces the freeze.
    const spy = withTrackWidth(928);
    const renderItem = vi.fn((c: Club) => statsCard(c, { a: { level: 29, active: 112 } }));

    const tree = (
      <Carousel
        items={CLUBS}
        getKey={(c: Club) => c.id}
        renderItem={renderItem}
        visibleCards={3}
        spacingRatio={0.94}
        edgeScale={0.8}
        ariaLabel="Your Clubs"
      />
    );
    const { rerender } = render(tree);
    const callsAfterFirstPaint = renderItem.mock.calls.length;

    // Same element, same renderItem identity: nothing about the cards changed.
    act(() => {
      rerender(tree);
    });

    expect(renderItem.mock.calls.length).toBe(callsAfterFirstPaint);

    spy.mockRestore();
    cleanup();
  });

  it('does not strand a card when the club list itself changes', () => {
    const spy = withTrackWidth(928);
    const { rerender } = render(renderWithStats({ a: { level: 29, active: 112 } }));

    const renamed: Club[] = [
      { id: 'a', name: 'SHARK CLUB' },
      { id: 'b', name: 'Club JAQK' },
    ];
    act(() => {
      rerender(
        <Carousel
          items={renamed}
          getKey={(c: Club) => c.id}
          renderItem={(c: Club) => statsCard(c, { a: { level: 31, active: 200 } })}
          visibleCards={3}
          spacingRatio={0.94}
          edgeScale={0.8}
          ariaLabel="Your Clubs"
        />
      );
    });

    expect(statOf('level', 'a')).toBe('31');
    expect(statOf('active', 'a')).toBe('200');
    expect(screen.queryByTestId('card-c')).toBeNull();

    spy.mockRestore();
    cleanup();
  });
});
