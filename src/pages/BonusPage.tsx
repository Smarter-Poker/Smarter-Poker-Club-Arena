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
import { retryFetch } from '../utils/retryFetch';
import { useIsMounted } from '../hooks/useIsMounted';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { reportError } from '../utils/errorReporter';
import RewardsSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';

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
  // Server-decided, not inferred from the ladder: whether a claim is available
  // depends on the last claim's UTC date, which only the server knows.
  const [canClaimDaily, setCanClaimDaily] = useState(false);
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
            if (err) reportError(err?.message || err, 'BonusPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[BonusPage] Realtime channel timed out');
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
      // AUDIT M18: this page used to read `profiles.streak_days` and render a
      // hardcoded `day * 10` chips ladder with "100 Diamonds" on day 7. That was
      // a third, independent idea of what the daily bonus is — disagreeing with
      // BonusService's DAILY_REWARDS constant AND with what the claim RPC paid.
      // The schedule and the streak now both come from the server, through
      // BonusService, so the ladder shown is the ladder that pays.
      const status = await bonusService.getBonusStatus(user!.id);

      if (getIsMounted && !getIsMounted()) return;

      setCurrentDay(status.currentDay);
      setCanClaimDaily(status.canClaimDaily);
      setDailyBonuses(
        status.dailyBonuses.map((b) => ({
          day: b.day,
          reward: `${b.reward.toLocaleString()} ${b.rewardType === 'vip_points' ? 'VIP Points' : 'Chips'}`,
          claimed: b.claimed,
        }))
      );

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
      reportError(error, 'BonusPage.Failed_to_load_bonuses');
      if (!getIsMounted || getIsMounted()) toast.error('Failed to load bonuses');
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) setLoading(false);
    }
  };

  const claimDailyBonus = async () => {
    if (claiming || !user?.id) return;
    setClaiming(true);
    try {
      // AUDIT M18: one server-owned claim. The old version called
      // `claim_daily_bonus` directly (never granted to `authenticated`, so it
      // always failed) and then emitted DAILY_REWARD_CLAIMED with an amount the
      // page invented — `currentDay * 10` — which matched nothing that could
      // ever have been paid. The reward now comes back from the claim itself.
      const result = await bonusService.claimDailyBonus(user.id);

      toast.success(
        `Daily bonus claimed: ${result.reward.toLocaleString()} ${
          result.rewardType === 'vip_points' ? 'VIP Points' : 'Chips'
        }`
      );
      masterBus.emit('DAILY_REWARD_CLAIMED', {
        amount: result.reward,
        rewardType: result.rewardType,
        streakDay: result.day,
      });
      setShowConfetti(true);
      haptic.medium();
      setTimeout(() => setShowConfetti(false), 2500);
      loadBonuses();
    } catch (error) {
      reportError(error, 'BonusPage.Failed_to_claim_bonus');
      // The service turns the server's refusal reason into player-facing text
      // ("already claimed today", "requirements not met"), so show it rather
      // than flattening every outcome into one generic failure.
      toast.error(error instanceof Error ? error.message : 'Failed to claim bonus');
    }
    setClaiming(false);
  };

  const claimSpecialBonus = async (bonusId: string) => {
    if (!user?.id) return;
    try {
      // AUDIT M17: this used to UPDATE special_bonuses directly. The table is
      // SELECT-own-only, so that write matched zero rows — and because
      // PostgREST reports no error for a zero-row write, the page showed
      // "Special bonus claimed!" every time while nothing was claimed and
      // nothing was paid.
      await bonusService.claimSpecialBonus(user.id, bonusId);
      toast.success('Special bonus claimed!');
      masterBus.emit('BALANCE_UPDATED', { source: 'special_bonus', userId: user.id });
      loadBonuses();
    } catch (error) {
      reportError(error, 'BonusPage.Failed_to_claim_special_bonus');
      toast.error(error instanceof Error ? error.message : 'Failed to claim special bonus');
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
      <RewardsSurfaceHeader
        eyebrow="Rewards Circuit / Bonuses"
        title="Bonus Vault"
        description="Claim The Server-Authorized Daily Reward Ladder And Inspect Active Special Bonuses From One Secure Reward Surface."
        art="diamonds"
        status="BONUS SCHEDULE // LIVE"
        metrics={[
          { label: 'Current Day', value: currentDay, tone: 'live' },
          { label: 'Daily Claim', value: canClaimDaily ? 'Ready' : 'Collected', tone: 'attention' },
          { label: 'Special Offers', value: specialBonuses.length },
        ]}
      />
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
        <p className="section-desc">Login Daily To Earn Rewards!</p>
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
          disabled={claiming || !canClaimDaily}
        >
          {claiming ? 'Claiming...' : canClaimDaily ? "Claim Today's Bonus" : 'Already Claimed'}
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
            No Special Bonuses Available Right Now. Check Back Later For Exclusive Rewards!
          </p>
        </section>
      )}
    </div>
  );
}
