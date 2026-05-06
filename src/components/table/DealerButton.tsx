/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DEALER BUTTON — Animated "D" chip on the table felt
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Renders the classic poker dealer button positioned near the dealer seat.
 * Smoothly animates between seat positions when the button moves.
 */

import React from 'react';

export interface DealerButtonProps {
  /** Index of the dealer seat (visual index, 0-based) */
  dealerVisualIndex: number;
  /** Array of seat positions with x/y percentages */
  seatPositions: Array<{ x: number; y: number }>;
  /** Whether the button should be visible */
  isVisible: boolean;
}

/**
 * Dealer Button — White "D" chip positioned near the current dealer seat.
 * Uses CSS transitions for smooth movement between positions.
 */
export function DealerButton({ dealerVisualIndex, seatPositions, isVisible }: DealerButtonProps) {
  if (!isVisible || dealerVisualIndex < 0 || dealerVisualIndex >= seatPositions.length) {
    return null;
  }

  const pos = seatPositions[dealerVisualIndex];

  // Offset the button slightly toward the center of the table
  // so it doesn't overlap the player avatar
  const centerX = 50;
  const centerY = 50;
  // Larger offset to prevent overlapping player avatars
  const offsetFactor = 0.28;
  const btnX = pos.x + (centerX - pos.x) * offsetFactor;
  const btnY = pos.y + (centerY - pos.y) * offsetFactor;

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
