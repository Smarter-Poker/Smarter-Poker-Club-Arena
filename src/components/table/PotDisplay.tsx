/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  POT DISPLAY — Main Pot & Side Pots Visualization
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-20 (PokerBros-parity redesign):
 *  - The pot is a THIN PILL: "POT" label + collected total, top row.
 *  - While a street is being bet, a second thin pill appears BELOW it with a
 *    small chip icon and the street's accumulating total. When the street
 *    completes the seat chips sweep to the middle (ChipPhysics cpCollect,
 *    driven by TablePage), the lower pill's amount folds into the top pill
 *    and the lower pill disappears.
 *  - The old casino chip-pile visualization next to the pot is GONE — it is
 *    what kept leaving stray red chips painted in the middle of the felt.
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
  /**
   * Dan 2026-08-20: total of the CURRENT street's live bets (still sitting in
   * front of the players). The engine's pot figure includes these the moment
   * they are wagered, so the top pill shows (mainPot - streetBets) — chips
   * only count as "in the pot" once they physically sweep to the middle.
   */
  streetBets?: number;
  /**
   * Dan 2026-08-19, bug list item 6: "pot-push animation to the winner after
   * every hand showing chip amounts, not auto-advancing."
   *
   * When set, the pot slides toward the winner's seat and fades, carrying its
   * amount with it, instead of the number simply vanishing when the hand ends.
   * The offset is in pixels from the pot's own centre toward that seat.
   */
  collectTo?: { dx: number; dy: number } | null;
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

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

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

/** Tiny decorative chip stack for the street-bets pill (pure CSS circles). */
function MiniChipIcon() {
  return (
    <span className="pot-display__mini-chips" aria-hidden="true">
      <span className="pot-display__mini-chip pot-display__mini-chip--b" />
      <span className="pot-display__mini-chip pot-display__mini-chip--m" />
      <span className="pot-display__mini-chip pot-display__mini-chip--t" />
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function PotDisplayComponent({
  mainPot,
  sidePots = [],
  currency = '',
  bigBlind = 0,
  displayMode = 'chips',
  onToggleDisplayMode,
  streetBets = 0,
  collectTo = null,
}: PotDisplayProps) {
  // Chips only belong to the pot once swept to the middle: the top pill shows
  // the collected portion, the lower pill shows what's still in front of seats.
  const collectedPot = Math.max(0, mainPot - Math.max(0, streetBets));

  // Pot update pulse animation — triggers CSS class briefly on change
  const [isPotUpdated, setIsPotUpdated] = useState(false);
  const prevPotRef = useRef(collectedPot);
  useEffect(() => {
    if (collectedPot > prevPotRef.current) {
      setIsPotUpdated(true);
      const timer = setTimeout(() => setIsPotUpdated(false), 500);
      prevPotRef.current = collectedPot;
      return () => clearTimeout(timer);
    }
    prevPotRef.current = collectedPot;
  }, [collectedPot]);

  // Multi-chip splash whenever a NEW side pot appears (all-in split moment)
  const prevSidePotCountRef = useRef(sidePots.length);
  useEffect(() => {
    if (sidePots.length > prevSidePotCountRef.current) {
      soundService.playChipSplash();
    }
    prevSidePotCountRef.current = sidePots.length;
  }, [sidePots.length]);

  // ANIMATION AUDIT 2026-08-19: during the pot-push (collectTo set) a
  // snapshot may already have zeroed the pot. Show the last real amount for
  // the slide so the pot travels to the winner still reading its value.
  const lastNonZeroPotRef = useRef(collectedPot);
  const displayPot = collectedPot > 0 ? collectedPot : collectTo ? lastNonZeroPotRef.current : 0;
  useEffect(() => {
    if (collectedPot > 0) lastNonZeroPotRef.current = collectedPot;
  }, [collectedPot]);

  // Total pot calculation
  const totalPot = useMemo(() => {
    return mainPot + sidePots.reduce((sum, p) => sum + p.amount, 0);
  }, [mainPot, sidePots]);

  const fmt = (n: number) =>
    displayMode === 'bb' && bigBlind > 0 ? formatBB(n, bigBlind) : formatAmount(n, currency);

  // Nothing at all to show: no pot, no live bets, no side pots, no push.
  if (mainPot === 0 && streetBets === 0 && sidePots.length === 0 && !collectTo) {
    return null;
  }

  return (
    <div
      className={`pot-display${isPotUpdated ? ' pot-display--updated' : ''}${
        collectTo ? ' pot-display--collect' : ''
      }`}
      style={
        collectTo
          ? ({
              '--collect-dx': `${collectTo.dx}px`,
              '--collect-dy': `${collectTo.dy}px`,
            } as React.CSSProperties)
          : undefined
      }
      role="status"
      aria-live="polite"
      aria-label={`Pot: ${formatAmount(displayPot, currency)}${streetBets > 0 ? `, ${formatAmount(streetBets, currency)} in front of players` : ''}${sidePots && sidePots.length > 0 ? ` plus ${sidePots.length} side pot${sidePots.length > 1 ? 's' : ''}` : ''}`}
    >
      {/* Main Pot pill — click to toggle chips/BB display */}
      <div
        className={`pot-display__main ${onToggleDisplayMode ? 'pot-display__main--clickable' : ''}`}
        onClick={onToggleDisplayMode}
        title={onToggleDisplayMode ? 'Click to toggle Chips/BB display' : undefined}
      >
        <span className="pot-display__label">POT</span>
        <span className="pot-display__amount">
          <AnimatedNumber value={displayPot} duration={350} format={fmt} />
        </span>
      </div>

      {/* Current street's bets — thin pill below the pot; folds into the pot
          total when the street completes and the chips sweep in. */}
      {streetBets > 0 && (
        <div className="pot-display__street" aria-hidden="true">
          <MiniChipIcon />
          <span className="pot-display__street-amount">
            <AnimatedNumber value={streetBets} duration={250} format={fmt} />
          </span>
        </div>
      )}

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
            <AnimatedNumber value={totalPot} duration={350} format={fmt} />
          </span>
        </div>
      )}
    </div>
  );
}

export const PotDisplay = memo(PotDisplayComponent, (prev, next) => {
  // Return true if props are equal (skip re-render)
  if (prev.mainPot !== next.mainPot) return false;
  if (prev.streetBets !== next.streetBets) return false;
  if (prev.currency !== next.currency) return false;
  if (prev.bigBlind !== next.bigBlind) return false;
  if (prev.displayMode !== next.displayMode) return false;
  if (JSON.stringify(prev.sidePots) !== JSON.stringify(next.sidePots)) return false;
  if (prev.onToggleDisplayMode !== next.onToggleDisplayMode) return false;
  // ANIMATION AUDIT 2026-08-19: collectTo was MISSING here — a collectTo
  // change alone reported "props equal", so the pot-push-to-winner slide
  // could silently never render. It only worked when the pot amount happened
  // to change in the same commit.
  if (prev.collectTo?.dx !== next.collectTo?.dx || prev.collectTo?.dy !== next.collectTo?.dy)
    return false;
  return true;
});

export default PotDisplay;
