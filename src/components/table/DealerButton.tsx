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
  const offsetFactor = 0.15;
  const btnX = pos.x + (centerX - pos.x) * offsetFactor;
  const btnY = pos.y + (centerY - pos.y) * offsetFactor;

  return (
    <div
      className="dealer-button"
      style={{
        position: 'absolute',
        left: `${btnX}%`,
        top: `${btnY}%`,
        transform: 'translate(-50%, -50%)',
        width: '28px',
        height: '28px',
        borderRadius: '50%',
        background: 'var(--dealer-btn-bg, linear-gradient(145deg, #ffffff, #e0e0e0))',
        border: '2px solid rgba(255,255,255,0.2)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 800,
        fontSize: '13px',
        color: 'var(--dealer-btn-color, #1a1a2e)',
        zIndex: 20,
        transition: 'left 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94), top 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
        boxShadow: '0 2px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.8)',
        userSelect: 'none',
        pointerEvents: 'none',
      }}
    >
      D
    </div>
  );
}

export default DealerButton;
