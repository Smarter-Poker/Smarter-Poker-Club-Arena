/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TIP DEALER — Tipping Component
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Allows player to tip the dealer:
 * - Quick tip amounts
 * - Custom amount input
 * - Flying chip animation trigger
 */

import React, { useState, useRef, useEffect } from 'react';
import { haptic } from '../../services/SoundService';
import './TipDealer.css';

export interface TipDealerProps {
  isOpen: boolean;
  onClose: () => void;
  /** May be async. The modal stays open and locked until it settles. */
  onTip: (amount: number) => void | Promise<void>;
  currency?: string;
  defaultAmounts?: number[];
  balance: number;
}

export function TipDealer({
  isOpen,
  onClose,
  onTip,
  currency = '',
  defaultAmounts = [1, 5, 25, 100],
  balance,
}: TipDealerProps) {
  const [customAmount, setCustomAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  // Clear the typed amount between openings so a reopened modal never arrives
  // pre-loaded with the last tip the player typed.
  useEffect(() => {
    if (isOpen) {
      setCustomAmount('');
      busyRef.current = false;
      setBusy(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const parsedCustom = parseFloat(customAmount);
  // The submit button used to be enabled for "0" and for "-5": it only checked
  // `!customAmount` (truthiness of the STRING) and the upper bound. "0" is a
  // non-empty string, so Tip was live on a tip that could never succeed.
  const customValid = Number.isFinite(parsedCustom) && parsedCustom > 0 && parsedCustom <= balance;

  const handleTip = async (amount: number) => {
    // busyRef, not `busy`: two taps in the same React batch both read the stale
    // state and both would fire a tip.
    if (busyRef.current) return;
    const snapped = Math.round(amount * 100) / 100;
    if (!(snapped > 0) || snapped > balance) return;
    busyRef.current = true;
    setBusy(true);
    haptic.light();
    try {
      // The modal is closed out by the CALLER on success (it toasts and clears
      // `isOpen` itself). Awaiting means the modal cannot be dismissed out from
      // under an in-flight request, and a refused tip no longer looks accepted.
      await onTip(snapped);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customValid) return;
    void handleTip(parsedCustom);
  };

  return (
    <div
      className="tip-overlay"
      onClick={() => {
        if (!busy) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tip-modal-title"
    >
      <div className="tip-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tip-modal__header">
          <span className="tip-modal__icon">◉</span>
          <h3 id="tip-modal-title" className="tip-modal__title">
            Tip Dealer
          </h3>
          <button
            type="button"
            className="tip-modal__close"
            onClick={onClose}
            disabled={busy}
            aria-label="Close tip dealer"
          >
            ×
          </button>
        </div>

        <div className="tip-modal__presets">
          {defaultAmounts.map((amount) => (
            <button
              key={amount}
              type="button"
              className="tip-modal__preset-btn"
              onClick={() => void handleTip(amount)}
              disabled={amount > balance || busy}
            >
              <span className="tip-modal__chip">{amount}</span>
              <span className="tip-modal__chip-label">
                {currency}
                {amount}
              </span>
            </button>
          ))}
        </div>

        <form onSubmit={handleCustomSubmit} className="tip-modal__custom">
          <input
            type="number"
            className="tip-modal__input"
            placeholder="Custom Amount"
            value={customAmount}
            onChange={(e) => setCustomAmount(e.target.value)}
            min="0.01"
            step="0.01"
            max={balance}
            disabled={busy}
            aria-label="Custom tip amount"
          />
          <button type="submit" className="tip-modal__submit" disabled={!customValid || busy}>
            {busy ? '...' : 'Tip'}
          </button>
        </form>

        <p className="tip-modal__balance">
          Available: {currency}
          {balance.toLocaleString()}
        </p>
      </div>
    </div>
  );
}

export default TipDealer;
