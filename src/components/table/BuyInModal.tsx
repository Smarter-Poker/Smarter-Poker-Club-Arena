/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BUY-IN MODAL — Table Buy-In Interface
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * premium-style buy-in modal with:
 * - Min/Max slider
 * - Quick amount buttons
 * - Auto rebuy toggle
 * - Account balance display
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { haptic, soundService } from '../../services/SoundService';
import {
  PlateButton,
  SPADE_CONSOLE_TOP_H,
  SPADE_CONSOLE_W,
  SPADE_CONSOLE_ZONES,
  ZoneText,
  zonePct,
} from '../console/SpadeConsole';
import { useFitText } from '../lobby/game-cards/useFitText';
import { compactChips } from '../../utils/format';
import './BuyInModal.css';
import { reportError } from '../../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BuyInModalProps {
  isOpen: boolean;
  recovery?: { amount: number; seat: number } | null;
  onClose: () => void;
  onConfirm: (amount: number, autoRebuy: boolean) => boolean | void | Promise<boolean | void>;
  tableName?: string;
  minBuyIn: number;
  maxBuyIn: number;
  defaultBuyIn?: number;
  /**
   * null = "we could not find out" (Dan 2026-09-04, the bust rebuy that
   * "failed to load"). It used to be collapsed to 0 one file up, so a failed
   * read rendered as INSUFFICIENT BALANCE on a player with chips - a dialog
   * that could not be confirmed and said nothing true. Unknown says unknown,
   * and offers a retry.
   */
  accountBalance: number | null;
  /** Re-read the balance when it is unknown. */
  onRetryBalance?: () => void;
  bigBlind: number;
  currency?: string;
  countdown?: number; // Seconds remaining to buy in
  /** FIX 136: If set, player recently cashed out and must buy in for at least this amount */
  cashoutRestriction?: number;
  /** Takes the player to the cashier. Without it the "Top Up Account" button is not rendered. */
  onTopUp?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatAmount(amount: number, _currency: string = ''): string {
  /* The lobby's compact figure: whole chips under a thousand, 1K / 1.2K /
     10K above it, always rounded down (Dan 2026-09-08). The amount the
     player actually buys in for is untouched (clampedBuyIn keeps its exact
     value); only the printed figure is compacted. */
  return compactChips(amount);
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function BuyInModal({
  isOpen,
  recovery,
  onClose,
  onConfirm,
  tableName,
  minBuyIn,
  maxBuyIn,
  defaultBuyIn,
  accountBalance,
  bigBlind,
  currency = '',
  countdown,
  cashoutRestriction,
  onTopUp,
  onRetryBalance,
}: BuyInModalProps) {
  // State
  const balanceKnown = accountBalance !== null;
  // Default to MAX buy-in (capped by account balance) — Dan's directive.
  // Unknown balance: default to the table max; the confirm stays closed below.
  const effectiveDefault =
    recovery?.amount ??
    (defaultBuyIn || Math.min(maxBuyIn, balanceKnown ? accountBalance : maxBuyIn));
  const [buyInAmount, setBuyInAmount] = useState(effectiveDefault);
  // Auto-rebuy was removed on 2026-08-20 (see the note in the render below).
  // `onConfirm` keeps its second parameter so callers and the atomic_table_buyin
  // signature are untouched; it is now always false rather than a promise the
  // platform does not keep.
  const autoRebuy = false;
  const [displayAmount, setDisplayAmount] = useState(effectiveDefault);
  const [isConfirmPulsing, setIsConfirmPulsing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const confirmInFlightRef = useRef(false);

  // 60-second kicker visual countdown
  const [timeLeft, setTimeLeft] = useState(60);

  // CHIP CONTINUITY: the server already caps the rejoin floor at max_buy_in
  // (fn_cash_effective_buyin). Mirror the cap anyway so a stale prop can never
  // push the slider's minimum above its maximum.
  const cappedCashoutRestriction = cashoutRestriction ? Math.min(cashoutRestriction, maxBuyIn) : 0;
  const effectiveMinBuyIn =
    cappedCashoutRestriction > minBuyIn ? cappedCashoutRestriction : minBuyIn;
  const animationFrameRef = useRef<number>(0);
  const countStartRef = useRef<number>(0);

  // LIVE E2E FIX 2026-08-15: the initial amount was captured by useState at
  // FIRST MOUNT, while accountBalance / blind props were still loading — the
  // modal could open showing a stale, below-minimum default (seen live:
  // 191.24 on a 200-minimum table). Re-derive and clamp the default every
  // time the modal OPENS (and if min/max settle late), from the live props.
  useEffect(() => {
    if (!isOpen) return;
    const fresh =
      recovery?.amount ??
      (defaultBuyIn || Math.min(maxBuyIn, balanceKnown ? accountBalance : maxBuyIn));
    const clamped = recovery?.amount ?? Math.max(minBuyIn, Math.min(maxBuyIn, fresh));
    if (Number.isFinite(clamped) && clamped > 0) {
      setBuyInAmount(clamped);
      setDisplayAmount(clamped);
    }
    // Intentionally NOT depending on accountBalance/defaultBuyIn: once open
    // with settled table limits, the player's own slider input must win.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, minBuyIn, maxBuyIn, recovery?.amount]);

  // Clamp buy-in to valid range
  const clampedBuyIn = useMemo(() => {
    return recovery?.amount ?? Math.max(effectiveMinBuyIn, Math.min(maxBuyIn, buyInAmount));
  }, [buyInAmount, effectiveMinBuyIn, maxBuyIn, recovery?.amount]);

  // Calculate slider percentage
  const sliderPercent = useMemo(() => {
    const range = maxBuyIn - effectiveMinBuyIn;
    return range > 0 ? ((clampedBuyIn - effectiveMinBuyIn) / range) * 100 : 0;
  }, [clampedBuyIn, effectiveMinBuyIn, maxBuyIn]);

  // Check if user has enough balance. Unknown is not enough - and not "insufficient".
  const hasEnoughBalance = balanceKnown && accountBalance >= clampedBuyIn;
  const canConfirm = !!recovery || hasEnoughBalance;

  // Animate amount counter when buyInAmount changes
  useEffect(() => {
    if (!isOpen) return;

    if (recovery) {
      setDisplayAmount(recovery.amount);
      return;
    }
    countStartRef.current = displayAmount;
    const startTime = Date.now();
    const duration = 400;

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / duration);

      // Easing function for smooth spring-like animation
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const current = countStartRef.current + (clampedBuyIn - countStartRef.current) * easeOut;

      setDisplayAmount(current);

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
      }
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [clampedBuyIn, isOpen, recovery?.amount]);

  // Pulse confirm button when ready
  useEffect(() => {
    if (hasEnoughBalance) {
      setIsConfirmPulsing(true);
      const timer = setTimeout(() => setIsConfirmPulsing(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [hasEnoughBalance]);

  /**
   * ESCAPE CLOSES THE SHEET (2026-08-28). Before this, the ONLY way out was
   * clicking the backdrop — unreachable by keyboard, and easy to miss on a
   * phone where the sheet fills the screen. Attached only while open so it
   * cannot swallow Escape for whatever is behind it, and it does not fire
   * mid-buy-in: a confirm already in flight must not be abandoned halfway.
   */
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isProcessing) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, isProcessing, onClose]);

  /**
   * 2026-08-20: the MAX BUY-IN was not reachable by dragging.
   *
   * `<input type="range">` only emits values on the grid `min + n*step`, and
   * this slider is `min={minBuyIn} max={maxBuyIn} step={bigBlind}`. A table's
   * min/max are whole multiples of the blind, so on paper the grid lands
   * exactly on max — but `maxBuyIn` is routinely NOT the table maximum: it is
   * clamped to what the player can actually afford. A balance of 137.50 at a
   * 1/2 table gives max 137.50 against min 40, and the slider tops out at
   * 136 — the player cannot buy in for everything they have, and the label
   * right above the slider says 137.50.
   *
   * Same fix as the raise slider: keep the step grid, and treat the last grid
   * position as the true maximum.
   */
  const sliderGridMax = useMemo(() => {
    const step = bigBlind || 1;
    if (!(maxBuyIn > effectiveMinBuyIn)) return maxBuyIn;
    const steps = Math.floor((maxBuyIn - effectiveMinBuyIn) / step);
    return Math.round((effectiveMinBuyIn + steps * step) * 100) / 100;
  }, [effectiveMinBuyIn, maxBuyIn, bigBlind]);

  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = Number(e.target.value);
      setBuyInAmount(raw >= sliderGridMax ? maxBuyIn : raw);
    },
    [sliderGridMax, maxBuyIn]
  );

  // Handle confirm
  const handleConfirm = useCallback(async () => {
    if (!canConfirm || isProcessing) return;
    if (confirmInFlightRef.current) return;
    confirmInFlightRef.current = true;
    setConfirmError(null);
    setIsProcessing(true);
    try {
      try {
        soundService.playBuyInConfirm();
      } catch (audioError) {
        reportError(audioError, 'BuyInModal.confirm_sound_failed');
      }
      const confirmed = await onConfirm(clampedBuyIn, autoRebuy);
      if (confirmed === false) {
        setConfirmError('Buy-In Not Yet Confirmed.');
      }
    } catch (err) {
      reportError(err, 'BuyInModal.onConfirm_threw');
      setConfirmError('Unable To Confirm Your Buy-In. Please Check Your Connection And Try Again.');
    } finally {
      confirmInFlightRef.current = false;
      setIsProcessing(false);
    }
  }, [clampedBuyIn, autoRebuy, canConfirm, isProcessing, onConfirm]);

  if (!isOpen) return null;

  const minPressed = !recovery && Math.abs(clampedBuyIn - effectiveMinBuyIn) < 0.005;
  const maxPressed = !recovery && Math.abs(clampedBuyIn - maxBuyIn) < 0.005;
  const bigBlinds = bigBlind > 0 ? Math.round(clampedBuyIn / bigBlind) : 0;
  const primaryLabel = isProcessing
    ? 'Joining'
    : recovery
      ? 'Retry Original Buy-In'
      : hasEnoughBalance
        ? 'Buy Chips'
        : balanceKnown
          ? 'Insufficient Balance'
          : 'Balance Unavailable';

  return (
    /**
     * ACCESSIBILITY 2026-08-28. This is the modal every player passes through
     * to sit down, and it had no dialog semantics at all: no role, no
     * aria-modal, no accessible name, and no Escape handler - the backdrop
     * click was the only way out, which is not reachable by keyboard. The
     * overlay must not be aria-hidden: that would hide the dialog and its
     * error messages from assistive technology too.
     *
     * THE MASTER (2026-09-04, approved 2026-09-08). The sheet is Dan's spade
     * PLO master - the render every Omaha card on a phone is drawn from - cut
     * into its head (crest, header well, pill slot), a stage on the rails, and
     * its deck (the four bays, the two plates, the chip). Table name and
     * BUY-IN sit in the header well, the countdown in the well's painted pill
     * slot; the stage holds the one control the master does not paint - the
     * slider, which goes UP AND DOWN (Dan 2026-09-05: a side-to-side drag is
     * the table-switch gesture) - beside the live amount; the bays print
     * MIN / BB / MAX / BALANCE (MIN and MAX snap the amount when tapped); and
     * CLOSE / BUY CHIPS are the plates painted into the foot. Nothing else is
     * drawn or stuck on. Every figure is the lobby's compact one (1K, 1.2K).
     */
    <div
      className="buy-in-modal__overlay"
      onClick={() => {
        if (!confirmInFlightRef.current) onClose();
      }}
    >
      <div
        className="buy-in-modal ac-popup"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="buy-in-modal-title"
      >
        <div className="buy-in-modal__master">
          {/* ── Head: the master's header well ─────────────────────────── */}
          <div className="buy-in-modal__head">
            <ZoneText
              text={tableName || 'Take Your Seat'}
              className="sc__eyebrow sc-ink--blue"
              style={zonePct(SPADE_CONSOLE_ZONES.eyebrow, SPADE_CONSOLE_W, SPADE_CONSOLE_TOP_H)}
            />
            <h2
              id="buy-in-modal-title"
              className="sc-zone sc__title sc-ink--silver buy-in-modal__title"
              style={zonePct(SPADE_CONSOLE_ZONES.title, SPADE_CONSOLE_W, SPADE_CONSOLE_TOP_H)}
            >
              <span>Buy-In</span>
            </h2>
            {countdown !== undefined && (
              <ZoneText
                text={`${countdown}s`}
                className={`sc__pill buy-in-modal__countdown ${countdown <= 10 ? 'sc-ink--red' : 'sc-ink--gold'}`}
                style={zonePct(SPADE_CONSOLE_ZONES.pill, SPADE_CONSOLE_W, SPADE_CONSOLE_TOP_H)}
              />
            )}
          </div>

          {/* ── Stage: the vertical slider beside the live amount ──────── */}
          <div className="buy-in-modal__stage">
            {!recovery && (
              <div className="buy-in-modal__slider-container">
                <input
                  type="range"
                  className="buy-in-modal__slider"
                  min={effectiveMinBuyIn}
                  max={maxBuyIn}
                  value={clampedBuyIn}
                  onChange={handleSliderChange}
                  step={bigBlind}
                  aria-label="Buy-In Amount"
                  aria-orientation="vertical"
                  style={
                    {
                      '--slider-percent': `${sliderPercent}%`,
                    } as React.CSSProperties
                  }
                />
              </div>
            )}
            <div className="buy-in-modal__current-amount">
              <span className="sc-label sc-ink--blue">
                {recovery ? 'Original Buy-In' : 'Chips'}
              </span>
              <span className="buy-in-modal__amount-value sc-ink--silver" aria-live="polite">
                {formatAmount(displayAmount, currency)}
              </span>
              {recovery && !isProcessing && (
                <p role="status" className="sc-copy sc-copy--center buy-in-modal__recovery">
                  Your {formatAmount(recovery.amount)} Chip Buy-In For Seat {recovery.seat} Needs
                  Confirmation. We Will Check It Before Retrying The Same Buy-In.
                </p>
              )}
              {confirmError && !recovery && (
                <p role="alert" className="sc-copy sc-copy--center sc-ink--red buy-in-modal__error">
                  {confirmError}
                </p>
              )}
              {!balanceKnown && onRetryBalance && (
                <button
                  type="button"
                  className="buy-in-modal__balance-retry sc-ink--blue"
                  onClick={onRetryBalance}
                >
                  Retry
                </button>
              )}
            </div>
          </div>

          {/* ── Deck: the four bays, the two plates, the chip ──────────── */}
          <div className="buy-in-modal__deck">
            <BayLabel zone={BUY_IN_ZONES.bays[0].label} text="Min" />
            <BayLabel zone={BUY_IN_ZONES.bays[1].label} text="BB" />
            <BayLabel zone={BUY_IN_ZONES.bays[2].label} text="Max" />
            <BayLabel zone={BUY_IN_ZONES.bays[3].label} text="Balance" />
            <BayButton
              zone={BUY_IN_ZONES.bays[0].value}
              text={formatAmount(effectiveMinBuyIn, currency)}
              ink={minPressed ? 'white' : 'silver'}
              label="Buy In For The Minimum"
              pressed={minPressed}
              onClick={() => setBuyInAmount(effectiveMinBuyIn)}
              disabled={!!recovery}
            />
            <BayValue
              zone={BUY_IN_ZONES.bays[1].value}
              text={bigBlinds > 0 ? `${bigBlinds}BB` : '0'}
              ink="silver"
            />
            <BayButton
              zone={BUY_IN_ZONES.bays[2].value}
              text={formatAmount(maxBuyIn, currency)}
              ink={maxPressed ? 'white' : 'silver'}
              label="Buy In For The Maximum"
              pressed={maxPressed}
              onClick={() => setBuyInAmount(maxBuyIn)}
              disabled={!!recovery}
            />
            <BayValue
              zone={BUY_IN_ZONES.bays[3].value}
              text={balanceKnown ? formatAmount(accountBalance, currency) : 'Unavailable'}
              ink={!balanceKnown ? 'muted' : hasEnoughBalance ? 'silver' : 'red'}
              className={`buy-in-modal__balance-value ${balanceKnown && !hasEnoughBalance ? 'buy-in-modal__balance-value--insufficient' : ''}`}
            />

            {/* AUTO REBUY REMOVED 2026-08-20.
                The checkbox told the player: "When your stack drops to 50% of the
                initial buy-in, it will be automatically replenished." Nothing
                implemented that. `atomic_table_buyin` writes `table_seats.auto_rebuy`
                and NO code anywhere - SQL function, engine, or client - ever reads
                the column back; verified in production, 0 of 38,390 seat rows had it
                set. The one server-side auto-rebuy path is horse-only and its body is
                an explicit no-op. The threshold was a hardcoded `50` whose setter had
                no call sites.
                So a player could tick it, bust, and sit at zero waiting for a top-up
                that was never coming. Promising to protect someone's seat and then
                not doing it is worse than not offering it. If this is wanted, it
                needs a real server-side implementation and a product decision about
                automatically spending a player's wallet while they are away. */}

            {/* The plates painted into the foot: CLOSE on steel; BUY CHIPS (or
                the retry, or the reason it cannot proceed) on the blue glass. */}
            {!recovery && !hasEnoughBalance && balanceKnown && onTopUp ? (
              <PlateButton
                zone={BUY_IN_ZONES.secondaryAction}
                canvasH={BUY_IN_DECK_H}
                label="Top Up"
                ink="gold"
                disabled={isProcessing}
                onClick={onTopUp}
                aria-label="Top Up Account"
              />
            ) : (
              <PlateButton
                zone={BUY_IN_ZONES.secondaryAction}
                canvasH={BUY_IN_DECK_H}
                label="Close"
                disabled={isProcessing}
                onClick={() => {
                  if (!confirmInFlightRef.current) onClose();
                }}
                aria-label="Close Buy-In"
              />
            )}
            <PlateButton
              zone={BUY_IN_ZONES.primaryAction}
              canvasH={BUY_IN_DECK_H}
              label={primaryLabel}
              ink={canConfirm ? 'white' : 'red'}
              className={`buy-in-modal__confirm ${!canConfirm ? 'buy-in-modal__confirm--disabled' : ''} ${isConfirmPulsing ? 'buy-in-modal__confirm--pulse' : ''} ${isProcessing ? 'buy-in-modal__confirm--processing' : ''}`}
              onClick={handleConfirm}
              disabled={!canConfirm || isProcessing}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── The master's deck and its zones (pixels on the 1000-wide master) ──── */

const BUY_IN_ASSET_ROOT = `${import.meta.env.BASE_URL}assets/club-buttons/popups/buy-in-v1`;
export const BUY_IN_ASSETS = {
  /* The master's rows 350-1135: the four bays (labels lifted), the plates,
     the chip. The head is the console's own top slice. */
  deck: `${BUY_IN_ASSET_ROOT}/deck.png`,
  reference: `${BUY_IN_ASSET_ROOT}/source/approved-reference.png`,
} as const;
export const BUY_IN_DECK_H = 785;
const DECK_Y = 350;

const bay = (x: number) => ({
  label: { x, y: 418 - DECK_Y, width: 129, height: 40 },
  value: { x: x - 8, y: 501 - DECK_Y, width: 145, height: 136 },
});

export const BUY_IN_ZONES = {
  bays: [bay(127), bay(335), bay(539), bay(743)],
  secondaryAction: { x: 100, y: 746 - DECK_Y, width: 381, height: 129 },
  primaryAction: { x: 520, y: 746 - DECK_Y, width: 381, height: 129 },
} as const;

type BuyInZone = { x: number; y: number; width: number; height: number };

function BayLabel({ zone, text }: { zone: BuyInZone; text: string }) {
  return (
    <ZoneText
      text={text}
      className="buy-in-modal__bay-label sc-ink--blue"
      style={zonePct(zone, SPADE_CONSOLE_W, BUY_IN_DECK_H)}
    />
  );
}

function BayValue({
  zone,
  text,
  ink,
  className = '',
}: {
  zone: BuyInZone;
  text: string;
  ink: 'silver' | 'white' | 'red' | 'muted';
  className?: string;
}) {
  return (
    <ZoneText
      as="strong"
      text={text}
      className={`buy-in-modal__bay-value sc-ink--${ink} ${className}`.trim()}
      style={zonePct(zone, SPADE_CONSOLE_W, BUY_IN_DECK_H)}
      minRatio={0.4}
    />
  );
}

/* A bay that is also a button. It paints nothing over the master; its
   state is the ink. */
function BayButton({
  zone,
  text,
  ink,
  pressed,
  label,
  className = '',
  onClick,
  disabled,
}: {
  zone: BuyInZone;
  text: string;
  ink: 'silver' | 'white' | 'red' | 'muted';
  pressed?: boolean;
  label: string;
  className?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const ref = useFitText<HTMLSpanElement>(text, 1, 0.4);
  return (
    <button
      type="button"
      className={`buy-in-modal__bay-button ${className}`.trim()}
      style={zonePct(zone, SPADE_CONSOLE_W, BUY_IN_DECK_H)}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
    >
      <span ref={ref} className={`buy-in-modal__bay-value sc-ink--${ink}`}>
        {text}
      </span>
    </button>
  );
}

export default BuyInModal;
