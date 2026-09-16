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
 *
 * Dan 2026-08-23 (chips and pots): "THE POT SHOULD SHOW THE AMOUNT OF CHIPS
 * NECESSARY TO EQUAL THE TOTAL CHIPS IN THE POT, AND THATS HOW IT SHOULD LOOK
 * WHEN ITS CALCULATED... ALWAYS COLORING UP TO USE THE FEWEST AMOUNT OF CHIPS
 * IN THE POT."
 *
 * So a chip pile is back — but NOT the one removed on 2026-08-20, and it
 * cannot fail the same way. The old pile was table/ChipStack's own `PotDisplay`
 * export: a separately-positioned block that drew a fixed red chip whatever
 * the pot held, and when it and the flying-chip layer disagreed about who
 * owned the middle of the felt, its chips were the ones left painted there.
 * This pile is a child of `.pot-display` itself, so it mounts, moves and
 * unmounts with the pot pill and cannot outlive it; it is derived purely from
 * `displayPot`, so no animation owns its lifetime; and it is pointer-events
 * none like the rest of the pot.
 *
 * It is also absolutely positioned ABOVE the pill instead of sitting in the
 * column flow, so `.pot-display__main` does not move by a pixel. That is load
 * bearing: tests/e2e/pot-above-chips.spec.ts pins the pill's box against a
 * checked-in pre-fix stylesheet at four viewport widths.
 */

import React, { useMemo, memo, useState, useEffect, useRef } from 'react';
import { AnimatedNumber } from '../common/AnimatedNumber';
import { soundService } from '../../services/SoundService';
import { visualChipStacks, type ChipDenomination } from '../../lib/chipDenominations';
import { formatTableChips } from '../../utils/format';
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
   * The hand this pot belongs to. Used ONLY to expire the carried-over amount
   * below - see lastNonZeroPotRef. Without it the component has no idea a hand
   * ended, because it stays mounted for the life of the table.
   */
  handNumber?: number;
  /**
   * Dan 2026-08-19, bug list item 6: "pot-push animation to the winner after
   * every hand showing chip amounts, not auto-advancing."
   *
   * When set, the pot slides toward the winner's seat and fades, carrying its
   * amount with it, instead of the number simply vanishing when the hand ends.
   * The offset is in pixels from the pot's own centre toward that seat.
   */
  collectTo?: { dx: number; dy: number } | null;
  /**
   * What the engine says was won, from POT_WIN. Used ONLY as the last resort
   * for the push label on a hand where the running total was never non-zero
   * — a fold-around, where the blinds sit in front of the seats all hand and
   * `mainPot === streetBets` throughout. Without it that push showed 0.
   */
  awardedPot?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ═══ THE POT IS THE TRUE NUMBER (Dan 2026-09-04) ═══════════════════════════
 *
 * "FOR ALL SMALL STAKES GAMES .50/1 AND LESS THE POT SHOULD SHOW TRUE
 * AMOUNTS... NOT ROUNDED UP. POT SHOULD SHOW 3.50 OR 6.80 OR WHAT EVER THE
 * TRUE NUMBER IS IN THE SMALLER GAMES."
 *
 * This used to be `Math.round(amount)` for anything from 1 up, so a 0.10/0.25
 * table with 5.10 of bomb antes in the middle read "POT 5", and a 1.50 pot of
 * blinds and antes read "POT 2" - a number that was simply not the pot. The
 * ladder of chips under the pill was exact (chipDenominations.ts), so the
 * discs and the digits disagreed on every micro-stakes hand.
 *
 * At SMALL STAKES (big blind at or under SMALL_STAKES_BB_MAX) the pot reads to
 * the penny with two places, always - 3.50, not 3.5, so a 3.50 and a 3.57 pot
 * are the same width and the pill does not jitter as the count-up animation
 * runs through 3.4, 3.47, 3.5. Above that, formatTableChips' own contract
 * applies: integers clean (a 1,250 tournament pot is "1,250"), and a real
 * fraction is kept when one exists (a 7.5 pot at 1/2 is "7.5"), never
 * rounded away. A caller with no big blind to hand (bigBlind = 0) gets the
 * same formatTableChips contract, which is also never a rounded magnitude.
 */
export const SMALL_STAKES_BB_MAX = 1;

function formatAmount(amount: number, bigBlind: number = 0): string {
  if (!(amount > 0)) return '0';
  if (bigBlind > 0 && bigBlind <= SMALL_STAKES_BB_MAX) {
    return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return formatTableChips(amount);
}

// Format amount in Big Blinds
function formatBB(amount: number, bigBlind: number): string {
  if (bigBlind <= 0) return formatAmount(amount, bigBlind);
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
          : formatAmount(pot.amount, bigBlind)}
      </span>
    </div>
  );
}

/**
 * A settled 0..1 for one disc, from its denomination and its ordinal within
 * that denomination.
 *
 * Dan 2026-09-14: chips in the pot "SHOULDN'T ALWAYS APPEAR IN NUMBER ORDER
 * HIGH TO LOW OR LOW TO HIGH... THEY SHOULD APPEAR 'IN A POT' MIXED TOGETHER."
 *
 * Keyed on (denomination, ordinal) rather than on a position in the finished
 * pile, which is the whole point: the third red 5 gets the same key whatever
 * else is in the pot, so a pot that grows does not re-deal the chips already
 * lying in it - the new ones slot in among them and everything else stays
 * where the player last saw it. Math.random() would reshuffle the entire pot
 * on every render, including the ones React does for an unrelated prop.
 *
 * `salt` gives one chip several independent draws (order, and how far it
 * lies off the centre line) without a second hash function.
 */
function chipJitter(denomValue: number, ordinal: number, salt: number): number {
  let h = Math.imul(denomValue ^ 0x9e3779b1, 0x85ebca6b);
  h = Math.imul(h ^ (ordinal + 0x165667b1), 0xc2b2ae35);
  h = Math.imul(h ^ (salt * 0x27d4eb2f), 0x2545f491);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * The pot, drawn as actual chips.
 *
 * Replaces MiniChipIcon, which drew three identical teal circles no matter
 * what the pot held — decoration, not information. This draws the fewest chips
 * that add up to `amount` on Dan's ladder, so a 21 pot is four red and one
 * white and it is readable at a glance without reading the number.
 *
 * `size` is the only difference between the two places it appears: `pot` is
 * the collected pot floating above the POT pill, `street` is the inline icon
 * in the live-bets pill under it, which has one line of pill height to live in.
 */
function PotChipPile({ amount, size }: { amount: number; size: 'pot' | 'street' }) {
  // The pot can hold far more denominations than a single bet, and it has the
  // middle of the felt to spread across, so it gets more room than a seat.
  // Dan 2026-08-24: one tower, highest denomination on the bottom, chips
  // slightly offset so every one of them is visible. `maxTotal` is the tower's
  // height in discs - see chipDenominations.ts. The collected pot floats over
  // the middle of the felt and can afford ten; the street pill has one line of
  // pill height, so it gets four.
  const stacks = useMemo(
    () =>
      visualChipStacks(
        amount,
        size === 'pot'
          ? { maxStacks: 6, maxPerStack: 10, maxTotal: 10 }
          : { maxStacks: 3, maxPerStack: 4, maxTotal: 4 }
      ),
    [amount, size]
  );

  // One horizontal spread, denominations MIXED - Dan 2026-09-14, "they should
  // appear 'in a pot' mixed together". Every disc visualChipStacks returned is
  // drawn; only the ORDER is re-dealt, by a key settled per (denomination,
  // ordinal), so the pile is stable across renders and stable as the pot grows.
  //
  // `truncated` / `count` ride along per disc for the same reason they do on
  // the seat chips: a denomination clamped for width prints its REAL number
  // above the spread, so a pot of 60,000 (twelve orange 5,000s, because Dan's
  // ladder has nothing between 5,000 and 100,000) still adds up to 60,000.
  const flattenedChips = useMemo(() => {
    const flat: {
      denom: ChipDenomination;
      partial: boolean;
      truncated: boolean;
      count: number;
      /** Where it lies, and how far off the centre line. */
      order: number;
      lift: number;
    }[] = [];
    stacks.forEach((stack) => {
      for (let i = 0; i < stack.drawn; i++) {
        flat.push({
          denom: stack.denom,
          partial: stack.partial,
          truncated: stack.truncated,
          count: stack.count,
          order: chipJitter(stack.denom.value, i, 1),
          // +/- 12% of a chip. Enough that the row reads as chips pushed into
          // a pot rather than as a dealt-out fan; small enough that the spread
          // still sits on one line under the pill.
          lift: (chipJitter(stack.denom.value, i, 2) - 0.5) * 0.24,
        });
      }
    });
    flat.sort((a, b) => a.order - b.order);
    return flat;
  }, [stacks]);

  // After the hooks, never before them: an early return above a useMemo is a
  // conditional hook call (react-hooks/rules-of-hooks), and the flatten above
  // already yields [] for a pot with no chips on the ladder.
  if (flattenedChips.length === 0) return null;

  // The count badge goes on the LAST disc of a clamped denomination, because a
  // later sibling lies over an earlier one and would bury it. Mixed order means
  // "last" is wherever the deal put it, not the top of a column.
  const lastOfTruncated = new Map<number, number>();
  flattenedChips.forEach((chip, i) => {
    if (chip.truncated) lastOfTruncated.set(chip.denom.value, i);
  });

  return (
    /* aria-hidden: the amount is already announced by the pill's aria-label. */
    <div className={`pot-display__pile pot-display__pile--${size}`} aria-hidden="true">
      <div className="pot-display__pile-stack" style={{ '--pile-group': 0 } as React.CSSProperties}>
        {flattenedChips.map((chip, index) => {
          const counted = lastOfTruncated.get(chip.denom.value) === index;
          return (
            <span
              key={index}
              className={`pot-display__pile-chip${chip.partial ? ' pot-display__pile-chip--partial' : ''}${counted ? ' pot-display__pile-chip--counted' : ''}`}
              style={
                {
                  '--pile-chip-color': chip.denom.color,
                  '--pile-chip-accent': chip.denom.accent,
                  // In a chip size, so the scatter holds at every table width.
                  transform: `translateY(calc(var(--cp-chip-size, 24px) * ${chip.lift.toFixed(3)}))`,
                } as React.CSSProperties
              }
            >
              {/* Multiplication sign, not a lowercase 'x' - check-title-case.mjs
                  rejects the letter on a forward-facing surface, and "twelve of
                  these" was never the letter anyway. */}
              {counted && (
                <span className="pot-display__pile-multi">
                  {'\u00d7'}
                  {chip.count.toLocaleString()}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function PotDisplayComponent({
  mainPot,
  sidePots = [],
  /* `currency` stays on the props (and in the memo comparator) for callers
     that still pass it; the pill prints chips, not a currency symbol, and the
     penny rule above is keyed on the big blind, so nothing reads it here. */
  bigBlind = 0,
  displayMode = 'chips',
  onToggleDisplayMode,
  streetBets = 0,
  collectTo = null,
  awardedPot = 0,
  handNumber = 0,
  showChipAnimation = true,
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
  //
  // Dan 2026-08-23: that carried amount must EXPIRE WITH ITS HAND. The ref was
  // only ever assigned, never cleared, and this component stays mounted for the
  // life of the table - so it held the last non-zero pot indefinitely.
  //
  // The failing shape is the commonest hand in poker. Hand N takes a 5,000 pot,
  // so the ref holds 5000. Hand N+1 folds around preflop: the blinds are still
  // in FRONT of the seats, so mainPot === streetBets on every snapshot and
  // collectedPot is 0 for the entire hand. collectTo is set for the push, which
  // is exactly the branch that reads the ref - so the pill, the chip pile and
  // the aria-live label all announced 5,000 sliding to a player who won 15.
  const lastNonZeroPotRef = useRef(collectedPot);
  const carriedHandRef = useRef(handNumber);
  if (carriedHandRef.current !== handNumber) {
    // Reset during render rather than in an effect: the push for the NEW hand
    // can be painted in the same commit as the hand-number change, and an
    // effect would clear the stale value one frame too late - after it had
    // already been shown.
    carriedHandRef.current = handNumber;
    lastNonZeroPotRef.current = 0;
  }
  /* Dan 2026-08-26: the push must show what was actually won, on EVERY hand.
     The reset above is right — the previous hand's 5,000 must never ride
     along — but it left the commonest hand with nothing at all to show: on a
     fold-around, `mainPot === streetBets` for the whole hand, so
     `collectedPot` is 0 throughout, the ref is never assigned, and the pill
     slid a ZERO to the winner.

     `awardedPot` is the amount the engine says was won (POT_WIN's own pot
     figure, handed down by TablePage). It is the correct number precisely in
     the case the running total cannot see, so it is the last resort before
     zero rather than a competing source: a live pot still wins while the
     hand is being played. */
  const displayPot =
    collectedPot > 0 ? collectedPot : collectTo ? lastNonZeroPotRef.current || awardedPot || 0 : 0;
  useEffect(() => {
    if (collectedPot > 0) lastNonZeroPotRef.current = collectedPot;
  }, [collectedPot]);

  // Total pot calculation
  const totalPot = useMemo(() => {
    return mainPot + sidePots.reduce((sum, p) => sum + p.amount, 0);
  }, [mainPot, sidePots]);

  const fmt = (n: number) =>
    displayMode === 'bb' && bigBlind > 0 ? formatBB(n, bigBlind) : formatAmount(n, bigBlind);

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
      aria-label={`Pot: ${formatAmount(displayPot, bigBlind)}${streetBets > 0 ? `, ${formatAmount(streetBets, bigBlind)} In Front Of Players` : ''}${sidePots && sidePots.length > 0 ? ` Plus ${sidePots.length} Side pot${sidePots.length > 1 ? 's' : ''}` : ''}`}
    >
      {/* Main Pot pill — click to toggle chips/BB display */}
      <div
        className={`pot-display__main ${onToggleDisplayMode ? 'pot-display__main--clickable' : ''}`}
        onClick={onToggleDisplayMode}
        title={onToggleDisplayMode ? 'Click To Toggle Chips/BB Display' : undefined}
      >
        <span className="pot-display__label">POT</span>
        <span className="pot-display__amount">
          <AnimatedNumber value={displayPot} duration={350} format={fmt} />
        </span>
      </div>

      {/* ── CHIP PILE ── */}
      {showChipAnimation && displayPot > 0 && <PotChipPile amount={displayPot} size="pot" />}

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
