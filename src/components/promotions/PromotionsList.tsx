/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PROMOTIONS LIST — Full promotion browser with active/upcoming/ended tabs
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Data source: promotionService.getPromotions()
 * Shows claimed status per promotion for current user.
 */

import { useState, useEffect, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import {
  promotionService,
  type Promotion,
  type PromotionClaim,
} from '../../services/PromotionService';
import PromotionDetail from './PromotionDetail';
import './PromotionsList.css';
import { reportError } from '../../utils/errorReporter';

interface PromotionsListProps {
  userId: string;
  clubId?: string;
}

type TabFilter = 'active' | 'upcoming' | 'ended';

const TYPE_ICONS: Record<string, string> = {
  bonus: '◈',
  freeroll: '◈',
  leaderboard: '★',
  rakeback: '◆',
  special: '★',
  deposit_match: '▣',
  refer_friend: '◉',
};

export default function PromotionsList({ userId, clubId }: PromotionsListProps) {
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [claims, setClaims] = useState<PromotionClaim[]>([]);
  const [tab, setTab] = useState<TabFilter>('active');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedPromo, setSelectedPromo] = useState<Promotion | null>(null);
  const isMounted = useIsMounted();

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [promos, userClaims] = await Promise.all([
        promotionService.getPromotions(clubId, tab),
        promotionService.getUserClaims(userId),
      ]);
      if (isMounted.current) {
        setPromotions(promos);
        setClaims(userClaims);
      }
    } catch (err) {
      reportError(err, 'PromotionsList.load_error');
      if (isMounted.current) setError(true);
    }
    if (isMounted.current) setLoading(false);
  }, [userId, clubId, tab]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useMasterBusSubscription('BALANCE_UPDATED', () => {
    if (isMounted.current) loadData();
  });

  const getTimeRemaining = (endDate: string): string => {
    const diff = new Date(endDate).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    if (days > 0) return `${days}d ${hours}h left`;
    if (hours > 0) return `${hours}h left`;
    const mins = Math.floor((diff % 3_600_000) / 60_000);
    return mins > 0 ? `${mins}m left` : 'Ending soon';
  };

  const isClaimedByUser = (promoId: string) => claims.some((c) => c.promotionId === promoId);

  const handleClaimed = () => {
    loadData(); // Refresh after claim
  };

  if (loading) {
    return (
      <div className="pl-widget">
        <h3 className="pl-title">Promotions</h3>
        <div className="pl-loading">
          <div className="pl-skeleton" />
          <div className="pl-skeleton" />
          <div className="pl-skeleton" />
        </div>
      </div>
    );
  }

  return (
    <div className="pl-widget">
      <div className="pl-header">
        <h3 className="pl-title">Promotions</h3>
        <div className="pl-tabs">
          {(['active', 'upcoming', 'ended'] as TabFilter[]).map((t) => (
            <button
              key={t}
              className={`pl-tab ${tab === t ? 'pl-tab-active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="pl-empty">
          Failed To Load Promotions.{' '}
          <button className="pl-retry" onClick={loadData}>
            Retry
          </button>
        </div>
      ) : promotions.length === 0 ? (
        <div className="pl-empty">No {tab} Promotions At The Moment</div>
      ) : (
        <div className="pl-grid">
          {promotions.map((promo) => {
            const claimed = isClaimedByUser(promo.id);
            const icon = TYPE_ICONS[promo.type] || '◈';

            return (
              <button
                key={promo.id}
                className={`pl-card ${claimed ? 'pl-card-claimed' : ''}`}
                onClick={() => setSelectedPromo(promo)}
              >
                {/* Type badge */}
                <div className="pl-card-header">
                  <span className="pl-card-icon">{icon}</span>
                  <span className="pl-card-type">{promo.type.replace(/_/g, ' ')}</span>
                  {claimed && <span className="pl-claimed-badge">✓ Claimed</span>}
                </div>

                {/* Content */}
                <h4 className="pl-card-title">{promo.title}</h4>
                <p className="pl-card-desc">{promo.description}</p>

                {/* Footer */}
                <div className="pl-card-footer">
                  {promo.prizePool && promo.prizePool > 0 && (
                    <span className="pl-card-prize">{promo.prizePool.toLocaleString()} Chips</span>
                  )}
                  {tab === 'active' && (
                    <span className="pl-card-time"> {getTimeRemaining(promo.endDate)}</span>
                  )}
                  {promo.maxClaims && (
                    <span className="pl-card-claims">
                      {promo.claimCount}/{promo.maxClaims} Claimed
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Detail modal */}
      {selectedPromo && (
        <PromotionDetail
          promotion={selectedPromo}
          userId={userId}
          isClaimed={isClaimedByUser(selectedPromo.id)}
          onClose={() => setSelectedPromo(null)}
          onClaimed={handleClaimed}
        />
      )}
    </div>
  );
}
