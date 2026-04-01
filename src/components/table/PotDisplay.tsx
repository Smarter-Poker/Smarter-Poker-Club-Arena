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

import React, { useMemo, useEffect, useState, memo } from 'react';
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
  previousPot?: number;
  showChipAnimation?: boolean;
  currency?: string;
  bigBlind?: number;
  displayMode?: PotDisplayMode;
  onToggleDisplayMode?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

// EXACT precision — no abbreviations, no rounding
function formatAmount(amount: number, currency: string = ''): string {
  return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

// Chip denomination colors
const CHIP_COLORS = [
  { threshold: 10000, color: '#8B4513', label: '10K' }, // Brown
  { threshold: 5000, color: '#1E90FF', label: '5K' }, // Blue
  { threshold: 1000, color: '#1C1C1C', label: '1K' }, // Black
  { threshold: 500, color: '#800080', label: '500' }, // Purple
  { threshold: 100, color: '#228B22', label: '100' }, // Green
  { threshold: 25, color: '#DC143C', label: '25' }, // Red
  { threshold: 5, color: '#4169E1', label: '5' }, // Blue
  { threshold: 1, color: '#F5F5F5', label: '1' }, // White
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

  return chips.slice(0, 4); // Max 4 denomination stacks visible
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
      {Array.from({ length: Math.min(count, 8) }).map((_, i) => (
        <div
          key={i}
          className="pot-display__chip"
          style={{
            backgroundColor: color,
            transform: `translateY(${-i * 3}px)`,
            zIndex: count - i,
            animationDelay: `${i * 50}ms`,
          }}
        >
          <div className="pot-display__chip-inner" />
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
  previousPot = 0,
  showChipAnimation = true,
  currency = '',
  bigBlind = 0,
  displayMode = 'chips',
  onToggleDisplayMode,
}: PotDisplayProps) {
  const [displayPot, setDisplayPot] = useState(mainPot);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isPotBump, setIsPotBump] = useState(false);
  const prevPotRef = React.useRef(mainPot);

  // Animated number counting — when mainPot changes, count up from old value to new value over 400ms
  useEffect(() => {
    setIsAnimating(true);

    // Animate number counting up from current display value
    const startValue = displayPot;
    const diff = mainPot - startValue;
    if (diff === 0) {
      setIsAnimating(false);
      return;
    }

    const startTime = Date.now();
    const duration = 400;

    const animate = () => {
      const elapsed = Date.now() - startTime;
      if (elapsed >= duration) {
        setDisplayPot(mainPot);
        setIsAnimating(false);
      } else {
        const progress = elapsed / duration;
        const currentValue = startValue + diff * progress;
        setDisplayPot(Math.trunc(currentValue * 100) / 100);
        requestAnimationFrame(animate);
      }
    };

    const frameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainPot]);

  // Pot bump animation — when pot increases by >2x previous
  useEffect(() => {
    if (mainPot > prevPotRef.current * 2 && prevPotRef.current > 0) {
      setIsPotBump(true);
      const timer = setTimeout(() => setIsPotBump(false), 500);
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
    <div className={`pot-display ${isPotBump ? 'pot-display--bump' : ''}`}>
      {/* Chip Stacks Visualization */}
      {showChipAnimation && mainPot > 0 && (
        <div className="pot-display__chips">
          {chipBreakdown.map((chip, i) => (
            <ChipStack
              key={i}
              color={chip.color}
              count={chip.count}
              offsetX={i * 22 - chipBreakdown.length * 11}
            />
          ))}
        </div>
      )}

      {/* Main Pot Amount — click to toggle chips/BB display */}
      <div
        className={`pot-display__main ${isAnimating ? 'pot-display__main--animating' : ''} ${onToggleDisplayMode ? 'pot-display__main--clickable' : ''} ${isPotBump ? 'pot-display__main--pulse' : ''}`}
        onClick={onToggleDisplayMode}
        title={onToggleDisplayMode ? 'Click to toggle Chips/BB display' : undefined}
      >
        <span className="pot-display__label">POT</span>
        <span className="pot-display__amount">
          {displayMode === 'bb' && bigBlind > 0
            ? formatBB(displayPot, bigBlind)
            : formatAmount(displayPot, currency)}
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
            {displayMode === 'bb' && bigBlind > 0
              ? formatBB(totalPot, bigBlind)
              : formatAmount(totalPot, currency)}
          </span>
        </div>
      )}

      {/* Pot Increase Indicator */}
      {isAnimating && mainPot > previousPot && (
        <div className="pot-display__increase">
          +
          {displayMode === 'bb' && bigBlind > 0
            ? formatBB(mainPot - previousPot, bigBlind)
            : formatAmount(mainPot - previousPot, currency)}
        </div>
      )}
    </div>
  );
}

export const PotDisplay = memo(PotDisplayComponent, (prev, next) => {
  // Return true if props are equal (skip re-render)
  if (prev.mainPot !== next.mainPot) return false;
  if (prev.previousPot !== next.previousPot) return false;
  if (prev.showChipAnimation !== next.showChipAnimation) return false;
  if (prev.currency !== next.currency) return false;
  if (prev.bigBlind !== next.bigBlind) return false;
  if (prev.displayMode !== next.displayMode) return false;
  if (JSON.stringify(prev.sidePots) !== JSON.stringify(next.sidePots)) return false;
  if (prev.onToggleDisplayMode !== next.onToggleDisplayMode) return false;
  return true;
});

export default PotDisplay;
