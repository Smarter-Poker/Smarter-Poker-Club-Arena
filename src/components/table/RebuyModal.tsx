import React, { useState } from 'react';
import { haptic, soundService } from '../../services/SoundService';
import './RebuyModal.css';

interface RebuyModalProps {
  isOpen: boolean;
  rebuyCost: number;
  rebuyChips: number;
  walletBalance: number;
  onConfirm: () => void;
  onClose: () => void;
  isProcessing: boolean;
}

const RebuyModal: React.FC<RebuyModalProps> = ({
  isOpen,
  rebuyCost,
  rebuyChips,
  walletBalance,
  onConfirm,
  onClose,
  isProcessing,
}) => {
  if (!isOpen) return null;

  const canAfford = walletBalance >= rebuyCost;

  return (
    <div className="rebuyModalOverlay" onClick={onClose}>
      <div className="rebuyModalContent" onClick={(e) => e.stopPropagation()}>
        <div className="rebuyModalHeader">
          <h3>Rebuy</h3>
          <button className="rebuyCloseBtn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="rebuyModalBody">
          <div className="rebuyInfo">
            {/* FIX 197: Format amounts with .toLocaleString() — was raw unformatted numbers */}
            <div className="rebuyRow">
              <span>Rebuy Cost</span>
              <span className="rebuyValue">
                {rebuyCost.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>
            <div className="rebuyRow">
              <span>Chips Received</span>
              <span className="rebuyValue rebuyChips">
                +
                {rebuyChips.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>
            <div className="rebuyRow">
              <span>Wallet Balance</span>
              <span className={`rebuyValue ${!canAfford ? 'insufficient' : ''}`}>
                {walletBalance.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>
          </div>
          {!canAfford && <div className="rebuyWarning">Insufficient balance for rebuy</div>}
        </div>
        <div className="rebuyModalFooter">
          <button className="rebuyDeclineBtn" onClick={onClose}>
            Decline
          </button>
          <button
            className="rebuyConfirmBtn"
            onClick={() => {
              soundService.playBuyInConfirm();
              onConfirm();
            }}
            disabled={!canAfford || isProcessing}
          >
            {isProcessing ? 'Processing...' : 'Rebuy'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RebuyModal;
