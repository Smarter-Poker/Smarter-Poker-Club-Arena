/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  INSURANCE MODAL — All-In Insurance + EV Cashout
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two-tab modal:
 *   1. Insurance — coverage slider with premium calculation
 *   2. EV Cashout — take guaranteed equity payout at slight rake discount
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { haptic, soundService } from '../../services/SoundService';
import { masterBus } from '../../core/MasterBus';
import { CardImage } from './CardImage';
import type { Card as CardImageCard } from './CardImage';
import './InsuranceModal.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface InsuranceOffer {
  maxCoverage: number;
  equityPercent: number; // 0-100
  premiumRate: number; // e.g., 0.05 = 5%
  potAmount: number;
  yourStack: number;
  opponentStack: number;
  yourCards: { rank: string; suit: 'h' | 'd' | 'c' | 's' }[];
  opponentCards?: { rank: string; suit: 'h' | 'd' | 'c' | 's' }[];
  board: { rank: string; suit: 'h' | 'd' | 'c' | 's' }[];
  evCashoutRake?: number; // EV cashout rake (default 1%)
  /**
   * POKERBROS PARITY 2026-08-26: the specific next-street cards that put the
   * opponent ahead — shown as a row of small cards with a count, exactly the
   * information the reference popup leads with. Computed server-side
   * (InsuranceEquity.leaderOuts) and sent with the offer.
   */
  outs?: { rank: string; suit: 'h' | 'd' | 'c' | 's' }[];
  /** Chance (%) the next card is one of the outs — shown next to the count. */
  outPct?: number;
  /**
   * Every all-in opponent, for multiway spots. When present it replaces the
   * single opponentCards column so a 3-way all-in shows BOTH hands you are
   * insured against, each under its player's name.
   */
  opponents?: { username?: string; cards: { rank: string; suit: 'h' | 'd' | 'c' | 's' }[] }[];
  /** Server-published offer window in seconds (drives the popup countdown). */
  timeoutSeconds?: number;
}

export interface InsuranceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAccept: (coverageAmount: number) => void;
  onDecline: () => void;
  /** FIX 89: "Decline for Hand" — never re-offered on later streets.
   * If omitted, only "Decline Now" button is shown. */
  onDeclineForHand?: () => void;
  onEvCashout?: (cashoutAmount: number) => void;
  offer: InsuranceOffer;
  timeRemaining?: number;
  currency?: string;
  enableEvCashout?: boolean;
}

type ModalTab = 'insurance' | 'ev-cashout';

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeRank(rank: string): CardImageCard['rank'] {
  if (rank === '10') return 'T';
  return rank as CardImageCard['rank'];
}

function toCardImage(card: { rank: string; suit: 'h' | 'd' | 'c' | 's' }): CardImageCard {
  return { rank: normalizeRank(card.rank), suit: card.suit };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function InsuranceModal({
  isOpen,
  onClose,
  onAccept,
  onDecline,
  onDeclineForHand,
  onEvCashout,
  offer,
  timeRemaining = 15,
  currency = '',
  enableEvCashout = true,
}: InsuranceModalProps) {
  const [activeTab, setActiveTab] = useState<ModalTab>('insurance');
  const [coverageAmount, setCoverageAmount] = useState(offer.maxCoverage);
  const [mounted, setMounted] = useState(false);
  // POKERBROS PARITY 2026-08-26: a LIVE countdown. The prop used to be a
  // static number that rendered "15s" for the whole window; the reference
  // popup visibly counts down to its auto-decline.
  const [secondsLeft, setSecondsLeft] = useState(offer.timeoutSeconds ?? timeRemaining);

  useEffect(() => {
    if (isOpen) {
      // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    } else {
      setMounted(false);
      setActiveTab('insurance');
    }
  }, [isOpen]);

  // Countdown ticks once per second while open; re-arms when a later street's
  // offer replaces this one (offer identity changes).
  useEffect(() => {
    if (!isOpen) return;
    setSecondsLeft(offer.timeoutSeconds ?? timeRemaining);
    const iv = setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(iv);
  }, [isOpen, offer, timeRemaining]);

  // STALE-SLIDER GUARD 2026-08-26: coverage is seeded from the offer in
  // useState, which never re-runs — if a different offer replaces this one,
  // the slider could sit above the new maximum and accept would over-ask.
  // Re-seed to full coverage whenever the offer identity changes.
  useEffect(() => {
    setCoverageAmount(offer.maxCoverage);
  }, [offer]);

  // ── Insurance calculations ──
  const premium = useMemo(
    () => Math.round(coverageAmount * offer.premiumRate * 100) / 100,
    [coverageAmount, offer.premiumRate]
  );
  const payout = useMemo(
    () => Math.round((coverageAmount - premium) * 100) / 100,
    [coverageAmount, premium]
  );

  // ── EV Cashout calculations ──
  // DEAD-BUTTON FIX 2026-08-26: enableEvCashout defaulted true, TablePage
  // never passed onEvCashout, and NO server endpoint exists for EV cashout —
  // so the tab rendered a "Cash Out" button that quietly did nothing to a
  // player making a financial decision. The tab now requires a real handler;
  // until the server grows one, the modal is insurance-only.
  const evCashoutAvailable = enableEvCashout && typeof onEvCashout === 'function';
  const evCashoutRake = offer.evCashoutRake ?? 0.01;
  const evRaw = useMemo(
    () => Math.round(offer.potAmount * (offer.equityPercent / 100) * 100) / 100,
    [offer.potAmount, offer.equityPercent]
  );
  const evCashoutAmount = useMemo(
    () => Math.round(evRaw * (1 - evCashoutRake) * 100) / 100,
    [evRaw, evCashoutRake]
  );
  const evRakeAmount = useMemo(() => evRaw - evCashoutAmount, [evRaw, evCashoutAmount]);

  // FIX 187: Insurance accept is a financial decision — dedicated sound + haptic
  const handleAccept = useCallback(() => {
    soundService.playInsurancePurchase();
    onAccept(coverageAmount);
  }, [coverageAmount, onAccept]);

  const handleDecline = useCallback(() => {
    soundService.playInsuranceDecline();
    onDecline();
  }, [onDecline]);

  // FIX 89: "Decline for Hand" — player won't be re-offered insurance on later streets
  const handleDeclineForHand = useCallback(() => {
    haptic.light();
    if (onDeclineForHand) onDeclineForHand();
    else onDecline(); // Fallback if prop not provided
  }, [onDeclineForHand, onDecline]);

  const handleEvCashout = useCallback(() => {
    haptic.medium();
    masterBus.emit('EV_CASHOUT_ACCEPTED', {
      handId: '',
      tableId: '',
      playerId: '',
      cashoutAmount: evCashoutAmount,
      equityPercent: offer.equityPercent,
    });
    onEvCashout?.(evCashoutAmount);
  }, [evCashoutAmount, offer.equityPercent, onEvCashout]);

  // Slider grid for the coverage range — see the onChange note on the input.
  // MICRO-STAKES MONEY MATH 2026-08-26: below 100 chips the old integer step
  // (min 1) made a 3.51 max slider jump 0-1-2-3 and Math.trunc presets showed
  // 25% of 3.51 as 0. Cents everywhere the economy is decimal.
  const coverageStep = offer.maxCoverage >= 100 ? Math.floor(offer.maxCoverage / 100) : 0.01;
  const coverageGridMax = useMemo(() => {
    if (!(offer.maxCoverage > 0)) return offer.maxCoverage;
    return Math.floor(offer.maxCoverage / coverageStep) * coverageStep;
  }, [offer.maxCoverage, coverageStep]);

  const presets = useMemo(
    () => [
      { label: '25%', value: Math.round(offer.maxCoverage * 0.25 * 100) / 100 },
      { label: '50%', value: Math.round(offer.maxCoverage * 0.5 * 100) / 100 },
      { label: '75%', value: Math.round(offer.maxCoverage * 0.75 * 100) / 100 },
      { label: 'MAX', value: offer.maxCoverage },
    ],
    [offer.maxCoverage]
  );

  if (!isOpen) return null;

  return (
    <div className="insurance-overlay">
      <div
        className="insurance-modal"
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        {/* Header */}
        <div className="insurance-modal__header">
          <div className="insurance-modal__title-row">
            <span className="insurance-modal__icon">⛨</span>
            <h2 className="insurance-modal__title">
              {activeTab === 'insurance' ? 'Insurance' : 'EV Cashout'}
            </h2>
          </div>
          <span
            className={`insurance-modal__timer ${secondsLeft <= 5 ? 'insurance-modal__timer--urgent' : ''}`}
          >
            {secondsLeft}s
          </span>
        </div>

        {/* Tab Switcher */}
        {evCashoutAvailable && (
          <div className="insurance-modal__tabs">
            <button
              className={`insurance-modal__tab ${activeTab === 'insurance' ? 'insurance-modal__tab--active' : ''}`}
              onClick={() => {
                haptic.light();
                setActiveTab('insurance');
              }}
            >
              ⛨ Insurance
            </button>
            <button
              className={`insurance-modal__tab ${activeTab === 'ev-cashout' ? 'insurance-modal__tab--active' : ''}`}
              onClick={() => {
                haptic.light();
                setActiveTab('ev-cashout');
              }}
            >
              EV Cashout
            </button>
          </div>
        )}

        {/* Cards Display */}
        <div className="insurance-modal__cards">
          <div className="insurance-modal__hand">
            <span className="insurance-modal__hand-label">Your Hand</span>
            <div className="insurance-modal__hand-cards">
              {offer.yourCards.map((card, i) => (
                <span key={i} className="insurance-modal__card">
                  <CardImage card={toCardImage(card)} size="xs" />
                </span>
              ))}
            </div>
          </div>
          <div className="insurance-modal__vs">Vs</div>
          {/* Multiway: one column per all-in opponent, each named. Falls back
              to the single opponentCards column for older payloads. */}
          {offer.opponents && offer.opponents.length > 0 ? (
            offer.opponents.map((opp, oi) => (
              <div key={oi} className="insurance-modal__hand">
                <span className="insurance-modal__hand-label">{opp.username || 'Opponent'}</span>
                <div className="insurance-modal__hand-cards">
                  {opp.cards.map((card, i) => (
                    <span key={i} className="insurance-modal__card">
                      <CardImage card={toCardImage(card)} size="xs" />
                    </span>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <div className="insurance-modal__hand">
              <span className="insurance-modal__hand-label">Opponent</span>
              <div className="insurance-modal__hand-cards">
                {offer.opponentCards ? (
                  offer.opponentCards.map((card, i) => (
                    <span key={i} className="insurance-modal__card">
                      <CardImage card={toCardImage(card)} size="xs" />
                    </span>
                  ))
                ) : (
                  <>
                    <span className="insurance-modal__card insurance-modal__card--hidden">?</span>
                    <span className="insurance-modal__card insurance-modal__card--hidden">?</span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Board */}
        <div className="insurance-modal__board">
          {offer.board.map((card, i) => (
            <span key={i} className="insurance-modal__board-card">
              <CardImage card={toCardImage(card)} size="xs" />
            </span>
          ))}
        </div>

        {/* Equity Bar */}
        <div className="insurance-modal__equity">
          <div className="insurance-modal__equity-bar">
            <div
              className="insurance-modal__equity-fill"
              style={{ width: `${offer.equityPercent}%` }}
            />
          </div>
          <span className="insurance-modal__equity-text">
            Your Equity: {offer.equityPercent.toFixed(1)}%
          </span>
        </div>

        {/* Outs — the specific next-street cards that put you behind */}
        {offer.outs && offer.outs.length > 0 && (
          <div className="insurance-modal__outs">
            <span className="insurance-modal__outs-label">
              Outs Against You ({offer.outs.length}
              {offer.outPct ? ` • ${offer.outPct.toFixed(1)}%` : ''})
            </span>
            <div className="insurance-modal__outs-cards">
              {offer.outs.map((card, i) => (
                <span key={i} className="insurance-modal__outs-card">
                  <CardImage card={toCardImage(card)} size="xs" />
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ═══ INSURANCE TAB ═══ */}
        {activeTab === 'insurance' && (
          <>
            <div className="insurance-modal__coverage">
              <span className="insurance-modal__coverage-label">Coverage Amount</span>
              <input
                type="range"
                className="insurance-modal__slider"
                /* SLIDER FLOOR 2026-08-26: min was 0, and a 0-coverage accept
                   round-trips as coveragePercent 0 -> server clamps to 1% -
                   the player buys insurance they asked NOT to have. Zero
                   coverage IS the Decline button; the slider starts at one
                   step. */
                min={coverageStep}
                max={offer.maxCoverage}
                step={coverageStep}
                value={coverageAmount}
                /* 2026-08-20: a range input only emits `min + n*step`, so with
                   a derived step the FULL coverage was often unreachable by
                   dragging — max 1,055 with step 10 tops out at 1,050 and the
                   player cannot insure the last 5. Treat the last grid stop as
                   the true maximum, exactly as the raise and buy-in sliders do. */
                onChange={(e) => {
                  const raw = parseFloat(e.target.value);
                  setCoverageAmount(raw >= coverageGridMax ? offer.maxCoverage : raw);
                }}
                aria-label={`Insurance coverage amount, up to ${offer.maxCoverage}`}
              />
              <div className="insurance-modal__presets">
                {presets.map((preset) => (
                  <button
                    key={preset.label}
                    className={`insurance-modal__preset ${coverageAmount === preset.value ? 'insurance-modal__preset--active' : ''}`}
                    onClick={() => setCoverageAmount(preset.value)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="insurance-modal__summary">
              <div className="insurance-modal__summary-row">
                <span className="insurance-modal__summary-label">Coverage</span>
                <span className="insurance-modal__summary-value">
                  {currency}
                  {coverageAmount.toLocaleString()}
                </span>
              </div>
              <div className="insurance-modal__summary-row">
                <span className="insurance-modal__summary-label">
                  Premium ({(offer.premiumRate * 100).toFixed(1)}%)
                </span>
                <span className="insurance-modal__summary-value insurance-modal__summary-value--negative">
                  -{currency}
                  {premium.toLocaleString()}
                </span>
              </div>
              <div className="insurance-modal__summary-row insurance-modal__summary-row--total">
                <span className="insurance-modal__summary-label">If You Lose, Receive</span>
                <span className="insurance-modal__summary-value insurance-modal__summary-value--highlight">
                  {currency}
                  {payout.toLocaleString()}
                </span>
              </div>
            </div>

            {/* POKERBROS PARITY 2026-08-26 (Dan): a decline is FINAL for the
                hand, so the old "Decline Now" / "Decline For Hand" pair is one
                button now. handleDecline routes to the for-hand path. */}
            <div className="insurance-modal__actions">
              <button
                className="insurance-modal__btn insurance-modal__btn--decline"
                onClick={handleDeclineForHand}
                title="Decline insurance for the rest of this hand"
              >
                Decline
              </button>
              <button
                className="insurance-modal__btn insurance-modal__btn--accept"
                onClick={handleAccept}
              >
                Buy Insurance
              </button>
            </div>
          </>
        )}

        {/* ═══ EV CASHOUT TAB ═══ */}
        {activeTab === 'ev-cashout' && evCashoutAvailable && (
          <>
            <div className="insurance-modal__ev-section">
              <div className="insurance-modal__ev-hero">
                <span className="insurance-modal__ev-amount">
                  {currency}
                  {evCashoutAmount.toLocaleString()}
                </span>
                <span className="insurance-modal__ev-subtitle">Guaranteed Payout</span>
              </div>

              <div className="insurance-modal__summary">
                <div className="insurance-modal__summary-row">
                  <span className="insurance-modal__summary-label">Pot Size</span>
                  <span className="insurance-modal__summary-value">
                    {currency}
                    {offer.potAmount.toLocaleString()}
                  </span>
                </div>
                <div className="insurance-modal__summary-row">
                  <span className="insurance-modal__summary-label">
                    Your Equity ({offer.equityPercent.toFixed(1)}%)
                  </span>
                  <span className="insurance-modal__summary-value">
                    {currency}
                    {evRaw.toLocaleString()}
                  </span>
                </div>
                <div className="insurance-modal__summary-row">
                  <span className="insurance-modal__summary-label">
                    Cashout Fee ({(evCashoutRake * 100).toFixed(0)}%)
                  </span>
                  <span className="insurance-modal__summary-value insurance-modal__summary-value--negative">
                    -{currency}
                    {evRakeAmount.toLocaleString()}
                  </span>
                </div>
                <div className="insurance-modal__summary-row insurance-modal__summary-row--total">
                  <span className="insurance-modal__summary-label">You Receive</span>
                  <span className="insurance-modal__summary-value insurance-modal__summary-value--highlight">
                    {currency}
                    {evCashoutAmount.toLocaleString()}
                  </span>
                </div>
              </div>

              <p className="insurance-modal__ev-note">
                Take Your Guaranteed Equity Now. The Hand Will Continue But Your Payout Is Locked.
              </p>
            </div>

            <div className="insurance-modal__actions">
              <button
                className="insurance-modal__btn insurance-modal__btn--decline"
                onClick={handleDecline}
              >
                Play It Out
              </button>
              <button
                className="insurance-modal__btn insurance-modal__btn--cashout"
                onClick={handleEvCashout}
              >
                Cash Out
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default InsuranceModal;
