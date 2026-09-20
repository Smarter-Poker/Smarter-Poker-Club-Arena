/**
 * TIME BANK STORE - buy time banks with diamonds, from the felt.
 *
 * Presets are 1, 10, 25, 100, and 500. The caller provides the server-owned
 * `feature_pricing` value used by `fn_purchase_time_banks_v2`, and one RPC buys
 * the full selected quantity so a large order cannot partially settle.
 *
 * The existing quantity, busy state, double-tap guard, server-priced total,
 * shortfall, dialog semantics, and title remain intact. The presentation uses
 * the Club Arena console money frame, the platform's painted Diamond icon, and
 * semantic illuminated controls instead of CSS-drawn glyphs.
 */
import React, { useState } from 'react';
import { SpadeConsole } from '../console/SpadeConsole';
import { mediaUrl } from '../../utils/mediaBase';
import './TimeBankStoreModal.css';

const QUANTITY_PRESETS = [1, 10, 25, 100, 500] as const;
const DIAMOND_ICON = mediaUrl('images/diamond-icon.png');

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

function Diamonds({ amount }: { amount: number | string }) {
  return (
    <span className="tbs-diamonds">
      <img className="tbs-diamonds__icon" src={DIAMOND_ICON} alt="" aria-hidden="true" />
      {amount}
    </span>
  );
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
      <div className="tbs-dialog" onClick={(e) => e.stopPropagation()}>
        <SpadeConsole
          as="section"
          family="riveted"
          eyebrow="Time Banks"
          title={banksRemaining > 0 ? 'Add Time Banks' : 'Out Of Time Banks'}
          titleId="tbs-title"
          pill={`${banksRemaining} Left`}
          pillInk={banksRemaining > 0 ? 'gold' : 'red'}
          plates={{
            secondary: { label: 'Not Now', ink: 'silver', onClick: onClose },
            primary: {
              label: busy ? 'Buying…' : 'Buy',
              ink: 'white',
              onClick: buy,
              disabled: busy || shortfall > 0,
            },
          }}
        >
          <p className="sc-copy">
            {banksRemaining > 0
              ? `You Have ${banksRemaining} Bank${banksRemaining === 1 ? '' : 's'} Left. Each One Adds ${bankSeconds} Seconds To Your Clock.`
              : `You Have No Time Banks Left. Each One Adds ${bankSeconds} Seconds To Your Clock When The Shot Clock Runs Out.`}
          </p>

          <div className="tbs-rows">
            <div className="tbs-row">
              <span className="sc-label sc-ink--blue">Price</span>
              <span className="tbs-row__value sc-ink--silver">
                <Diamonds amount={`${diamondCost} Per Bank`} />
              </span>
            </div>

            <div className="tbs-row tbs-row--picker">
              <span className="sc-label sc-ink--blue">Quantity</span>
              <span className="tbs-presets" role="group" aria-label="Quantity">
                {QUANTITY_PRESETS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`tbs-preset ${quantity === n ? 'sc-ink--white tbs-preset--on' : 'sc-ink--muted'}`}
                    aria-pressed={quantity === n}
                    onClick={() => setQuantity(n)}
                  >
                    {n}
                  </button>
                ))}
              </span>
            </div>

            <div className="tbs-row">
              <span className="sc-label sc-ink--blue">
                {quantity} Bank{quantity === 1 ? '' : 's'}
              </span>
              <span className="tbs-row__value tbs-row__value--total sc-ink--silver">
                <Diamonds amount={total.toLocaleString()} />
              </span>
            </div>
          </div>

          {shortfall > 0 && (
            <p className="sc-copy sc-copy--center sc-ink--red tbs-shortfall">
              You Need {shortfall.toLocaleString()} More Diamond
              {shortfall === 1 ? '' : 's'} For This.
            </p>
          )}
        </SpadeConsole>
      </div>
    </div>
  );
};

export default TimeBankStoreModal;
