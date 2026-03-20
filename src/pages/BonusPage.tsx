/**
 *  BONUS PAGE — Daily Bonuses & Rewards
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { bonusService } from '../services/BonusService';
import { useToast } from '../components/common/Toast';
import { haptic } from '../services/HapticService';
import './BonusPage.css';
import { retryAsync } from '../utils/retryAsync';
import { retryFetch } from '../utils/retryFetch';
import { useIsMounted } from '../hooks/useIsMounted';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';

interface DailyBonus {
  day: number;
  reward: string;
  claimed: boolean;
}

interface SpecialBonus {
  id: string;
  title: string;
  description: string;
  reward: string;
  expires_at: string;
  claimed: boolean;
}

export default function BonusPage() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  useVisibilityRefresh(() => {
    if (user?.id) loadBonuses();
  });

  const [dailyBonuses, setDailyBonuses] = useState<DailyBonus[]>([]);
  const [currentDay, setCurrentDay] = useState(1);
  const [specialBonuses, setSpecialBonuses] = useState<SpecialBonus[]>([]);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [visibleDayCards, setVisibleDayCards] = useState(new Set<number>());
  const [visibleBonusCards, setVisibleBonusCards] = useState(new Set<number>());
  const toast = useToast();
  const isMounted = useIsMounted();
  const [showConfetti, setShowConfetti] = useState(false);

  // Safety timeout: prevent infinite skeleton if auth/Supabase hangs
  useEffect(() => {
    const timeout = setTimeout(() => setLoading(false), 5000);
    return () => clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (user?.id) {
      let isMounted = true;
      loadBonuses(() => isMounted);

      const channelKey = 'bonuses-live';

      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'special_bonuses',
            filter: `user_id=eq.${user.id}`,
          },
          () => {
            if (!isMounted) return;
            toast.info(' New bonus available!');
            loadBonuses(() => isMounted);
          }
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            console.error('[BonusPage] ❌ Realtime channel error:', err?.message || err);
          }
          if (status === 'TIMED_OUT') {
            console.warn('[BonusPage] ⏱️ Realtime channel timed out');
          }
        });

      return () => {
        isMounted = false;
        masterBus.removeRegisteredChannel(channelKey);
      };
    }
  }, [user?.id]);

  // ── Bus Listener: cross-page sync ──
  useEffect(() => {
    let isMounted = true;
    const unsubs = [
      masterBus.subscribeDebounced(
        'BALANCE_UPDATED',
        () => {
          if (isMounted) loadBonuses(() => isMounted);
        },
        500
      ),
      masterBus.subscribeDebounced(
        'DAILY_REWARD_CLAIMED',
        () => {
          if (isMounted) loadBonuses(() => isMounted);
        },
        500
      ),
    ];
    return () => {
      isMounted = false;
      unsubs.forEach((u) => u());
    };
  }, []);

  const loadingRef = useRef(false);

  const loadBonuses = async (getIsMounted?: () => boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (!getIsMounted || getIsMounted()) setLoading(true);
    try {
      const { data: profile } = await retryFetch(
        () =>
          supabase
            .from('profiles')
            .select('streak_days, last_login')
            .eq('id', user?.id)
            .maybeSingle()
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      if (getIsMounted && !getIsMounted()) return;
      if (profile) {
        setCurrentDay(profile.streak_days || 1);

        const dailies: DailyBonus[] = [];
        for (let i = 1; i <= 7; i++) {
          dailies.push({
            day: i,
            reward: i === 7 ? ' 100 Diamonds' : `${i * 10} Chips`,
            claimed: i <= (profile.streak_days || 0),
          });
        }
        setDailyBonuses(dailies);
      }

      const { data: specials } = await retryFetch(
        () =>
          supabase
            .from('special_bonuses')
            .select('id, title, description, reward, expires_at, claimed')
            .eq('user_id', user?.id)
            .gte('expires_at', new Date().toISOString())
            .order('expires_at', { ascending: true })
            .limit(100)
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      if (getIsMounted && !getIsMounted()) return;
      if (specials) {
        setSpecialBonuses(
          specials.map((b: any) => ({
            id: b.id,
            title: b.title,
            description: b.description,
            reward: b.reward,
            expires_at: b.expires_at,
            claimed: b.claimed,
          }))
        );
      }
    } catch (error) {
      console.error('Failed to load bonuses:', error);
      if (!getIsMounted || getIsMounted()) toast.error('Failed to load bonuses');
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) setLoading(false);
    }
  };

  const claimDailyBonus = async () => {
    if (claiming) return;
    setClaiming(true);
    try {
      // Update streak and claim bonus
      const { error: claimErr } = await retryAsync(
        () => supabase.rpc('claim_daily_bonus', { p_user_id: user?.id }),
        3
      );
      if (claimErr) {
        console.error('[BonusPage] claim_daily_bonus failed:', claimErr.message);
        toast.error('Failed to claim bonus');
        setClaiming(false);
        return;
      }
      toast.success('Daily bonus claimed!');
      masterBus.emit('DAILY_REWARD_CLAIMED', {
        amount: currentDay === 7 ? 100 : currentDay * 10,
        rewardType: currentDay === 7 ? 'diamonds' : 'chips',
        streakDay: currentDay,
      });
      setShowConfetti(true);
      haptic.medium();
      setTimeout(() => setShowConfetti(false), 2500);
      loadBonuses();
    } catch (error) {
      console.error('Failed to claim bonus:', error);
      toast.error('Failed to claim bonus');
    }
    setClaiming(false);
  };

  const claimSpecialBonus = async (bonusId: string) => {
    if (!user?.id) return;
    try {
      const { error } = await supabase
        .from('special_bonuses')
        .update({ claimed: true, claimed_at: new Date().toISOString() })
        .eq('id', bonusId)
        .eq('user_id', user.id)
        .eq('claimed', false); // Prevent double-claim race condition
      if (error) throw error;
      toast.success('Special bonus claimed!');
      masterBus.emit('BALANCE_UPDATED', { source: 'special_bonus', userId: user.id });
      loadBonuses();
    } catch (error) {
      console.error('Failed to claim special bonus:', error);
      toast.error('Failed to claim special bonus');
    }
  };

  // Stagger day cards
  useEffect(() => {
    setVisibleDayCards(new Set());
    const timers = dailyBonuses.map((_, i) =>
      setTimeout(() => setVisibleDayCards((prev) => new Set([...prev, i])), i * 40)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [dailyBonuses.length]);

  // Stagger special bonus cards
  useEffect(() => {
    setVisibleBonusCards(new Set());
    const timers = specialBonuses.map((_, i) =>
      setTimeout(() => setVisibleBonusCards((prev) => new Set([...prev, i])), i * 50)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [specialBonuses.length]);

  const getTimeRemaining = (expiresAt: string): string => {
    const diff = new Date(expiresAt).getTime() - Date.now();
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    if (hours > 24) return `${Math.floor(hours / 24)}d left`;
    if (hours > 0) return `${hours}h ${minutes}m left`;
    return `${minutes}m left`;
  };

  if (loading) {
    return (
      <div className="bonus-page">
        <section className="bonus-section">
          <div className="bonus-skeleton-header" />
          <div className="bonus-skeleton-calendar">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="bonus-skeleton-day" />
            ))}
          </div>
          <div className="bonus-skeleton-btn" />
        </section>
      </div>
    );
  }

  return (
    <div className="bonus-page">
      {/* Confetti Celebration (Initiative 7) */}
      {showConfetti && (
        <div className="bonus-confetti-container">
          {Array.from({ length: 30 }).map((_, i) => (
            <div
              key={i}
              className="confetti-piece"
              style={{
                left: `${Math.random() * 100}%`,
                animationDelay: `${Math.random() * 0.5}s`,
                animationDuration: `${1.5 + Math.random() * 1.5}s`,
                backgroundColor: ['#FFD700', '#00d4ff', '#ff6b6b', '#10b981', '#a855f7'][i % 5],
              }}
            />
          ))}
        </div>
      )}
      {/* Daily Login Calendar */}
      <section className="bonus-section">
        <h3>Daily Login Bonus</h3>
        <p className="section-desc">Login daily to earn rewards!</p>
        <div className="daily-calendar">
          {dailyBonuses.map((bonus, index) => (
            <div
              key={bonus.day}
              className={`day-card ${bonus.claimed ? 'claimed' : ''} ${bonus.day === currentDay ? 'current' : ''}`}
              style={{
                opacity: visibleDayCards.has(index) ? 1 : 0,
                transform: visibleDayCards.has(index) ? 'scale(1)' : 'scale(0.9)',
                transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className="day-num">Day {bonus.day}</span>
              <span className="day-reward">{bonus.reward}</span>
              {bonus.claimed && <span className="claimed-check"></span>}
            </div>
          ))}
        </div>
        <button
          className="btn btn-primary claim-btn"
          onClick={claimDailyBonus}
          disabled={claiming || dailyBonuses[currentDay - 1]?.claimed}
        >
          {claiming
            ? 'Claiming...'
            : dailyBonuses[currentDay - 1]?.claimed
              ? 'Already Claimed'
              : "Claim Today's Bonus"}
        </button>
      </section>

      {/* Special Bonuses */}
      {specialBonuses.length > 0 ? (
        <section className="bonus-section">
          <h3>Special Bonuses</h3>
          <div className="special-list">
            {specialBonuses.map((bonus, index) => (
              <div
                key={bonus.id}
                className={`special-card ${bonus.claimed ? 'claimed' : ''}`}
                style={{
                  opacity: visibleBonusCards.has(index) ? 1 : 0,
                  transform: visibleBonusCards.has(index) ? 'translateY(0)' : 'translateY(10px)',
                  transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                }}
              >
                <div className="special-info">
                  <h4>{bonus.title}</h4>
                  <p>{bonus.description}</p>
                  <span className="special-reward"> {bonus.reward}</span>
                </div>
                <div className="special-actions">
                  <span className="special-expires">{getTimeRemaining(bonus.expires_at)}</span>
                  {!bonus.claimed && (
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => claimSpecialBonus(bonus.id)}
                      disabled={claiming}
                    >
                      Claim
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="bonus-section" style={{ textAlign: 'center', padding: '2rem 1rem' }}>
          <h3>Special Bonuses</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            No special bonuses available right now. Check back later for exclusive rewards!
          </p>
        </section>
      )}
    </div>
  );
}
