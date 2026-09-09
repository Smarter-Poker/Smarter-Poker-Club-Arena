/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ADD-ON MODAL — 60-second timed add-on prompt
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { tournamentService } from '../../services/TournamentService';
import { masterBus } from '../../core/MasterBus';
import { soundService } from '../../services/SoundService';
import { safeErrorMessage } from '../../utils/safeErrorMessage';
// Whole-number tournament money (Dan 2026-08-20).
import { money } from '../../utils/buyIn';
import './RebuyModal.css'; // Shared styles

interface AddOnModalProps {
  tournamentId: string;
  userId: string;
  tournamentName: string;
  addOnCost: number;
  addOnChips: number;
  currentStack: number;
  durationSeconds?: number;
  onClose: () => void;
  onSuccess: (newStack: number) => void;
}

export const AddOnModal: React.FC<AddOnModalProps> = ({
  tournamentId,
  userId,
  tournamentName,
  addOnCost,
  addOnChips,
  currentStack,
  durationSeconds = 60,
  onClose,
  onSuccess,
}) => {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(durationSeconds);
  const [purchased, setPurchased] = useState(false);
  // Prevent same-frame taps while the service owns durable purchase identity.
  const inFlightRef = useRef(false);

  // ── Countdown timer ──
  useEffect(() => {
    if (purchased) return;
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onClose();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [purchased, onClose]);

  const handleAddOn = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setProcessing(true);
    setError(null);
    try {
      const result = await tournamentService.processAddOn(tournamentId, userId);
      if (result.success) {
        setPurchased(true);
        soundService.playBuyInConfirm();
        masterBus.emit('TOURNAMENT_UPDATED', {
          tournamentId,
          status: 'addon',
        });
        onSuccess(result.newStack);
      }
    } catch (err: any) {
      setError(safeErrorMessage(err, 'Add-on failed'));
    } finally {
      setProcessing(false);
      inFlightRef.current = false;
    }
  }, [tournamentId, userId, onSuccess]);

  const progressPercent = (countdown / durationSeconds) * 100;

  return (
    <div className="addon-modal-overlay" onClick={onClose}>
      <div className="addon-modal" onClick={(e) => e.stopPropagation()}>
        <div className="am-header">
          <h3 className="am-title">Add-On Period</h3>
          <button className="am-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="am-body">
          <div className="am-tournament-name">{tournamentName}</div>

          {/* ── Countdown ── */}
          {!purchased && (
            <div className="am-countdown">
              <span className="am-countdown-label">Time Remaining</span>
              <span className="am-countdown-value">
                {Math.floor(countdown / 60)}:{(countdown % 60).toString().padStart(2, '0')}
              </span>
              <div className="am-countdown-bar">
                <div className="am-countdown-fill" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}

          {/* ── Stack Preview ── */}
          <div className="am-stack-display">
            <div className="am-stack-current">
              <span className="am-stack-label">Current Stack</span>
              <span className="am-stack-value">{currentStack.toLocaleString()}</span>
            </div>
            <span className="am-arrow">→</span>
            <div className="am-stack-new">
              <span className="am-stack-label">After Add-On</span>
              <span className="am-stack-value am-stack-high">
                {(currentStack + addOnChips).toLocaleString()}
              </span>
            </div>
          </div>

          <div className="am-details">
            <div className="am-detail-row">
              <span className="am-detail-label">Add-On Cost</span>
              <span className="am-detail-value">{money(addOnCost)} Chips</span>
            </div>
            <div className="am-detail-row">
              <span className="am-detail-label">Chips Received</span>
              <span className="am-detail-value am-highlight">+{addOnChips.toLocaleString()}</span>
            </div>
            <div className="am-detail-row">
              <span className="am-detail-label">One-Time Only</span>
              <span className="am-detail-value">Yes</span>
            </div>
          </div>

          {purchased && (
            <div className="am-success">Add-On Purchased! Your Stack Has Been Updated.</div>
          )}

          {error && <div className="am-error">⚠ {error}</div>}
        </div>

        <div className="am-footer">
          <button className="am-btn am-btn-cancel" onClick={onClose} disabled={processing}>
            {purchased ? 'Close' : 'Decline'}
          </button>
          {!purchased && (
            <button
              className="am-btn am-btn-addon"
              onClick={handleAddOn}
              disabled={processing || countdown <= 0}
            >
              {processing ? 'Processing...' : `Add-On - ${money(addOnCost)}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default AddOnModal;
