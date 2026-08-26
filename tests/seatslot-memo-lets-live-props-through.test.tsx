/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SeatSlot's memo comparator must not swallow a prop that changes on screen
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SeatSlot is `memo`'d with a HAND-WRITTEN comparator - roughly forty explicit
 * field checks - because it renders up to nine times per table and up to four
 * tables can be mounted at once. That is the right shape, and it has exactly
 * one failure mode: a prop gets added to the component, wired at the call site,
 * and never added to the comparator. The feature is then invisible, and it is
 * invisible in the most confusing possible way - it works whenever some OTHER
 * prop on that seat happens to change in the same tick, so it looks flaky
 * rather than missing.
 *
 * It has happened repeatedly (the comparator itself carries three separate
 * "AUDIT FIX: this was missing" notes), so this file pins the behaviour rather
 * than the comparator's source: render, change ONE prop, assert the DOM moved.
 *
 * Audit 2026-08-25 added the four below. Each was a live prop that the
 * comparator blocked:
 *
 *   holeCardCount       - the variant's hand size, so a PLO6 villain drew a
 *                         Hold'em hand until something else about that seat
 *                         changed. TablePage feeds it from `tableState.gameType`
 *                         which is EMPTY on the first paint, so the arrival of
 *                         the real variant was exactly the update being lost.
 *   isHeroReservedSeat  - an EMPTY-seat prop, and the comparator's
 *                         `if (!pp && !np) return true` short-circuit meant NO
 *                         empty-seat prop could ever get through. The hero's own
 *                         reserved chair never changed from EMPTY to YOUR SEAT.
 *   player.frame/.aura  - the equipped cosmetics, which the profiles
 *                         subscription rewrites on their own.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import SeatSlot, { type SeatPlayer } from '../src/components/table/SeatSlot';

const villain: SeatPlayer = {
  id: 'v1',
  name: 'VILLAIN',
  stack: 1000,
  status: 'active',
  showCards: false,
  isHero: false,
};

function renderSeat(props: Record<string, unknown>) {
  return render(
    <SeatSlot
      seatNumber={3}
      player={villain}
      position={null}
      isActive={false}
      lastAction={null}
      {...props}
    />
  );
}

describe('the variant hand size reaches an already-rendered seat', () => {
  it('a hidden villain redraws its backs when holeCardCount arrives', () => {
    // The real sequence: the seat paints before the table row lands, so the
    // count is the default 2, and then the variant turns out to be PLO6.
    const { container, rerender } = renderSeat({ holeCardCount: 2 });
    expect(container.querySelectorAll('.seat__card--back')).toHaveLength(2);

    rerender(
      <SeatSlot
        seatNumber={3}
        player={villain}
        position={null}
        isActive={false}
        lastAction={null}
        holeCardCount={6}
      />
    );
    expect(container.querySelectorAll('.seat__card--back')).toHaveLength(6);
  });

  it('and the 2-card class follows it, so the row is never sized for a hand it is not drawing', () => {
    const { container, rerender } = renderSeat({ holeCardCount: 2 });
    expect(container.querySelector('.seat__cards--twocard')).not.toBeNull();

    rerender(
      <SeatSlot
        seatNumber={3}
        player={villain}
        position={null}
        isActive={false}
        lastAction={null}
        holeCardCount={4}
      />
    );
    expect(container.querySelector('.seat__cards--twocard')).toBeNull();
  });
});

describe('an empty seat can still change', () => {
  it('flips from EMPTY to YOUR SEAT when the hero reserves it', () => {
    const { container, rerender } = render(
      <SeatSlot
        seatNumber={5}
        player={null}
        position={null}
        isActive={false}
        lastAction={null}
        canSit={false}
        isHeroReservedSeat={false}
      />
    );
    expect(container.querySelector('.seat__empty-label')?.textContent).toBe('EMPTY');

    rerender(
      <SeatSlot
        seatNumber={5}
        player={null}
        position={null}
        isActive={false}
        lastAction={null}
        canSit={false}
        isHeroReservedSeat
      />
    );
    expect(container.querySelector('.seat__empty-label')?.textContent).toBe('YOUR SEAT');
  });

  it('and says so to a screen reader, not "empty"', () => {
    const { container } = render(
      <SeatSlot
        seatNumber={5}
        player={null}
        position={null}
        isActive={false}
        lastAction={null}
        canSit={false}
        isHeroReservedSeat
      />
    );
    expect(container.querySelector('[aria-label]')?.getAttribute('aria-label')).toBe(
      'Seat 5: your seat'
    );
  });
});

describe('equipped cosmetics repaint when the profiles subscription rewrites them', () => {
  it('a newly equipped frame reaches a seat that is otherwise unchanged', () => {
    const { container, rerender } = renderSeat({ showAvatar: true });
    const before = container.querySelector('[class*="frame-"]');

    rerender(
      <SeatSlot
        seatNumber={3}
        player={{ ...villain, frame: 'frame-gold' }}
        position={null}
        isActive={false}
        lastAction={null}
        showAvatar
      />
    );
    const after = container.innerHTML;
    // The assertion that matters is that the render was not skipped: the DOM
    // must differ once a frame token is present where there was none.
    expect(after).not.toBe(before?.outerHTML ?? '');
    expect(after).toContain('frame-gold');
  });
});
