/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ADD-ON BUBBLE — "Has Added On For 50.00", shown above the seat that did it
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-04: "IF A PLAYER ADDS ON AFTER A HAND, THEY SHOULD GET A LITTLE
 * POP UP ABOVE THEIR HEAD. 'HAS ADDED ON FOR XX.XX'."
 *
 * WHERE THE FACT COMES FROM. Add-on chips (and, since Chip Standard C3, the
 * bust rebuy too) are debited at once but only reach the stack when the
 * engine's sweep resolves the `table_pending_addons` row — at the end of the
 * hand, or on an idle tick. That sweep now emits `add_on_applied` on the
 * table's event hub with the amount that ACTUALLY landed (capped at the max
 * buy-in; the remainder was refunded). The bubble says that number, not what
 * the player asked for.
 *
 * WHY IT REUSES THE CHAT BUBBLE. The chat bubble already solves the hard
 * part: an absolutely-positioned box over `.seat-wrapper` that flips below
 * the plate on the top arc, pops in, and never intercepts a tap. This hook
 * just produces `SeatChatBubble` entries for it, tagged `variant: 'notice'`
 * so the CSS can tint them gold instead of chat white.
 */

import { useEffect, useRef, useState } from 'react';
import { formatChips } from '../../lib/utils';
import type { SeatChatBubble } from './ChatBubble';

/** Long enough to read six words across a table; short enough to be gone
    before the next hand's first action needs the plate. */
export const ADD_ON_BUBBLE_LIFETIME_MS = 4000;

/** The wire shape the engine emits from `processPendingAddOns`. */
export interface AddOnAppliedEvent {
  type: 'add_on_applied';
  table_id?: string;
  seat?: number | null;
  user_id: string;
  amount: number;
  stack?: number | null;
  kind?: 'addon' | 'rebuy' | string;
  timestamp?: number;
}

/** Is this engine event an add-on landing? Exported for the tests. */
export function isAddOnAppliedEvent(evt: unknown): evt is AddOnAppliedEvent {
  if (!evt || typeof evt !== 'object') return false;
  const e = evt as Record<string, unknown>;
  const type = typeof e.type === 'string' ? e.type.toLowerCase() : '';
  return type === 'add_on_applied' && typeof e.user_id === 'string' && Number(e.amount) > 0;
}

/** The exact words. One phrase for add-on and rebuy alike — Dan asked for
    one, and to the table both are a stack getting bigger between hands. */
export function addOnBubbleText(amount: number): string {
  return `Has Added On For ${formatChips(amount)}`;
}

/**
 * Resolve the seat to hang the bubble over. The event carries the seat the
 * engine knew; if it is missing (a player found by id but not by seat), fall
 * back to the seat-ordered owner list the table renders from — the same map
 * the chat bubble uses.
 */
export function seatForAddOn(
  evt: AddOnAppliedEvent,
  seatOwnerIds: ReadonlyArray<string | null | undefined>
): number {
  const fromEvent = Number(evt.seat);
  if (Number.isFinite(fromEvent) && fromEvent > 0) return fromEvent;
  const idx = seatOwnerIds.findIndex((id) => !!id && id === evt.user_id);
  return idx >= 0 ? idx + 1 : 0;
}

/**
 * Turn the engine's latest event into at most one add-on bubble per seat.
 *
 * `engineLastEvent` is a "latest event" cell, not a stream: the same object
 * is handed back on every render until the next event replaces it, so each
 * object is processed once (by identity) and never again.
 */
export function useSeatAddOnBubbles(
  engineLastEvent: unknown,
  seatOwnerIds: ReadonlyArray<string | null | undefined>,
  options: { lifetimeMs?: number; nameForSeat?: (seatNumber: number) => string } = {}
): SeatChatBubble[] {
  const { lifetimeMs = ADD_ON_BUBBLE_LIFETIME_MS, nameForSeat } = options;
  const [bubbles, setBubbles] = useState<SeatChatBubble[]>([]);
  const lastSeenRef = useRef<unknown>(null);
  const seatOwnerIdsRef = useRef(seatOwnerIds);
  seatOwnerIdsRef.current = seatOwnerIds;
  // Read through a ref: callers hand in a fresh closure every render, and a
  // name lookup must not re-arm the effect.
  const nameForSeatRef = useRef(nameForSeat);
  nameForSeatRef.current = nameForSeat;
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    if (!engineLastEvent || lastSeenRef.current === engineLastEvent) return;
    lastSeenRef.current = engineLastEvent;
    if (!isAddOnAppliedEvent(engineLastEvent)) return;

    const seatNumber = seatForAddOn(engineLastEvent, seatOwnerIdsRef.current);
    if (seatNumber <= 0) return; // Nobody to hang it over.

    const id = `addon-${engineLastEvent.user_id}-${engineLastEvent.timestamp ?? Date.now()}`;
    const fresh: SeatChatBubble = {
      id,
      seatNumber,
      playerId: engineLastEvent.user_id,
      playerName: nameForSeatRef.current?.(seatNumber) ?? '',
      content: addOnBubbleText(Number(engineLastEvent.amount)),
      shownAt: Date.now(),
      variant: 'notice',
    };

    // One per seat, latest wins — two add-ons in a row replace, not stack.
    setBubbles((prev) => [...prev.filter((b) => b.seatNumber !== seatNumber), fresh]);

    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      setBubbles((prev) => prev.filter((b) => b.id !== id));
    }, lifetimeMs);
    timersRef.current.add(timer);
  }, [engineLastEvent, lifetimeMs]);

  // A seat that emptied while the bubble was up has nothing under it.
  const activeSeats = new Set(seatOwnerIds.map((id, i) => (id ? i + 1 : 0)).filter((n) => n > 0));
  return bubbles.filter((b) => activeSeats.has(b.seatNumber));
}
