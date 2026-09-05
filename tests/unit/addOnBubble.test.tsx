import { act, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  "HAS ADDED ON FOR XX.XX" — the bubble over the seat (Dan 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "IF A PLAYER ADDS ON AFTER A HAND, THEY SHOULD GET A LITTLE POP UP ABOVE
 *  THEIR HEAD. 'HAS ADDED ON FOR XX.XX'."
 *
 * The engine says `add_on_applied` when the chips land; this pins that the
 * table turns it into exactly those words, over exactly that seat, for a
 * bounded time, and that the wiring in TablePage is the one that shows it.
 */

import { ChatBubble, bubbleForSeat } from '../../src/components/table/ChatBubble';
import {
  ADD_ON_BUBBLE_LIFETIME_MS,
  addOnBubbleText,
  isAddOnAppliedEvent,
  seatForAddOn,
  useSeatAddOnBubbles,
} from '../../src/components/table/AddOnBubble';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const SEATS: readonly (string | null)[] = ['villain', 'hero', null, 'third'];

function Harness({ event, seats = SEATS }: { event: unknown; seats?: readonly (string | null)[] }) {
  const bubbles = useSeatAddOnBubbles(event, seats, {
    nameForSeat: (n) => `Seat ${n}`,
  });
  return (
    <div>
      {seats.map((_, i) => {
        const b = bubbleForSeat(bubbles, i + 1);
        return (
          <div key={i} data-testid={`seat-${i + 1}`}>
            {b ? (
              <ChatBubble text={b.content} playerName={b.playerName} variant={b.variant} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

describe('the words and the seat', () => {
  it('says exactly "Has Added On For XX.XX", two decimals, grouped', () => {
    expect(addOnBubbleText(50)).toBe('Has Added On For 50.00');
    expect(addOnBubbleText(12.5)).toBe('Has Added On For 12.50');
    expect(addOnBubbleText(1500)).toBe('Has Added On For 1,500.00');
  });

  it('recognises only a real add-on landing', () => {
    expect(isAddOnAppliedEvent({ type: 'add_on_applied', user_id: 'u', amount: 20 })).toBe(true);
    expect(isAddOnAppliedEvent({ type: 'ADD_ON_APPLIED', user_id: 'u', amount: 20 })).toBe(true);
    expect(isAddOnAppliedEvent({ type: 'add_on_applied', user_id: 'u', amount: 0 })).toBe(false);
    expect(isAddOnAppliedEvent({ type: 'seat_left', user_id: 'u', amount: 20 })).toBe(false);
    expect(isAddOnAppliedEvent(null)).toBe(false);
  });

  it('hangs it over the engine seat, or the seat that owns the player id when the engine had none', () => {
    const base = { type: 'add_on_applied' as const, user_id: 'hero', amount: 20 };
    expect(seatForAddOn({ ...base, seat: 4 }, SEATS)).toBe(4);
    expect(seatForAddOn({ ...base, seat: null }, SEATS)).toBe(2);
    expect(seatForAddOn({ ...base, user_id: 'observer' }, SEATS)).toBe(0);
  });
});

describe('useSeatAddOnBubbles', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('raises a gold notice over the seat and takes it down after the lifetime', () => {
    const { rerender } = render(<Harness event={null} />);
    expect(screen.queryByText(/Has Added On/)).toBeNull();

    const evt = { type: 'add_on_applied', seat: 2, user_id: 'hero', amount: 75.5, timestamp: 1 };
    rerender(<Harness event={evt} />);

    const bubble = screen.getByText('Has Added On For 75.50');
    expect(screen.getByTestId('seat-2').contains(bubble)).toBe(true);
    expect(bubble.closest('.chat-bubble')?.className).toContain('chat-bubble--notice');
    expect(screen.getByText('Seat 2')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(ADD_ON_BUBBLE_LIFETIME_MS - 1);
    });
    expect(screen.queryByText(/Has Added On/)).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText(/Has Added On/)).toBeNull();
  });

  it('processes one event object once, and a second add-on on the same seat replaces the first', () => {
    const evt1 = { type: 'add_on_applied', seat: 2, user_id: 'hero', amount: 10, timestamp: 1 };
    const { rerender } = render(<Harness event={evt1} />);
    rerender(<Harness event={evt1} />); // same object again: no second bubble, no re-armed timer
    expect(screen.getAllByText(/Has Added On/)).toHaveLength(1);

    const evt2 = { type: 'add_on_applied', seat: 2, user_id: 'hero', amount: 20, timestamp: 2 };
    rerender(<Harness event={evt2} />);
    expect(screen.queryByText('Has Added On For 10.00')).toBeNull();
    expect(screen.getByText('Has Added On For 20.00')).toBeTruthy();
  });

  it('ignores an add-on for someone with no seat to sit over', () => {
    const evt = { type: 'add_on_applied', seat: null, user_id: 'nobody', amount: 20, timestamp: 1 };
    render(<Harness event={evt} />);
    expect(screen.queryByText(/Has Added On/)).toBeNull();
  });
});

describe('the wiring is the real one', () => {
  it('TablePage feeds the engine event into the hook and lets the notice win the seat slot', () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toContain("import { useSeatAddOnBubbles } from '../components/table/AddOnBubble'");
    expect(page).toContain('useSeatAddOnBubbles(engineLastEvent, seatOwnerIds');
    expect(page).toMatch(
      /bubbleForSeat\(seatAddOnBubbles, seatNumber\) \?\?\s*bubbleForSeat\(seatChatBubbles, seatNumber\)/
    );
  });

  it('the engine announces from the sweep, with the applied amount', () => {
    const sweep = read('server/src/engine/ServerTableEngineSeating.ts');
    expect(sweep).toContain("type: 'add_on_applied'");
    expect(sweep).toMatch(/amount: applied,/);
  });

  it('the notice is gold, not chat white', () => {
    const css = read('src/components/table/ChatBubble.css');
    expect(css).toMatch(
      /\.chat-bubble--notice[\s\S]*background: linear-gradient\(180deg, rgba\(255, 214, 102/
    );
  });
});
