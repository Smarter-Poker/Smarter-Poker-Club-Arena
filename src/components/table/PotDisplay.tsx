/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  POT DISPLAY — Main Pot & Side Pots Visualization
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Displays the current pot amount(s) at the center of the poker table with:
 * - Animated main pot with chip visuals
 * - Side pot breakdown for all-in scenarios
 * - Chip stack animations on pot updates
 */

import React, { useMemo, memo, useState, useEffect, useRef } from 'react';
import { AnimatedNumber } from '../common/AnimatedNumber';
import './PotDisplay.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface SidePot {
  id: string;
  amount: number;
  eligiblePlayers: string[];
}

export type PotDisplayMode = 'chips' | 'bb';

export interface PotDisplayProps {
  mainPot: number;
  sidePots?: SidePot[];
  showChipAnimation?: boolean;
  currency?: string;
  bigBlind?: number;
  displayMode?: PotDisplayMode;
  onToggleDisplayMode?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

// Always show whole numbers for amounts >= 1. Sub-dollar amounts show 2 decimals.
function formatAmount(amount: number, currency: string = ''): string {
  if (amount >= 1) return Math.round(amount).toLocaleString('en-US');
  if (amount > 0) return amount.toFixed(2);
  return '0';
}

// Format amount in Big Blinds
function formatBB(amount: number, bigBlind: number): string {
  if (bigBlind <= 0) return formatAmount(amount);
  const bbs = amount / bigBlind;
  // Show 1 decimal for fractional BBs, whole number for clean amounts
  if (bbs === Math.floor(bbs)) {
    return `${bbs} BB`;
  }
  return `${bbs.toFixed(1)} BB`;
}

// Standard poker chip denomination colors
const CHIP_COLORS = [
  { threshold: 5000, color: '#a855f7', label: '5K' }, // Purple
  { threshold: 1000, color: '#f97316', label: '1K' }, // Orange
  { threshold: 500, color: '#7c3aed', label: '500' }, // Violet
  { threshold: 100, color: '#1a1a2e', label: '100' }, // Black
  { threshold: 25, color: '#22c55e', label: '25' }, // Green
  { threshold: 5, color: '#ef4444', label: '5' }, // Red
  { threshold: 1, color: '#e0e0e0', label: '1' }, // White
];

function getChipBreakdown(amount: number): { color: string; count: number; label: string }[] {
  const chips: { color: string; count: number; label: string }[] = [];
  let remaining = amount;

  for (const chip of CHIP_COLORS) {
    if (remaining >= chip.threshold) {
      const count = Math.min(Math.floor(remaining / chip.threshold), 8); // Max 8 chips per denom
      chips.push({ color: chip.color, count, label: chip.label });
      remaining -= count * chip.threshold;
    }
  }

  return chips.slice(0, 3); // Max 3 denomination stacks visible
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface ChipStackProps {
  color: string;
  count: number;
  offsetX: number;
}

function ChipStack({ color, count, offsetX }: ChipStackProps) {
  return (
    <div className="pot-display__chip-stack" style={{ transform: `translateX(${offsetX}px)` }}>
      {Array.from({ length: Math.min(count, 5) }).map((_, i) => (
        <div
          key={i}
          className="pot-display__chip"
          style={
            {
              '--chip-color': color,
              transform: `translateY(${-i * 2}px)`,
              zIndex: count - i,
              animationDelay: `${i * 50}ms`,
            } as React.CSSProperties
          }
        >
          <div className="pot-display__chip-face" />
        </div>
      ))}
    </div>
  );
}

interface SidePotBadgeProps {
  pot: SidePot;
  index: number;
}

function SidePotBadge({
  pot,
  index,
  displayMode = 'chips',
  bigBlind = 0,
}: SidePotBadgeProps & { displayMode?: PotDisplayMode; bigBlind?: number }) {
  return (
    <div className="pot-display__side-pot" style={{ animationDelay: `${index * 100}ms` }}>
      <span className="pot-display__side-pot-label">Side Pot {index + 1}</span>
      <span className="pot-display__side-pot-amount">
        {displayMode === 'bb' && bigBlind > 0
          ? formatBB(pot.amount, bigBlind)
          : formatAmount(pot.amount)}
      </span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function PotDisplayComponent({
  mainPot,
  sidePots = [],
  showChipAnimation = true,
  currency = '',
  bigBlind = 0,
  displayMode = 'chips',
  onToggleDisplayMode,
}: PotDisplayProps) {
  // Pot update pulse animation — triggers CSS class briefly on change
  const [isPotUpdated, setIsPotUpdated] = useState(false);
  const prevPotRef = useRef(mainPot);
  useEffect(() => {
    if (mainPot !== prevPotRef.current && mainPot > prevPotRef.current) {
      setIsPotUpdated(true);
      const timer = setTimeout(() => setIsPotUpdated(false), 500);
      prevPotRef.current = mainPot;
      return () => clearTimeout(timer);
    }
    prevPotRef.current = mainPot;
  }, [mainPot]);

  // Calculate chip visualization
  const chipBreakdown = useMemo(() => getChipBreakdown(mainPot), [mainPot]);

  // Total pot calculation
  const totalPot = useMemo(() => {
    return mainPot + sidePots.reduce((sum, p) => sum + p.amount, 0);
  }, [mainPot, sidePots]);

  if (mainPot === 0 && sidePots.length === 0) {
    return null;
  }

  return (
    <div className={`pot-display${isPotUpdated ? ' pot-display--updated' : ''}`}>
      {/* Chip Stacks Visualization */}
      {showChipAnimation && mainPot > 0 && (
        <div className="pot-display__chips">
          {chipBreakdown.map((chip, i) => (
            <ChipStack
              key={i}
              color={chip.color}
              count={chip.count}
              offsetX={i * 8 - chipBreakdown.length * 4}
            />
          ))}
        </div>
      )}

      {/* Main Pot Amount — click to toggle chips/BB display */}
      <div
        className={`pot-display__main ${onToggleDisplayMode ? 'pot-display__main--clickable' : ''}`}
        onClick={onToggleDisplayMode}
        title={onToggleDisplayMode ? 'Click to toggle Chips/BB display' : undefined}
      >
        <span className="pot-display__label">POT</span>
        <span className="pot-display__amount">
          {displayMode === 'bb' && bigBlind > 0 ? (
            <AnimatedNumber value={mainPot} duration={350} format={(n) => formatBB(n, bigBlind)} />
          ) : (
            <AnimatedNumber
              value={mainPot}
              duration={350}
              format={(n) => formatAmount(n, currency)}
            />
          )}
        </span>
      </div>

      {/* Side Pots */}
      {sidePots.length > 0 && (
        <div className="pot-display__side-pots">
          {sidePots.map((pot, i) => (
            <SidePotBadge
              key={pot.id}
              pot={pot}
              index={i}
              displayMode={displayMode}
              bigBlind={bigBlind}
            />
          ))}
        </div>
      )}

      {/* Total (if side pots exist) */}
      {sidePots.length > 0 && (
        <div className="pot-display__total">
          <span className="pot-display__total-label">TOTAL</span>
          <span className="pot-display__total-amount">
            {displayMode === 'bb' && bigBlind > 0 ? (
              <AnimatedNumber
                value={totalPot}
                duration={350}
                format={(n) => formatBB(n, bigBlind)}
              />
            ) : (
              <AnimatedNumber
                value={totalPot}
                duration={350}
                format={(n) => formatAmount(n, currency)}
              />
            )}
          </span>
        </div>
      )}
    </div>
  );
}

export const PotDisplay = memo(PotDisplayComponent, (prev, next) => {
  // Return true if props are equal (skip re-render)
  if (prev.mainPot !== next.mainPot) return false;
  if (prev.showChipAnimation !== next.showChipAnimation) return false;
  if (prev.currency !== next.currency) return false;
  if (prev.bigBlind !== next.bigBlind) return false;
  if (prev.displayMode !== next.displayMode) return false;
  if (JSON.stringify(prev.sidePots) !== JSON.stringify(next.sidePots)) return false;
  if (prev.onToggleDisplayMode !== next.onToggleDisplayMode) return false;
  return true;
});

export default PotDisplay;
