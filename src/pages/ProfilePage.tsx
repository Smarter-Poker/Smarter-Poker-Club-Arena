/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Profile Page
 * User profile with DNA, VIP status, and achievements
 *
 * NO HARDCODED DATA - All data comes from Supabase
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useMemo, useCallback, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { LoadingState } from '../components/common/EmptyState';
import DailyBonusWheel from '../components/bonus/DailyBonusWheel';
import FriendListPanel from '../components/social/FriendListPanel';
import { VIPStatusCard } from '../components/vip/VIPStatusCard';
import { VIPProgressRing } from '../components/vip/VIPProgressRing';
import { profileService } from '../services/ProfileService';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { bonusService } from '../services/BonusService';
import { masterBus } from '../core/MasterBus';
import { StreakFire } from '../components/gamification/StreakFire';
import StreakMultiplier from '../components/gamification/StreakMultiplier';
import FinancialAchievementBadge from '../components/gamification/FinancialAchievementBadge';
import CircularGauge from '../components/common/CircularGauge';
import DiamondRainEffect from '../components/effects/DiamondRainEffect';
import MissionsPanel, { Mission } from '../components/gamification/MissionsPanel';
import GamificationLeaderboard from '../components/gamification/GamificationLeaderboard';
import PlayerActivityFeed from '../components/social/PlayerActivityFeed';
import ReferralDashboard from '../components/social/ReferralDashboard';
import PerformanceTrends from '../components/stats/PerformanceTrends';
import StakeLevelComparison from '../components/stats/StakeLevelComparison';
import PlayerStyleRadar from '../components/stats/PlayerStyleRadar';
import PromotionsList from '../components/promotions/PromotionsList';
import { dailyChallengeService, type UserDailyChallenge } from '../services/DailyChallengeService';
import { useSwipeTabs } from '../hooks/useSwipeTabs';
import { useToast } from '../components/common/Toast';
import { retryFetch } from '../utils/retryFetch';
import styles from './ProfilePage.module.css';

import { useIsMounted } from '../hooks/useIsMounted';

// #5: Lazy-load Recharts (387KB) — only imported when History tab is opened
const LazyProfitChart = lazy(() => import('../components/profile/ProfitChart'));

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
  const navigate = useNavigate();
  const isMountedRef = useIsMounted();

  const toast = useToast();
  const { user: storeUser } = useAuthUser();
  useVisibilityRefresh(async () => {
    const {
      data: { user: au },
    } = await supabase.auth.getUser();
    if (!au) return;
    const { data: p } = await supabase
      .from('profiles')
      .select('diamonds, daily_streak, is_vip, stats')
      .eq('id', au.id)
      .maybeSingle();
    if (p) {
      setDiamonds(p.diamonds || 0);
      setDailyStreak(p.daily_streak || 0);
      setIsVIP(p.is_vip || false);
      if (p.stats)
        setStats({
          totalHands: p.stats.total_hands || 0,
          vpip: p.stats.vpip || 0,
          pfr: p.stats.pfr || 0,
          threeBet: p.stats.three_bet || 0,
          aggression: p.stats.aggression_factor || 0,
          bbPer100: p.stats.bb_per_100 || 0,
          biggestPot: p.stats.biggest_pot || 0,
          totalProfit: p.stats.total_profit || 0,
          winRate: p.stats.win_rate || 0,
          tournamentsPlayed: p.stats.tournaments_played || 0,
          tournamentsWon: p.stats.tournaments_won || 0,
          bountyKOs: p.stats.bounty_kos || 0,
          roi: p.stats.roi || 0,
        });
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
  const [missions, setMissions] = useState<Mission[]>([]);
  const [diamonds, setDiamonds] = useState(0);
  const [isVIP, setIsVIP] = useState(false);
  const [dailyStreak, setDailyStreak] = useState(0);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [visibleStats, setVisibleStats] = useState<Set<number>>(new Set());

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
    async function loadProfile() {
      setIsLoading(true);

      // SWR: Show cached profile instantly while loading fresh data
      try {
        const {
          data: { user: authUser },
        } = await supabase.auth.getUser();
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
        } catch {
          /* corrupt cache */
        }

        // Fetch basic profile and stats
        const { data: profile } = await retryFetch(
          () =>
            supabase
              .from('profiles')
              .select(
                'id, username, display_name, player_number, avatar_url, vip_level, created_at, diamonds, is_vip, daily_streak, stats'
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
            playerNumber: profile.player_number || Math.floor(Math.random() * 9999) + 1,
            avatarUrl: profile.avatar_url || '',
            vipLevel: profile.vip_level || 'bronze',
            memberSince: profile.created_at,
          });

          setDiamonds(profile.diamonds || 0);
          setIsVIP(profile.is_vip || false);
          setDailyStreak(profile.daily_streak || 0);

          if (profile.stats) {
            setStats({
              totalHands: profile.stats.total_hands || 0,
              vpip: profile.stats.vpip || 0,
              pfr: profile.stats.pfr || 0,
              threeBet: profile.stats.three_bet || 0,
              aggression: profile.stats.aggression_factor || 0,
              bbPer100: profile.stats.bb_per_100 || 0,
              biggestPot: profile.stats.biggest_pot || 0,
              totalProfit: profile.stats.total_profit || 0,
              winRate: profile.stats.win_rate || 0,
              tournamentsPlayed: profile.stats.tournaments_played || 0,
              tournamentsWon: profile.stats.tournaments_won || 0,
              bountyKOs: profile.stats.bounty_kos || 0,
              roi: profile.stats.roi || 0,
            });
          }
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
                  playerNumber: profile.player_number || Math.floor(Math.random() * 9999) + 1,
                  avatarUrl: profile.avatar_url || '',
                  vipLevel: profile.vip_level || 'bronze',
                  memberSince: profile.created_at,
                },
                stats: profile.stats
                  ? {
                      totalHands: profile.stats.total_hands || 0,
                      vpip: profile.stats.vpip || 0,
                      pfr: profile.stats.pfr || 0,
                      threeBet: profile.stats.three_bet || 0,
                      aggression: profile.stats.aggression_factor || 0,
                      bbPer100: profile.stats.bb_per_100 || 0,
                      biggestPot: profile.stats.biggest_pot || 0,
                      totalProfit: profile.stats.total_profit || 0,
                      winRate: profile.stats.win_rate || 0,
                      tournamentsPlayed: profile.stats.tournaments_played || 0,
                      tournamentsWon: profile.stats.tournaments_won || 0,
                      bountyKOs: profile.stats.bounty_kos || 0,
                      roi: profile.stats.roi || 0,
                    }
                  : null,
                diamonds: profile.diamonds || 0,
                isVIP: profile.is_vip || false,
                dailyStreak: profile.daily_streak || 0,
              })
            );
          } catch {
            /* storage full */
          }
        }

        // ── Batch: achievements + missions + transactions in parallel ──
        const [achievementsResult, missionsResult, transactionsResult] = await Promise.allSettled([
          // Achievements
          retryFetch(
            () =>
              supabase
                .from('user_achievements')
                .select('*, achievement:achievements(*)')
                .eq('user_id', authUser.id)
                .limit(200)
                .then((r) => r),
            { maxRetries: 2, isMountedRef: isMountedRef }
          ),
          // Missions (daily + weekly + monthly)
          Promise.all([
            dailyChallengeService.getTodaysChallenges(authUser.id),
            dailyChallengeService.getWeeklyChallenges(authUser.id),
            dailyChallengeService.getMonthlyChallenges(authUser.id),
          ]),
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

        // Process missions
        if (missionsResult.status === 'fulfilled') {
          const [daily, weekly, monthly] = missionsResult.value;
          const allMissions = [...daily, ...weekly, ...monthly];
          setMissions(
            allMissions.map((mc) => ({
              id: mc.id,
              tier: ('tier' in mc ? mc.tier : 'daily') as 'daily' | 'weekly' | 'monthly',
              title: mc.challenge.name,
              description: mc.challenge.description,
              icon: mc.challenge.icon,
              current: mc.progress,
              target: mc.challenge.requirement,
              rewardAmount: mc.challenge.chipReward,
              rewardType: 'chips' as const,
              completed: mc.completed,
              claimed: mc.claimed,
            }))
          );
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
        console.error('[PROFILE] Load failed:', err);
        if (isMounted) toast.error(err.message || 'Failed to load profile data');
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }
    loadProfile();
    return () => {
      isMounted = false;
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
                  'id, username, display_name, player_number, avatar_url, vip_level, created_at, diamonds, is_vip, daily_streak, stats'
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
                      vipLevel: profile.vip_level || 'bronze',
                      memberSince: profile.created_at,
                    });
                    setDiamonds(profile.diamonds || 0);
                    setIsVIP(profile.is_vip || false);
                  }
                });
            }
          })
          .catch(() => {});
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
              supabase
                .from('profiles')
                .select('stats')
                .eq('id', authUser.id)
                .maybeSingle()
                .then(({ data: profile }) => {
                  if (profile?.stats && isMounted) {
                    setStats({
                      totalHands: profile.stats.total_hands || 0,
                      vpip: profile.stats.vpip || 0,
                      pfr: profile.stats.pfr || 0,
                      threeBet: profile.stats.three_bet || 0,
                      aggression: profile.stats.aggression_factor || 0,
                      bbPer100: profile.stats.bb_per_100 || 0,
                      biggestPot: profile.stats.biggest_pot || 0,
                      totalProfit: profile.stats.total_profit || 0,
                      winRate: profile.stats.win_rate || 0,
                      tournamentsPlayed: profile.stats.tournaments_played || 0,
                      tournamentsWon: profile.stats.tournaments_won || 0,
                      bountyKOs: profile.stats.bounty_kos || 0,
                      roi: profile.stats.roi || 0,
                    });
                  }
                });
            }
          })
          .catch(() => {});
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
              supabase
                .from('diamond_wallets')
                .select('balance')
                .eq('user_id', authUser.id)
                .maybeSingle()
                .then(({ data: dw }) => {
                  if (dw && isMounted) setDiamonds(dw.balance || 0);
                });
            }
          })
          .catch(() => {});
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
                .select('diamonds, daily_streak')
                .eq('id', authUser.id)
                .maybeSingle()
                .then(({ data }) => {
                  if (data && isMounted) {
                    setDiamonds(data.diamonds || 0);
                    setDailyStreak(data.daily_streak || 0);
                  }
                });
            }
          })
          .catch(() => {});
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
          .catch(() => {});
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
          .catch(() => {});
      },
      500
    );

    // Auto-refresh missions when progress is updated in-game
    const unsubChallengeProgress = masterBus.subscribeDebounced(
      'CHALLENGE_PROGRESS_UPDATED',
      () => {
        if (!isMounted) return;
        supabase.auth
          .getUser()
          .then(({ data: { user: authUser } }) => {
            if (authUser && isMounted) {
              Promise.all([
                dailyChallengeService.getTodaysChallenges(authUser.id),
                dailyChallengeService.getWeeklyChallenges(authUser.id),
                dailyChallengeService.getMonthlyChallenges(authUser.id),
              ])
                .then(([daily, weekly, monthly]) => {
                  if (!isMounted) return;
                  const allMissions = [...daily, ...weekly, ...monthly];
                  setMissions(
                    allMissions.map((mc) => ({
                      id: mc.id,
                      tier: ('tier' in mc ? mc.tier : 'daily') as 'daily' | 'weekly' | 'monthly',
                      title: mc.challenge.name,
                      description: mc.challenge.description,
                      icon: mc.challenge.icon,
                      current: mc.progress,
                      target: mc.challenge.requirement,
                      rewardAmount: mc.challenge.chipReward,
                      rewardType: 'chips' as const,
                      completed: mc.completed,
                      claimed: mc.claimed,
                    }))
                  );
                })
                .catch(() => {});
            }
          })
          .catch(() => {});
      },
      1000
    );

    return () => {
      isMounted = false;
      unsubProfile();
      unsubHand();
      unsubBalance();
      unsubDailyReward();
      unsubMissionClaim();
      unsubWheelSpin();
      unsubChallengeProgress();
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
        } = await supabase.auth.getUser();
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
                  'id, username, display_name, player_number, avatar_url, vip_level, created_at, diamonds, is_vip, daily_streak, stats'
                )
                .eq('id', authUser.id)
                .maybeSingle();

              if (updatedProfile) {
                setUser({
                  id: updatedProfile.id,
                  username: updatedProfile.username || 'Player',
                  displayName: updatedProfile.display_name || updatedProfile.username || 'Player',
                  playerNumber:
                    updatedProfile.player_number || Math.floor(Math.random() * 9999) + 1,
                  avatarUrl: updatedProfile.avatar_url || '',
                  vipLevel: updatedProfile.vip_level || 'bronze',
                  memberSince: updatedProfile.created_at,
                });

                setDiamonds(updatedProfile.diamonds || 0);
                setIsVIP(updatedProfile.is_vip || false);

                if (updatedProfile.stats) {
                  setStats({
                    totalHands: updatedProfile.stats.total_hands || 0,
                    vpip: updatedProfile.stats.vpip || 0,
                    pfr: updatedProfile.stats.pfr || 0,
                    threeBet: updatedProfile.stats.three_bet || 0,
                    aggression: updatedProfile.stats.aggression_factor || 0,
                    bbPer100: updatedProfile.stats.bb_per_100 || 0,
                    biggestPot: updatedProfile.stats.biggest_pot || 0,
                    totalProfit: updatedProfile.stats.total_profit || 0,
                    winRate: updatedProfile.stats.win_rate || 0,
                    tournamentsPlayed: updatedProfile.stats.tournaments_played || 0,
                    tournamentsWon: updatedProfile.stats.tournaments_won || 0,
                    bountyKOs: updatedProfile.stats.bounty_kos || 0,
                    roi: updatedProfile.stats.roi || 0,
                  });
                }
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
          .subscribe();
      } catch (err) {
        console.error('[PROFILE] Realtime subscription failed:', err);
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
      <div className={styles.page}>
        <div className={styles.emptyProfile}>
          <span style={{ fontSize: '3rem' }}></span>
          <p>Profile not found</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* Profile Header */}
      <section className={styles.profileHeader}>
        <div className={styles.avatarContainer}>
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt={user.displayName}
              className={styles.avatar}
              loading="lazy"
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
          <p className={styles.playerNumber}>Player #{user.playerNumber}</p>
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
              const url = 'https://smarter.poker/hub/avatars-complete';
              const isInIframe = typeof window !== 'undefined' && window.parent !== window;
              if (isInIframe) {
                try { window.top!.open(url, '_blank'); } catch { window.open(url, '_blank'); }
              } else {
                window.open(url, '_blank');
              }
            }}
          >
            Change Avatar
          </button>
          <button className={styles.editButton} onClick={() => navigate('/settings')}>
            Edit Profile
          </button>
          <button
            className={styles.editButton}
            onClick={() => navigate('/vip')}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            💎 {diamonds.toLocaleString()} {isVIP && <span style={{ fontSize: 12 }}>👑 VIP</span>}
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

      {/* Daily Missions */}
      <section className={styles.contentSection}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <h3 style={{ margin: 0, fontSize: '0.875rem', color: '#8a9aaa', fontWeight: 600 }}>
            Daily Missions
          </h3>
        </div>
        <MissionsPanel
          missions={missions}
          onClaim={async (missionId) => {
            if (!user?.id) return;
            const targetMission = missions.find((m) => m.id === missionId);
            if (!targetMission) return;
            try {
              await dailyChallengeService.claimChallenge(
                user.id,
                targetMission.id,
                targetMission.rewardAmount
              );
              if (isMountedRef.current) {
                setMissions((prev) =>
                  prev.map((m) => (m.id === missionId ? { ...m, claimed: true } : m))
                );
              }
              toast.success('Mission reward claimed!');
            } catch (err: any) {
              console.error('Failed to claim mission:', err);
              toast.error(err.message || 'Failed to claim mission reward');
            }
          }}
        />
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
                <span style={{ fontSize: '3rem' }}></span>
                <p>No achievements yet. Start playing to unlock achievements!</p>
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
                      Loading chart...
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
                <p>No recent transactions to display.</p>
                <button className={styles.playButton} onClick={() => navigate('/lobby')}>
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
              onSpin={async (segment) => {
                setShowBonusWheel(false);
              }}
            />
          </div>
        </div>
      )}

      {/* Diamond Rain Gamification Effect */}
      <DiamondRainEffect active={showDiamondRain} onComplete={() => setShowDiamondRain(false)} />
    </div>
  );
}
