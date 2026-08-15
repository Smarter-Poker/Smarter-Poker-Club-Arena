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
  pot: number;
  bigBlind: number;
  onAction: (action: 'fold' | 'check' | 'call' | 'raise' | 'allin', amount?: number) => void;
  isMyTurn?: boolean;
  showPotOdds?: boolean;
  confirmAllIn?: boolean;
  showBetSizePresets?: boolean;
  /** Phase 2 T1-02 hint — drives preflop 2X/3X/4X/5X presets vs postflop fraction presets. */
  isPreflop?: boolean;
  /**
   * Highest bet on the CURRENT street (server-authoritative `currentBet`), as a
   * raise-TO absolute. Required for the multiplier presets to mean anything
   * when hero is facing a bet: "3X" against an open to 15 is a raise to 45, not
   * to 3 big blinds. Defaults to 0 (unopened pot) -> multipliers fall back to
   * the big blind, which is the correct baseline for an opening raise.
   */
  currentBet?: number;
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

export default function ActionPanel({
  canFold,
  canCheck,
  canCall,
  canRaise,
  canAllIn,
  callAmount,
  minRaise: rawMinRaise,
  maxRaise: rawMaxRaise,
  pot,
  bigBlind,
  onAction,
  isMyTurn = true,
  showPotOdds = false,
  confirmAllIn = true,
  showBetSizePresets = true,
  isPreflop = false,
  currentBet = 0,
  verticalSlider = true,
}: ActionPanelProps) {
  const smallestChip = Math.max(bigBlind / 2, 0.01);
  const minRaise = roundToChip(rawMinRaise, smallestChip, rawMinRaise, rawMaxRaise);
  const maxRaise = rawMaxRaise;
  const [isRaiseMode, setIsRaiseMode] = useState(false);
  const [pendingAllIn, setPendingAllIn] = useState(false);
  const [raiseAmount, setRaiseAmount] = useState(minRaise);
  const [turnPulse, setTurnPulse] = useState(false);
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
      setPendingAllIn(false);
    }
  }, [isMyTurn]);

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

  // Phase 2 T1-02 + T1-09: PokerBros §5.2 + §5.5 ("MUST IMPROVE").
  //   Preflop:  BB multipliers (2X / 3X / 4X) per §5.2 OBSERVED.
  //   Postflop: 33% / 50% / 75% / POT GTO Wizard quartet per §5.5 — replaces
  //             the 1/2 / 2/3 / POT trio with 4 presets so users get
  //             smaller-bet flexibility on the bottom end and 100% pot at top.
  //
  // 2026-08-15 ROOT-CAUSE FIX (Dan: "when hero is facing a bet and you click
  // 3X 4X 5X etc it's not calculating or changing the bet amount").
  //
  // The old math was `bigBlind * N`, then clamped into [minRaise, maxRaise].
  // Facing a raise, minRaise is already well above 4 big blinds — e.g. against
  // an open to 3BB the min raise-TO is 6BB — so 2X, 3X AND 4X all clamped to
  // the identical minRaise value. Every multiplier produced the same number and
  // the displayed amount never moved. That is precisely the reported symptom.
  //
  // A multiplier preset is a multiple of the BET BEING FACED, not of the blind.
  // Unopened, the bet being faced IS the big blind, so an opening raise still
  // reads 2X/3X/4X/5X of the BB exactly as before. Facing an open to 15, "3X"
  // now correctly means raise TO 45.
  //
  // Postflop presets are raise-TO absolutes too, so when hero is facing a bet a
  // "POT" raise is `currentBet + callAmount + (pot + callAmount)` — the standard
  // pot-sized-raise identity — not a bare fraction of the pot, which would have
  // been below the minimum and clamped into the same dead value.
  //
  const presets = useMemo(() => {
    const clamp = (raw: number) => roundToChip(raw, smallestChip, minRaise, maxRaise);

    if (isPreflop) {
      // Baseline: the live bet to beat. Unopened pot -> the big blind.
      const base = Math.max(currentBet, bigBlind) || bigBlind || 1;
      return [2, 3, 4, 5].map((n) => ({
        label: `${n}X`,
        raw: base * n,
        value: clamp(base * n),
      }));
    }

    // Postflop. `pot` excludes hero's call, so the true pot after hero calls is
    // pot + callAmount; a pot-sized raise tops that with the call itself.
    const potAfterCall = pot + callAmount;
    const fractions: Array<[string, number]> = [
      ['33%', 0.33],
      ['50%', 0.5],
      ['75%', 0.75],
      ['POT', 1],
    ];
    return fractions.map(([label, f]) => {
      const raw = currentBet + callAmount + potAfterCall * f;
      return { label, raw, value: clamp(raw) };
    });
  }, [isPreflop, bigBlind, currentBet, callAmount, pot, smallestChip, minRaise, maxRaise]);

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
    if (raiseAmount >= maxRaise) {
      if (confirmAllIn) {
        setPendingAllIn(true);
        return;
      }
      onAction('allin', maxRaise);
    } else {
      onAction('raise', raiseAmount);
    }
    setIsRaiseMode(false);
  }, [raiseAmount, maxRaise, onAction, confirmAllIn]);

  const handleAllIn = useCallback(() => {
    haptic.strong();
    if (confirmAllIn) {
      setPendingAllIn(true);
      return;
    }
    onAction('allin', maxRaise);
    setIsRaiseMode(false);
  }, [maxRaise, onAction, confirmAllIn]);

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
      const val = roundToChip(raw, smallestChip, minRaise, maxRaise);
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
    [bigBlind, presets]
  );

  const sliderProgress =
    maxRaise > minRaise ? ((raiseAmount - minRaise) / (maxRaise - minRaise)) * 100 : 0;

  // ─── ALL-IN CONFIRMATION MODE ────────────────────────────────
  if (pendingAllIn) {
    return (
      <div className="action-panel action-panel--raise action-panel--allin-confirm">
        <div className="raise-actions" style={{ flexDirection: 'column', gap: '8px' }}>
          <button
            className="raise-confirm"
            style={{ backgroundColor: '#D32F2F', height: '64px', fontSize: '20px' }}
            onClick={() => {
              haptic.strong();
              onAction('allin', maxRaise);
              setPendingAllIn(false);
              setIsRaiseMode(false);
            }}
            aria-label={`Confirm all in ${formatChips(maxRaise)}`}
          >
            CONFIRM ALL-IN ({formatChips(maxRaise)})
          </button>
          <button
            className="raise-cancel"
            onClick={() => setPendingAllIn(false)}
            aria-label="Cancel all in"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

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
                    aria-label="Type exact bet amount"
                    aria-valuemin={minRaise}
                    aria-valuemax={maxRaise}
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
                  aria-label="Bet all in"
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
              <button
                className="raise-confirm"
                onClick={handleConfirmRaise}
                aria-label={`Raise ${formatChips(raiseAmount)}`}
              >
                Raise {formatChips(raiseAmount)}
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
            <span className="action-btn__amount">{formatChips(maxRaise)}</span>
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
