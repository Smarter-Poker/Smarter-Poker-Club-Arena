/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TIME BANK STORE — buy more banks with diamonds (Dan 2026-08-21, item 3)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * "When you click on time banks, when a user is OUT it should pop up to buy
 *  more with diamonds, each time bank = 5 diamonds. Have defaults set of
 *  1-10-25-100-500."
 *
 * Presets are exactly those five. The price shown is whatever the caller passes
 * from `feature_pricing` — the same row `fn_purchase_time_banks` charges from —
 * so the sheet can never advertise a number the server will not honour, and the
 * quantity is the only thing the client gets to choose.
 *
 * One RPC per purchase, not one per bank: buying 500 as 500 calls could fail
 * halfway and leave the player part-charged.
 *
 * Styling follows the house schema set in FoldProtectionDialog.css — blue body,
 * brushed-nickel exterior + interior frames, silver (never gold) accents.
 */

import React, { useState } from 'react';
import './TimeBankStoreModal.css';

const QUANTITY_PRESETS = [1, 10, 25, 100, 500] as const;

export interface TimeBankStoreModalProps {
  open: boolean;
  onClose: () => void;
  /** Diamonds per bank, read from `feature_pricing.time_bank_seconds`. */
  diamondCost: number;
  /** Banks the player currently holds — shown so the sheet explains itself. */
  banksRemaining: number;
  /** Seconds one bank adds to the shot clock (Bible V8 §6.2 = 20). */
  bankSeconds?: number;
  /** Player's diamond balance, when known. Purchases are still server-priced. */
  diamondBalance?: number | null;
  /**
   * Performs the purchase. Resolves true on success. The parent owns the RPC so
   * this component stays presentational and testable.
   */
  onPurchase: (quantity: number) => Promise<boolean>;
}

export const TimeBankStoreModal: React.FC<TimeBankStoreModalProps> = ({
  open,
  onClose,
  diamondCost,
  banksRemaining,
  bankSeconds = 20,
  diamondBalance,
  onPurchase,
}) => {
  const [quantity, setQuantity] = useState<number>(QUANTITY_PRESETS[0]);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const total = diamondCost * quantity;
  const shortfall =
    typeof diamondBalance === 'number' && diamondBalance < total ? total - diamondBalance : 0;

  const buy = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await onPurchase(quantity);
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="tbs-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tbs-title"
      onClick={onClose}
    >
      <div className="tbs-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="tbs-close" aria-label="Close" onClick={onClose}>
          ×
        </button>

        <h3 id="tbs-title" className="tbs-title">
          {banksRemaining > 0 ? 'Add Time Banks' : 'Out Of Time Banks'}
        </h3>
        <p className="tbs-body">
          {banksRemaining > 0
            ? `You Have ${banksRemaining} Bank${banksRemaining === 1 ? '' : 's'} Left. Each One Adds ${bankSeconds} Seconds To Your Clock.`
            : `You Have No Time Banks Left. Each One Adds ${bankSeconds} Seconds To Your Clock When The Shot Clock Runs Out.`}
        </p>

        <div className="tbs-price-row">
          <span className="tbs-price-label">Price</span>
          <span className="tbs-price-value">
            <span className="tbs-diamond" aria-hidden="true" />
            {diamondCost} Per Bank
          </span>
        </div>

        <div className="tbs-presets" role="group" aria-label="Quantity">
          {QUANTITY_PRESETS.map((n) => (
            <button
              key={n}
              type="button"
              className={`tbs-preset${quantity === n ? ' tbs-preset--on' : ''}`}
              aria-pressed={quantity === n}
              onClick={() => setQuantity(n)}
            >
              {n}
            </button>
          ))}
        </div>

        <div className="tbs-total">
          <span>
            {quantity} Bank{quantity === 1 ? '' : 's'}
          </span>
          <span className="tbs-total-value">
            <span className="tbs-diamond" aria-hidden="true" />
            {total.toLocaleString()}
          </span>
        </div>

        {shortfall > 0 && (
          <p className="tbs-shortfall">
            You Need {shortfall.toLocaleString()} More Diamond
            {shortfall === 1 ? '' : 's'} For This.
          </p>
        )}

        <div className="tbs-actions">
          <button type="button" className="tbs-btn tbs-btn--ghost" onClick={onClose}>
            Not Now
          </button>
          <button
            type="button"
            className="tbs-btn tbs-btn--buy"
            onClick={buy}
            disabled={busy || shortfall > 0}
          >
            {busy ? 'Buying…' : 'Buy'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TimeBankStoreModal;
