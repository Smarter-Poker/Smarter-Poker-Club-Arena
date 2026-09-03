/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DAILY LOGIN REWARD — Full-screen animated reward reveal
 * ═══════════════════════════════════════════════════════════════════════════════
 * Card flip animation revealing diamond/chip reward on first daily visit.
 * "Claim" button with haptic + particle burst.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { triggerHaptic } from '../../services/HapticService';
import { masterBus } from '../../core/MasterBus';
import './DailyLoginReward.css';

interface DailyLoginRewardProps {
  /** Reward amount */
  amount: number;
  /** Type of reward */
  rewardType: 'diamonds' | 'chips';
  /** Current streak day */
  streakDay: number;
  /** Called when claimed */
  onClaim: () => void;
  /** Called when dismissed */
  onClose: () => void;
}

export default function DailyLoginReward({
  amount,
  rewardType,
  streakDay,
  onClaim,
  onClose,
}: DailyLoginRewardProps) {
  const [revealed, setRevealed] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const handleReveal = useCallback(() => {
    triggerHaptic('medium');
    setRevealed(true);
  }, []);

  const handleClaim = useCallback(() => {
    triggerHaptic('success');
    setClaimed(true);
    masterBus.emit('DAILY_REWARD_CLAIMED', { amount, rewardType, streakDay });
    onClaim();
    // Auto-close after celebration — guarded against unmount
    closeTimerRef.current = setTimeout(() => {
      if (isMounted.current) onClose();
    }, 1800);
  }, [onClaim, onClose, amount, rewardType, streakDay]);

  const icon = rewardType === 'diamonds' ? '◆' : '◉';

  return (
    <div className="dlr-overlay" onClick={!claimed ? undefined : onClose}>
      <div className="dlr-container" onClick={(e) => e.stopPropagation()}>
        {/* Streak indicator */}
        <div className="dlr-streak">
          <span className="dlr-streak-fire">▲</span>
          <span className="dlr-streak-text">Day {streakDay} Streak</span>
        </div>

        {/* Card */}
        <div
          className={`dlr-card ${revealed ? 'flipped' : ''} ${claimed ? 'claimed' : ''}`}
          onClick={!revealed ? handleReveal : undefined}
        >
          {/* Front face */}
          <div className="dlr-card-front">
            <div className="dlr-card-pattern" />
            <span className="dlr-card-icon">◈</span>
            <span className="dlr-card-prompt">Tap To Reveal</span>
          </div>

          {/* Back face — reward */}
          <div className="dlr-card-back">
            <span className="dlr-reward-icon">{icon}</span>
            <span className="dlr-reward-amount">+{amount.toLocaleString()}</span>
            <span className="dlr-reward-type">
              {rewardType === 'diamonds' ? 'Diamonds' : 'Chips'}
            </span>
          </div>
        </div>

        {/* Claim button */}
        {revealed && !claimed && (
          <button className="dlr-claim-btn" onClick={handleClaim}>
            Claim Reward
          </button>
        )}

        {/* Claimed celebration */}
        {claimed && (
          <div className="dlr-celebration">
            <span className="dlr-celebration-text">Claimed!</span>
          </div>
        )}

        {/* Close */}
        {!claimed && (
          <button className="dlr-close" onClick={onClose} aria-label="Skip Daily Reward">
            Skip
          </button>
        )}
      </div>
    </div>
  );
}
