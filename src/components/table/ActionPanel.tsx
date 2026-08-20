/**
 * CLUB ARENA — Action Panel Component (Premium PokerBros-Style)
 * Large action buttons: Fold (red), Check/Call (green), Raise (amber/gold)
 * Professional layout with raise mode sub-panel, slider, and presets
 * PokerBros specs: 70-80px buttons, 16px radius, premium polish with glows and gradients
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { haptic } from '../../services/SoundService';
import './ActionPanel.css';

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
  onAction: (action: 'fold' | 'check' | 'call' | 'raise' | 'allin', amount?: number) => void;
  isMyTurn?: boolean;
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
   * Phase 2 T1-02: render the slider vertically on the right side per spec §5.2
   * "Vertical or angled slider on the RIGHT side of the screen". When false,
   * the legacy horizontal slider sits between amount-row and preset-row.
   * Defaults to true (this is the spec-compliant behavior); explicit prop lets
   * the parent fall back to horizontal during the visual rollout if needed.
   */
  verticalSlider?: boolean;
}

function formatChips(amount: number): string {
  if (amount >= 1000000) return `${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 10000) return `${(amount / 1000).toFixed(1)}K`;
  if (amount === Math.floor(amount)) return amount.toLocaleString();
  return amount.toFixed(2);
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
 *       the pot."  Rounding went through `roundToChip`, which snaps to the
 *       NEAREST half-blind - so it rounded DOWN as readily as up, and a 1/2
 *       game produced amounts like 22.5. Presets now ceil to a whole number.
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
  const { isPreflop, bigBlind, currentBet, callAmount, pot, minRaise, maxRaise, isPotLimit } =
    input;

  // Whole-number bounds. Floor the ceiling and ceil the floor so that every
  // value we can emit is both whole AND legal.
  const capWhole = Math.floor(maxRaise);
  const minWhole = Math.ceil(minRaise);

  const finalize = (label: string, raw: number): RaisePreset => {
    // If the legal minimum is already above the ceiling, hero has no raise
    // room left; the only legal raise-TO is the ceiling itself.
    if (minWhole > capWhole) return { label, raw, value: maxRaise, cappedByMax: true };
    const whole = Math.ceil(raw);
    const capped = Math.min(whole, capWhole);
    return { label, raw, value: Math.max(minWhole, capped), cappedByMax: capped < whole };
  };

  if (isPreflop) {
    // The bet being faced. Unopened pot -> the big blind.
    const base = Math.max(currentBet, bigBlind) || bigBlind || 1;
    const multiples = isPotLimit ? [2, 3, 4] : [2, 3, 4, 5];
    const presets = multiples.map((n) => finalize(`${n}X`, base * n));
    if (isPotLimit) {
      presets.push(finalize('POT', potSizedRaiseTo(currentBet, pot, callAmount)));
    }
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
  onAction,
  isMyTurn = true,
  showPotOdds = false,
  confirmAllIn: _confirmAllInDeprecated,
  showBetSizePresets = true,
  isPreflop = false,
  isPotLimit = false,
  currentBet = 0,
  raiseIntent,
  verticalSlider = true,
}: ActionPanelProps) {
  const smallestChip = Math.max(bigBlind / 2, 0.01);
  const minRaise = roundToChip(rawMinRaise, smallestChip, rawMinRaise, rawMaxRaise);
  const maxRaise = rawMaxRaise;
  // Only an amount that reaches the REAL all-in threshold is an all-in.
  const allInThreshold = allInTo ?? rawMaxRaise;
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
  useEffect(() => {
    document.body.classList.toggle('ca-raising', isRaiseMode);
    return () => document.body.classList.remove('ca-raising');
  }, [isRaiseMode]);
  // Phase 2 T1-03: spec §5.2 — tapping the amount opens a numeric keyboard.
  // amountTyping toggles the inline input; amountDraft holds the raw text
  // while the user types so we don't fight their cursor mid-edit. Commit on
  // Enter / blur — parse, clamp to [minRaise, maxRaise], over-stack snaps
  // to all-in (= maxRaise per spec).
  const [amountTyping, setAmountTyping] = useState(false);
  const [amountDraft, setAmountDraft] = useState<string>('');
  const amountInputRef = useRef<HTMLInputElement | null>(null);
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1024
  );
  const prevTurnRef = useRef(isMyTurn);

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
    setRaiseAmount(roundToChip(target, smallestChip, minRaise, maxRaise));
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

  // Dan 2026-04-17: the vertical slider was breaking on narrow phones — ticks
  // piled up, progress fill looked empty at min, BB labels overlapped the
  // amount. Force the legacy horizontal slider on mobile; keep vertical on
  // desktop/tablet where there's room to breathe.
  const effectiveVerticalSlider = verticalSlider && isDesktop;

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
      }),
    [isPreflop, bigBlind, currentBet, callAmount, pot, minRaise, maxRaise, isPotLimit]
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
  const sliderStep = bigBlind || 1;
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
    setIsRaiseMode(true);
    setRaiseAmount(minRaise);
    lastSnapRef.current = minRaise;
  }, [canRaise, canAllIn, minRaise]);

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

  const adjustRaise = useCallback(
    (delta: number) => {
      haptic.light();
      setRaiseAmount((prev) => roundToChip(prev + delta, smallestChip, minRaise, maxRaise));
    },
    [minRaise, maxRaise, smallestChip]
  );

  const setPreset = useCallback(
    (value: number) => {
      haptic.medium();
      setRaiseAmount(roundToChip(value, smallestChip, minRaise, maxRaise));
    },
    [minRaise, maxRaise, smallestChip]
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
  }, [raiseAmount]);

  const commitAmountEdit = useCallback(() => {
    setAmountTyping(false);
    if (!amountDraft) return; // empty input — keep prior amount
    // Allow comma decimals (some EU locales) and strip $ / spaces.
    const cleaned = amountDraft.replace(/[,\s$]/g, '');
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed) || parsed <= 0) return; // garbage — keep prior
    // Spec §5.2:
    //   - exceeds stack → AUTO-CAPS to all-in (= maxRaise)
    //   - below minimum → snaps to min legal
    // roundToChip already clamps into [minRaise, maxRaise]; the all-in cap is
    // therefore implicit (maxRaise IS the all-in amount per the engine).
    const next = roundToChip(parsed, smallestChip, minRaise, maxRaise);
    setRaiseAmount(next);
    haptic.medium();
  }, [amountDraft, smallestChip, minRaise, maxRaise]);

  const cancelAmountEdit = useCallback(() => {
    setAmountTyping(false);
    setAmountDraft('');
  }, []);

  // Slider change with snap-to-preset haptic feedback
  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = Number(e.target.value);
      // Top of the grid means "all the way" — see sliderGridMax above.
      const val =
        raw >= sliderGridMax ? maxRaise : roundToChip(raw, smallestChip, minRaise, maxRaise);
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
    // minRaise / maxRaise / smallestChip / sliderGridMax are all read above;
    // they were missing here and only stayed correct by accident, because
    // `presets` happens to change whenever they do.
    [bigBlind, presets, smallestChip, minRaise, maxRaise, sliderGridMax]
  );

  const sliderProgress =
    maxRaise > minRaise ? ((raiseAmount - minRaise) / (maxRaise - minRaise)) * 100 : 0;

  // ─── RAISE MODE ──────────────────────────────────────────────
  if (isRaiseMode) {
    // Phase 2 T1-02: shared slider markup so the vertical and horizontal
    // variants stay in lockstep for accessibility (same min/max/step/aria-*).
    const sliderEl = (
      <input
        type="range"
        className="raise-slider"
        min={minRaise}
        max={maxRaise}
        step={bigBlind || 1}
        value={raiseAmount}
        onChange={handleSliderChange}
        style={{ '--slider-progress': `${sliderProgress}%` } as React.CSSProperties}
        aria-label="Raise amount"
        aria-valuemin={minRaise}
        aria-valuemax={maxRaise}
        aria-valuenow={raiseAmount}
        aria-valuetext={`Raise to ${formatChips(raiseAmount)}`}
        // Firefox-specific: native vertical orientation.
        // WebKit/Blink rotate the horizontal slider via CSS in the
        // .raise-slider--vertical wrapper.
        {...(effectiveVerticalSlider ? { orient: 'vertical' as const } : {})}
      />
    );

    return (
      <div
        className={`action-panel action-panel--raise${effectiveVerticalSlider ? ' action-panel--raise-vertical' : ''}`}
      >
        {/* Phase 2 T1-02: vertical layout splits the panel — main column on
            the left holds amount + presets + confirm; slider sits on the right
            edge per spec §5.2. Horizontal fallback retains the legacy stack. */}
        <div className="raise-layout">
          <div className="raise-main">
            {/* Amount Display with +/- */}
            <div className="raise-header">
              <button
                className="raise-adjust raise-adjust--minus"
                onClick={() => adjustRaise(-bigBlind)}
                disabled={raiseAmount <= minRaise}
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
                    onChange={(e) => setAmountDraft(e.target.value)}
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
                    aria-label={`Type exact bet amount, between ${formatChips(
                      minRaise
                    )} and ${formatChips(maxRaise)}`}
                  />
                ) : (
                  <button
                    type="button"
                    className="raise-value__amount"
                    onClick={beginEditAmount}
                    aria-label={`Edit bet amount ${formatChips(raiseAmount)} — opens numeric keyboard`}
                    title="Tap to type exact amount"
                  >
                    {formatChips(raiseAmount)}
                  </button>
                )}
                {bigBlind > 0 && !amountTyping && (
                  <span className="raise-value__bb">{(raiseAmount / bigBlind).toFixed(1)} BB</span>
                )}
              </div>
              <button
                className="raise-adjust raise-adjust--plus"
                onClick={() => adjustRaise(bigBlind)}
                disabled={raiseAmount >= maxRaise}
              >
                +
              </button>
            </div>

            {/* Horizontal slider — only rendered in legacy mode. */}
            {!effectiveVerticalSlider && (
              <div className="raise-slider-wrap">
                {sliderEl}
                <div className="raise-slider-ticks">
                  <div className="raise-slider-tick" style={{ left: '25%' }} />
                  <div className="raise-slider-tick" style={{ left: '50%' }} />
                  <div className="raise-slider-tick" style={{ left: '75%' }} />
                  <div className="raise-slider-tick" style={{ left: '100%' }} />
                </div>
              </div>
            )}

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
                    title={`Raise to ${formatChips(p.value)}`}
                    aria-label={`Bet ${p.label} — raise to ${formatChips(p.value)}`}
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
                  title={`All in for ${formatChips(allInThreshold)}`}
                  aria-label={`Bet all in for ${formatChips(allInThreshold)}`}
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
                    ? `All in for ${formatChips(raiseAmount)}`
                    : `Raise to ${formatChips(raiseAmount)}`
                }
              >
                {raiseAmount >= allInThreshold ? 'All In' : 'Raise'}{' '}
                {formatChips(raiseAmount)}
              </button>
            </div>
          </div>

          {/* Phase 2 T1-02: vertical slider rail on the right per spec §5.2.
              Uses a CSS-rotated <input type="range"> wrapped in a fixed-height
              column. Tick marks correspond to 25/50/75/100% of the legal range.
              Hidden when verticalSlider is false. */}
          {effectiveVerticalSlider && (
            <div className="raise-slider-vertical">
              <div className="raise-slider-vertical__rail">
                {sliderEl}
                <div className="raise-slider-vertical__ticks" aria-hidden="true">
                  {/* BB labels at 25/50/75/100% of the raise range */}
                  {[100, 75, 50, 25].map((pct) => {
                    const val = minRaise + (maxRaise - minRaise) * (pct / 100);
                    const bbLabel = bigBlind > 0 ? `${Math.round(val / bigBlind)}` : '';
                    return (
                      <div
                        key={pct}
                        className="raise-slider-vertical__tick"
                        style={{ bottom: `${pct}%` }}
                      >
                        {bigBlind > 0 && (
                          <span className="raise-slider-vertical__tick-label">{bbLabel}BB</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="raise-slider-vertical__caps" aria-hidden="true">
                <span className="raise-slider-vertical__cap raise-slider-vertical__cap--max">
                  {formatChips(maxRaise)}
                </span>
                <span className="raise-slider-vertical__cap raise-slider-vertical__cap--min">
                  {formatChips(minRaise)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── STANDARD 3-BUTTON MODE ──────────────────────────────────
  return (
    <div
      className={`action-panel ${isMyTurn ? 'action-panel--active' : ''} ${turnPulse ? 'action-panel--attention' : ''}`}
    >
      <div className="action-row">
        {/* FOLD — Always Red, Left */}
        <button
          className="action-btn action-btn--fold"
          onClick={() => {
            haptic.light(); // FIX 183: Bible V8 §5.4 — fold = light haptic (was medium)
            onAction('fold');
          }}
          disabled={!canFold}
          title={isDesktop ? 'Fold (F or Q)' : undefined}
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
            title={isDesktop ? 'Check/Call (C or W)' : undefined}
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
            title={isDesktop ? 'Check/Call (C or W)' : undefined}
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
            <span className="action-btn__label">—</span>
          </button>
        )}

        {/* RAISE — Amber/Orange, Right */}
        {canAllIn && !canRaise ? (
          <button
            className="action-btn action-btn--allin"
            onClick={handleAllIn}
            title={isDesktop ? 'Raise/Bet (R or E)' : undefined}
            aria-label="All in"
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
            className="action-btn action-btn--raise"
            onClick={handleRaiseClick}
            disabled={!canRaise}
            title={isDesktop ? 'Raise/Bet (R or E)' : undefined}
            aria-label="Open raise panel"
          >
            {/* Per PokerBros spec §5.1: the Raise button itself shows ONLY
                the word "Raise" (or "Bet" when no current bet). The actual
                sizing — including 2X/3X/4X preflop presets and 33/50/75/POT
                postflop presets — lives in the bet-sizing panel that opens
                when this button is tapped. We removed the prior "{N} BB"
                sub-label which the user explicitly flagged as wrong. */}
            <span className="action-btn__label">{callAmount > 0 ? 'Raise' : 'Bet'}</span>
            {isDesktop && <span className="action-btn__shortcut">R</span>}
          </button>
        )}
      </div>
    </div>
  );
}

export { ActionPanel };
