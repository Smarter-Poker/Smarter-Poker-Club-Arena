import React from 'react';
import { soundService } from '../../services/SoundService';
// Whole-number tournament money (Dan 2026-08-20): "Sit and Go and any
// tournament buy-ins must never be decimal buy-ins, whole numbers only."
// This file used to define its own money() that FORCED two decimals.
import { money, moneyExact } from '../../utils/buyIn';
import DiamondsToChipsButton from '../games/DiamondsToChipsButton';
import { compactChips } from '../../utils/format';
import {
  PlateButton,
  SPADE_CONSOLE_TOP_H,
  SPADE_CONSOLE_W,
  SPADE_CONSOLE_ZONES,
  ZoneText,
  zonePct,
} from '../console/SpadeConsole';
import { BUY_IN_DECK_H, BUY_IN_ZONES, BayLabel, BayValue } from './BuyInModal';
import './RebuyModal.css';

interface RebuyModalProps {
  isOpen: boolean;
  /** Base rebuy cost - the part that feeds the prize pool. */
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
  /** A prior submission needs its original receipt, not a new purchase. */
  purchaseUnconfirmed?: boolean;
  /**
   * The club whose host runs the Diamond Games (Dan 2026-09-10: a player who
   * cannot cover a rebuy is offered the diamonds-to-chips door rather than a
   * dead end). Omitted, the door is simply not offered.
   */
  diamondGamesClubId?: string | null;
  /** Leave the table for the games. The parent decides what closing means. */
  onPlayDiamonds?: (path: string) => void;
}

/**
 * THE REBUY SHEET ON THE SPADE MASTER (2026-09-08).
 *
 * This was a rounded navy card with five text rows and two pill buttons - the
 * one sheet a tournament player meets at the worst moment, having just
 * busted, and it looked nothing like the felt around it. It is now the same
 * sheet as Buy-In: Dan's spade master cut into its head (the header well with
 * REBUY engraved and the chips coming back printed in the pill slot), a stage
 * on the rails (the total the server will charge, large, and the reason when
 * the wallet cannot cover it), and the deck (the four bays printing COST /
 * FEE / CHIPS / BALANCE, and the two painted plates: DECLINE on steel, REBUY
 * on the blue glass). Nothing is drawn or stuck on. The terms of the rebuy
 * (cost, fee, total) print exactly - the split is cent-accurate and the
 * total is the whole advertised price; the chips and the balance are the
 * lobby's compact figure (1K, 1.2K), rounded down, so a sheet never overstates.
 *
 * Whole-number tournament money (Dan 2026-08-20): "Sit and Go and any
 * tournament buy-ins must never be decimal buy-ins, whole numbers only."
 */
const RebuyModal: React.FC<RebuyModalProps> = ({
  isOpen,
  rebuyCost,
  rebuyFee = 0,
  rebuyChips,
  walletBalance,
  onConfirm,
  onClose,
  isProcessing,
  purchaseUnconfirmed = false,
  diamondGamesClubId,
  onPlayDiamonds,
}) => {
  if (!isOpen) return null;

  // The advertised total is whole, but its prize/fee split is cent-accurate.
  // Rounding both halves independently turned 13.50 + 1.50 into a fictional
  // 16-chip charge. Add first, then round only the whole advertised price.
  const totalCost = Math.round((Number(rebuyCost) + Number(rebuyFee)) * 100) / 100;
  // Gate on the TOTAL - this is the number the server debits.
  const canAfford = walletBalance >= totalCost;
  const canConfirm = purchaseUnconfirmed || canAfford;
  const dismiss = () => {
    if (isProcessing || purchaseUnconfirmed) return;
    onClose();
  };
  const primaryLabel = isProcessing
    ? 'Working'
    : purchaseUnconfirmed
      ? 'Retry Confirmation'
      : `Rebuy ${money(totalCost)}`;

  return (
    <div className="rebuy-modal__overlay" onClick={dismiss}>
      <div
        className="rebuy-modal ac-popup"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rebuy-modal-title"
        aria-busy={isProcessing || undefined}
      >
        <div className="rebuy-modal__master">
          {/* Head: the master's header well. */}
          <div className="rebuy-modal__head">
            <ZoneText
              text="Tournament"
              className="sc__eyebrow sc-ink--blue"
              style={zonePct(SPADE_CONSOLE_ZONES.eyebrow, SPADE_CONSOLE_W, SPADE_CONSOLE_TOP_H)}
            />
            <ZoneText
              as="h2"
              id="rebuy-modal-title"
              text="Rebuy"
              className="sc__title sc-ink--silver"
              style={zonePct(SPADE_CONSOLE_ZONES.title, SPADE_CONSOLE_W, SPADE_CONSOLE_TOP_H)}
            />
            <ZoneText
              text={`+${compactChips(rebuyChips)}`}
              className="sc__pill sc-ink--green"
              style={zonePct(SPADE_CONSOLE_ZONES.pill, SPADE_CONSOLE_W, SPADE_CONSOLE_TOP_H)}
            />
          </div>

          {/* Stage: the total the server will charge, and why it cannot be. */}
          <div className="rebuy-modal__stage">
            <span className="sc-label sc-ink--blue">Total Charged</span>
            <span className="rebuy-modal__amount sc-ink--silver">{money(totalCost)}</span>
            {rebuyFee > 0 && (
              <p className="sc-copy sc-copy--center sc-ink--muted rebuy-modal__breakdown">
                {moneyExact(rebuyCost)} Rebuy Plus {moneyExact(rebuyFee)} <span>House Fee</span>
              </p>
            )}
            {purchaseUnconfirmed && (
              <p role="alert" className="sc-copy sc-copy--center sc-ink--red rebuy-modal__warning">
                Rebuy Not Confirmed. Retry To Check The Same Purchase.
              </p>
            )}
            {!canAfford && !purchaseUnconfirmed && (
              <p role="alert" className="sc-copy sc-copy--center sc-ink--red rebuy-modal__warning">
                Insufficient Balance. You Need {money(totalCost)} To Rebuy.
              </p>
            )}
            {!canAfford && onPlayDiamonds && (
              <DiamondsToChipsButton
                clubId={diamondGamesClubId}
                enabled={isOpen && !isProcessing}
                size="compact"
                onGo={onPlayDiamonds}
              />
            )}
          </div>

          {/* Deck: the four bays, the two plates, the chip. */}
          <div className="rebuy-modal__deck">
            <BayLabel zone={BUY_IN_ZONES.bays[0].label} text="Cost" />
            <BayLabel zone={BUY_IN_ZONES.bays[1].label} text="Fee" />
            <BayLabel zone={BUY_IN_ZONES.bays[2].label} text="Chips" />
            <BayLabel zone={BUY_IN_ZONES.bays[3].label} text="Balance" />
            <BayValue zone={BUY_IN_ZONES.bays[0].value} text={moneyExact(rebuyCost)} ink="silver" />
            <BayValue zone={BUY_IN_ZONES.bays[1].value} text={moneyExact(rebuyFee)} ink="silver" />
            <BayValue
              zone={BUY_IN_ZONES.bays[2].value}
              text={`+${compactChips(rebuyChips)}`}
              ink="green"
            />
            <BayValue
              zone={BUY_IN_ZONES.bays[3].value}
              text={compactChips(walletBalance)}
              ink={canAfford ? 'silver' : 'red'}
            />
            <PlateButton
              zone={BUY_IN_ZONES.secondaryAction}
              canvasH={BUY_IN_DECK_H}
              label="Decline"
              onClick={dismiss}
              disabled={isProcessing || purchaseUnconfirmed}
              aria-label="Decline Rebuy"
            />
            <PlateButton
              zone={BUY_IN_ZONES.primaryAction}
              canvasH={BUY_IN_DECK_H}
              label={primaryLabel}
              ink={canConfirm ? 'white' : 'red'}
              className={isProcessing ? 'rebuy-modal__confirm--processing' : ''}
              onClick={() => {
                // Guard here too: the disabled attribute alone loses a race if a
                // second tap lands in the same frame as the first.
                if (!canConfirm || isProcessing) return;
                soundService.playBuyInConfirm();
                onConfirm();
              }}
              disabled={!canConfirm || isProcessing}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default RebuyModal;
