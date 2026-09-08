/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useTableAnimations — Chip Animations, Throwables, Confetti
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Extracted from TablePage.tsx.
 * Manages throwable selection/events, chip animation events, seat positions,
 * and confetti trigger state.
 */

import { useState, useCallback, useEffect } from 'react';
import { throwableService, type Throwable, type ThrowEvent } from '../services/ThrowableService';
import { roomService } from '../services/RoomService';
import type { ChipAnimationEvent } from '../components/table/ChipAnimation';
import { preloadThrowableImages } from '../components/table/ThrowableImage';
import { isThrowableEventId } from '../throwables/identity';

interface ThrowPlaybackState {
  events: ThrowEvent[];
  pending: ThrowEvent[];
  receipts: string[];
}

const MAX_ACTIVE_THROWS = 12;

// Receipt identity only deduplicates delivery; it does not authorize a throw.
// Keep the history after animation completion, and bound it for long-lived tables.
function appendThrow(
  state: ThrowPlaybackState,
  event: ThrowEvent,
  receipt?: string
): ThrowPlaybackState {
  const key = isThrowableEventId(receipt) ? receipt.toLowerCase() : undefined;
  if (
    key &&
    (state.receipts.includes(key) ||
      state.events.some((queued) => queued.id.toLowerCase() === key) ||
      state.pending.some((queued) => queued.id.toLowerCase() === key))
  )
    return state;
  // Rendering capacity must not discard a delivered throw. Pending events
  // mount only after a slot opens, so their animation and sound start together.
  const canPlay = state.events.length < MAX_ACTIVE_THROWS;
  return {
    events: canPlay ? [...state.events, event] : state.events,
    pending: canPlay ? state.pending : [...state.pending, event],
    receipts: key ? [...state.receipts.slice(-511), key] : state.receipts,
  };
}

export interface UseTableAnimationsReturn {
  // Throwables
  showThrowableSelector: boolean;
  setShowThrowableSelector: React.Dispatch<React.SetStateAction<boolean>>;
  throwTargetSeat: number | null;
  setThrowTargetSeat: React.Dispatch<React.SetStateAction<number | null>>;
  activeThrows: ThrowEvent[];
  handleThrowableSelect: (throwable: Throwable, requestId?: string) => void;
  handleThrowComplete: (eventId: string) => void;
  receiveThrow: (fromSeat: number, toSeat: number, throwableId: string, eventId?: string) => void;
  // Chip animations
  chipAnimations: ChipAnimationEvent[];
  setChipAnimations: React.Dispatch<React.SetStateAction<ChipAnimationEvent[]>>;
  // Confetti
  showConfetti: boolean;
  setShowConfetti: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useTableAnimations(
  tableId: string | undefined,
  userId: string,
  heroSeat: number
): UseTableAnimationsReturn {
  // Warm the 49-render image cache during idle time so the first throw
  // (ours or an opponent's) never rasterizes mid-flight. v2: effect, not a
  // render-body side effect (it is idempotent either way, but React render
  // purity matters -- and StrictMode double-render made the guard load-bearing).
  useEffect(() => {
    preloadThrowableImages();
  }, []);

  // Throwable state
  const [showThrowableSelector, setShowThrowableSelector] = useState(false);
  const [throwTargetSeat, setThrowTargetSeat] = useState<number | null>(null);
  const [throwPlayback, setThrowPlayback] = useState<ThrowPlaybackState>({
    events: [],
    pending: [],
    receipts: [],
  });
  const activeThrows = throwPlayback.events;

  useEffect(() => {
    setThrowPlayback({ events: [], pending: [], receipts: [] });
    setShowThrowableSelector(false);
    setThrowTargetSeat(null);
  }, [tableId, userId]);

  // Chip animation state
  const [chipAnimations, setChipAnimations] = useState<ChipAnimationEvent[]>([]);

  // Confetti state
  const [showConfetti, setShowConfetti] = useState(false);

  const handleThrowableSelect = useCallback(
    async (throwable: Throwable, requestId?: string) => {
      if (!tableId || !userId || throwTargetSeat === null) return;

      // The selector has already consumed inventory through the server RPC,
      // which enforces the account cooldown under a lock. A second timer
      // here measures response arrival, not charge time: variable latency
      // could discard an already-paid throw. Every approved selection plays.

      const event = throwableService.createThrowEvent(
        heroSeat,
        throwTargetSeat,
        throwable.id,
        requestId
      );

      if (event) {
        setThrowPlayback((prev) => appendThrow(prev, event, requestId));
        // 2026-08-20: impact audio moved INTO ThrowAnimation, which now plays a
        // launch whoosh at flight start and the item-specific SFX exactly on
        // landing (both sender and receivers). Playing the old generic thud
        // here fired at SEND time, before anything had hit.
        roomService.sendChat(
          tableId,
          userId,
          `[THROW:${throwable.id}:${throwTargetSeat}]`,
          event.id
        );
      }

      setShowThrowableSelector(false);
      setThrowTargetSeat(null);
    },
    [tableId, userId, heroSeat, throwTargetSeat]
  );

  /**
   * Render a throw sent by ANOTHER player. Wired from useTableChat, which
   * parses the `[THROW:id:seat]` broadcast. Without this the receiving client
   * dropped the message and showed nothing.
   */
  const receiveThrow = useCallback(
    (fromSeat: number, toSeat: number, throwableId: string, eventId?: string) => {
      const event = throwableService.createThrowEvent(fromSeat, toSeat, throwableId, eventId);
      if (!event) return;
      setThrowPlayback((prev) => appendThrow(prev, event, eventId));
      // Audio handled by ThrowAnimation (launch + per-item impact), see above.
    },
    []
  );

  const handleThrowComplete = useCallback((eventId: string) => {
    setThrowPlayback((prev) => {
      const events = prev.events.filter((event) => event.id !== eventId);
      // Duplicate/stale completion callbacks must not advance the queue.
      if (events.length === prev.events.length) return prev;
      const available = MAX_ACTIVE_THROWS - events.length;
      return {
        ...prev,
        events: [...events, ...prev.pending.slice(0, available)],
        pending: prev.pending.slice(available),
      };
    });
  }, []);

  /* `getSeatPositions` is GONE (2026-08-28). It was deprecated on 2026-08-15
     — it invented an 800x500 landscape ellipse corresponding to nothing on
     screen — and has had zero callers since throwables moved to the real
     seat geometry (`throwSeatPositions` in TablePage). Deleted per the
     Animation Law cleanup: dead geometry is a trap. */

  return {
    showThrowableSelector,
    setShowThrowableSelector,
    throwTargetSeat,
    setThrowTargetSeat,
    activeThrows,
    handleThrowableSelect,
    handleThrowComplete,
    receiveThrow,
    chipAnimations,
    setChipAnimations,
    showConfetti,
    setShowConfetti,
  };
}
