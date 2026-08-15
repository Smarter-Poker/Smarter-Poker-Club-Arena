/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useTableAnimations — Chip Animations, Throwables, Confetti
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Extracted from TablePage.tsx.
 * Manages throwable selection/events, chip animation events, seat positions,
 * and confetti trigger state.
 */

import { useState, useCallback, useRef } from 'react';
import { throwableService, type Throwable, type ThrowEvent } from '../services/ThrowableService';
import { roomService } from '../services/RoomService';
import { soundService } from '../services/SoundService';
import type { ChipAnimationEvent } from '../components/table/ChipAnimation';

/** Minimum gap between outgoing throws (ms) — prevents spam + diamond drain. */
const THROW_RATE_LIMIT_MS = 1500;

export interface UseTableAnimationsReturn {
  // Throwables
  showThrowableSelector: boolean;
  setShowThrowableSelector: React.Dispatch<React.SetStateAction<boolean>>;
  throwTargetSeat: number | null;
  setThrowTargetSeat: React.Dispatch<React.SetStateAction<number | null>>;
  activeThrows: ThrowEvent[];
  handleThrowableSelect: (throwable: Throwable) => void;
  handleThrowComplete: (eventId: string) => void;
  receiveThrow: (fromSeat: number, toSeat: number, throwableId: string) => void;
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
  const lastThrowAtRef = useRef(0);
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

      // Rate limit: this path bypassed the chat limiter entirely, so a held
      // tap could emit unbounded broadcasts (and diamond charges).
      const now = Date.now();
      if (now - lastThrowAtRef.current < THROW_RATE_LIMIT_MS) return;
      lastThrowAtRef.current = now;

      const event = throwableService.createThrowEvent(heroSeat, throwTargetSeat, throwable.id);

      if (event) {
        setActiveThrows((prev) => [...prev, event]);
        try {
          soundService.playThrowableImpact();
        } catch {
          /* audio is best-effort */
        }
        roomService.sendChat(tableId, userId, `[THROW:${throwable.id}:${throwTargetSeat}]`);
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
  const receiveThrow = useCallback((fromSeat: number, toSeat: number, throwableId: string) => {
    const event = throwableService.createThrowEvent(fromSeat, toSeat, throwableId);
    if (!event) return;
    setActiveThrows((prev) => (prev.length >= 12 ? prev : [...prev, event]));
    try {
      soundService.playThrowableImpact();
    } catch {
      /* audio is best-effort */
    }
  }, []);

  const handleThrowComplete = useCallback((eventId: string) => {
    setActiveThrows((prev) => prev.filter((e) => e.id !== eventId));
  }, []);

  /**
   * @deprecated Dan 2026-08-15 (item 4) — NOT the real table geometry.
   *
   * This invents an 800x500 LANDSCAPE ellipse (centre 400,250 / radii
   * 300,150) that corresponds to nothing on screen. The real table is a
   * 341:609 PORTRAIT box, so throws positioned by this launched and landed at
   * arbitrary points and never hit the villain's avatar.
   *
   * Throwables now use `throwSeatPositions` in TablePage, derived from the
   * same hero-rotated percentage map the seats themselves render from and
   * scaled to .table-scaler. This has zero callers as of this commit and is
   * retained only so the hook's public shape does not change mid-session;
   * delete it outright in the next cleanup pass.
   */
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
    receiveThrow,
    getSeatPositions,
    chipAnimations,
    setChipAnimations,
    showConfetti,
    setShowConfetti,
  };
}
