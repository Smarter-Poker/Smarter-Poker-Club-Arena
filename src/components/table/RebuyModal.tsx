import React from 'react';
import { soundService } from '../../services/SoundService';
// Whole-number tournament money (Dan 2026-08-20): "Sit and Go and any
// tournament buy-ins must never be decimal buy-ins, whole numbers only."
// This file used to define its own money() that FORCED two decimals.
import { money } from '../../utils/buyIn';
import DiamondsToChipsButton from '../games/DiamondsToChipsButton';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { PurchaseConsole, PurchaseText } from './PurchaseConsole';
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
  /**
   * The spendable balance, or null when it could not be read. Unknown is not
   * zero (launch audit 2026-10-05): a failed read used to arrive here as 0,
   * print "Insufficient", disable Rebuy, and the player was eliminated when
   * the window closed with the chips to stay in. An unknown balance lets the
   * attempt through; the server, which debits, decides.
   */
  walletBalance: number | null;
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
  const dialogRef = useFocusTrap(isOpen, '#rebuy-modal-title');
  if (!isOpen) return null;

  // The advertised total is whole, but its prize/fee split is cent-accurate.
  // Rounding both halves independently turned 13.50 + 1.50 into a fictional
  // 16-chip charge. Add first, then round only the whole advertised price.
  const totalCost = Math.round((Number(rebuyCost) + Number(rebuyFee)) * 100) / 100;
  // Gate on the TOTAL - this is the number the server debits.
  const balanceUnknown = walletBalance === null || !Number.isFinite(walletBalance);
  const canAfford = balanceUnknown || (walletBalance as number) >= totalCost;
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
    <div className="rebuy-modal__overlay addon-console__overlay" onClick={dismiss}>
      <div
        className="addon-console"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            dismiss();
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rebuy-modal-title"
        aria-busy={isProcessing || undefined}
      >
        <PurchaseConsole
          title="Rebuy Available"
          titleId="rebuy-modal-title"
          subtitle="Add Chips To Continue Playing"
          status={
            <>
              <strong>
                <PurchaseText>
                  {isProcessing
                    ? 'Working'
                    : purchaseUnconfirmed
                      ? 'Pending'
                      : canAfford
                        ? 'Ready'
                        : 'Balance Low'}
                </PurchaseText>
              </strong>
              <span>{purchaseUnconfirmed ? 'Confirmation Needed' : 'Rebuy Status'}</span>
            </>
          }
          rows={[
            <React.Fragment key="cost">
              <span>Rebuy Cost</span>
              <strong>
                <PurchaseText>{`${money(totalCost)} Chips`}</PurchaseText>
              </strong>
            </React.Fragment>,
            <React.Fragment key="chips">
              <span>Chips Received</span>
              <strong>
                <PurchaseText>{`+${rebuyChips.toLocaleString()} Chips`}</PurchaseText>
              </strong>
            </React.Fragment>,
            <React.Fragment key="balance">
              <span>Your Balance</span>
              <strong>
                <PurchaseText>
                  {balanceUnknown ? '--' : `${money(walletBalance as number)} Chips`}
                </PurchaseText>
              </strong>
            </React.Fragment>,
          ]}
          secondary={{
            label: 'Decline',
            onClick: dismiss,
            disabled: isProcessing || purchaseUnconfirmed,
            'aria-label': 'Decline Rebuy',
          }}
          primary={{
            label: primaryLabel,
            onClick: () => {
              if (!canConfirm || isProcessing) return;
              soundService.playBuyInConfirm();
              onConfirm();
            },
            disabled: !canConfirm || isProcessing,
          }}
          onClose={dismiss}
          closeDisabled={isProcessing || purchaseUnconfirmed}
          messages={
            <>
              {purchaseUnconfirmed && (
                <p role="alert">Rebuy Not Confirmed. Retry To Check The Same Purchase.</p>
              )}
              {!canAfford && !purchaseUnconfirmed && (
                <p role="alert">Insufficient Balance. You Need {money(totalCost)} To Rebuy.</p>
              )}
              {!canAfford && onPlayDiamonds && (
                <DiamondsToChipsButton
                  clubId={diamondGamesClubId}
                  enabled={isOpen && !isProcessing}
                  size="compact"
                  onGo={onPlayDiamonds}
                />
              )}
            </>
          }
        />
      </div>
    </div>
  );
};

export default RebuyModal;
