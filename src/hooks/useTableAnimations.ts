/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useTableAnimations — Chip Animations, Throwables, Confetti
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Extracted from TablePage.tsx.
 * Manages throwable selection/events, chip animation events, seat positions,
 * and confetti trigger state.
 */

import { useState, useCallback } from 'react';
import { throwableService, type Throwable, type ThrowEvent } from '../services/ThrowableService';
import { roomService } from '../services/RoomService';
import type { ChipAnimationEvent } from '../components/table/ChipAnimation';

export interface UseTableAnimationsReturn {
  // Throwables
  showThrowableSelector: boolean;
  setShowThrowableSelector: React.Dispatch<React.SetStateAction<boolean>>;
  throwTargetSeat: number | null;
  setThrowTargetSeat: React.Dispatch<React.SetStateAction<number | null>>;
  activeThrows: ThrowEvent[];
  handleThrowableSelect: (throwable: Throwable) => void;
  handleThrowComplete: (eventId: string) => void;
  getSeatPositions: (maxPlayers: number) => Map<number, { x: number; y: number }>;
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
  // Throwable state
  const [showThrowableSelector, setShowThrowableSelector] = useState(false);
  const [throwTargetSeat, setThrowTargetSeat] = useState<number | null>(null);
  const [activeThrows, setActiveThrows] = useState<ThrowEvent[]>([]);

  // Chip animation state
  const [chipAnimations, setChipAnimations] = useState<ChipAnimationEvent[]>([]);

  // Confetti state
  const [showConfetti, setShowConfetti] = useState(false);

  const handleThrowableSelect = useCallback(
    async (throwable: Throwable) => {
      if (!tableId || !userId || throwTargetSeat === null) return;

      const event = throwableService.createThrowEvent(heroSeat, throwTargetSeat, throwable.id);

      if (event) {
        setActiveThrows((prev) => [...prev, event]);
        roomService.sendChat(tableId, userId, `[THROW:${throwable.id}:${throwTargetSeat}]`);
      }

      setShowThrowableSelector(false);
      setThrowTargetSeat(null);
    },
    [tableId, userId, heroSeat, throwTargetSeat]
  );

  const handleThrowComplete = useCallback((eventId: string) => {
    setActiveThrows((prev) => prev.filter((e) => e.id !== eventId));
  }, []);

  const getSeatPositions = useCallback(
    (maxPlayers: number): Map<number, { x: number; y: number }> => {
      const positions = new Map<number, { x: number; y: number }>();
      const centerX = 400;
      const centerY = 250;
      const radiusX = 300;
      const radiusY = 150;

      // UI-AUDIT #2b: seats (and ThrowEvent.fromSeat/toSeat) are 1-indexed
      // seatNumbers. Previously this Map was keyed 0..maxPlayers-1, so every
      // seatPositions.get(seatNumber) was one seat off and the highest seat
      // (get(maxPlayers)) returned undefined → ThrowAnimation rendered null.
      // Key by the 1-indexed seatNumber, and rotate the ellipse so the hero is
      // at the bottom (matching the viewer-relative table layout).
      const heroIndex = heroSeat > 0 ? heroSeat - 1 : 0;
      for (let seat = 1; seat <= maxPlayers; seat++) {
        const i = seat - 1;
        // Rotate so the hero (heroIndex) lands at the bottom of the ellipse.
        const rel = (i - heroIndex + maxPlayers) % maxPlayers;
        const angle = ((rel * 360) / maxPlayers + 90) * (Math.PI / 180);
        positions.set(seat, {
          x: centerX + radiusX * Math.cos(angle),
          y: centerY + radiusY * Math.sin(angle),
        });
      }
      return positions;
    },
    [heroSeat]
  );

  return {
    showThrowableSelector,
    setShowThrowableSelector,
    throwTargetSeat,
    setThrowTargetSeat,
    activeThrows,
    handleThrowableSelect,
    handleThrowComplete,
    getSeatPositions,
    chipAnimations,
    setChipAnimations,
    showConfetti,
    setShowConfetti,
  };
}
