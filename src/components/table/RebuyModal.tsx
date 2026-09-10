import React from 'react';
import { soundService } from '../../services/SoundService';
// Whole-number tournament money (Dan 2026-08-20): "Sit and Go and any
// tournament buy-ins must never be decimal buy-ins, whole numbers only."
// This file used to define its own money() that FORCED two decimals.
import { money, moneyExact } from '../../utils/buyIn';
import DiamondsToChipsButton from '../games/DiamondsToChipsButton';
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
  /**
   * The club whose host runs the Diamond Games (Dan 2026-09-10: a player who
   * cannot cover a rebuy is offered the diamonds-to-chips door rather than a
   * dead end). Omitted, the door is simply not offered.
   */
  diamondGamesClubId?: string | null;
  /** Leave the table for the games. The parent decides what closing means. */
  onPlayDiamonds?: (path: string) => void;
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
  diamondGamesClubId,
  onPlayDiamonds,
}) => {
  if (!isOpen) return null;

  // The advertised total is whole, but its prize/fee split is cent-accurate.
  // Rounding both halves independently turned 13.50 + 1.50 into a fictional
  // 16-chip charge. Add first, then round only the whole advertised price.
  const totalCost = Math.round((Number(rebuyCost) + Number(rebuyFee)) * 100) / 100;
  // Gate on the TOTAL — this is the number the server debits.
  const canAfford = walletBalance >= totalCost;

  return (
    <div className="rebuyModalOverlay" onClick={onClose}>
      <div
        className="rebuyModalContent"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rebuy-modal-title"
      >
        <div className="rebuyModalHeader">
          <h3 id="rebuy-modal-title">Rebuy</h3>
          <button
            type="button"
            className="rebuyCloseBtn"
            onClick={onClose}
            disabled={isProcessing}
            aria-label="Close Rebuy"
          >
            ×
          </button>
        </div>
        <div className="rebuyModalBody">
          <div className="rebuyInfo">
            {/* FIX 197: Format amounts with .toLocaleString() — was raw unformatted numbers */}
            <div className="rebuyRow">
              <span>Rebuy Cost</span>
              <span className="rebuyValue">{moneyExact(rebuyCost)}</span>
            </div>
            {rebuyFee > 0 && (
              <div className="rebuyRow">
                <span>House Fee</span>
                <span className="rebuyValue">{moneyExact(rebuyFee)}</span>
              </div>
            )}
            <div className="rebuyRow rebuyRow--total">
              <span>Total Charged</span>
              <span className="rebuyValue">{money(totalCost)}</span>
            </div>
            <div className="rebuyRow">
              <span>Chips Received</span>
              <span className="rebuyValue rebuyChips">+{money(rebuyChips)}</span>
            </div>
            <div className="rebuyRow">
              <span>Wallet Balance</span>
              <span className={`rebuyValue ${!canAfford ? 'insufficient' : ''}`}>
                {money(walletBalance)}
              </span>
            </div>
          </div>
          {!canAfford && onPlayDiamonds && (
            <DiamondsToChipsButton
              clubId={diamondGamesClubId}
              enabled={isOpen}
              size="compact"
              onGo={onPlayDiamonds}
            />
          )}
          {!canAfford && (
            <div className="rebuyWarning">
              Insufficient Balance - You Need {money(totalCost)} To Rebuy
            </div>
          )}
        </div>
        <div className="rebuyModalFooter">
          <button
            type="button"
            className="rebuyDeclineBtn"
            onClick={onClose}
            disabled={isProcessing}
          >
            Decline
          </button>
          <button
            type="button"
            className="rebuyConfirmBtn"
            onClick={() => {
              // Guard here too: the disabled attribute alone loses a race if a
              // second tap lands in the same frame as the first.
              if (!canAfford || isProcessing) return;
              soundService.playBuyInConfirm();
              onConfirm();
            }}
            disabled={!canAfford || isProcessing}
          >
            {isProcessing ? 'Processing...' : `Rebuy ${money(totalCost)}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RebuyModal;
