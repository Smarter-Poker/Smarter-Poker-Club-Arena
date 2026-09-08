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
  const [activeThrows, setActiveThrows] = useState<ThrowEvent[]>([]);

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
        setActiveThrows((prev) => [...prev, event]);
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
      setActiveThrows((prev) => (prev.length >= 12 ? prev : [...prev, event]));
      // Audio handled by ThrowAnimation (launch + per-item impact), see above.
    },
    []
  );

  const handleThrowComplete = useCallback((eventId: string) => {
    setActiveThrows((prev) => prev.filter((e) => e.id !== eventId));
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
