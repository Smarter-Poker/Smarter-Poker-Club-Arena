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
import { soundService } from '../../services/SoundService';
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

// Real poker chip denomination colors — matches casino standard
// Descending order so breakdown algorithm picks highest denominations first
const CHIP_COLORS = [
  { threshold: 100000, color: '#f97316', label: '100K' }, // Orange
  { threshold: 25000, color: '#14b8a6', label: '25K' }, // Teal
  { threshold: 5000, color: '#ec4899', label: '5K' }, // Pink
  { threshold: 1000, color: '#eab308', label: '1K' }, // Yellow
  { threshold: 500, color: '#a855f7', label: '500' }, // Purple
  { threshold: 100, color: '#1a1a2e', label: '100' }, // Black
  { threshold: 25, color: '#22c55e', label: '25' }, // Green
  { threshold: 5, color: '#ef4444', label: '5' }, // Red
  { threshold: 1, color: '#e0e0e0', label: '1' }, // White
];

/**
 * Calculate chip breakdown for a pot amount.
 *
 * Rules:
 *  1. Break amount into exact denominations (largest first)
 *  2. Max 10 chips TOTAL displayed — when over, remove smallest denomination
 *     chips first until total <= 10
 *  3. Visual accuracy: 487 = 4 black + 3 green + 2 red + 2 white = 11 → trim 1 white = 10
 */
const MAX_TOTAL_CHIPS = 10;

function getChipBreakdown(amount: number): { color: string; count: number; label: string }[] {
  if (amount <= 0) return [];

  // Step 1: exact breakdown into denominations
  const chips: { color: string; count: number; label: string }[] = [];
  let remaining = Math.round(amount);

  for (const chip of CHIP_COLORS) {
    if (remaining >= chip.threshold) {
      const count = Math.floor(remaining / chip.threshold);
      chips.push({ color: chip.color, count, label: chip.label });
      remaining -= count * chip.threshold;
    }
  }

  // Step 2: count total chips
  let totalChips = chips.reduce((sum, c) => sum + c.count, 0);

  // Step 3: trim from smallest denominations (end of array) until at limit
  while (totalChips > MAX_TOTAL_CHIPS && chips.length > 0) {
    const smallest = chips[chips.length - 1];
    const excess = totalChips - MAX_TOTAL_CHIPS;
    if (smallest.count <= excess) {
      // Remove entire denomination
      totalChips -= smallest.count;
      chips.pop();
    } else {
      // Trim partial
      smallest.count -= excess;
      totalChips = MAX_TOTAL_CHIPS;
    }
  }

  return chips;
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
  // Show up to 8 physical chips per stack — the visual ceiling for readability
  const visibleCount = Math.min(count, 8);
  // Stack height per chip — tighter stacking for that satisfying pile look
  const chipGap = 2;
  return (
    <div
      className="pot-display__chip-stack"
      style={{
        transform: `translateX(${offsetX}px)`,
        height: `${18 + visibleCount * chipGap + 10}px`,
      }}
    >
      {Array.from({ length: visibleCount }).map((_, i) => (
        <div
          key={i}
          className="pot-display__chip"
          style={
            {
              '--chip-color': color,
              '--chip-offset': `${-i * chipGap}px`,
              '--chip-spin': `${(Math.random() - 0.5) * 8}`,
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

  // Multi-chip splash whenever a NEW side pot appears (all-in split moment)
  const prevSidePotCountRef = useRef(sidePots.length);
  useEffect(() => {
    if (sidePots.length > prevSidePotCountRef.current) {
      soundService.playChipSplash();
    }
    prevSidePotCountRef.current = sidePots.length;
  }, [sidePots.length]);

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
    <div
      className={`pot-display${isPotUpdated ? ' pot-display--updated' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={`Pot: ${formatAmount(mainPot, currency)}${sidePots && sidePots.length > 0 ? ` plus ${sidePots.length} side pot${sidePots.length > 1 ? 's' : ''}` : ''}`}
    >
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
