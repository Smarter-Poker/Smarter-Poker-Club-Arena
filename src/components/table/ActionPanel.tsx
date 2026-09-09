/**
 * CLUB ARENA — Action Panel Component (Premium PokerBros-Style)
 * Large action buttons: Fold (red), Check/Call (green), Raise (amber/gold)
 * Professional layout with raise mode sub-panel, slider, and presets
 * PokerBros specs: 70-80px buttons, 16px radius, premium polish with glows and gradients
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { haptic } from '../../services/SoundService';
import './ActionPanel.css';
import { formatTableChips } from '../../utils/format';

interface ActionPanelProps {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  canRaise: boolean;
  canAllIn: boolean;
  callAmount: number;
  minRaise: number;
  maxRaise: number;
  /**
   * Dan 2026-08-18 (PLO bug): the raise-TO amount that actually puts hero
   * all-in (stack + own bet). In NO-LIMIT this equals maxRaise, so behaviour
   * is unchanged. In POT-LIMIT maxRaise is the POT CAP — betting the pot is
   * the largest LEGAL raise but is emphatically NOT all-in, and treating the
   * two as equal is what made "bet pot" shove the whole stack.
   */
  allInTo?: number;
  pot: number;
  bigBlind: number;
  /**
   * The table's SMALL blind. Dan 2026-08-23 (item 9): "the bet slider should go
   * up in smaller increments, it snap goes to the next BB amount instead of
   * allowing the user to choose an amount inbetween the blinds."
   *
   * The slider used to step by a whole big blind, so on a 1/2 table it could
   * only ever produce 12, 14, 16 - every amount between the blinds was
   * unreachable by drag. The step is now the table's own chip unit, and the
   * small blind IS that unit by definition: it is the smallest amount this
   * table ever forces onto the felt, so every multiple of it is an amount a
   * player can actually make.
   *
   * Optional because the panel can derive it: for every standard structure the
   * small blind is half the big blind, which is the fallback. Pass it when the
   * structure is not half (2/5, 3/6) so the grid is exact rather than close.
   */
  smallBlind?: number;
  onAction: (action: 'fold' | 'check' | 'call' | 'raise' | 'allin', amount?: number) => void;
  isMyTurn?: boolean;
  /**
   * 2026-09-04 (disconnect audit item 6): true while the engine socket is not
   * connected. The panel is drawn from the last snapshot, which may be a
   * street old; the buttons stay live (the HTTP action path is a second
   * transport and the server is the authority on whose turn it is) but they
   * are marked so a tap is an informed one, and the row says why.
   */
  connectionStale?: boolean;
  showPotOdds?: boolean;
  /**
   * @deprecated Dan 2026-08-19, bug list item 12: "do NOT add a confirm-all-in
   * button - accept the action." Accepted and ignored so that callers still
   * passing it do not break; there is no confirmation step any more.
   */
  confirmAllIn?: boolean;
  showBetSizePresets?: boolean;
  /** Phase 2 T1-02 hint — drives preflop 2X/3X/4X/5X presets vs postflop fraction presets. */
  isPreflop?: boolean;
  /** True for PLO4/5/6, so the preset row always offers RAISE POT. */
  isPotLimit?: boolean;
  /**
   * True for the fixed-limit games (FLH, FLO8), where the street has exactly
   * one legal wager and `minRaise === maxRaise`. The sizing panel is skipped
   * entirely — there is nothing to size — and the button shows the amount.
   * 2026-08-23.
   */
  isFixedLimit?: boolean;
  /**
   * Highest bet on the CURRENT street (server-authoritative `currentBet`), as a

   * raise-TO absolute. Required for the multiplier presets to mean anything
   * when hero is facing a bet: "3X" against an open to 15 is a raise to 45, not
   * to 3 big blinds. Defaults to 0 (unopened pot) -> multipliers fall back to
   * the big blind, which is the correct baseline for an opening raise.
   */
  currentBet?: number;
  /**
   * Keyboard entry point into raise mode.
   *
   * The documented F / C / R / A shortcuts and the 1/2/3/4 bet-preset keys used
   * to call `setShowRaiseSlider(true)` in TablePage — state that NOTHING
   * rendered. Pressing R on hero's turn therefore did nothing visible, and
   * worse, `showRaiseSlider` fed TablePage's `isModalOpen`, which disables the
   * whole keyboard handler: the key that appeared to do nothing also silently
   * killed F, C and A until Escape. This panel owns the sizing UI, so the
   * hotkeys have to arrive here.
   *
   * Bump `nonce` to act. `open: true` enters raise mode; pass `amount` to
   * preselect a size (the pot-fraction preset keys), clamped to the legal range.
   * `open: false` leaves it — the parent closes the panel on fold/check/call and
   * on Escape. A nonce rather than a plain boolean so pressing the same preset
   * twice re-opens the panel.
   */
  raiseIntent?: { nonce: number; open: boolean; amount?: number };
  /**
   * @deprecated Dan 2026-08-27: "there should be a slider located on the right,
   * that slides up and down (NEVER SIDE TO SIDE)."
   *
   * There is no horizontal slider any more, so there is nothing for this to
   * switch between. It is accepted and IGNORED so that a caller still passing
   * it does not break — exactly as `confirmAllIn` above.
   *
   * WHY THE SWITCH HAD TO GO RATHER THAN JUST DEFAULT TO TRUE. A horizontal
   * drag on a phone is the same gesture as the table-switch swipe, so the two
   * fight and the swipe usually wins — Dan 2026-08-26: "when it's on its side,
   * it auto slides to the next page." A prop that can still produce that
   * control is a prop that will eventually produce it. The rail is now the
   * only sizing control the panel has, at every width.
   */
  verticalSlider?: boolean;
  /**
   * Tournament seat: the slider steps by the level's chip unit (the small
   * blind) instead of the cash tables' whole dollar. See sliderUnitFor.
   */
  isTournament?: boolean;
  /**
   * Dan 2026-08-25 (binding): "tournaments and cash games should ALWAYS be
   * defaulted to actual totals unless the user changes the setting to BB.
   * Enforce that rule and functionality."
   *
   * This panel used to print big blinds unconditionally — the sub-label under
   * the bet amount and both slider cap figures were BB whatever the player had
   * chosen — so a table whose every other number was chips still handed the
   * player "26BB / 4BB" on the control they actually bet with.
   *
   * This is the SAME user setting the seats and the pot read
   * (`user_table_settings.show_stack_in_bb`, default false). Off = chips
   * everywhere, which is the default and the rule. It is a prop rather than a
   * hook read so this component stays presentational and unit-testable.
   */
  showStackInBB?: boolean;
}

// Dan 2026-08-28: bet/raise amounts are never abbreviated — see
// formatTableChips. A player cannot size a raise off "1.5K".
function formatChips(amount: number): string {
  return formatTableChips(amount);
}

/**
 * Round bet amount to proper chip increments — no fractional bets like 5.208.
 * Uses smallest chip = smallBlind (e.g. $1 for 1/2 game).
 * Ensures result is always >= min and <= max.
 */
function roundToChip(amount: number, smallestChip: number, min: number, max: number): number {
  if (smallestChip <= 0) smallestChip = 1;
  const rounded = Math.round(amount / smallestChip) * smallestChip;
  const clean = Math.round(rounded * 100) / 100;
  return Math.max(min, Math.min(max, clean));
}

/**
 * A slider position budget. Beyond this the step is doubled: a range of a
 * million chips at 1-chip resolution is not finer control, it is a control
 * whose every pixel spans forty values, and it makes the arrow keys useless.
 * Two thousand is already far more positions than a phone has pixels, so this
 * only ever engages on tournament-sized ranges.
 */
export const MAX_SLIDER_POSITIONS = 2000;

/**
 * The drag increment for the bet slider.
 *
 * WHY THIS EXISTS (Dan 2026-08-23, item 9). The slider was
 * `step={bigBlind || 1}`, anchored at `min={minRaise}`, so `<input
 * type="range">` could only ever emit `minRaise + n * bigBlind`. On a 1/2
 * table with min-raise 12 that is 12, 14, 16, 18 - 13 and 15 did not exist as
 * far as the drag was concerned, which is exactly what Dan saw as "it snap
 * goes to the next BB amount". At 0.25/0.50 stakes it was worse: a 0.50 step
 * across a 60-chip range gave 120 positions where the table's own chips allow
 * four times that.
 *
 * The step is the table's chip unit (the small blind), doubled while the range
 * would otherwise blow past MAX_SLIDER_POSITIONS. Doubling rather than
 * arbitrary scaling keeps every step a whole number of chips, so a coarsened
 * step still lands on amounts the table can make.
 *
 * LEGALITY: the engine imposes NO granularity rule. `validateAction` in
 * server/src/engine/PokerEngine.ts checks only `raiseAmount >= minRaise` and
 * `amount <= maxRaiseTo` (plus the pot-limit ceiling), each with a half-cent
 * tolerance. So any cent-resolution value inside [minRaise, maxRaise] is
 * accepted - the step is a usability choice, not a legality one, and the
 * type-in field is what covers the amounts between two steps.
 */
/**
 * The slider's travel unit, before the position-budget coarsening.
 *
 * Dan 2026-08-26: "in cash games it should go out by DOLLARS one at a time;
 * in tournaments same functionality, just scaled per chip depth."
 *
 * Cash tables whose big blind is at least a dollar therefore step by exactly
 * 1 - drag one notch, bet one more dollar. Sub-dollar cash stakes keep the
 * chip grid (a whole-dollar step across a 0.05/0.10 pot would leave the
 * slider two positions). Tournaments keep the small blind as the unit: it IS
 * the smallest chip in play and it grows with the levels, which is what
 * "scaled per chip depth" means - a 100/200 level steps by 100, not by 1.
 */
export function sliderUnitFor(
  isTournament: boolean,
  bigBlind: number,
  smallestChip: number
): number {
  if (!isTournament && bigBlind >= 1) return 1;
  return smallestChip > 0 ? smallestChip : 0.01;
}

export function betSliderStep(minRaise: number, maxRaise: number, smallestChip: number): number {
  const chip = smallestChip > 0 ? smallestChip : 0.01;
  const range = maxRaise - minRaise;
  if (!(range > 0)) return chip;
  let step = chip;
  while (range / step > MAX_SLIDER_POSITIONS) step *= 2;
  return Math.round(step * 100) / 100;
}

/**
 * Keep a typed bet amount to something that can be a bet.
 *
 * Dan 2026-08-23: "there should also be an area to click and type if a user
 * wants a very specific amount." A raw text input accepts "12e5", "--3" and
 * "1.2.3", and `Number('12e5')` is 1,200,000 - a silent shove. Filtering as
 * the user types means the field can never HOLD a value that would surprise
 * them on commit, rather than swallowing it afterwards.
 *
 * Comma is accepted and normalised to a point (EU keypads emit it). At most
 * two decimals, because the engine's chips are whole cents.
 */
export function sanitizeAmountDraft(raw: string): string {
  const stripped = raw.replace(/[^0-9.,]/g, '').replace(/,/g, '.');
  const firstDot = stripped.indexOf('.');
  if (firstDot === -1) return stripped;
  const whole = stripped.slice(0, firstDot);
  const frac = stripped
    .slice(firstDot + 1)
    .replace(/\./g, '')
    .slice(0, 2);
  return `${whole}.${frac}`;
}

export interface RaisePreset {
  label: string;
  /** Pre-round, pre-clamp value. Kept for debugging and tests. */
  raw: number;
  /** The amount the button actually raises TO. */
  value: number;
  /** True when the ceiling, not the sizing rule, decided this value. */
  cappedByMax: boolean;
}

export interface RaisePresetInput {
  isPreflop: boolean;
  bigBlind: number;
  /** Highest bet on the current street, as a raise-TO absolute. */
  currentBet: number;
  /** What hero still owes to call. */
  callAmount: number;
  /** Pot in the middle, EXCLUDING hero's outstanding call. */
  pot: number;
  /** Minimum legal raise-TO. */
  minRaise: number;
  /**
   * Maximum legal raise-TO. The caller already makes this game-correct: in
   * pot-limit it is the pot cap, in no-limit it is hero's all-in. Presets must
   * never exceed it, and must never independently invent a different ceiling.
   */
  maxRaise: number;
  /**
   * True for the pot-limit games (PLO4/5/6). Dan 2026-08-19, bug list item 4b:
   * "PLO must always have a RAISE POT button" - it was missing preflop.
   */
  isPotLimit?: boolean;
  /**
   * The table's chip granularity — the smallest amount that can actually be
   * wagered. Dan 2026-08-21 (item 9): "it must identify which game stakes it's
   * at." Presets that are NOT exact multiples (POT and the postflop fractions)
   * snap to this grid, so a 1.5K/3K game offers 4,500 rather than 4,501 and a
   * 0.5/1 game offers 3.5 rather than 4. Defaults to the small blind.
   */
  smallestChip?: number;
}

/**
 * The pot-sized raise-TO: call the outstanding bet, then raise by the pot as it
 * stands after that call.
 *
 *   raiseTo = currentBet + (pot + callAmount)
 *
 * `pot` excludes hero's own outstanding call, so `pot + callAmount` is the pot
 * hero would be raising into. This is the single definition of a pot-sized
 * raise on the client; `TablePage` uses it for the pot-limit ceiling and the
 * POT preset uses it for its amount, so the button and the cap can never drift
 * apart.
 */
export function potSizedRaiseTo(currentBet: number, pot: number, callAmount: number): number {
  return currentBet + pot + callAmount;
}

/**
 * Bet-size preset buttons.
 *
 * Dan 2026-08-19, two rules the previous implementation broke:
 *
 *   (7) "4X/3X/2X raises must be multiples of the last bet, or the BB if not
 *       facing action."  The baseline is `max(currentBet, bigBlind)` - facing
 *       an open to 15, 3X is a raise TO 45; unopened, 3X is 3 big blinds.
 *
 *  (14) "3X/4X/5X raises must round to the next whole number without exceeding
 *       the pot."  SUPERSEDED 2026-08-21 by item 9 below: a button labelled 3X
 *       has to raise exactly 3X, and on a table whose chips are not whole
 *       numbers those two rules cannot both hold. Exactness wins for the NX
 *       buttons; the derived sizings (POT, fractions) snap to the chip grid.
 *
 *       The "without exceeding the pot" half is enforced by `maxRaise`, which
 *       the caller already sets to the pot cap in pot-limit games. Presets
 *       deliberately do NOT impose a pot ceiling of their own: in no-limit a
 *       4X open is a normal bet that has nothing to do with the pot, and
 *       capping it there would collapse 2X/3X/4X/5X onto one number preflop -
 *       the exact dead-buttons bug fixed in August. The ceiling is floored to a
 *       whole number first, so ceiling a preset can never push it past the cap.
 *
 *  (4b) "PLO must always have a RAISE POT button" - it was missing preflop.
 *       Preflop offered 2X/3X/4X/5X and nothing else, so in a pot-limit game
 *       the one sizing that defines the game had no button. In pot-limit the
 *       fourth preset is now POT rather than 5X, which also removes a dead
 *       button: with maxRaise set to the pot cap, 4X and 5X both clamped to
 *       that same cap, so 5X was already an unlabelled POT.
 */
export function computeRaisePresets(input: RaisePresetInput): RaisePreset[] {
  const {
    isPreflop,
    bigBlind,
    currentBet,
    callAmount,
    pot,
    minRaise,
    maxRaise,
    isPotLimit,
    smallestChip,
  } = input;

  /**
   * Dan 2026-08-21 (item 9): "the pre-selected 3X, 4X, 5X isn't calibrated or
   * working correctly. It must identify which game stakes it's at, and if you
   * are raising a bet you're facing, it should purely 3X, 4X or 5X the bet
   * you're facing EXACTLY."
   *
   * Two things were wrong, and they were both in this rounding step.
   *
   *  1. Every preset was pushed through `Math.ceil`. On any table whose chips
   *     are not whole numbers — a 0.5/1 game, or any stake with a half-blind
   *     small blind — 3X of a 2.5 bet came out as 8, not 7.5. The button said
   *     3X and raised 3.2X. An exact multiple is the one thing a button
   *     labelled "3X" has to deliver.
   *
   *  2. The grid was the integer 1, regardless of stakes. That is not what
   *     "the game's chips" means at 1.5K/3K any more than it is at 0.5/1.
   *
   * So multiples are now EXACT and are only ever moved by legality — below the
   * minimum raise or above the ceiling — in which case `cappedByMax` says so.
   * Only the derived sizings (POT, the postflop fractions), which have no exact
   * value to preserve, snap to the table's chip grid.
   */
  const grid = smallestChip && smallestChip > 0 ? smallestChip : Math.max(bigBlind / 2, 0.01);
  const snapUp = (n: number) => Math.ceil(n / grid - 1e-9) * grid;
  /** Kill binary dust like 7.500000000000001 before it reaches a button. */
  const clean = (n: number) => Math.round(n * 100) / 100;

  const capOnGrid = Math.floor(maxRaise / grid + 1e-9) * grid;
  const minOnGrid = snapUp(minRaise);

  /** For POT and the fractions: nearest legal value on the chip grid. */
  const finalize = (label: string, raw: number): RaisePreset => {
    // If the legal minimum is already above the ceiling, hero has no raise
    // room left; the only legal raise-TO is the ceiling itself.
    if (minOnGrid > capOnGrid) return { label, raw, value: maxRaise, cappedByMax: true };
    const onGrid = snapUp(raw);
    const capped = Math.min(onGrid, capOnGrid);
    return {
      label,
      raw,
      value: clean(Math.max(minOnGrid, capped)),
      cappedByMax: capped < onGrid,
    };
  };

  /**
   * For NX: the exact multiple, untouched, unless it is illegal. No grid
   * snapping — N times a legal bet is already a legal amount by construction,
   * because the bet it multiplies was itself made of this table's chips.
   */
  const finalizeExact = (label: string, raw: number): RaisePreset => {
    /* CLAMP ONTO THE GRID, NOT ONTO THE RAW BOUND.
       The exact multiple is preserved while it is legal, which is the whole
       point of a button labelled 3X. But the moment it is NOT legal the value
       stops being a multiple and becomes a clamp, and a clamp has no exact
       value worth protecting: it must be a real amount the player can actually
       bet. Clamping to the raw `maxRaise` put a fractional 27.5 on the button
       at a table whose chips are whole, which is the same class of defect as
       the ceil it replaced, just at the other end. */
    if (minOnGrid > capOnGrid) return { label, raw, value: clean(capOnGrid), cappedByMax: true };
    const exact = clean(raw);
    if (exact > capOnGrid) return { label, raw, value: clean(capOnGrid), cappedByMax: true };
    if (exact < minOnGrid) return { label, raw, value: clean(minOnGrid), cappedByMax: false };
    return { label, raw, value: exact, cappedByMax: false };
  };

  /**
   * ── THE MULTIPLIER ROW (Dan 2026-08-28, mobile pass item 1) ───────────────
   *
   * Verbatim: "WE DON'T NEED ALL OF THOSE MULTIPLIERS. 2.5X 3X 3.5X 4X POT AND
   * ALL IN ARE FINE. (REMOVE 2X AND 5X)"
   *
   * So the row is `MULTIPLES` + POT, and ALL IN is appended by the renderer.
   * Seven buttons became six, and on a 375px phone that is the difference
   * between a comfortable hit area and a row of slivers — the previous set had
   * ALL IN clipped at the right edge in Dan's screenshot.
   *
   * WHY THESE FOUR. 2X was never a raise anyone makes: preflop it is a min-open
   * and postflop it is a min-raise, both of which the slider already reaches and
   * neither of which wants a dedicated button. 5X is past the point where a
   * player sizes by multiple rather than by pot. What is left is the band people
   * actually open and 3-bet into, and 3.5X — which the row never had — is the
   * gap between the 3X and 4X it sat between.
   *
   * NO POT BUTTON PREFLOP IN NO-LIMIT, and this is deliberate rather than an
   * omission — I added one while making the row uniform and had to take it back
   * out. Preflop unopened the pot is just the blinds, so a pot-sized raise at
   * 1/2 is a raise TO 4: SMALLER than the 2.5X button sitting to its left. The
   * row is read left to right as ascending sizes, and a POT that undercuts every
   * multiple beside it breaks that reading. Pot-limit keeps its preflop POT
   * because that sizing is the game.
   */
  const MULTIPLES = [2.5, 3, 3.5, 4];

  /**
   * Pot-limit truncates the row, and this is not a style choice: `maxRaise` is
   * pinned to the pot cap, so every multiple above it clamps onto that same
   * number. Left alone, PLO would draw three or four buttons that all bet the
   * identical amount. Preflop the cap is far enough out that all four are
   * distinct; facing a bet postflop it bites at 3X.
   */
  const potLimited = (all: number[], cap: number) => all.filter((n) => n <= cap);

  if (isPreflop) {
    // The bet being faced. Unopened pot -> the big blind.
    const base = Math.max(currentBet, bigBlind) || bigBlind || 1;
    const multiples = isPotLimit ? potLimited(MULTIPLES, 4) : MULTIPLES;
    const presets = multiples.map((n) => finalizeExact(`${n}X`, base * n));
    if (isPotLimit) {
      // The ceiling includes full nominal blinds when a blind is short.
      presets.push(finalize('POT', maxRaise));
    }
    return presets;
  }

  // ── Dan 2026-08-21: "when you are facing a bet, 3X and 4X must be
  // clickable options." Postflop FACING A BET mirrors the preflop grammar —
  // exact multiples of the bet being faced (rule 7: base = the last bet) —
  // plus POT. Fractions only make sense when nobody has bet yet.
  if (currentBet > 0) {
    const multiples = isPotLimit ? potLimited(MULTIPLES, 3) : MULTIPLES;
    const presets = multiples.map((n) => finalizeExact(`${n}X`, currentBet * n));
    presets.push(finalize('POT', potSizedRaiseTo(currentBet, pot, callAmount)));
    return presets;
  }

  // Postflop fractions are "bet f x the pot I'd be raising into", as raise-TO
  // absolutes: currentBet + f * (pot + callAmount). At f = 1 this is exactly
  // potSizedRaiseTo. The previous formula added `callAmount` a second time, so
  // facing a bet the POT button offered MORE than a pot-sized raise - invisible
  // in PLO because maxRaise clamped it back, but real money in no-limit.
  const potToRaiseInto = pot + callAmount;
  const fractions: Array<[string, number]> = [
    ['33%', 0.33],
    ['50%', 0.5],
    ['75%', 0.75],
    ['POT', 1],
  ];
  return fractions.map(([label, f]) => finalize(label, currentBet + potToRaiseInto * f));
}

export default function ActionPanel({
  canFold,
  canCheck,
  canCall,
  canRaise,
  canAllIn,
  callAmount,
  minRaise: rawMinRaise,
  maxRaise: rawMaxRaise,
  allInTo,
  pot,
  bigBlind,
  smallBlind,
  onAction,
  isMyTurn = true,
  connectionStale = false,
  showPotOdds = false,
  confirmAllIn: _confirmAllInDeprecated,
  showBetSizePresets = true,
  isPreflop = false,
  isPotLimit = false,
  isFixedLimit = false,
  currentBet = 0,

  raiseIntent,
  isTournament = false,
  verticalSlider: _verticalSliderDeprecated,
  // Chips is the default and the rule — see the prop's docstring.
  showStackInBB = false,
}: ActionPanelProps) {
  /**
   * The table's chip unit. The small blind when the parent knows it, otherwise
   * half the big blind, which is the small blind for every standard structure.
   * Never below a cent: the engine's chips are whole cents (see the CENT_EPS
   * note in server/src/engine/PokerEngine.ts), so a finer grid would invent
   * amounts that do not exist.
   */
  const smallestChip = useMemo(() => {
    const sb = smallBlind && smallBlind > 0 ? smallBlind : bigBlind / 2;
    return Math.max(Math.round(sb * 100) / 100, 0.01);
  }, [smallBlind, bigBlind]);
  const minRaise = roundToChip(rawMinRaise, smallestChip, rawMinRaise, rawMaxRaise);
  const maxRaise = rawMaxRaise;
  // Only an amount that reaches the REAL all-in threshold is an all-in.
  const allInThreshold = allInTo ?? rawMaxRaise;

  /**
   * Dan 2026-08-23 (item 9). Was `bigBlind || 1`, which is what made the drag
   * "snap to the next BB amount". See betSliderStep for the full account.
   */
  /* Dan 2026-08-26: dollars one at a time in cash; chip-depth scaled in
     tournaments. See sliderUnitFor. betSliderStep still doubles the unit
     while the range would exceed MAX_SLIDER_POSITIONS. */
  const sliderUnit = useMemo(
    () => sliderUnitFor(!!isTournament, bigBlind, smallestChip),
    [isTournament, bigBlind, smallestChip]
  );
  const sliderStep = useMemo(
    () => betSliderStep(minRaise, maxRaise, sliderUnit),
    [minRaise, maxRaise, sliderUnit]
  );

  /** Chips are whole cents; kill binary dust before it reaches a button. */
  const cleanChips = useCallback((n: number) => Math.round(n * 100) / 100, []);

  /**
   * Clamp into the legal range WITHOUT snapping. Used for typed amounts and
   * for preset values, both of which are exact on purpose: a button labelled
   * 2.5X that raises 2.6X is the defect Dan reported on the NX row in August,
   * and a typed 13.37 that commits 13 is the same defect on the keypad.
   */
  const clampAmount = useCallback(
    (n: number) => cleanChips(Math.min(Math.max(n, minRaise), maxRaise)),
    [cleanChips, minRaise, maxRaise]
  );

  /**
   * Round onto the slider's OWN value grid (minRaise + n * sliderStep), so the
   * number under the thumb is always a number the thumb can be at. Used by the
   * drag and by the +/- nudges; deliberately NOT used by the keypad.
   */
  const snapToSliderGrid = useCallback(
    (n: number) => {
      const bounded = Math.min(Math.max(n, minRaise), maxRaise);
      // The ceiling is never rounded away from. maxRaise is the all-in (or the
      // pot cap), and it is only on the step grid by coincidence - snapping it
      // to the nearest step is how the panel used to offer 186 when hero's
      // stack was 187.50 and call it a shove.
      if (bounded >= maxRaise) return cleanChips(maxRaise);
      if (!(sliderStep > 0)) return cleanChips(bounded);
      const steps = Math.round((bounded - minRaise) / sliderStep);
      return clampAmount(minRaise + steps * sliderStep);
    },
    [sliderStep, minRaise, maxRaise, cleanChips, clampAmount]
  );

  const [isRaiseMode, setIsRaiseMode] = useState(false);
  const [raiseAmount, setRaiseAmount] = useState(minRaise);
  const [turnPulse, setTurnPulse] = useState(false);

  /**
   * Dan 2026-08-18 (screenshot review): the raise panel is tall, and the
   * floating bottom-left HUD (previous-hand card, timebank pill) plus the
   * chat button rendered straight THROUGH it — the slider handle sat behind
   * the timebank pill. A body-level flag lets those fixed overlays hide for
   * exactly as long as the panel is open (see .ca-raising rules in
   * TablePage.css). Body class, not React state, because those overlays are
   * siblings mounted far away in the tree.
   */
  /* ─── THIS TABLE'S ROOT, NOT `document.body` (fixed 2026-08-28) ───────────
   *
   * The flag used to be `document.body.classList.toggle('ca-raising', …)` and
   * every rule that read it was `body.ca-raising …`. One body, four tables:
   *
   *   - in TILE VIEW all four tables are painted at once, so opening the raise
   *     slider on one hid the timebank pill, previous-hand card, bankroll widget
   *     and chat button on ALL FOUR;
   *   - in either view the panels raced each other. Table two closing its
   *     slider ran `toggle(..., false)` — or its unmount ran the cleanup's
   *     unconditional `remove` — and stripped the class while table one's
   *     overlay was still open, putting the timebank pill straight back on top
   *     of table one's slider handle. That is the exact z-order defect this
   *     flag was added to fix, reappearing whenever a second table was open.
   *
   * The class goes on this panel's own `.table-page` ancestor instead, and the
   * five selectors are `.table-page.ca-raising …`. `.action-panel` is
   * `position: fixed`, but fixed positioning does not change where an element
   * sits in the DOM, so `closest()` still finds the right root.
   *
   * Falls back to `document.body` only when there is no `.table-page` above the
   * panel — a harness or a Storybook-style mount. Losing the flag entirely there
   * would silently drop the behaviour under test.
   */
  const panelRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = panelRootRef.current?.closest('.table-page') ?? document.body;
    host.classList.toggle('ca-raising', isRaiseMode);
    return () => host.classList.remove('ca-raising');
  }, [isRaiseMode]);

  /* ─── TAP ANYWHERE ABOVE THE PANEL TO GET THE THREE HOT KEYS BACK ─────────
   *
   * Dan 2026-08-29: "you should be able to click the back button or anywhere
   * on the top of the screen to close the action bar and go back to the 3 hot
   * keys."
   *
   * The sizing overlay is tall and `position: fixed`, so on a phone it stands
   * over the bottom of the felt - including, at some stack sizes, the hero's
   * own cards. Until now the ways out were the Back button at the top of the
   * overlay and the Raise button behind it: both small, both at the bottom,
   * and neither is where a thumb goes when the reflex is "get this out of my
   * way". A player who taps the felt to dismiss it got nothing, or worse got
   * whatever the felt does with a tap.
   *
   * So a pointerdown outside the panel closes it. Three details, each
   * load-bearing:
   *
   *   - CAPTURE PHASE, and the event is stopped. The tap that dismisses must
   *     not ALSO reach the felt underneath - otherwise dismissing the panel
   *     over an open seat would try to seat the player, which is the kind of
   *     surprise that costs money. First tap closes, second tap acts.
   *   - SCOPED TO THIS TABLE'S ROOT, not the document. Four tables can be
   *     painted at once in tile view (see the note above on why the
   *     `ca-raising` flag moved off `document.body`); a document-level
   *     listener would let a tap on table two dismiss table one's slider.
   *   - `pointerdown`, not `click`. A click fires after the gesture completes,
   *     which on a slider drag that ends outside the panel would close it on
   *     release. Pointerdown is the moment the player commits to the tap.
   *
   * Escape does the same on a desktop, which is what a keyboard user expects
   * from anything modal-shaped and costs one listener — but NOT while the
   * amount field is being typed into. Escape already means "throw away this
   * draft and put the previous amount back" in that input (see its onKeyDown),
   * and stealing it would make the panel vanish mid-correction. The first
   * version of this did exactly that and
   * tests/actionpanel-bet-granularity.test.tsx caught it. One Escape, two
   * meanings, innermost wins — which is how every nested dismissible behaves.
   */
  const amountTypingRef = useRef(false);
  useEffect(() => {
    if (!isRaiseMode) return;
    const panel = panelRootRef.current;
    const host = panel?.closest('.table-page') ?? document.body;

    const onPointerDown = (e: Event) => {
      const target = e.target as Node | null;
      // Inside the panel (slider, presets, Back, the amount field) - leave it.
      if (!target || (panel && panel.contains(target))) return;
      e.preventDefault();
      e.stopPropagation();
      setIsRaiseMode(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (amountTypingRef.current) return; // the input owns Escape while it is open
      setIsRaiseMode(false);
    };

    host.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      host.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [isRaiseMode]);
  // Phase 2 T1-03: spec §5.2 — tapping the amount opens a numeric keyboard.
  // amountTyping toggles the inline input; amountDraft holds the raw text
  // while the user types so we don't fight their cursor mid-edit. Commit on
  // Enter / blur — parse, clamp to [minRaise, maxRaise], over-stack snaps
  // to all-in (= maxRaise per spec).
  const [amountTyping, setAmountTyping] = useState(false);
  /* Read by the Escape handler above, which is declared before this state and
     must not close the panel while the inline editor owns the key. */
  useEffect(() => {
    amountTypingRef.current = amountTyping;
  }, [amountTyping]);
  const [amountDraft, setAmountDraft] = useState<string>('');
  const amountInputRef = useRef<HTMLInputElement | null>(null);
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1024
  );
  const prevTurnRef = useRef(isMyTurn);

  /**
   * The vertical rail is a horizontal <input type="range"> rotated -90deg, so
   * its pre-rotation WIDTH is what you see as height. That was a hard-coded
   * 240px: on a short panel the rail overran the panel, and on a tall one the
   * thumb could not reach the top of its own track - which is where the all-in
   * cap sits. Measured instead, and kept measured, and published to the
   * stylesheet as `--raise-rail-length`.
   */
  /**
   * A CALLBACK REF, NOT A `useRef` + A DEPENDENCY GUESS (changed 2026-08-26).
   *
   * This measured through `railRef.current` inside an effect keyed on
   * `[isRaiseMode]`. The rail did not exist at every width back then — it was
   * gated on `windowWidth >= 1024`, which that dependency list never mentioned
   * — so widening a window from 900px to 1200px with the raise overlay open
   * mounted the rail with nothing observing it, and `railLength` stayed at the
   * 240px default. That is the pre-rotation width of the range input, so the
   * track stopped spanning the rail and the thumb could not reach the top: the
   * all-in cap, i.e. exactly the failure the comment above says this was added
   * to fix.
   *
   * The width gate is gone (2026-08-27 — the rail is the only sizing control at
   * every width now), so that particular trigger cannot fire again. The
   * callback ref stays anyway, and deliberately: it keys the measurement on the
   * NODE rather than on a dependency list somebody has to keep true. React
   * calls it with the node on mount and with null on unmount, whatever caused
   * either, so the observation can no longer disagree with the element's real
   * lifetime.
   */
  const railRef = useRef<HTMLDivElement | null>(null);
  const [railEl, setRailEl] = useState<HTMLDivElement | null>(null);
  const setRailNode = useCallback((node: HTMLDivElement | null) => {
    railRef.current = node;
    setRailEl(node);
  }, []);
  const [railLength, setRailLength] = useState(240);

  useEffect(() => {
    const el = railEl;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h > 0) setRailLength(h);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // Keyed on the NODE. Mount, unmount and remount all re-run this by
    // construction, so no dependency list has to predict when the rail exists.
  }, [railEl]);

  useEffect(() => {
    setRaiseAmount(minRaise);
  }, [minRaise]);

  useEffect(() => {
    if (!isMyTurn) {
      setIsRaiseMode(false);
    }
  }, [isMyTurn]);

  // Keyboard-driven raise. Only meaningful on hero's turn and only when a raise
  // is actually legal, so the hotkey can never open a panel whose confirm button
  // the server would refuse.
  const raiseIntentNonce = raiseIntent?.nonce;
  const raiseIntentOpen = raiseIntent?.open;
  const raiseIntentAmount = raiseIntent?.amount;
  const firstIntentRef = useRef(true);
  useEffect(() => {
    if (raiseIntentNonce === undefined) return;
    // Do not spring open on mount just because a nonce exists.
    if (firstIntentRef.current) {
      firstIntentRef.current = false;
      return;
    }
    if (!raiseIntentOpen) {
      setIsRaiseMode(false);
      return;
    }
    if (!isMyTurn || (!canRaise && !canAllIn)) return;
    const target =
      raiseIntentAmount === undefined
        ? minRaise
        : Math.min(Math.max(raiseIntentAmount, minRaise), maxRaise);
    haptic.light();
    setIsRaiseMode(true);
    setRaiseAmount(snapToSliderGrid(target));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raiseIntentNonce]);

  useEffect(() => {
    if (isMyTurn && !prevTurnRef.current) {
      setTurnPulse(true);
      const timer = setTimeout(() => setTurnPulse(false), 600);
      prevTurnRef.current = isMyTurn;
      return () => clearTimeout(timer);
    }
    prevTurnRef.current = isMyTurn;
  }, [isMyTurn]);

  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const isDesktop = windowWidth >= 1024;

  // Preset sizing lives in `computeRaisePresets` above - a pure function so the
  // rules Dan set (multiples of the bet being faced; whole numbers; never past
  // the legal ceiling) are unit-testable instead of trapped inside a render.
  const presets = useMemo(
    () =>
      computeRaisePresets({
        isPreflop,
        bigBlind,
        currentBet,
        callAmount,
        pot,
        minRaise,
        maxRaise,
        isPotLimit,
        // Dan 2026-08-21 (item 9): the derived sizings snap to THIS table's
        // chips, not to the integer 1.
        smallestChip,
      }),
    [isPreflop, bigBlind, currentBet, callAmount, pot, minRaise, maxRaise, isPotLimit, smallestChip]
  );

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * 2026-08-20: THE SLIDER COULD NOT REACH ITS OWN MAXIMUM — you could not
   * shove with it.
   * ═══════════════════════════════════════════════════════════════════════
   * `<input type="range">` only produces values on the grid `min + n*step`.
   * The slider is `min={minRaise} max={maxRaise} step={bigBlind}`, so unless
   * `maxRaise - minRaise` happens to be an exact multiple of the big blind,
   * dragging fully right stops SHORT of maxRaise and the browser never emits
   * it. Four of five realistic tables measured:
   *
   *   1/2  min 12  max 200    -> tops out at 200    ok (200-12 is even)
   *   1/2  min 12  max 187.50 -> tops out at 186    1.50 short
   *   5/10 min 60  max 431    -> tops out at 430    1 short
   *   PLO  min 12  cap 47     -> tops out at 46     1 short
   *   .5/1 min 3   max 63.25  -> tops out at 63     0.25 short
   *
   * A stack is only an exact multiple of the blind before the first hand, so
   * in practice hero could NEVER slide to all-in (or, in pot-limit, to the pot
   * cap). The `+` button and the presets could still get there, which is
   * exactly why this survived: the panel looked like it worked. The vertical
   * slider even printed `maxRaise` as its top cap label — a number its own
   * control could not produce.
   *
   * Fix: keep the step grid (it is what makes dragging feel like chips), and
   * treat the LAST grid position as maxRaise. Nothing else moves: every lower
   * position is still exactly where it was.
   */
  const sliderGridMax = useMemo(() => {
    if (!(maxRaise > minRaise)) return maxRaise;
    const steps = Math.floor((maxRaise - minRaise) / sliderStep);
    return Math.round((minRaise + steps * sliderStep) * 100) / 100;
  }, [minRaise, maxRaise, sliderStep]);

  // Track last slider value for haptic snap feedback
  const lastSnapRef = useRef<number>(minRaise);

  const handleRaiseClick = useCallback(() => {
    if (!canRaise && !canAllIn) return;
    haptic.light();
    /* Dan 2026-08-25 (item 5): the sizing controls open as an OVERLAY above a
       three-button row that never moves, so unlike the old full-panel swap
       this button is still on screen while the overlay is up. It therefore has
       to close it too - otherwise the only way back out is the Back button
       hiding at the top of the overlay. */
    if (isRaiseMode) {
      setIsRaiseMode(false);
      return;
    }
    // 2026-08-23 (fixed limit): there is exactly ONE legal wager on this street
    // — TablePage collapses minRaise and maxRaise onto it — so there is nothing
    // to size and no panel to open. Opening the sizing panel here would draw a
    // slider with a zero-length track and a preset row where every button reads
    // the same number. The tap IS the bet.
    if (isFixedLimit) {
      haptic.medium();
      if (minRaise >= allInThreshold) onAction('allin', allInThreshold);
      else onAction('raise', minRaise);
      return;
    }
    setIsRaiseMode(true);
    setRaiseAmount(minRaise);
    lastSnapRef.current = minRaise;
  }, [canRaise, canAllIn, minRaise, isFixedLimit, allInThreshold, onAction, isRaiseMode]);

  const handleConfirmRaise = useCallback(() => {
    haptic.medium(); // FIX 196: Bible V8 §5.4 — raise = medium haptic (was strong/heavy, reserved for all_in)
    // Dan 2026-08-18: compare against the REAL all-in threshold, not maxRaise.
    // In PLO maxRaise is the pot cap, so this branch used to fire on every
    // pot-sized bet and shove the stack.
    if (raiseAmount >= allInThreshold) {
      onAction('allin', allInThreshold);
    } else {
      onAction('raise', raiseAmount);
    }
    setIsRaiseMode(false);
  }, [raiseAmount, allInThreshold, onAction]);

  const handleAllIn = useCallback(() => {
    haptic.strong();
    // Dan 2026-08-19, bug 12: no confirmation step. The tap IS the action.
    // AUDIT 2026-08-19: was maxRaise, which in POT-LIMIT is the pot cap, not
    // the stack - an "ALL IN" tap would report a pot-sized amount. The server
    // derives the real all-in from the stack so no chips were ever wrong, but
    // sending an amount that contradicts the action is a trap for anything
    // that reads it (optimistic UI, telemetry).
    onAction('allin', allInThreshold);
    setIsRaiseMode(false);
  }, [allInThreshold, onAction]);

  /**
   * The +/- nudges move by ONE slider step, not by one big blind.
   *
   * Dan 2026-08-23 (item 9) reported the slider, but the nudges had the same
   * defect and it was worse: from 13 on a 1/2 table, `+` added the big blind
   * and then re-rounded, so the amount went 13 -> 15 and 14 was unreachable by
   * any control on the panel. Stepping by the grid also guarantees the number
   * and the thumb agree after a nudge.
   */
  const adjustRaise = useCallback(
    (delta: number) => {
      haptic.light();
      setRaiseAmount((prev) => snapToSliderGrid(prev + delta));
    },
    [snapToSliderGrid]
  );

  const setPreset = useCallback(
    (value: number) => {
      haptic.medium();
      // Clamp only. A preset value is already exact by construction (2.5X of
      // the bet faced, or a pot fraction already snapped to the chip grid in
      // computeRaisePresets); re-snapping it here to the chip unit is what made
      // an exact 2.5X of 15 commit 40 instead of 37.50 on a 5/10 table.
      setRaiseAmount(clampAmount(value));
    },
    [clampAmount]
  );

  // Phase 2 T1-03: tap-the-amount → numeric keyboard.
  const beginEditAmount = useCallback(() => {
    haptic.light();
    setAmountDraft(String(Math.round(raiseAmount * 100) / 100));
    setAmountTyping(true);
    // Focus on next paint so the inputMode="numeric" keyboard pops on iOS/Android.
    requestAnimationFrame(() => {
      amountInputRef.current?.focus();
      amountInputRef.current?.select();
    });
  }, [raiseAmount, cleanChips]);

  const commitAmountEdit = useCallback(() => {
    setAmountTyping(false);
    if (!amountDraft) return; // empty input — keep prior amount
    // The draft is already filtered to digits and one separator by
    // sanitizeAmountDraft, so this only has to catch the half-typed states a
    // filter cannot reject: "", ".", "0".
    const parsed = Number(amountDraft);
    if (!Number.isFinite(parsed) || parsed <= 0) return; // garbage — keep prior
    // Spec §5.2:
    //   - exceeds stack → AUTO-CAPS to all-in (= maxRaise)
    //   - below minimum → snaps to min legal
    //
    // Clamp ONLY. Dan 2026-08-23 (item 9): "there should also be an area to
    // click and type if a user wants a very specific amount." Snapping the
    // typed number to the slider's step would defeat the entire feature - the
    // whole reason to type is to reach an amount between two steps. Any cent
    // value inside [minRaise, maxRaise] is legal: PokerEngine.validateAction
    // enforces the two bounds and nothing else.
    setRaiseAmount(clampAmount(parsed));
    haptic.medium();
  }, [amountDraft, clampAmount]);

  const cancelAmountEdit = useCallback(() => {
    setAmountTyping(false);
    setAmountDraft('');
  }, []);

  // Slider change with snap-to-preset haptic feedback
  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = Number(e.target.value);
      // Top of the grid means "all the way" — see sliderGridMax above.
      // Below that, `raw` is already on the grid when the drag produced it;
      // snapping is what puts a value back on the grid after the keypad has
      // left it between two steps.
      const val = raw >= sliderGridMax ? maxRaise : snapToSliderGrid(raw);
      setRaiseAmount(val);

      // Snap feedback — trigger haptic when crossing a BB boundary
      const currentBB = Math.round(val / (bigBlind || 1));
      const lastBB = Math.round(lastSnapRef.current / (bigBlind || 1));
      if (currentBB !== lastBB) {
        haptic.light();
        lastSnapRef.current = val;
      }

      // Stronger haptic when hitting a preset value (within 1 BB tolerance)
      const tolerance = bigBlind || 1;
      for (const p of presets) {
        if (
          Math.abs(val - p.value) <= tolerance &&
          Math.abs(lastSnapRef.current - p.value) > tolerance
        ) {
          haptic.medium();
          break;
        }
      }
    },
    // maxRaise / sliderGridMax / snapToSliderGrid are all read above; they were
    // missing here once and only stayed correct by accident, because `presets`
    // happens to change whenever they do.
    [bigBlind, presets, maxRaise, sliderGridMax, snapToSliderGrid]
  );

  const sliderProgress =
    maxRaise > minRaise ? ((raiseAmount - minRaise) / (maxRaise - minRaise)) * 100 : 0;

  /**
   * Dan 2026-08-23: "when you aren't facing a bet, and enter an amount, it's a
   * bet, not a raise" — the sizing panel said RAISE 24 on an unopened street.
   *
   * The predicate is `currentBet`, the highest wager on THIS street, and not
   * `callAmount`. They differ in the one spot that matters: the big blind
   * preflop with no raisers has callAmount 0 but currentBet = the blind, and
   * putting in more there is a RAISE — the blind is already a bet. Keying off
   * callAmount would have called that a bet, which is the same error in the
   * opposite direction. (The main action bar keys off callAmount and had
   * exactly that hole; it now shares this value.)
   *
   * Note this is a LABEL, not the wire action. The engine models an opening
   * bet as a raise from zero and every consumer downstream of `onAction`
   * expects 'raise'; the word on the button is what was wrong.
   */
  const isOpeningBet = currentBet <= 0;
  const wagerVerb = isOpeningBet ? 'Bet' : 'Raise';

  /**
   * ─── RAISE SIZING OVERLAY ────────────────────────────────────
   *
   * Dan 2026-08-25 (item 5): "these 3 action buttons should be on the bottom,
   * and if you click Raise, the action slider and other buttons pop open and
   * can overlay the Hero and other things when clicked to open."
   *
   * Raise mode used to REPLACE the whole panel: the three buttons disappeared,
   * a much taller box took their place, and the bar's height changed under a
   * table that had already reserved room for the short version. It is an
   * OVERLAY now — this block renders ABOVE the pinned row, inside the same
   * `position: fixed; bottom: 0` panel, so the panel grows UPWARD over the hero
   * and the bottom of the felt and the row underneath never moves a pixel.
   *
   * The reserve every other stylesheet reads is `--sp-action-reserve`, and it
   * is now a constant declared in TablePage.css rather than a measurement of
   * `.action-panel-wrapper`, so opening the overlay cannot change it by any
   * route at all. (It could not before either — this panel is `position: fixed`
   * and not part of that wrapper's flow — but "cannot, because of where the
   * markup happens to sit" is a fact somebody can edit away, and on 2026-08-27
   * a different collapse of that same wrapper did resize the table twice a
   * hand.) The table must not reflow when the slider appears.
   */
  const raiseOverlay = (() => {
    if (!isRaiseMode) return null;
    /**
     * THE ONE SIZING CONTROL — a vertical rail, at every width.
     *
     * Dan 2026-08-27: "there should be a slider located on the right, that
     * slides up and down (NEVER SIDE TO SIDE) that moves the bets up in small
     * increments."
     *
     * It is still a native `<input type="range">` — that is what gives it a
     * real thumb, arrow-key and Home/End support, and the whole
     * aria-valuemin/max/now/text contract for free — and the stylesheet turns
     * it on its side with `rotate(-90deg)` (see
     * `.raise-slider-vertical__rail .raise-slider` in ActionPanel.css).
     *
     * WHY `orient="vertical"` IS GONE. It was set here so Firefox would render
     * the input natively vertical, and the CSS rotation was gated behind
     * `@supports (-webkit-appearance: none) and (not (-moz-appearance: none))`
     * so it applied to WebKit and not to Firefox. That is two geometries, and
     * the gate has to guess correctly which engine it is standing in — a query
     * about a vendor-prefixed ALIAS, which is precisely the kind of thing an
     * engine adds for web compatibility without telling anyone. Guess wrong and
     * the rotation is skipped, at which point a phone gets a horizontal range
     * input squeezed into a 28px-wide column: side to side, in the one place
     * Dan has now said twice it must never be.
     *
     * Rotation with no `orient` is ONE geometry on every engine, and it is the
     * safe one: the element's own axis is horizontal, so a browser that ignores
     * the transform entirely still shows a working slider rather than a
     * zero-length one. Drag mapping falls out of the same transform — screen-Y
     * becomes the input's local X, so a purely SIDEWAYS drag moves the value by
     * nothing at all. Arrow keys are unaffected: Up and Right both increase a
     * range input on every engine, so Up still means "bet more".
     */
    const sliderEl = (
      <input
        type="range"
        className="raise-slider"
        min={minRaise}
        max={maxRaise}
        /* One chip, not one big blind. See betSliderStep. */
        step={sliderStep}
        value={raiseAmount}
        onChange={handleSliderChange}
        style={{ '--slider-progress': `${sliderProgress}%` } as React.CSSProperties}
        aria-label={`${wagerVerb} Amount`}
        aria-valuemin={minRaise}
        aria-valuemax={maxRaise}
        aria-valuenow={raiseAmount}
        aria-valuetext={`${wagerVerb} ${formatChips(raiseAmount)}`}
      />
    );

    /* The main column on the left holds amount + presets + confirm; the rail
       sits in the reserved right-hand gutter (spec §5.2). */
    return (
      <div className="raise-layout">
        <div className="raise-main">
          {/* Amount Display with +/- */}
          <div className="raise-header">
            <button
              className="raise-adjust raise-adjust--minus"
              onClick={() => adjustRaise(-sliderStep)}
              disabled={raiseAmount <= minRaise}
              aria-label={`Decrease By ${formatChips(sliderStep)}`}
            >
              −
            </button>
            <div className="raise-value">
              {amountTyping ? (
                <input
                  ref={amountInputRef}
                  type="text"
                  /* iOS shows the digits-only keypad; Android still gets a
                       numeric keyboard with the spec-required decimal point. */
                  inputMode="decimal"
                  pattern="[0-9]*[.,]?[0-9]*"
                  className="raise-value__input"
                  value={amountDraft}
                  /* Filter as they type. A raw text field accepts "12e5",
                       and Number("12e5") is 1,200,000 - a silent shove on a
                       control the player thinks is a bet box. */
                  onChange={(e) => setAmountDraft(sanitizeAmountDraft(e.target.value))}
                  onBlur={commitAmountEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitAmountEdit();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelAmountEdit();
                    }
                  }}
                  aria-label={`Type Exact Bet Amount, Between ${formatChips(
                    minRaise
                  )} And ${formatChips(maxRaise)}`}
                />
              ) : (
                <button
                  type="button"
                  className="raise-value__amount"
                  onClick={beginEditAmount}
                  aria-label={`Edit Bet Amount ${formatChips(raiseAmount)} - Opens Numeric Keyboard`}
                  title="Tap To Type Exact Amount"
                >
                  {formatChips(raiseAmount)}
                </button>
              )}
              {/* Big blinds only when the player asked for them — chips are
                  the default everywhere (Dan 2026-08-25). */}
              {showStackInBB && bigBlind > 0 && !amountTyping && (
                <span className="raise-value__bb">{(raiseAmount / bigBlind).toFixed(1)} BB</span>
              )}
            </div>
            <button
              className="raise-adjust raise-adjust--plus"
              onClick={() => adjustRaise(sliderStep)}
              disabled={raiseAmount >= maxRaise}
              aria-label={`Increase By ${formatChips(sliderStep)}`}
            >
              +
            </button>
          </div>

          {/* THERE IS NO HORIZONTAL SLIDER HERE ANY MORE, and the absence is
              the feature — see the `verticalSlider` prop docstring. The rail
              below is the only sizing control, at every width. Do not
              reintroduce a `.raise-slider-wrap` branch: on a phone that gesture
              is the table-switch swipe. */}

          {/* Preset Row */}
          {showBetSizePresets && (
            <div className="raise-presets">
              {presets.map((p) => (
                <button
                  key={p.label}
                  className={`raise-preset${raiseAmount === p.value ? ' raise-preset--on' : ''}`}
                  onClick={() => setPreset(p.value)}
                  /* Only dead when there is no legal raise at all. The old
                       `p.value < minRaise` test could never fire (value is
                       already clamped to minRaise) while `p.value > maxRaise`
                       greyed out every preset a short stack could still shove
                       into. Over-stack now snaps to all-in, per spec 5.2. */
                  disabled={minRaise > maxRaise}
                  title={`${wagerVerb} ${formatChips(p.value)}`}
                  aria-label={`${p.label} - ${wagerVerb} ${formatChips(p.value)}`}
                >
                  {p.label}
                </button>
              ))}
              <button
                className="raise-preset raise-preset--allin"
                onClick={handleAllIn}
                // Never offer a shove hero is not entitled to make. The
                // server would reject it, but a button that produces an
                // error toast is a broken button.
                disabled={!canAllIn}
                title={`All In For ${formatChips(allInThreshold)}`}
                aria-label={`Bet All In For ${formatChips(allInThreshold)}`}
              >
                ALL IN
              </button>
            </div>
          )}
          {/* Confirm / Cancel Row */}
          <div className="raise-actions">
            <button
              className="raise-cancel"
              onClick={() => setIsRaiseMode(false)}
              aria-label="Back"
            >
              Back
            </button>
            {/* 2026-08-20: the confirm button said "Raise N" even when N was
                  hero's whole stack and handleConfirmRaise was about to
                  dispatch `allin`. Now that the slider can actually reach the
                  top (see sliderGridMax), that state is one drag away, and a
                  button that says Raise while it shoves is the same class of
                  lie the ALL IN label had. Say which action it is. */}
            <button
              className={`raise-confirm${
                raiseAmount >= allInThreshold ? ' raise-confirm--allin' : ''
              }`}
              onClick={handleConfirmRaise}
              aria-label={
                raiseAmount >= allInThreshold
                  ? `All In For ${formatChips(raiseAmount)}`
                  : `${wagerVerb} ${formatChips(raiseAmount)}`
              }
            >
              {raiseAmount >= allInThreshold ? 'All In' : wagerVerb} {formatChips(raiseAmount)}
            </button>
          </div>
        </div>

        {/* The vertical rail, in the gutter reserved on the right (spec §5.2).
              A CSS-rotated <input type="range"> inside a column that stretches
              to the panel's full height, so the thumb travels the whole of it.
              Tick marks are 25/50/75/100% of the legal range; the top one is
              the all-in by construction. Rendered unconditionally — there is no
              other sizing control. */}
        <div className="raise-slider-vertical">
          <div
            className="raise-slider-vertical__rail"
            ref={setRailNode}
            style={{ ['--raise-rail-length' as string]: `${railLength}px` }}
          >
            {sliderEl}
            <div className="raise-slider-vertical__ticks" aria-hidden="true">
              {/* BB labels at 25/50/75/100% of the raise range */}
              {[100, 75, 50, 25].map((pct) => {
                // Evenly spaced across the LEGAL range, which already ends
                // at the hero's stack - so the top tick is the all-in.
                // Snapped onto the slider's own grid: a tick that names an
                // amount the thumb cannot land on is a target you cannot
                // hit. `Math.round` used to do this job, which also erased
                // the label entirely at 0.25/0.50 stakes, where four ticks
                // across a 10-chip range all rounded to the same integer.
                const val = snapToSliderGrid(minRaise + (maxRaise - minRaise) * (pct / 100));
                const isTop = pct === 100;
                return (
                  <div
                    key={pct}
                    className={`raise-slider-vertical__tick${
                      isTop ? ' raise-slider-vertical__tick--max' : ''
                    }`}
                    style={{ bottom: `${pct}%` }}
                  >
                    <span className="raise-slider-vertical__tick-label">
                      {isTop ? 'ALL IN' : formatChips(val)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          {/* Dan 2026-08-25: the max cap sat at the top of this column at
                exactly the height of the 100% tick label, so "26BB" and
                "ALL IN" printed on top of each other (visible in his
                screenshot as "A26BB"). They named the same number anyway —
                the top tick IS the all-in — so only the floor is labelled
                here now. Do not re-add a --max cap without moving the top
                tick label out of its way first.
                And the floor prints CHIPS unless the player switched to BB;
                every other number on the felt already did. */}
          <div className="raise-slider-vertical__caps" aria-hidden="true">
            <span className="raise-slider-vertical__cap raise-slider-vertical__cap--min">
              {showStackInBB && bigBlind > 0
                ? `${Math.round(minRaise / bigBlind)}BB`
                : formatChips(minRaise)}
            </span>
          </div>
        </div>
      </div>
    );
  })();

  // ─── PINNED 3-BUTTON ROW ─────────────────────────────────────
  // Always rendered, in every state, flush with the bottom of the viewport.
  // The sizing overlay above it is a sibling, not a replacement.
  return (
    <div
      ref={panelRootRef}
      className={`action-panel${isMyTurn ? ' action-panel--active' : ''}${
        turnPulse ? ' action-panel--attention' : ''
      }${isRaiseMode ? ' action-panel--raise action-panel--raise-vertical' : ''}${
        connectionStale ? ' action-panel--stale' : ''
      }`}
      data-connection={connectionStale ? 'stale' : 'live'}
    >
      {raiseOverlay}
      {connectionStale && (
        <div className="action-panel__stale-note" role="status" aria-live="polite">
          Reconnecting To The Table, These Buttons May Be A Moment Behind
        </div>
      )}
      {/* ═══ THE ROW IS NOT CONDITIONAL. ═══════════════════════════════════
          AUDIT 2026-08-25. This was `{!isRaiseMode && (<div className="action-row">`,
          which quietly reverted Dan's 2026-08-25 item 5 — "these 3 action
          buttons should be on the bottom, and if you click Raise, the action
          slider and other buttons pop open and can OVERLAY the Hero" — back to
          the older behaviour where raise mode REPLACED the whole panel.

          Nothing else in this component or its stylesheet had been reverted
          with it, so five things had been dead ever since:

            - `handleRaiseClick`'s `if (isRaiseMode) { setIsRaiseMode(false) }`
              close branch: the button it belongs to was not on screen;
            - `action-btn--on`, a whole styling rule written for "it stays on
              the row now and a second tap closes the overlay";
            - `aria-expanded={isRaiseMode}`, which could only ever be false;
            - `.action-panel--raise .raise-layout { margin: 0 auto 10px }` —
              a documented gap between the overlay and "the row it floats
              above", floating above nothing;
            - the whole premise of `--sp-bottom-row-h`, which is the measured
              height of THIS row and which every other stylesheet reserves
              against. A row that disappears is a reserve that lies.

          The panel is `position: fixed; bottom: 0`, so the overlay grows the
          panel UPWARD over the felt and this row does not move a pixel. */}
      <div className="action-row">
        {/* FOLD — Always Red, Left */}
        <button
          className="action-btn action-btn--fold"
          onClick={() => {
            haptic.light(); // FIX 183: Bible V8 §5.4 — fold = light haptic (was medium)
            onAction('fold');
          }}
          disabled={!canFold}
          title={isDesktop ? 'Fold (F Or Q)' : undefined}
          aria-label="Fold"
        >
          <span className="action-btn__label">Fold</span>
          {isDesktop && <span className="action-btn__shortcut">F</span>}
        </button>

        {/* CHECK or CALL — Green, Center */}
        {canCheck ? (
          <button
            className="action-btn action-btn--check"
            onClick={() => {
              haptic.light(); // FIX 183: Bible V8 §5.4 — check = light haptic (was medium)
              onAction('check');
            }}
            title={isDesktop ? 'Check/Call (C Or W)' : undefined}
            aria-label="Check"
          >
            <span className="action-btn__label">Check</span>
            {isDesktop && <span className="action-btn__shortcut">C</span>}
          </button>
        ) : canCall ? (
          <button
            className="action-btn action-btn--call"
            onClick={() => {
              haptic.light(); // FIX 183: Bible V8 §5.4 — call = light haptic (was medium)
              onAction('call');
            }}
            title={isDesktop ? 'Check/Call (C Or W)' : undefined}
            aria-label={`Call ${formatChips(callAmount)}`}
          >
            <span className="action-btn__label">Call</span>
            <span className="action-btn__amount">{formatChips(callAmount)}</span>
            {showPotOdds && pot > 0 && callAmount > 0 && (
              <span
                className="action-btn__odds"
                style={{ fontSize: '11px', opacity: 0.7, marginTop: '2px' }}
              >
                {Math.round((callAmount / (pot + callAmount)) * 100)}%
              </span>
            )}
            {isDesktop && <span className="action-btn__shortcut">C</span>}
          </button>
        ) : (
          <button className="action-btn action-btn--check" disabled>
            <span className="action-btn__label">-</span>
          </button>
        )}

        {/* RAISE — Amber/Orange, Right */}
        {canAllIn && !canRaise ? (
          <button
            className="action-btn action-btn--allin"
            onClick={handleAllIn}
            title={isDesktop ? 'Raise/Bet (R Or E)' : undefined}
            aria-label="All In"
          >
            <span className="action-btn__label">All In</span>
            {/* 2026-08-20: this printed `maxRaise`. In POT-LIMIT maxRaise is
                the POT CAP, not the stack — so in PLO the button read
                "All In 47" and the tap shoved 300. handleAllIn was fixed to
                dispatch allInThreshold in August with the note that "sending
                an amount that contradicts the action is a trap"; the LABEL
                kept the trap, and the label is the part the player reads. */}
            <span className="action-btn__amount">{formatChips(allInThreshold)}</span>
            {isDesktop && <span className="action-btn__shortcut">R</span>}
          </button>
        ) : (
          <button
            className={`action-btn action-btn--raise${isRaiseMode ? ' action-btn--on' : ''}`}
            onClick={handleRaiseClick}
            disabled={!canRaise}
            title={isDesktop ? 'Raise/Bet (R Or E)' : undefined}
            /* The button survives the overlay opening now (Dan 2026-08-25,
               item 5), so it is a disclosure control rather than a one-way
               door: say which way the next tap goes. */
            aria-expanded={isRaiseMode}
            aria-label={`${isRaiseMode ? 'Close' : 'Open'} ${wagerVerb} Panel`}
          >
            {/* Per PokerBros spec §5.1: the Raise button itself shows ONLY
                the word "Raise" (or "Bet" when no current bet). The actual
                sizing — including 2X/3X/4X preflop presets and 33/50/75/POT
                postflop presets — lives in the bet-sizing panel that opens
                when this button is tapped. We removed the prior "{N} BB"
                sub-label which the user explicitly flagged as wrong. */}
            <span className="action-btn__label">{wagerVerb}</span>
            {/* 2026-08-23: in fixed limit the amount is NOT a choice the player
                is about to make in a sizing panel — it is the only legal wager
                on this street. Hiding it (correct for no-limit, per the spec
                note above) would mean tapping blind, so print it. */}
            {isFixedLimit && <span className="action-btn__amount">{formatChips(minRaise)}</span>}
            {isDesktop && <span className="action-btn__shortcut">R</span>}
          </button>
        )}
      </div>
    </div>
  );
}

export { ActionPanel };
