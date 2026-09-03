/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PROMOTION CAROUSEL — Auto-rotating active promotions banner for lobby
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { promotionService, type Promotion } from '../../services/PromotionService';
import './PromotionCarousel.css';
import { reportError } from '../../utils/errorReporter';

interface PromotionCarouselProps {
  clubId?: string;
  onPromoClick?: (promotion: Promotion) => void;
}

const GRADIENT_PALETTE = [
  'linear-gradient(135deg, #7c3aed, #db2777)',
  'linear-gradient(135deg, #2563eb, #06b6d4)',
  'linear-gradient(135deg, #059669, #34d399)',
  'linear-gradient(135deg, #d97706, #f59e0b)',
  'linear-gradient(135deg, #dc2626, #f87171)',
];

const TYPE_ICONS: Record<string, string> = {
  bonus: '◈',
  freeroll: '◈',
  leaderboard: '★',
  rakeback: '◆',
  special: '★',
  deposit_match: '▣',
  refer_friend: '◉',
};

export default function PromotionCarousel({ clubId, onPromoClick }: PromotionCarouselProps) {
  const [promos, setPromos] = useState<Promotion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  useEffect(() => {
    const loadPromos = async () => {
      try {
        const data = await promotionService.getPromotions(clubId, 'active');
        if (isMounted.current) setPromos(data);
      } catch (err) {
        reportError(err, 'PromotionCarousel.load_error');
      }
      if (isMounted.current) setLoading(false);
    };
    loadPromos();
  }, [clubId]);

  // Refresh when data changes (e.g. promo claimed, new promo created)
  useMasterBusSubscription('BALANCE_UPDATED', () => {
    if (isMounted.current) {
      promotionService.getPromotions(clubId, 'active').then((data) => {
        if (isMounted.current) setPromos(data);
      });
    }
  });

  // Auto-rotate every 6 seconds
  useEffect(() => {
    if (promos.length <= 1) return;
    timerRef.current = setInterval(() => {
      if (isMounted.current) {
        setActiveIndex((prev) => (prev + 1) % promos.length);
      }
    }, 6000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [promos.length]);

  const goTo = useCallback(
    (index: number) => {
      setActiveIndex(index);
      // Reset the auto-rotate timer so it doesn't advance mid-view
      if (timerRef.current) clearInterval(timerRef.current);
      if (promos.length > 1) {
        timerRef.current = setInterval(() => {
          if (isMounted.current) {
            setActiveIndex((prev) => (prev + 1) % promos.length);
          }
        }, 6000);
      }
    },
    [promos.length]
  );

  if (loading || promos.length === 0) return null;

  // Bounds-check activeIndex to prevent stale index after promos array shrinks
  const safeIndex = activeIndex >= promos.length ? 0 : activeIndex;
  const promo = promos[safeIndex];
  const gradient = GRADIENT_PALETTE[safeIndex % GRADIENT_PALETTE.length];
  const icon = TYPE_ICONS[promo.type] || '◈';

  const getTimeRemaining = (): string => {
    const diff = new Date(promo.endDate).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    if (days > 0) return `${days}d ${hours}h left`;
    if (hours > 0) return `${hours}h left`;
    const mins = Math.floor((diff % 3_600_000) / 60_000);
    return mins > 0 ? `${mins}m left` : 'Ending soon';
  };

  return (
    <div className="pc-container">
      <button
        className="pc-banner"
        style={{ background: gradient }}
        onClick={() => onPromoClick?.(promo)}
        aria-label="View Promotion Details"
      >
        <div className="pc-icon">{icon}</div>
        <div className="pc-content">
          <span className="pc-type">{promo.type.replace(/_/g, ' ')}</span>
          <h4 className="pc-title">{promo.title}</h4>
          <p className="pc-desc">{promo.description}</p>
        </div>
        <div className="pc-meta">
          {promo.prizePool && promo.prizePool > 0 && (
            <span className="pc-prize"> {promo.prizePool.toLocaleString()}</span>
          )}
          <span className="pc-time"> {getTimeRemaining()}</span>
        </div>
      </button>

      {/* Dot indicators */}
      {promos.length > 1 && (
        <div className="pc-dots">
          {promos.map((_, i) => (
            <button
              key={i}
              className={`pc-dot ${i === safeIndex ? 'pc-dot-active' : ''}`}
              onClick={() => goTo(i)}
              aria-label={`Promotion ${i + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
