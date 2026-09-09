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
 * CSS preset pills and two drawn buttons. It is the buy-in deck now - the same
 * master a player sits down through - because it is the same act: choose a
 * quantity, read the price, pay. The four bays print PRICE / BANKS / EACH /
 * TOTAL, the presets are lit numerals on the glass, and NOT NOW / BUY sit on
 * the painted plates.
 */

import React, { useState } from 'react';
import { compactChips } from '../../utils/format';
import { BayLabel, BayValue, BUY_IN_DECK_H, BUY_IN_ZONES } from './BuyInModal';
import {
  PlateButton,
  SPADE_CONSOLE_TOP_H,
  SPADE_CONSOLE_W,
  SPADE_CONSOLE_ZONES,
  ZoneText,
  zonePct,
} from '../console/SpadeConsole';
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
        <div className="tbs-master">
          <div className="tbs-head">
            <ZoneText
              text="Shot Clock"
              className="sc__eyebrow sc-ink--blue"
              style={zonePct(SPADE_CONSOLE_ZONES.eyebrow, SPADE_CONSOLE_W, SPADE_CONSOLE_TOP_H)}
            />
            <ZoneText
              as="h3"
              id="tbs-title"
              text={banksRemaining > 0 ? 'Time Banks' : 'Out Of Banks'}
              className="sc__title sc-ink--silver"
              style={zonePct(SPADE_CONSOLE_ZONES.title, SPADE_CONSOLE_W, SPADE_CONSOLE_TOP_H)}
            />
            <ZoneText
              text={`${bankSeconds}s Each`}
              className="sc__pill sc-ink--blue"
              style={zonePct(SPADE_CONSOLE_ZONES.pill, SPADE_CONSOLE_W, SPADE_CONSOLE_TOP_H)}
            />
          </div>

          <div className="tbs-stage">
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
            {shortfall > 0 && (
              <p role="alert" className="sc-copy sc-copy--center sc-ink--red tbs-shortfall">
                You Need {compactChips(shortfall)} More Diamond{shortfall === 1 ? '' : 's'} For
                This.
              </p>
            )}
          </div>

          <div className="tbs-deck">
            <BayLabel zone={BUY_IN_ZONES.bays[0].label} text="Price" />
            <BayLabel zone={BUY_IN_ZONES.bays[1].label} text="Banks" />
            <BayLabel zone={BUY_IN_ZONES.bays[2].label} text="Held" />
            <BayLabel zone={BUY_IN_ZONES.bays[3].label} text="Total" />
            <BayValue
              zone={BUY_IN_ZONES.bays[0].value}
              text={compactChips(diamondCost)}
              ink="silver"
            />
            <BayValue zone={BUY_IN_ZONES.bays[1].value} text={compactChips(quantity)} ink="white" />
            <BayValue
              zone={BUY_IN_ZONES.bays[2].value}
              text={compactChips(banksRemaining)}
              ink="silver"
            />
            <BayValue
              zone={BUY_IN_ZONES.bays[3].value}
              text={compactChips(total)}
              ink={shortfall > 0 ? 'red' : 'blue'}
            />
            <PlateButton
              zone={BUY_IN_ZONES.secondaryAction}
              canvasH={BUY_IN_DECK_H}
              label="Not Now"
              onClick={onClose}
            />
            <PlateButton
              zone={BUY_IN_ZONES.primaryAction}
              canvasH={BUY_IN_DECK_H}
              label={busy ? 'Buying' : `Buy ${quantity}`}
              ink={busy || shortfall > 0 ? 'muted' : 'white'}
              onClick={buy}
              disabled={busy || shortfall > 0}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default TimeBankStoreModal;
