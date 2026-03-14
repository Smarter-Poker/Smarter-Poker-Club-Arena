/**
 *  PROMOTIONS PAGE — Club Promotions & Bonuses with Live Updates
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import DailyBonusWheel from '../components/bonus/DailyBonusWheel';
import LeaderboardCard from '../components/leaderboard/LeaderboardCard';
import ReferralModal from '../components/social/ReferralModal';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { promotionService } from '../services/PromotionService';
import ClubBottomNav from '../components/club/ClubBottomNav';
import './PromotionsPage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubUUID } from '../utils/clubIdResolver';
import PageSkeleton from '../components/common/PageSkeleton';

interface Promotion {
  id: string;
  title: string;
  description: string;
  type: 'bonus' | 'freeroll' | 'leaderboard' | 'rakeback' | 'special';
  image_url?: string;
  start_date: string;
  end_date: string;
  prize_pool?: number;
  is_active: boolean;
  requirements?: string;
}

export default function PromotionsPage() {
  useVisibilityRefresh(() => loadPromotions());
  const { clubId } = useParams();
  const { user } = useAuthUser();
  const toast = useToast();

  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'active' | 'upcoming'>('active');
  const [showBonusWheel, setShowBonusWheel] = useState(false);
  const [showReferral, setShowReferral] = useState(false);
  const [visiblePromoCards, setVisiblePromoCards] = useState(new Set<number>());
  const loadPromotionsRef = useRef(async () => {});

  useEffect(() => {
    loadPromotionsRef.current = loadPromotions;
  });

  useEffect(() => {
    let isMounted = true;
    loadPromotions(() => isMounted);

    // Real-time promotions updates
    const channelKey = 'promotions-live';

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'promotions',
        },
        () => {
          toast.info(' New promotion available!');
          if (isMounted) {
            loadPromotionsRef.current();
          }
        }
      )
      .subscribe();

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId]);

  const loadPromotions = async (getIsMounted?: () => boolean) => {
    setLoading(true);
    try {
      let query = supabase
        .from('promotions')
        .select(
          'id, title, description, type, image_url, start_date, end_date, prize_pool, is_active, requirements, club_id'
        )
        .order('start_date', { ascending: false });

      if (clubId) {
        const resolvedId = await resolveClubUUID(clubId);
        query = query.eq('club_id', resolvedId);
      }

      const { data, error } = await query.limit(20);

      if (getIsMounted && !getIsMounted()) return;

      if (!error && data) {
        setPromotions(data);
      }
    } catch (error) {
      console.error('Failed to load promotions:', error);
      toast.error('Failed to load promotions');
    }
    if (getIsMounted && !getIsMounted()) return;
    setLoading(false);
  };

  const now = new Date();
  const filteredPromos = promotions.filter((p) => {
    const start = new Date(p.start_date);
    const end = new Date(p.end_date);

    if (filter === 'active') {
      return start <= now && end >= now;
    } else if (filter === 'upcoming') {
      return start > now;
    }
    return true;
  });

  // Stagger promo cards
  useEffect(() => {
    setVisiblePromoCards(new Set());
    const timers = filteredPromos.map((_, i) =>
      setTimeout(() => setVisiblePromoCards((prev) => new Set([...prev, i])), i * 50)
    );
    return () => timers.forEach((t) => clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredPromos.length]);

  const getTypeIcon = (type: string): string => {
    switch (type) {
      case 'bonus':
        return '🎁';
      case 'freeroll':
        return '🏆';
      case 'leaderboard':
        return '📊';
      case 'rakeback':
        return '💰';
      default:
        return '⭐';
    }
  };

  const formatPromoType = (type: string): string => {
    const labels: Record<string, string> = {
      bonus: 'Bonus',
      freeroll: 'Freeroll',
      leaderboard: 'Leaderboard',
      rakeback: 'Rakeback',
      special: 'Special',
      high_hand: 'High Hand',
      rake_race: 'Rake Race',
      milestone: 'Milestone',
    };
    return (
      labels[type.toLowerCase()] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    );
  };

  const formatDate = (dateStr: string): string => {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  };

  const getTimeRemaining = (endDate: string): string => {
    const end = new Date(endDate);
    const diffMs = end.getTime() - now.getTime();
    const diffDays = Math.floor(diffMs / 86400000);
    const diffHours = Math.floor((diffMs % 86400000) / 3600000);

    if (diffDays > 0) return `${diffDays}d ${diffHours}h left`;
    if (diffHours > 0) return `${diffHours}h left`;
    return 'Ending soon';
  };

  return (
    <div className="promotions-page">
      {/* Daily Bonus Button */}
      <div className="daily-bonus-banner" onClick={() => setShowBonusWheel(true)}>
        <span className="bonus-icon">🎰</span>
        <span className="bonus-text">Claim Your Daily Bonus!</span>
        <span className="bonus-arrow">›</span>
      </div>

      {/* Referral Banner */}
      <div className="referral-banner" onClick={() => setShowReferral(true)}>
        <span className="bonus-icon">🤝</span>
        <span className="bonus-text">Invite Friends & Earn 5% Rake!</span>
        <span className="bonus-arrow">›</span>
      </div>

      <div className="promo-filters">
        {(['active', 'upcoming', 'all'] as const).map((f) => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      <div className="promotions-list">
        {loading ? (
          <div className="promo-skeleton-list">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="promo-skeleton-card">
                <div className="promo-skel-icon" />
                <div className="promo-skel-body">
                  <div className="promo-skel-line" style={{ width: '60%' }} />
                  <div className="promo-skel-line" style={{ width: '80%' }} />
                  <div className="promo-skel-line" style={{ width: '45%' }} />
                </div>
              </div>
            ))}
          </div>
        ) : filteredPromos.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">○</span>
            <p>No {filter} promotions</p>
          </div>
        ) : (
          filteredPromos.map((promo, index) => (
            <div
              key={promo.id}
              className="promo-card"
              style={{
                opacity: visiblePromoCards.has(index) ? 1 : 0,
                transform: visiblePromoCards.has(index) ? 'translateY(0)' : 'translateY(10px)',
                transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              {promo.image_url && (
                <div className="promo-image">
                  <img src={promo.image_url} alt="" loading="lazy" />
                </div>
              )}
              <div className="promo-content">
                <div className="promo-header">
                  <span className="promo-icon">{getTypeIcon(promo.type)}</span>
                  <span className="promo-type">{formatPromoType(promo.type)}</span>
                </div>
                <h3 className="promo-title">{promo.title}</h3>
                <p className="promo-desc">{promo.description}</p>

                <div className="promo-meta">
                  <span className="promo-dates">
                    {formatDate(promo.start_date)} - {formatDate(promo.end_date)}
                  </span>
                  {promo.prize_pool && (
                    <span className="promo-prize">{promo.prize_pool.toLocaleString()}</span>
                  )}
                </div>

                {new Date(promo.end_date) > now && new Date(promo.start_date) <= now && (
                  <div className="promo-countdown-row">
                    <span className="promo-countdown">{getTimeRemaining(promo.end_date)}</span>
                    {new Date(promo.end_date).getTime() - now.getTime() < 86400000 && (
                      <span className="ending-soon-badge">⚠️ Ending Soon</span>
                    )}
                  </div>
                )}

                {/* Show LeaderboardCard for leaderboard promotions */}
                {promo.type === 'leaderboard' && (
                  <div className="promo-leaderboard">
                    <LeaderboardCard
                      promotionId={promo.id}
                      title={`${promo.title || 'Leaderboard'} Rankings`}
                      limit={5}
                      showCurrentUser={true}
                    />
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Daily Bonus Wheel Modal */}
      {showBonusWheel && (
        <div className="bonus-wheel-overlay" onClick={() => setShowBonusWheel(false)}>
          <div className="bonus-wheel-modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowBonusWheel(false)}>
              ✕
            </button>
            <DailyBonusWheel
              onSpin={async () => {
                // Handle spin completion
                setShowBonusWheel(false);
              }}
            />
          </div>
        </div>
      )}

      {/* Referral Modal */}
      <ReferralModal
        isOpen={showReferral}
        onClose={() => setShowReferral(false)}
        referralCode={user?.id?.slice(0, 8).toUpperCase() || 'POKER123'}
        referralLink={`https://clubarena.poker/join?ref=${user?.id || 'guest'}`}
        totalReferrals={0}
      />

      {/* Bottom Navigation */}
      {clubId && <ClubBottomNav clubId={clubId} />}
    </div>
  );
}
