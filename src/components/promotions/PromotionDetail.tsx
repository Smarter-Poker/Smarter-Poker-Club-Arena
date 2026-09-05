/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PROMOTION DETAIL — Full modal with claim functionality + leaderboard
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import {
  promotionService,
  type Promotion,
  type LeaderboardEntry,
} from '../../services/PromotionService';
import { useToast } from '../common/Toast';
import './PromotionDetail.css';
import { reportError } from '../../utils/errorReporter';

interface PromotionDetailProps {
  promotion: Promotion;
  userId: string;
  isClaimed: boolean;
  onClose: () => void;
  onClaimed: () => void;
}

export default function PromotionDetail({
  promotion,
  userId,
  isClaimed,
  onClose,
  onClaimed,
}: PromotionDetailProps) {
  const [claiming, setClaiming] = useState(false);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loadingLb, setLoadingLb] = useState(false);
  const toast = useToast();
  const popupRef = useRef<HTMLDivElement>(null);
  const isMounted = useIsMounted();

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Load leaderboard for leaderboard-type promotions — keyed by promotion.id
  // to prevent re-fetch when parent re-renders with same promotion
  const loadLeaderboard = useCallback(async (promoId: string) => {
    setLoadingLb(true);
    try {
      const entries = await promotionService.getLeaderboard(promoId, 10);
      if (isMounted.current) setLeaderboard(entries);
    } catch (err) {
      reportError(err, 'PromotionDetail.leaderboard_error');
    }
    if (isMounted.current) setLoadingLb(false);
  }, []);

  useEffect(() => {
    if (promotion.type !== 'leaderboard') return;
    loadLeaderboard(promotion.id);
  }, [promotion.id, promotion.type, loadLeaderboard]);

  const handleClaim = async () => {
    if (isClaimed || claiming) return;
    setClaiming(true);
    try {
      await promotionService.claimPromotion(promotion.id, userId);
      if (!isMounted.current) return;
      /* NO BALANCE_UPDATED HERE, AND THE MESSAGE SAYS WHAT HAPPENED.
         Claiming records a `promotion_claims` row; it credits no wallet. Only
         the deposit-match path calls `add_to_promo_wallet`, and that path
         filters on a promotion type the table's own check constraint forbids
         (`promotions_type_check` allows leaderboard, rake_race, milestone,
         mystery, high_hand), so it can never match. Emitting BALANCE_UPDATED
         made every surface re-read a balance that had not moved, and
         "Promotion claimed!" beside it read as "you have been paid". */
      toast.success('Promotion Claimed. Your Reward Is Recorded Against This Offer.');
      onClaimed();
    } catch (err: any) {
      reportError(err, 'PromotionDetail.claim_error');
      if (isMounted.current) toast.error(err.message || 'Failed to claim promotion');
    }
    if (isMounted.current) setClaiming(false);
  };

  const isActive = (() => {
    const now = Date.now();
    return (
      new Date(promotion.startDate).getTime() <= now && new Date(promotion.endDate).getTime() >= now
    );
  })();

  const isFullyClaimed = promotion.maxClaims ? promotion.claimCount >= promotion.maxClaims : false;

  const getTimeRemaining = (): string => {
    const diff = new Date(promotion.endDate).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    if (days > 0) return `${days}d ${hours}h remaining`;
    if (hours > 0) return `${hours}h remaining`;
    const mins = Math.floor((diff % 3_600_000) / 60_000);
    return mins > 0 ? `${mins}m remaining` : 'Ending soon';
  };

  return (
    <div className="pd-overlay">
      <div className="pd-modal" ref={popupRef}>
        {/* Header */}
        <div className="pd-header">
          <div>
            <span className="pd-type-badge">{promotion.type.replace(/_/g, ' ')}</span>
            <h3 className="pd-title">{promotion.title}</h3>
          </div>
          <button className="pd-close" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Description */}
        <p className="pd-description">{promotion.description}</p>

        {/* Stats row */}
        <div className="pd-stats">
          {promotion.prizePool && promotion.prizePool > 0 && (
            <div className="pd-stat">
              <span className="pd-stat-value"> {promotion.prizePool.toLocaleString()}</span>
              <span className="pd-stat-label">Prize Pool</span>
            </div>
          )}
          <div className="pd-stat">
            <span className="pd-stat-value"> {getTimeRemaining()}</span>
            <span className="pd-stat-label">Time Left</span>
          </div>
          {promotion.maxClaims && (
            <div className="pd-stat">
              <span className="pd-stat-value">
                {promotion.claimCount}/{promotion.maxClaims}
              </span>
              <span className="pd-stat-label">Claimed</span>
            </div>
          )}
          {promotion.bonusPercent && (
            <div className="pd-stat">
              <span className="pd-stat-value">{promotion.bonusPercent}%</span>
              <span className="pd-stat-label">Bonus Match</span>
            </div>
          )}
        </div>

        {/* Requirements */}
        {promotion.requirements && (
          <div className="pd-section">
            <h4>Requirements</h4>
            <p>{promotion.requirements}</p>
          </div>
        )}

        {/* Terms */}
        {promotion.terms && (
          <div className="pd-section">
            <h4>Terms</h4>
            <p>{promotion.terms}</p>
          </div>
        )}

        {/* Leaderboard */}
        {promotion.type === 'leaderboard' && (
          <div className="pd-section">
            <h4>Leaderboard</h4>
            {loadingLb ? (
              <div className="pd-lb-loading">Loading...</div>
            ) : leaderboard.length === 0 ? (
              <div className="pd-lb-empty">No Entries Yet</div>
            ) : (
              <div className="pd-lb">
                {leaderboard.map((entry) => (
                  <div key={entry.userId} className="pd-lb-row">
                    <span className="pd-lb-rank">#{entry.rank}</span>
                    <span className="pd-lb-name">{entry.displayName || entry.username}</span>
                    <span className="pd-lb-score">{entry.score.toLocaleString()}</span>
                    {entry.prize && (
                      <span className="pd-lb-prize"> {entry.prize.toLocaleString()}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Claim button */}
        <button
          className={`pd-claim-btn ${isClaimed ? 'pd-claimed' : ''} ${!isActive || isFullyClaimed ? 'pd-disabled' : ''}`}
          onClick={handleClaim}
          disabled={isClaimed || claiming || !isActive || isFullyClaimed}
        >
          {isClaimed
            ? '✓ Claimed'
            : claiming
              ? 'Claiming...'
              : isFullyClaimed
                ? 'Fully Claimed'
                : !isActive
                  ? 'Not Active'
                  : 'Claim Promotion'}
        </button>
      </div>
    </div>
  );
}
