/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  REBUY MODAL — Player-facing rebuy prompt for tournament play
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useCallback, useRef } from 'react';
import { tournamentService } from '../../services/TournamentService';
import { masterBus } from '../../core/MasterBus';
import { soundService } from '../../services/SoundService';
import { safeErrorMessage } from '../../utils/safeErrorMessage';
// Whole-number tournament money (Dan 2026-08-20).
import { money } from '../../utils/buyIn';
import './RebuyModal.css';

interface RebuyModalProps {
  tournamentId: string;
  userId: string;
  tournamentName: string;
  rebuyCost: number;
  rebuyChips: number;
  currentStack: number;
  rebuyWindowLevel: number;
  currentLevel: number;
  onClose: () => void;
  onSuccess: (newStack: number) => void;
}

export const RebuyModal: React.FC<RebuyModalProps> = ({
  tournamentId,
  userId,
  tournamentName,
  rebuyCost,
  rebuyChips,
  currentStack,
  rebuyWindowLevel,
  currentLevel,
  onClose,
  onSuccess,
}) => {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not `processing`: setProcessing lands after a render, so a
  // same-frame double tap otherwise fires two rebuys. The rebuy RPC takes no
  // idempotency key, so the second one is a real second charge.
  const inFlightRef = useRef(false);

  const handleRebuy = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setProcessing(true);
    setError(null);
    try {
      const result = await tournamentService.processRebuy(tournamentId, userId);
      if (result.success) {
        soundService.playBuyInConfirm();
        masterBus.emit('TOURNAMENT_UPDATED', {
          tournamentId,
          status: 'rebuy',
        });
        onSuccess(result.newStack || rebuyChips);
      }
    } catch (err: any) {
      setError(safeErrorMessage(err, 'Rebuy failed'));
    } finally {
      setProcessing(false);
      inFlightRef.current = false;
    }
  }, [tournamentId, userId, rebuyChips, onSuccess]);

  const levelsRemaining = Math.max(0, rebuyWindowLevel - currentLevel);

  return (
    <div className="rebuy-modal-overlay" onClick={onClose}>
      <div className="rebuy-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rm-header">
          <h3 className="rm-title">♻ Rebuy Available</h3>
          <button className="rm-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="rm-body">
          <div className="rm-tournament-name">{tournamentName}</div>

          <div className="rm-stack-display">
            <div className="rm-stack-current">
              <span className="rm-stack-label">Current Stack</span>
              <span className="rm-stack-value rm-stack-low">{currentStack.toLocaleString()}</span>
            </div>
            <span className="rm-arrow">→</span>
            <div className="rm-stack-new">
              <span className="rm-stack-label">After Rebuy</span>
              <span className="rm-stack-value rm-stack-high">
                {(currentStack + rebuyChips).toLocaleString()}
              </span>
            </div>
          </div>

          <div className="rm-details">
            <div className="rm-detail-row">
              <span className="rm-detail-label">Rebuy Cost</span>
              <span className="rm-detail-value">{money(rebuyCost)} Chips</span>
            </div>
            <div className="rm-detail-row">
              <span className="rm-detail-label">Chips Received</span>
              <span className="rm-detail-value rm-highlight">+{rebuyChips.toLocaleString()}</span>
            </div>
            <div className="rm-detail-row">
              <span className="rm-detail-label">Window Closes</span>
              <span className="rm-detail-value">
                {levelsRemaining > 0
                  ? `In ${levelsRemaining} Level${levelsRemaining > 1 ? 's' : ''}`
                  : 'Last Chance!'}
              </span>
            </div>
          </div>

          {error && <div className="rm-error">⚠ {error}</div>}
        </div>

        <div className="rm-footer">
          <button className="rm-btn rm-btn-cancel" onClick={onClose} disabled={processing}>
            Decline
          </button>
          <button className="rm-btn rm-btn-rebuy" onClick={handleRebuy} disabled={processing}>
            {processing ? 'Processing...' : `Rebuy - ${money(rebuyCost)}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RebuyModal;
