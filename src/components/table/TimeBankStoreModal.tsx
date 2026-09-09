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
 * ON THE MASTER (2026-09-09, #ClubArenaConsole). This was a rounded sheet with
 * CSS preset pills and two drawn buttons. It is the spade console now: the
 * price, what you hold and what it comes to are printed on the glass between
 * the rails, the presets are lit numerals, and NOT NOW / BUY sit on the
 * painted plates.
 *
 * NOT the four-bay deck (Dan 2026-09-09: "I DON'T LIKE THE 4 BOXES, AND THE WAY
 * IT STICKS OUT ON THE SIDES"). The bays belong to the buy-in family - the
 * sheets a player sits down and rebuys through - and nowhere else.
 */

import React, { useState } from 'react';
import { compactChips } from '../../utils/format';
import { SpadeConsole } from '../console/SpadeConsole';
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
      <div className="tbs-modal ac-popup" onClick={(e) => e.stopPropagation()}>
        <SpadeConsole
          as="div"
          eyebrow="Shot Clock"
          title={banksRemaining > 0 ? 'Time Banks' : 'Out Of Banks'}
          titleId="tbs-title"
          pill={`${bankSeconds}s Each`}
          plates={{
            secondary: { label: 'Not Now', onClick: onClose },
            primary: {
              label: busy ? 'Buying' : `Buy ${quantity}`,
              ink: busy || shortfall > 0 ? 'muted' : 'white',
              onClick: buy,
              disabled: busy || shortfall > 0,
            },
          }}
        >
          <p className="sc-copy sc-copy--center tbs-body">
            {banksRemaining > 0
              ? `You Have ${banksRemaining} Bank${banksRemaining === 1 ? '' : 's'} Left. Each One Adds ${bankSeconds} Seconds To Your Clock.`
              : `You Have No Time Banks Left. Each One Adds ${bankSeconds} Seconds To Your Clock When The Shot Clock Runs Out.`}
          </p>

          <div className="tbs-presets" role="group" aria-label="Quantity">
            {QUANTITY_PRESETS.map((n) => (
              <button
                key={n}
                type="button"
                className={`tbs-preset${quantity === n ? ' tbs-preset--on' : ''} ${
                  quantity === n ? 'sc-ink--white' : 'sc-ink--muted'
                }`}
                aria-pressed={quantity === n}
                onClick={() => setQuantity(n)}
              >
                {n}
              </button>
            ))}
          </div>

          <dl className="tbs-figures">
            <div className="tbs-figure">
              <dt className="sc-label sc-ink--blue">Price Each</dt>
              <dd className="tbs-figure__value sc-ink--silver">{compactChips(diamondCost)}</dd>
            </div>
            <div className="tbs-figure">
              <dt className="sc-label sc-ink--blue">Banks Held</dt>
              <dd className="tbs-figure__value sc-ink--silver">{compactChips(banksRemaining)}</dd>
            </div>
            <div className="tbs-figure">
              <dt className="sc-label sc-ink--blue">Total</dt>
              <dd
                className={`tbs-figure__value ${shortfall > 0 ? 'sc-ink--red' : 'sc-ink--white'}`}
              >
                {compactChips(total)}
              </dd>
            </div>
          </dl>

          {shortfall > 0 && (
            <p role="alert" className="sc-copy sc-copy--center sc-ink--red tbs-shortfall">
              You Need {compactChips(shortfall)} More Diamond{shortfall === 1 ? '' : 's'} For This.
            </p>
          )}
        </SpadeConsole>
      </div>
    </div>
  );
};

export default TimeBankStoreModal;
