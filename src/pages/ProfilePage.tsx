/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Profile Page
 * User profile with DNA, VIP status, and achievements
 *
 * NO HARDCODED DATA - All data comes from Supabase
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useMemo, useCallback, useRef, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase, getAuthUser } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { LoadingState } from '../components/common/EmptyState';
import DailyBonusWheel from '../components/bonus/DailyBonusWheel';
import FriendListPanel from '../components/social/FriendListPanel';
import { VIPStatusCard } from '../components/vip/VIPStatusCard';
import { VIPProgressRing } from '../components/vip/VIPProgressRing';
import UserProfileEdit, { UserProfileData } from '../components/social/UserProfileEdit';
import { profileService } from '../services/ProfileService';
import { DiamondService } from '../services/DiamondService';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { bonusService } from '../services/BonusService';
import { masterBus } from '../core/MasterBus';
import { StreakFire } from '../components/gamification/StreakFire';
import StreakMultiplier from '../components/gamification/StreakMultiplier';
import FinancialAchievementBadge from '../components/gamification/FinancialAchievementBadge';
import CircularGauge from '../components/common/CircularGauge';
import DiamondRainEffect from '../components/effects/DiamondRainEffect';
import GamificationLeaderboard from '../components/gamification/GamificationLeaderboard';
import PlayerActivityFeed from '../components/social/PlayerActivityFeed';
import ReferralDashboard from '../components/social/ReferralDashboard';
import PerformanceTrends from '../components/stats/PerformanceTrends';
import StakeLevelComparison from '../components/stats/StakeLevelComparison';
import PlayerStyleRadar from '../components/stats/PlayerStyleRadar';
import PromotionsList from '../components/promotions/PromotionsList';
import { useSwipeTabs } from '../hooks/useSwipeTabs';
import { useToast } from '../components/common/Toast';
import { retryFetch } from '../utils/retryFetch';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import styles from './ProfilePage.module.css';

import { useIsMounted } from '../hooks/useIsMounted';
import { generateDefaultAvatar } from '../utils/avatarGenerator';
import { reportError } from '../utils/errorReporter';
import { lazyWithRetry } from '../utils/lazyWithRetry';

// #5: Lazy-load Recharts (387KB) — only imported when History tab is opened
const LazyProfitChart = lazyWithRetry(() => import('../components/profile/ProfitChart'));

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  playerNumber: number;
  avatarUrl: string;
  vipLevel: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';
  memberSince: string;
}

interface PokerStats {
  totalHands: number;
  vpip: number;
  pfr: number;
  threeBet: number;
  aggression: number;
  bbPer100: number;
  biggestPot: number;
  totalProfit: number;
  winRate: number;
  tournamentsPlayed: number;
  tournamentsWon: number;
  bountyKOs: number;
  roi: number;
}

interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  unlockedAt?: string;
  progress?: number;
  maxProgress?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT VALUES (for new users with no data)
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_STATS: PokerStats = {
  totalHands: 0,
  vpip: 0,
  pfr: 0,
  threeBet: 0,
  aggression: 0,
  bbPer100: 0,
  biggestPot: 0,
  totalProfit: 0,
  winRate: 0,
  tournamentsPlayed: 0,
  tournamentsWon: 0,
  bountyKOs: 0,
  roi: 0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

const VIPBadge = ({ level }: { level: string }) => {
  const colors: Record<string, string> = {
    bronze: 'linear-gradient(135deg, #cd7f32 0%, #8b4513 100%)',
    silver: 'linear-gradient(135deg, #c0c0c0 0%, #808080 100%)',
    gold: 'linear-gradient(135deg, #ffd700 0%, #b8860b 100%)',
    platinum: 'linear-gradient(135deg, #e5e4e2 0%, #a0a0a0 100%)',
    diamond: 'linear-gradient(135deg, #b9f2ff 0%, #7df9ff 50%, #00bfff 100%)',
  };

  // Don't render badge for invalid/empty/none levels
  const validLevels = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
  if (!level || !validLevels.includes(level.toLowerCase())) {
    return null;
  }

  return (
    <span className={styles.vipBadge} style={{ background: colors[level] || colors.bronze }}>
      {level.toUpperCase()}
    </span>
  );
};

const StatCard = ({
  value,
  label,
  positive,
  index,
  isVisible,
}: {
  value: string | number;
  label: string;
  positive?: boolean | null;
  index?: number;
  isVisible?: boolean;
}) => (
  <div
    className={styles.statCard}
    style={{
      opacity: isVisible ? 1 : 0,
      transform: isVisible ? 'translateY(0)' : 'translateY(8px)',
      transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
    }}
  >
    <span
      className={`${styles.statValue} ${positive === true ? styles.positive : positive === false ? styles.negative : ''}`}
    >
      {value}
    </span>
    <span className={styles.statLabel}>{label}</span>
  </div>
);

const AchievementCard = ({ achievement }: { achievement: Achievement }) => {
  const isUnlocked = !!achievement.unlockedAt;
  const isComplete =
    achievement.progress !== undefined &&
    achievement.maxProgress !== undefined &&
    achievement.progress >= achievement.maxProgress;

  return (
    <div className={`${styles.achievementCard} ${isUnlocked ? styles.unlocked : styles.locked}`}>
      <span className={styles.achievementIcon}>{achievement.icon}</span>
      <div className={styles.achievementInfo}>
        <h4>{achievement.name}</h4>
        <p>{achievement.description}</p>
        {achievement.progress !== undefined && achievement.maxProgress !== undefined && (
          <div className={styles.achievementProgress}>
            <div
              className={styles.achievementProgressFill}
              style={{
                width: `${Math.min(100, (achievement.progress / achievement.maxProgress) * 100)}%`,
              }}
            />
            <span>
              {Math.min(achievement.progress, achievement.maxProgress)} / {achievement.maxProgress}
            </span>
          </div>
        )}
      </div>
      {isUnlocked && !isComplete && (
        <span className={styles.achievementDate}>
          {new Date(achievement.unlockedAt!).toLocaleDateString()}
        </span>
      )}
      {isComplete && <span className={styles.achievementComplete}></span>}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function ProfilePage() {
  useEffect(() => {
    document.title = 'Profile | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const isMountedRef = useIsMounted();

  const toast = useToast();
  const [showProfileEdit, setShowProfileEdit] = useState(false);
  const { user: storeUser } = useAuthUser();
  useVisibilityRefresh(async () => {
    const {
      data: { user: au },
    } = await getAuthUser();
    if (!au) return;
    const { data: p } = await supabase
      .from('profiles')
      .select('diamonds, login_streak, is_vip')
      .eq('id', au.id)
      .maybeSingle();
    if (p) {
      setDiamonds(p.diamonds || 0);
      setDailyStreak(p.login_streak || 0);
      setIsVIP(p.is_vip || false);
      // stats column doesn't exist in profiles DB table — stats will be loaded separately
    }
  });
  const [activeTab, setActiveTab] = useState<'stats' | 'achievements' | 'history' | 'social'>(
    'stats'
  );

  const swipeHandlers = useSwipeTabs({
    tabs: ['stats', 'achievements', 'history', 'social'],
    activeTab,
    onTabChange: (tab) => setActiveTab(tab as any),
  });

  const [isLoading, setIsLoading] = useState(true);
  const [showBonusWheel, setShowBonusWheel] = useState(false);
  const [showDiamondRain, setShowDiamondRain] = useState(false);

  // Real data from database
  const [user, setUser] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<PokerStats>(DEFAULT_STATS);
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [diamonds, setDiamonds] = useState(0);
  const [isVIP, setIsVIP] = useState(false);
  const [dailyStreak, setDailyStreak] = useState(0);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [visibleStats, setVisibleStats] = useState<Set<number>>(new Set());

  /* Mobile-fit sweep (2026-08-22): three 120px gauges plus gaps and padding
     measured 429px inside a 375px viewport — the Win Rate gauge ran off the
     right edge. The gauge's size is an SVG attribute, so CSS cannot shrink
     it; the social-page answer is that the content itself scales down to fit
     one screen. 92px x 3 + gaps + padding = 340px, inside every phone. */
  const [gaugeSize, setGaugeSize] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 480px)').matches ? 92 : 120
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 480px)');
    const apply = () => setGaugeSize(mq.matches ? 92 : 120);
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Stat stagger animation
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (!isLoading && user) {
      setVisibleStats(new Set());
      const statCount = 11; // Update based on actual stat count
      for (let i = 0; i < statCount; i++) {
        timers.push(setTimeout(() => setVisibleStats((prev) => new Set(prev).add(i)), i * 50));
      }
    }
    return () => timers.forEach((t) => clearTimeout(t));
  }, [activeTab, isLoading, user]);

  // Load profile data from Supabase
  useEffect(() => {
    let isMounted = true;

    // Safety net: force loading off after 12s to prevent infinite spinner
    const safetyTimer = setTimeout(() => {
      if (isMounted) {
        console.warn('[PROFILE] Safety timeout - forcing loading off after 12s');
        setIsLoading(false);
      }
    }, 12000);

    async function loadProfile() {
      setIsLoading(true);

      // SWR: Show cached profile instantly while loading fresh data
      try {
        if (!isMounted) return;

        // Load user auth
        const {
          data: { user: authUser },
        } = await getAuthUser();
        if (!authUser || !isMounted) return;

        const swrKey = `profile_cache_${authUser.id}`;
        try {
          const cached = sessionStorage.getItem(swrKey);
          if (cached) {
            const cp = JSON.parse(cached);
            if (cp.user) setUser(cp.user);
            if (cp.stats) setStats(cp.stats);
            if (cp.diamonds != null) setDiamonds(cp.diamonds);
            if (cp.isVIP != null) setIsVIP(cp.isVIP);
            if (cp.dailyStreak != null) setDailyStreak(cp.dailyStreak);
            setIsLoading(false); // Show cached UI instantly
          }
        } catch (e) {
          reportError(e, 'ProfilePage.loadProfile');
          /* corrupt cache */
        }

        // PERF 2026-08-23: this batch needs only authUser.id - never the
        // profile row - but sat behind it, so the page paid two round trips
        // in series where one would do. The query array below is the
        // original, moved verbatim; only where it is AWAITED changed, so
        // the order of state updates is untouched.
        const secondaryDataPromise = Promise.allSettled([
          // Achievements
          retryFetch(
            () =>
              supabase
                .from('training_user_achievements')
                /* `achievement:achievements(*)` 400'd on every profile load,
                   for every user, since it was written: there is no
                   `achievements` table in this schema. PostgREST said so in
                   the response body — PGRST200, "Perhaps you meant
                   'training_achievement_definitions' instead" — and the FK
                   confirms it (training_user_achievements.achievement_id ->
                   training_achievement_definitions). Nothing surfaced it,
                   because the result is read through Promise.allSettled and a
                   rejected fetch just renders an empty achievement list, and
                   retryFetch dutifully retried the impossible query 3x a load.

                   The aliases matter too: the definitions table has `icon_url`
                   and `threshold`, not `icon` and `max_progress`, so the
                   consumer below would have rendered a blank icon and an
                   undefined progress cap even once the embed resolved.

                   Explicit columns rather than `*` for the same reason
                   `select('*')` was removed from the profile readers in
                   August: a star-select touching one ungranted column makes
                   Postgres reject the whole statement. */
                .select(
                  'id, achievement_id, user_id, progress, unlocked_at, ' +
                    'achievement:training_achievement_definitions(' +
                    'id, name, description, icon:icon_url, max_progress:threshold)'
                )
                .eq('user_id', authUser.id)
                .limit(200)
                .then((r) => r),
            { maxRetries: 2, isMountedRef: isMountedRef }
          ),
          // Transaction history
          retryFetch(
            () =>
              supabase
                .from('wallet_transactions')
                .select('id, type, amount, created_at, description')
                .eq('user_id', authUser.id)
                .order('created_at', { ascending: true })
                .limit(200)
                .then((r) => r),
            { maxRetries: 2, isMountedRef: isMountedRef }
          ),
        ]);

        // Fetch basic profile and stats
        const { data: profile } = await retryFetch(
          () =>
            supabase
              .from('profiles')
              .select(
                'id, username, display_name, player_number, avatar_url, tier, created_at, diamonds, is_vip, login_streak'
              )
              .eq('id', authUser.id)
              .maybeSingle()
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMountedRef }
        );

        if (profile && isMounted) {
          setUser({
            id: profile.id,
            username: profile.username || 'Player',
            displayName: profile.display_name || profile.username || 'Player',
            playerNumber: profile.player_number || 0,
            avatarUrl: profile.avatar_url || '',
            vipLevel: profile.tier || 'bronze',
            memberSince: profile.created_at,
          });

          setDiamonds(profile.diamonds || 0);
          setIsVIP(profile.is_vip || false);
          setDailyStreak(profile.login_streak || 0);

          // stats not available from profiles table — loaded separately
        }

        // Save to SWR cache
        if (profile && isMounted) {
          try {
            sessionStorage.setItem(
              swrKey,
              JSON.stringify({
                user: {
                  id: profile.id,
                  username: profile.username || 'Player',
                  displayName: profile.display_name || profile.username || 'Player',
                  playerNumber: profile.player_number || 0,
                  avatarUrl: profile.avatar_url || '',
                  vipLevel: profile.tier || 'bronze',
                  memberSince: profile.created_at,
                },
                stats: null, // Stats loaded separately from poker_session_stats
                diamonds: profile.diamonds || 0,
                isVIP: profile.is_vip || false,
                dailyStreak: profile.login_streak || 0,
              })
            );
          } catch (e) {
            reportError(e, 'ProfilePage');
            /* storage full */
          }
        }

        // ── Batch: achievements + transactions in parallel ──
        // Challenges are NOT loaded here any more: this page links to
        // /challenges instead of rendering them, so fetching all three tiers on
        // every profile visit was pure waste (9 round trips on a fresh day).
        const [achievementsResult, transactionsResult] = await secondaryDataPromise;

        if (!isMounted) return;

        // Process achievements
        if (achievementsResult.status === 'fulfilled' && achievementsResult.value.data) {
          setAchievements(
            achievementsResult.value.data.map((ua: any) => ({
              id: ua.achievement?.id || ua.id,
              name: ua.achievement?.name || 'Achievement',
              description: ua.achievement?.description || '',
              icon: ua.achievement?.icon || '',
              unlockedAt: ua.unlocked_at,
              progress: ua.progress,
              maxProgress: ua.achievement?.max_progress,
            }))
          );
        } else {
          setAchievements([]);
        }

        // Process transactions
        if (transactionsResult.status === 'fulfilled' && transactionsResult.value.data) {
          setTransactions(transactionsResult.value.data);
        } else {
          setTransactions([]);
        }

        // Notify Master Bus that profile is loaded
        if (profile) {
          masterBus.emit('USER_PROFILE_LOADED', {
            userId: authUser.id,
            avatarUrl: profile.avatar_url || '',
            displayName: profile.display_name,
          });
        }
      } catch (err: any) {
        reportError(err, 'ProfilePage.Load_failed');
        if (isMounted) toast.error(err.message || 'Failed to load profile data');
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }
    loadProfile();
    return () => {
      isMounted = false;
      clearTimeout(safetyTimer);
    };
  }, []);

  // ── Bus Listeners: cross-page profile reactivity ──
  useEffect(() => {
    let isMounted = true;

    // Helper: invalidate SWR cache when bus events update state
    const invalidateProfileCache = () => {
      try {
        const keys = Object.keys(sessionStorage);
        keys.forEach((k) => {
          if (k.startsWith('profile_cache_')) sessionStorage.removeItem(k);
        });
      } catch {
        /* silent */
      }
    };

    const unsubProfile = masterBus.subscribeDebounced(
      'PROFILE_UPDATED',
      () => {
        invalidateProfileCache();
        // Re-load profile when updated from settings or other pages
        supabase.auth
          .getUser()
          .then(({ data: { user: authUser } }) => {
            if (authUser && isMounted) {
              supabase
                .from('profiles')
                .select(
                  'id, username, display_name, player_number, avatar_url, tier, created_at, diamonds, is_vip, login_streak'
                )
                .eq('id', authUser.id)
                .maybeSingle()
                .then(({ data: profile }) => {
                  if (profile && isMounted) {
                    setUser({
                      id: profile.id,
                      username: profile.username || 'Player',
                      displayName: profile.display_name || profile.username || 'Player',
                      playerNumber: profile.player_number || 0,
                      avatarUrl: profile.avatar_url || '',
                      vipLevel: profile.tier || 'bronze',
                      memberSince: profile.created_at,
                    });
                    setDiamonds(profile.diamonds || 0);
                    setIsVIP(profile.is_vip || false);
                  }
                });
            }
          })
          .catch((e) => console.warn('[Profile] Refreshing profile after update failed:', e));
      },
      500
    );
    const unsubHand = masterBus.subscribeDebounced(
      'HAND_COMPLETED',
      () => {
        invalidateProfileCache();
        // Refresh stats after a hand is completed
        supabase.auth
          .getUser()
          .then(({ data: { user: authUser } }) => {
            if (authUser && isMounted) {
              // Stats column doesn't exist in profiles table — stats come from poker_session_stats
              // For now, use total_hands_played from profiles as the only available stat
              supabase
                .from('profiles')
                .select('total_hands_played')
                .eq('id', authUser.id)
                .maybeSingle()
                .then(({ data: profile }) => {
                  if (profile && isMounted) {
                    setStats((prev) => ({
                      ...prev,
                      totalHands: profile.total_hands_played || 0,
                    }));
                  }
                });
            }
          })
          .catch((e) => console.warn('[Profile] Refreshing hand stats failed:', e));
      },
      2000
    );
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        invalidateProfileCache();
        // Refresh diamond balance when balance changes on other pages
        supabase.auth
          .getUser()
          .then(({ data: { user: authUser } }) => {
            if (authUser && isMounted) {
              DiamondService.getBalance(authUser.id).then((dw) => {
                if (dw && isMounted) setDiamonds(dw.balance || 0);
              });
            }
          })
          .catch((e) => console.warn('[Profile] Refreshing diamond balance failed:', e));
      },
      500
    );
    const unsubDiamond = masterBus.subscribeDebounced(
      'DIAMOND_BALANCE_CHANGED',
      () => {
        invalidateProfileCache();
        supabase.auth
          .getUser()
          .then(({ data: { user: authUser } }) => {
            if (authUser && isMounted) {
              DiamondService.getBalance(authUser.id).then((dw) => {
                if (dw && isMounted) setDiamonds(dw.balance || 0);
              });
            }
          })
          .catch((e) => console.warn('[Profile] Refreshing diamond balance failed:', e));
      },
      500
    );

    // Gamification bus listeners: refresh balance when rewards earned on other pages
    const unsubDailyReward = masterBus.subscribeDebounced(
      'DAILY_REWARD_CLAIMED',
      (payload: any) => {
        if (!isMounted) return;
        if (payload?.rewardType === 'diamonds') setShowDiamondRain(true);
        supabase.auth
          .getUser()
          .then(({ data: { user: authUser } }) => {
            if (authUser && isMounted) {
              supabase
                .from('profiles')
                .select('diamonds, login_streak')
                .eq('id', authUser.id)
                .maybeSingle()
                .then(({ data }) => {
                  if (data && isMounted) {
                    setDiamonds(data.diamonds || 0);
                    setDailyStreak(data.login_streak || 0);
                  }
                });
            }
          })
          .catch((e) => console.warn('[Profile] Refreshing daily reward data failed:', e));
      },
      500
    );
    const unsubMissionClaim = masterBus.subscribeDebounced(
      'MISSION_CLAIMED',
      (payload: any) => {
        if (!isMounted) return;
        if (payload?.rewardType === 'diamonds') setShowDiamondRain(true);
        supabase.auth
          .getUser()
          .then(({ data: { user: authUser } }) => {
            if (authUser && isMounted) {
              supabase
                .from('profiles')
                .select('diamonds')
                .eq('id', authUser.id)
                .maybeSingle()
                .then(({ data }) => {
                  if (data && isMounted) setDiamonds(data.diamonds || 0);
                });
            }
          })
          .catch((e) => console.warn('[Profile] Refreshing mission claim diamonds failed:', e));
      },
      500
    );
    const unsubWheelSpin = masterBus.subscribeDebounced(
      'WHEEL_SPIN_RESULT',
      (payload: any) => {
        if (!isMounted) return;
        if (payload?.type === 'diamonds') setShowDiamondRain(true);
        supabase.auth
          .getUser()
          .then(({ data: { user: authUser } }) => {
            if (authUser && isMounted) {
              supabase
                .from('profiles')
                .select('diamonds')
                .eq('id', authUser.id)
                .maybeSingle()
                .then(({ data }) => {
                  if (data && isMounted) setDiamonds(data.diamonds || 0);
                });
            }
          })
          .catch((e) => console.warn('[Profile] Refreshing wheel spin diamonds failed:', e));
      },
      500
    );

    return () => {
      isMounted = false;
      unsubProfile();
      unsubHand();
      unsubBalance();
      unsubDiamond();
      unsubDailyReward();
      unsubMissionClaim();
      unsubWheelSpin();
    };
  }, []);

  // #1+#2: Setup Supabase Realtime via Channel Registry (fixed cleanup leak)
  useEffect(() => {
    let isMounted = true;
    let activeChannelKey: string | null = null;

    async function setupRealtimeSubscription() {
      try {
        const {
          data: { user: authUser },
        } = await getAuthUser();
        if (!authUser || !isMounted) return;

        activeChannelKey = `profile-${authUser.id}`;

        // #1: Use Channel Registry for deduplication
        const channel = masterBus.getOrCreateChannel(activeChannelKey);

        // Subscribe to profile changes
        channel
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'profiles',
              filter: `id=eq.${authUser.id}`,
            },
            async (payload) => {
              const { data: updatedProfile } = await supabase
                .from('profiles')
                .select(
                  'id, username, display_name, player_number, avatar_url, tier, created_at, diamonds, is_vip, login_streak'
                )
                .eq('id', authUser.id)
                .maybeSingle();

              if (updatedProfile) {
                setUser({
                  id: updatedProfile.id,
                  username: updatedProfile.username || 'Player',
                  displayName: updatedProfile.display_name || updatedProfile.username || 'Player',
                  playerNumber: updatedProfile.player_number || 0,
                  avatarUrl: updatedProfile.avatar_url || '',
                  vipLevel: updatedProfile.tier || 'bronze',
                  memberSince: updatedProfile.created_at,
                });

                setDiamonds(updatedProfile.diamonds || 0);
                setIsVIP(updatedProfile.is_vip || false);

                // Stats loaded separately — not in profiles table
              }
            }
          )
          // Subscribe to wallet changes for diamonds
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'wallets',
              filter: `user_id=eq.${authUser.id}`,
            },
            async (payload) => {
              const { data: updatedProfile } = await supabase
                .from('profiles')
                .select('diamonds, is_vip')
                .eq('id', authUser.id)
                .maybeSingle();

              if (updatedProfile) {
                setDiamonds(updatedProfile.diamonds || 0);
                setIsVIP(updatedProfile.is_vip || false);
              }
            }
          )
          .subscribe((status: string, err?: Error) => {
            if (status === 'CHANNEL_ERROR') {
              if (err) reportError(err?.message || err, 'ProfilePage._Realtime_channel_error');
            }
            if (status === 'TIMED_OUT') {
              console.warn('[ProfilePage] Realtime channel timed out');
            }
          });
      } catch (err) {
        reportError(err, 'ProfilePage.Realtime_subscription_failed');
      }
    }

    setupRealtimeSubscription();

    // #2: FIX — cleanup is now robust against async race conditions
    return () => {
      isMounted = false;
      if (activeChannelKey) {
        masterBus.removeRegisteredChannel(activeChannelKey);
      }
    };
  }, []);

  if (isLoading) {
    return <LoadingState message="Loading profile..." />;
  }

  if (!user) {
    return (
      <StandardContentLayout className={styles.page}>
        <div className={styles.emptyProfile}>
          <p>Profile Not Found</p>
        </div>
      </StandardContentLayout>
    );
  }

  return (
    <StandardContentLayout className={styles.page}>
      {/* Profile Header */}
      <section className={styles.profileHeader}>
        <div className={styles.avatarContainer}>
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt={user.displayName}
              className={styles.avatar}
              loading="lazy"
              onError={(e) => {
                (e.target as HTMLImageElement).src = generateDefaultAvatar();
              }}
            />
          ) : (
            <div className={styles.avatarDefault}>{user.displayName.charAt(0).toUpperCase()}</div>
          )}
          <VIPBadge level={user.vipLevel} />
        </div>

        <div className={styles.userInfo}>
          <h1 className={styles.displayName}>
            {user.displayName}
            {dailyStreak > 0 && <StreakFire streakCount={dailyStreak} size="sm" showLabel />}
            {dailyStreak > 0 && (
              <StreakMultiplier streak={dailyStreak} multiplier={1 + dailyStreak * 0.1} size="sm" />
            )}
          </h1>
          {/* 2026-08-20: this was `profile.player_number || Math.floor(Math.random() * 9999) + 1`
              in three separate places in this file. When a profile had no
              player_number the page invented one — a DIFFERENT one on every load,
              and a different one again depending on which of the three code paths
              produced it. A player's own ID visibly changing between refreshes is
              not a cosmetic issue in a card room. Show nothing when there is no
              number rather than something untrue. */}
          {user.playerNumber > 0 && (
            <p className={styles.playerNumber}>Player #{user.playerNumber}</p>
          )}
          <div className={styles.statChipsContainer}>
            <div className={styles.statChip}>
              <span className={styles.chipLabel}>Member</span>
              <span className={styles.chipValue}>
                {new Date(user.memberSince).toLocaleDateString('en-US', {
                  month: 'short',
                  year: '2-digit',
                })}
              </span>
            </div>
            <div className={styles.statChip}>
              <span className={styles.chipLabel}>Hands</span>
              <span className={styles.chipValue}>{stats.totalHands.toLocaleString()}</span>
            </div>
            <div className={styles.statChip}>
              <span className={styles.chipLabel}>VPIP</span>
              <span className={styles.chipValue}>{stats.vpip}%</span>
            </div>
            <div className={styles.statChip}>
              <span className={styles.chipLabel}>ROI</span>
              <span className={styles.chipValue}>
                {stats.roi > 0 ? `+${stats.roi}` : stats.roi}%
              </span>
            </div>
          </div>
        </div>

        <div className={styles.headerActions}>
          <button
            className={styles.editButton}
            onClick={() => {
              const url = 'https://smarter.poker/hub/avatars';
              window.open(url, '_blank');
            }}
          >
            Change Avatar
          </button>
          <button className={styles.editButton} onClick={() => setShowProfileEdit(true)}>
            Edit Profile
          </button>
          <button
            className={styles.editButton}
            onClick={() => navigate('/vip')}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            ◆ {diamonds.toLocaleString()} {isVIP && <span style={{ fontSize: 12 }}>♛ VIP</span>}
          </button>
        </div>
      </section>

      {/* VIP Status Section (for VIP users) */}
      {isVIP &&
        (() => {
          const VIP_TIERS = [
            { tier: 'bronze' as const, threshold: 0 },
            { tier: 'silver' as const, threshold: 1000 },
            { tier: 'gold' as const, threshold: 5000 },
            { tier: 'platinum' as const, threshold: 50000 },
            { tier: 'diamond' as const, threshold: 500000 },
          ];
          const currentTierIndex = VIP_TIERS.reduce(
            (acc, t, i) => (diamonds >= t.threshold ? i : acc),
            0
          );
          const currentTier = VIP_TIERS[currentTierIndex];
          const nextTierData = VIP_TIERS[currentTierIndex + 1];
          const nextTierPoints = nextTierData?.threshold;
          const nextTierName = nextTierData?.tier;

          return (
            <section className={styles.contentSection}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <VIPProgressRing
                  current={diamonds}
                  total={nextTierPoints || diamonds}
                  tier={currentTier.tier}
                  nextTier={nextTierName || currentTier.tier}
                  size={72}
                  strokeWidth={6}
                />
                <VIPStatusCard
                  tier={currentTier.tier}
                  currentPoints={diamonds}
                  pointsLabel="Diamonds"
                  nextTierPoints={nextTierPoints}
                  benefits={[
                    '6% Leaderboard Boost',
                    'Unlimited Throwables',
                    'Auto Time Bank',
                    'Premium Themes',
                  ]}
                  memberSince={user?.memberSince ? new Date(user.memberSince) : undefined}
                />
              </div>
            </section>
          );
        })()}

      {/* Daily Bonus */}
      <section className={styles.contentSection}>
        <button className={styles.bonusButton} onClick={() => setShowBonusWheel(true)}>
          Daily Bonus
        </button>
      </section>

      {/* Daily Challenges — single source of truth lives at /challenges.
          This page used to render a full MissionsPanel with its own copy of the
          load + claim logic, duplicating the widget on ClubDetailPage and the
          dedicated page. Three surfaces meant three independent claim guards
          over the same rows and three sets of queries per visit. */}
      <section className={styles.contentSection}>
        <button
          className={styles.bonusButton}
          onClick={() => navigate('/challenges')}
          style={{ width: '100%' }}
        >
          Daily Challenges
        </button>
      </section>

      {/* Gamification Leaderboard */}
      <section className={styles.contentSection}>
        <GamificationLeaderboard />
      </section>

      {/* Player Activity Feed */}
      {user?.id && (
        <section className={styles.contentSection}>
          <PlayerActivityFeed userId={user.id} />
        </section>
      )}

      {/* Referral Program Dashboard */}
      {user?.id && (
        <section className={styles.contentSection}>
          <ReferralDashboard userId={user.id} />
        </section>
      )}

      {/* Player Intelligence — Analytics Dashboard */}
      {user?.id && (
        <section className={styles.contentSection}>
          <PerformanceTrends userId={user.id} />
        </section>
      )}
      {user?.id && (
        <section className={styles.contentSection}>
          <PlayerStyleRadar userId={user.id} />
        </section>
      )}
      {user?.id && (
        <section className={styles.contentSection}>
          <StakeLevelComparison userId={user.id} />
        </section>
      )}
      {user?.id && (
        <section className={styles.contentSection}>
          <PromotionsList userId={user.id} />
        </section>
      )}

      {/* Achievement Showcase — always visible */}
      {achievements.filter((a) => a.unlockedAt).length > 0 && (
        <section className={styles.contentSection}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <h3 style={{ margin: 0, fontSize: '0.875rem', color: '#8a9aaa', fontWeight: 600 }}>
              Top Achievements
            </h3>
            <button
              onClick={() => setActiveTab('achievements')}
              style={{
                background: 'none',
                border: 'none',
                color: '#00d4ff',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
                padding: '2px 6px',
              }}
              /* 2026-08-23: 2px of padding made this 18px tall — the smallest
                 tap target measured anywhere in the app. It has no class of
                 its own to style, so it opts into the shared touch utility,
                 which adds an invisible 44px hit area without changing how
                 the link looks. */
              className="tap-target"
            >
              View All
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
            {achievements
              .filter((a) => a.unlockedAt)
              .sort((a, b) => new Date(b.unlockedAt!).getTime() - new Date(a.unlockedAt!).getTime())
              .slice(0, 5)
              .map((a) => (
                <div
                  key={a.id}
                  style={{
                    flex: '0 0 auto',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 10px',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(0,212,255,0.15)',
                    borderRadius: 8,
                    minWidth: 0,
                  }}
                >
                  <span style={{ fontSize: '1.25rem' }}>{a.icon || '★'}</span>
                  <span
                    style={{
                      fontSize: '0.7rem',
                      color: '#ccc',
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {a.name}
                  </span>
                </div>
              ))}
          </div>
        </section>
      )}

      {/* Tab Navigation */}
      <nav className={styles.tabNav}>
        <button
          className={`${styles.tab} ${activeTab === 'stats' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('stats')}
        >
          Stats
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'achievements' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('achievements')}
        >
          Achievements
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'history' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('history')}
        >
          History
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'social' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('social')}
        >
          Friends
        </button>
      </nav>

      {/* Tab Content */}
      <section className={styles.tabContent} {...swipeHandlers}>
        {activeTab === 'stats' && (
          <div className={styles.statsContainer}>
            <div className={styles.statsGroup}>
              <h3>Core Stats</h3>
              <div className={styles.circularStatsGrid}>
                <div
                  className={`${styles.circularGaugeWrapper} ${visibleStats.has(0) ? styles.visible : styles.hidden}`}
                >
                  <CircularGauge
                    value={stats.vpip}
                    label="VPIP"
                    sublabel="Volun. Put In Pot"
                    accent="#00d4ff"
                    size={gaugeSize}
                  />
                </div>
                <div
                  className={`${styles.circularGaugeWrapper} ${visibleStats.has(1) ? styles.visible : styles.hidden}`}
                >
                  <CircularGauge
                    value={stats.pfr}
                    label="PFR"
                    sublabel="Pre-Flop Raise"
                    accent="#fbbf24"
                    size={gaugeSize}
                  />
                </div>
                <div
                  className={`${styles.circularGaugeWrapper} ${visibleStats.has(2) ? styles.visible : styles.hidden}`}
                >
                  <CircularGauge
                    value={stats.winRate}
                    label="Win Rate"
                    sublabel="Hands Won"
                    accent="#10b981"
                    size={gaugeSize}
                  />
                </div>
              </div>
              <div className={styles.statsGrid}>
                <StatCard
                  value={stats.totalHands.toLocaleString()}
                  label="Hands Played"
                  index={3}
                  isVisible={visibleStats.has(3)}
                />
                <StatCard
                  value={`${stats.threeBet}%`}
                  label="3-Bet"
                  index={4}
                  isVisible={visibleStats.has(4)}
                />
                <StatCard
                  value={stats.aggression.toFixed(1)}
                  label="Aggression"
                  index={5}
                  isVisible={visibleStats.has(5)}
                />
              </div>
            </div>

            <div className={styles.statsGroup}>
              <h3>Financial</h3>
              <div className={styles.statsGrid}>
                <StatCard
                  value={`${stats.bbPer100 > 0 ? '+' : ''}${stats.bbPer100}`}
                  label="BB/100"
                  positive={stats.bbPer100 > 0 ? true : stats.bbPer100 < 0 ? false : null}
                  index={6}
                  isVisible={visibleStats.has(6)}
                />
                <StatCard
                  value={stats.biggestPot.toLocaleString()}
                  label="Biggest Pot"
                  index={7}
                  isVisible={visibleStats.has(7)}
                />
                <StatCard
                  value={`${stats.totalProfit > 0 ? '+' : ''}${stats.totalProfit.toLocaleString()}`}
                  label="Total Profit"
                  positive={stats.totalProfit > 0}
                  index={8}
                  isVisible={visibleStats.has(8)}
                />
              </div>
            </div>

            <div className={styles.statsGroup}>
              <h3>Tournaments</h3>
              <div className={styles.statsGrid}>
                <StatCard
                  value={stats.tournamentsPlayed}
                  label="Played"
                  index={9}
                  isVisible={visibleStats.has(9)}
                />
                <StatCard
                  value={stats.tournamentsWon}
                  label="Won"
                  index={10}
                  isVisible={visibleStats.has(10)}
                />
                <StatCard
                  value={stats.bountyKOs}
                  label="Bounty KOs"
                  index={11}
                  isVisible={visibleStats.has(11)}
                />
                <StatCard
                  value={
                    stats.tournamentsPlayed > 0
                      ? `${((stats.tournamentsWon / stats.tournamentsPlayed) * 100).toFixed(1)}%`
                      : '0%'
                  }
                  label="Win Rate"
                  index={12}
                  isVisible={visibleStats.has(12)}
                />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'achievements' && (
          <div className={styles.achievementsContainer}>
            {achievements.length > 0 ? (
              <>
                <div className={styles.achievementsSummary}>
                  <span>{achievements.filter((a) => a.unlockedAt).length}</span>
                  <span>/ {achievements.length} Unlocked</span>
                </div>
                <div className={styles.achievementsGrid}>
                  {achievements.map((achievement) => (
                    <AchievementCard key={achievement.id} achievement={achievement} />
                  ))}
                </div>
              </>
            ) : (
              <div className={styles.emptyAchievements}>
                <p>No Achievements Yet. Start Playing To Unlock Achievements!</p>
              </div>
            )}

            {/* Financial Achievement Badges */}
            <div style={{ marginTop: 16 }}>
              <h3
                style={{
                  margin: '0 0 8px',
                  fontSize: '0.875rem',
                  color: '#8a9aaa',
                  fontWeight: 600,
                }}
              >
                Financial Milestones
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <FinancialAchievementBadge
                  type="first_cashout"
                  unlocked={stats.totalProfit > 0}
                  size="sm"
                />
                <FinancialAchievementBadge
                  type="thousand_club"
                  unlocked={stats.totalProfit >= 1000}
                  size="sm"
                />
                <FinancialAchievementBadge
                  type="perfect_settlement"
                  unlocked={stats.totalHands >= 500}
                  size="sm"
                />
                <FinancialAchievementBadge
                  type="diamond_whale"
                  unlocked={diamonds >= 10000}
                  size="sm"
                />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div className={styles.historyContainer}>
            {transactions.length > 0 ? (
              <>
                {/* #5: Lazy-loaded Profit Graph */}
                <Suspense
                  fallback={
                    <div
                      style={{
                        height: 200,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#6a7a8a',
                      }}
                    >
                      Loading Chart...
                    </div>
                  }
                >
                  <LazyProfitChart transactions={transactions} />
                </Suspense>

                {/* Transaction List */}
                <h3 style={{ color: '#8a9aaa', fontSize: '0.8rem', marginBottom: 8 }}>
                  Recent Transactions
                </h3>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    maxHeight: 300,
                    overflowY: 'auto',
                  }}
                >
                  {[...transactions]
                    .reverse()
                    .slice(0, 50)
                    .map((tx) => (
                      <div
                        key={tx.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '8px 12px',
                          background: 'rgba(255,255,255,0.03)',
                          borderRadius: 8,
                          border: '1px solid rgba(255,255,255,0.06)',
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ color: '#ccc', fontSize: '0.8rem', fontWeight: 600 }}>
                            {tx.description || tx.type}
                          </span>
                          <span style={{ color: '#4a5a6a', fontSize: '0.7rem' }}>
                            {new Date(tx.created_at).toLocaleDateString()}
                          </span>
                        </div>
                        <span
                          style={{
                            color: tx.type === 'credit' ? '#22c55e' : '#ef4444',
                            fontWeight: 700,
                            fontSize: '0.85rem',
                          }}
                        >
                          {tx.type === 'credit' ? '+' : '-'}
                          {(tx.amount || 0).toLocaleString()}
                        </span>
                      </div>
                    ))}
                </div>
              </>
            ) : (
              <div className={styles.emptyHistory}>
                <span className={styles.emptyIcon}></span>
                <p>No Recent Transactions To Display.</p>
                <button className={styles.playButton} onClick={() => navigate('/')}>
                  Start Playing
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'social' && (
          <div className={styles.socialContainer}>
            <FriendListPanel />
          </div>
        )}
      </section>

      {/* Daily Bonus Wheel Modal */}
      {showBonusWheel && (
        <div className={styles.bonusWheelOverlay} onClick={() => setShowBonusWheel(false)}>
          <div className={styles.bonusWheelModal} onClick={(e) => e.stopPropagation()}>
            <button className={styles.modalClose} onClick={() => setShowBonusWheel(false)}>
              ✕
            </button>
            <DailyBonusWheel
              onSpin={async () => {
                // The SERVER decides what a daily bonus pays — fn_claim_daily_bonus
                // reads a fixed 7-day ladder out of daily_bonus_rewards; there is
                // no randomness anywhere in it. Hand the real outcome back so the
                // wheel stops on the day that was actually credited instead of a
                // segment picked by Math.random() in the browser.
                try {
                  const res = await bonusService.claimDailyBonus(user!.id);
                  toast.success(
                    res.rewardType === 'vip_points'
                      ? `Daily bonus: ${res.reward.toLocaleString()} VIP points (day ${res.day})`
                      : `Daily bonus: ${res.reward.toLocaleString()} chips (day ${res.day})`
                  );
                  return {
                    day: res.day,
                    reward: res.reward,
                    rewardType:
                      res.rewardType === 'vip_points' ? ('vip' as const) : ('chips' as const),
                  };
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Could not claim daily bonus');
                  setShowBonusWheel(false);
                  return null;
                }
              }}
            />
          </div>
        </div>
      )}

      {/* Diamond Rain Gamification Effect */}
      <DiamondRainEffect active={showDiamondRain} onComplete={() => setShowDiamondRain(false)} />

      {showProfileEdit && user && (
        <UserProfileEdit
          isOpen={showProfileEdit}
          onClose={() => setShowProfileEdit(false)}
          initialData={{
            id: user.id || '',
            username: user.username || '',
            displayName: user.displayName || '',
            avatarUrl: user.avatarUrl || '',
            bio: (user as any).bio || '',
            tags: [],
          }}
          onSave={async (data: UserProfileData) => {
            try {
              const { error } = await supabase
                .from('profiles')
                .update({
                  username: data.username,
                  display_name: data.displayName,
                  bio: data.bio,
                })
                .eq('id', user.id);

              if (error) throw error;

              const { error: userError } = await supabase
                .from('users')
                .update({ username: data.username })
                .eq('id', user.id);

              if (userError) throw userError;

              setUser({
                ...user,
                username: data.username,
                displayName: data.displayName,
              });
              setShowProfileEdit(false);
            } catch (err) {
              console.error('Failed to update profile:', err);
            }
          }}
        />
      )}
    </StandardContentLayout>
  );
}
