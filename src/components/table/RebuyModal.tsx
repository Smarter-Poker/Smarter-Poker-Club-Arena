import React from 'react';
import { soundService } from '../../services/SoundService';
// Whole-number tournament money (Dan 2026-08-20): "Sit and Go and any
// tournament buy-ins must never be decimal buy-ins, whole numbers only."
// This file used to define its own money() that FORCED two decimals.
import { money, moneyExact } from '../../utils/buyIn';
import { SpadeConsole, type ConsoleBay } from '../console/SpadeConsole';
import './RebuyModal.css';

interface RebuyModalProps {
  isOpen: boolean;
  /** Base rebuy cost — the part that feeds the prize pool. */
  rebuyCost: number;
  /**
   * House fee charged ON TOP of rebuyCost (10% by default). Before 2026-08-20
   * the modal did not know this existed: it printed the base cost and enabled
   * Confirm whenever the wallet covered the base, so a player holding
   * base <= balance < base + fee was invited to press a button the server was
   * guaranteed to reject with "Insufficient chips".
   */
  rebuyFee?: number;
  rebuyChips: number;
  walletBalance: number;
  onConfirm: () => void;
  onClose: () => void;
  isProcessing: boolean;
}

const RebuyModal: React.FC<RebuyModalProps> = ({
  isOpen,
  rebuyCost,
  rebuyFee = 0,
  rebuyChips,
  walletBalance,
  onConfirm,
  onClose,
  isProcessing,
}) => {
  if (!isOpen) return null;

  // The advertised total is whole, but its prize/fee split is cent-accurate.
  // Rounding both halves independently turned 13.50 + 1.50 into a fictional
  // 16-chip charge. Add first, then round only the whole advertised price.
  const totalCost = Math.round((Number(rebuyCost) + Number(rebuyFee)) * 100) / 100;
  // Gate on the TOTAL — this is the number the server debits.
  const canAfford = walletBalance >= totalCost;

  /* #ClubArenaConsole (2026-09-14): the rebuy wears the four-bay deck. Dan
     2026-09-09: the four-bay deck is the buy-in family's and nobody else's,
     and a rebuy is a buy-in. Re-rendered, not rewritten: the cent-exact
     total, the gate on the TOTAL, the sound-after-guard confirm are as they
     were. The offer prints as the pill, the price as the figure on the glass,
     the receipt - cost, fee, total, wallet - in the four bays, Decline and
     Rebuy on the two plates. The strings the tests read are kept: "House
     Fee", "Total Charged", the exact split, "Rebuy <total>", "You Need
     <total> To Rebuy", and no ".00" on a tournament figure. */
  const bays: ConsoleBay[] = [
    { label: 'Rebuy Cost', value: moneyExact(rebuyCost) },
    { label: 'House Fee', value: moneyExact(rebuyFee) },
    { label: 'Total Charged', value: money(totalCost), ink: 'white' },
    { label: 'Wallet Balance', value: money(walletBalance), ink: canAfford ? 'silver' : 'red' },
  ];

  return (
    <div className="rbm-overlay" onClick={onClose}>
      <div
        className="rbm-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rebuy-modal-title"
      >
        <SpadeConsole
          family="fourbay"
          eyebrow="Tournament"
          title="Rebuy"
          titleId="rebuy-modal-title"
          pill={`+${money(rebuyChips)}`}
          pillInk="green"
          bays={bays}
          plates={{
            secondary: {
              label: 'Decline',
              onClick: onClose,
              disabled: isProcessing,
            },
            primary: {
              label: isProcessing ? 'Processing...' : `Rebuy ${money(totalCost)}`,
              ink: canAfford ? 'white' : 'muted',
              onClick: () => {
                // Guard here too: the disabled attribute alone loses a race if a
                // second tap lands in the same frame as the first.
                if (!canAfford || isProcessing) return;
                soundService.playBuyInConfirm();
                onConfirm();
              },
              disabled: !canAfford || isProcessing,
            },
          }}
        >
          <div className="rbm-stage">
            <span className="sc-label sc-ink--blue">Rebuy For</span>
            <span className="rbm-figure">
              <span className="rbm-figure__value sc-ink--silver">{money(totalCost)}</span>
              <span className="rbm-figure__unit sc-ink--muted">Chips</span>
            </span>
            <span className="rbm-offer sc-ink--muted">
              You Receive <strong className="sc-ink--green">{money(rebuyChips)}</strong> Chips
            </span>
          </div>
          {!canAfford && (
            <p className="sc-copy sc-copy--center sc-ink--red rbm-warning">
              Insufficient Balance - You Need {money(totalCost)} To Rebuy
            </p>
          )}
        </SpadeConsole>
      </div>
    </div>
  );
};

export default RebuyModal;
