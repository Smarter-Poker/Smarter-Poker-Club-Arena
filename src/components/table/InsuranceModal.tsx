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

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => setMounted(true), 50);
    } else {
      setMounted(false);
      setActiveTab('insurance');
    }
  }, [isOpen]);

  // ── Insurance calculations ──
  const premium = useMemo(
    () => Math.trunc(coverageAmount * offer.premiumRate),
    [coverageAmount, offer.premiumRate]
  );
  const payout = useMemo(() => coverageAmount - premium, [coverageAmount, premium]);

  // ── EV Cashout calculations ──
  const evCashoutRake = offer.evCashoutRake ?? 0.01;
  const evRaw = useMemo(
    () => Math.trunc(offer.potAmount * (offer.equityPercent / 100)),
    [offer.potAmount, offer.equityPercent]
  );
  const evCashoutAmount = useMemo(
    () => Math.trunc(evRaw * (1 - evCashoutRake)),
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

  const presets = useMemo(
    () => [
      { label: '25%', value: Math.trunc(offer.maxCoverage * 0.25) },
      { label: '50%', value: Math.trunc(offer.maxCoverage * 0.5) },
      { label: '75%', value: Math.trunc(offer.maxCoverage * 0.75) },
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
          {timeRemaining !== undefined && (
            <span className="insurance-modal__timer">{timeRemaining}s</span>
          )}
        </div>

        {/* Tab Switcher */}
        {enableEvCashout && (
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
              💰 EV Cashout
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
                  <CardImage card={toCardImage(card)} deckStyle="4color" size="xs" />
                </span>
              ))}
            </div>
          </div>
          <div className="insurance-modal__vs">vs</div>
          <div className="insurance-modal__hand">
            <span className="insurance-modal__hand-label">Opponent</span>
            <div className="insurance-modal__hand-cards">
              {offer.opponentCards ? (
                offer.opponentCards.map((card, i) => (
                  <span key={i} className="insurance-modal__card">
                    <CardImage card={toCardImage(card)} deckStyle="4color" size="xs" />
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
        </div>

        {/* Board */}
        <div className="insurance-modal__board">
          {offer.board.map((card, i) => (
            <span key={i} className="insurance-modal__board-card">
              <CardImage card={toCardImage(card)} deckStyle="4color" size="xs" />
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

        {/* ═══ INSURANCE TAB ═══ */}
        {activeTab === 'insurance' && (
          <>
            <div className="insurance-modal__coverage">
              <span className="insurance-modal__coverage-label">Coverage Amount</span>
              <input
                type="range"
                className="insurance-modal__slider"
                min={0}
                max={offer.maxCoverage}
                step={Math.max(1, Math.floor(offer.maxCoverage / 100))}
                value={coverageAmount}
                onChange={(e) => setCoverageAmount(parseInt(e.target.value))}
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
                <span className="insurance-modal__summary-label">If you lose, receive</span>
                <span className="insurance-modal__summary-value insurance-modal__summary-value--highlight">
                  {currency}
                  {payout.toLocaleString()}
                </span>
              </div>
            </div>

            <div className="insurance-modal__actions">
              <button
                className="insurance-modal__btn insurance-modal__btn--decline"
                onClick={handleDecline}
              >
                Decline Now
              </button>
              {onDeclineForHand && (
                <button
                  className="insurance-modal__btn insurance-modal__btn--decline-hand"
                  onClick={handleDeclineForHand}
                  title="Decline insurance for all remaining streets this hand"
                >
                  Decline for Hand
                </button>
              )}
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
        {activeTab === 'ev-cashout' && (
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
                  <span className="insurance-modal__summary-label">You receive</span>
                  <span className="insurance-modal__summary-value insurance-modal__summary-value--highlight">
                    {currency}
                    {evCashoutAmount.toLocaleString()}
                  </span>
                </div>
              </div>

              <p className="insurance-modal__ev-note">
                Take your guaranteed equity now. The hand will continue but your payout is locked.
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
                💰 Cash Out
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default InsuranceModal;
