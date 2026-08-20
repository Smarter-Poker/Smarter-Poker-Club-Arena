/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DEALER BUTTON — Animated "D" chip on the table felt
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Renders the classic poker dealer button positioned near the dealer seat.
 * Smoothly animates between seat positions when the button moves.
 */

import React, { useEffect, useRef } from 'react';
import { dealerButtonPosition } from './tableGeometry';
import { soundService } from '../../services/SoundService';

export interface DealerButtonProps {
  /** Index of the dealer seat (visual index, 0-based) */
  dealerVisualIndex: number;
  /** Array of seat positions with x/y percentages */
  seatPositions: Array<{ x: number; y: number }>;
  /** Whether the button should be visible */
  isVisible: boolean;
  /**
   * REVIEW FIX 2026-08-19: multi-table gate (#175) — background tables must
   * not tock every hand. TablePage passes its ambientSoundsAllowed.
   */
  playSounds?: boolean;
}

/**
 * Dealer Button — White "D" chip positioned near the current dealer seat.
 * Uses CSS transitions for smooth movement between positions.
 */
export function DealerButton({
  dealerVisualIndex,
  seatPositions,
  isVisible,
  playSounds = true,
}: DealerButtonProps) {
  // COMPETITOR-PARITY 2026-08-19: one very soft felt 'tock' as the puck lands
  // on its new seat. Skipped on first mount — only actual moves speak. The
  // 600ms delay matches the CSS slide so the sound lands WITH the puck.
  const prevIndexRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isVisible || dealerVisualIndex < 0) return;
    const prev = prevIndexRef.current;
    prevIndexRef.current = dealerVisualIndex;
    if (prev == null || prev === dealerVisualIndex) return;
    if (!playSounds) return;
    const t = setTimeout(() => soundService.playDealerButtonMove(), 600);
    return () => clearTimeout(t);
  }, [dealerVisualIndex, isVisible, playSounds]);

  if (!isVisible || dealerVisualIndex < 0 || dealerVisualIndex >= seatPositions.length) {
    return null;
  }

  const pos = seatPositions[dealerVisualIndex];

  // Offset the button slightly toward the center of the table so it doesn't
  // overlap the player avatar. The factors live in tableGeometry so the bet
  // chips can position themselves relative to the button rather than guessing
  // at it — see betChipFactor().
  const { x: btnX, y: btnY } = dealerButtonPosition(pos);

  // Only position is inlined — every other visual property lives on the
  // `.dealer-button` CSS class so theme tokens, drop-in animation, and the
  // premium multi-layer shadows stay authoritative in one place.
  return (
    <div
      className="dealer-button"
      style={{
        left: `${btnX}%`,
        top: `${btnY}%`,
        transform: 'translate(-50%, -50%)',
        transition:
          'left 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94), top 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
      }}
    >
      D
    </div>
  );
}

export default DealerButton;
