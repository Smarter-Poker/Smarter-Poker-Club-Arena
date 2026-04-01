/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ChipPhysics — Realistic Chip Sprite Renderer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Renders micro chip towers with denomination colors and physics-like animations:
 *   - Stack height proportional to bet size
 *   - Bet-to-pot arc trajectory
 *   - Splash animation (chips scatter then settle)
 *   - Denomination color system (white → gold per tier)
 */

import React, { useMemo, useEffect, useState } from 'react';
import './ChipPhysics.css';

// ═══════════════════════════════════════════════════════════════════════════════
// DENOMINATION SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

interface ChipDenom {
  value: number;
  color: string;
  accent: string;
  label: string;
}

const DENOMINATIONS: ChipDenom[] = [
  { value: 1, color: '#F0F0F0', accent: '#c0c0c0', label: '1' },     // White = $1
  { value: 5, color: '#DC2626', accent: '#991b1b', label: '5' },      // Red = $5
  { value: 25, color: '#1E8C3A', accent: '#14622a', label: '25' },    // Green = $25
  { value: 100, color: '#1A1A1A', accent: '#444444', label: '100' },  // Black = $100
  { value: 500, color: '#8B00C9', accent: '#5c0085', label: '500' },  // Purple = $500
  { value: 1000, color: '#FF6B00', accent: '#cc5500', label: '1K' },  // Orange = $1000
];

function getChipBreakdown(amount: number): { denom: ChipDenom; count: number }[] {
  const breakdown: { denom: ChipDenom; count: number }[] = [];
  let remaining = Math.abs(amount);

  // Work from highest to lowest denomination
  for (let i = DENOMINATIONS.length - 1; i >= 0; i--) {
    const denom = DENOMINATIONS[i];
    const count = Math.floor(remaining / denom.value);
    if (count > 0) {
      // Cap visual chips at 5 per denomination for clarity
      breakdown.push({ denom, count: Math.min(count, 5) });
      remaining -= count * denom.value;
    }
  }

  // Ensure at least 1 chip displays
  if (breakdown.length === 0 && amount > 0) {
    breakdown.push({ denom: DENOMINATIONS[0], count: 1 });
  }

  return breakdown.slice(0, 3); // Max 3 denomination groups visible
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ChipPhysicsProps {
  amount: number;
  animate?: 'none' | 'splash' | 'slide-in' | 'collect';
  compact?: boolean;
  showAmount?: boolean;
  className?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function ChipPhysics({
  amount,
  animate = 'none',
  compact = false,
  showAmount = true,
  className = '',
}: ChipPhysicsProps) {
  const [isVisible, setIsVisible] = useState(animate === 'none');

  const breakdown = useMemo(() => getChipBreakdown(amount), [amount]);

  useEffect(() => {
    if (animate !== 'none') {
      const timer = setTimeout(() => setIsVisible(true), 50);
      return () => clearTimeout(timer);
    }
  }, [animate]);

  if (amount <= 0) return null;

  return (
    <div
      className={`chip-physics ${compact ? 'cp--compact' : ''} ${isVisible ? 'cp--visible' : ''} cp--${animate} ${className}`}
    >
      {/* Chip stacks */}
      <div className="cp-stacks">
        {breakdown.map(({ denom, count }, groupIdx) => (
          <div
            key={denom.value}
            className="cp-stack"
            style={{ '--group-idx': groupIdx } as React.CSSProperties}
          >
            {Array.from({ length: count }, (_, chipIdx) => (
              <div
                key={chipIdx}
                className="cp-chip"
                style={
                  {
                    '--chip-color': denom.color,
                    '--chip-accent': denom.accent,
                    '--chip-idx': chipIdx,
                    '--total-chips': count,
                  } as React.CSSProperties
                }
              >
                <div className="cp-chip__face">
                  <span className="cp-chip__label">{denom.label}</span>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Amount display */}
      {showAmount && <span className="cp-amount">{formatChipAmount(amount)}</span>}
    </div>
  );
}

function formatChipAmount(amount: number): string {
  if (amount >= 1000000) return `${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 10000) return `${(amount / 1000).toFixed(1)}K`;
  return amount.toLocaleString();
}

export default ChipPhysics;
