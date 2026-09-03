/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Profile Page
 * User profile with DNA, VIP status, and achievements
 *
 * NO HARDCODED DATA - All data comes from Supabase
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, Suspense, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase, getAuthUser } from '../lib/supabase';
import { LoadingState } from '../components/common/EmptyState';
import FriendListPanel from '../components/social/FriendListPanel';
import { VIPStatusCard } from '../components/vip/VIPStatusCard';
import { VIPProgressRing } from '../components/vip/VIPProgressRing';
import UserProfileEdit, { UserProfileData } from '../components/social/UserProfileEdit';
import { DiamondService } from '../services/DiamondService';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { masterBus } from '../core/MasterBus';
import { StreakFire } from '../components/gamification/StreakFire';
import StreakMultiplier from '../components/gamification/StreakMultiplier';
import FinancialAchievementBadge from '../components/gamification/FinancialAchievementBadge';
import CircularGauge from '../components/common/CircularGauge';
import DiamondRainEffect from '../components/effects/DiamondRainEffect';
import PlayerActivityFeed from '../components/social/PlayerActivityFeed';
import ReferralDashboard from '../components/social/ReferralDashboard';
import { useSwipeTabs } from '../hooks/useSwipeTabs';
import { useToast } from '../components/common/Toast';
import { retryFetch } from '../utils/retryFetch';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import styles from './ProfilePage.module.css';

import { useIsMounted } from '../hooks/useIsMounted';
import { generateDefaultAvatar } from '../utils/avatarGenerator';
import { reportError } from '../utils/errorReporter';
import { lazyWithRetry } from '../utils/lazyWithRetry';
import { formatPopupText } from '../utils/popupStyle';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';

// #5: Lazy-load Recharts (387KB) — only imported when History tab is opened
const LazyProfitChart = lazyWithRetry(() => import('../components/profile/ProfitChart'));

const PROFILE_TABS = ['stats', 'achievements', 'history', 'social'] as const;
type ProfileTab = (typeof PROFILE_TABS)[number];

function isProfileTab(value: string | null): value is ProfileTab {
  return PROFILE_TABS.includes(value as ProfileTab);
}

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
  bio?: string;
  player_tags?: string[];
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

const finiteStat = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function profileStatsFromV2(payload: any): PokerStats | null {
  if (payload?.contract_version !== 2 || !payload?.overall) return null;
  const overall = payload.overall;
  const tournaments = payload.tournaments ?? {};
  const totalHands = finiteStat(overall.total_hands);
  const handsWon = finiteStat(overall.hands_won);
  return {
    totalHands,
    vpip: finiteStat(overall.vpip) * 100,
    pfr: finiteStat(overall.pfr) * 100,
    threeBet: finiteStat(overall.three_bet_percent) * 100,
    aggression: finiteStat(overall.aggression_factor),
    bbPer100: finiteStat(overall.bb_per_100),
    biggestPot: finiteStat(overall.biggest_pot_won),
    totalProfit: finiteStat(overall.total_profit),
    winRate: totalHands > 0 ? (handsWon / totalHands) * 100 : 0,
    tournamentsPlayed: finiteStat(tournaments.entries),
    tournamentsWon: finiteStat(tournaments.wins),
    bountyKOs: finiteStat(tournaments.total_bounties),
    roi: finiteStat(tournaments.roi) * 100,
  };
}

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
  isVisible,
}: {
  value: string | number;
  label: string;
  positive?: boolean | null;
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
  const [searchParams, setSearchParams] = useSearchParams();
  const isMountedRef = useIsMounted();

  const toast = useToast();
  const [showProfileEdit, setShowProfileEdit] = useState(false);
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
  const [activeTab, setActiveTab] = useState<ProfileTab>(() => {
    const requested = searchParams.get('tab');
    return isProfileTab(requested) ? requested : 'stats';
  });

  useEffect(() => {
    const requested = searchParams.get('tab');
    if (isProfileTab(requested) && requested !== activeTab) setActiveTab(requested);
  }, [activeTab, searchParams]);

  const selectTab = useCallback(
    (tab: ProfileTab) => {
      setActiveTab(tab);
      const next = new URLSearchParams(searchParams);
      if (tab === 'stats') next.delete('tab');
      else next.set('tab', tab);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? PROFILE_TABS.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + PROFILE_TABS.length) %
            PROFILE_TABS.length;
    const nextTab = PROFILE_TABS[nextIndex];
    selectTab(nextTab);
    requestAnimationFrame(() => document.getElementById(`profile-tab-${nextTab}`)?.focus());
  };

  const swipeHandlers = useSwipeTabs({
    tabs: [...PROFILE_TABS],
    activeTab,
    onTabChange: (tab) => selectTab(tab as ProfileTab),
  });

  const [isLoading, setIsLoading] = useState(true);
  const [showDiamondRain, setShowDiamondRain] = useState(false);

  // Real data from database
  const [user, setUser] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<PokerStats>(DEFAULT_STATS);
  const [statsAvailable, setStatsAvailable] = useState(false);
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
      // Three gauges plus ten stat cards. The old count stopped at index 10,
      // leaving Bounty KOs and tournament Win Rate permanently at opacity 0.
      const statCount = 13;
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
            if (cp.stats) {
              setStats(cp.stats);
              setStatsAvailable(true);
            }
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
                .order('created_at', { ascending: false })
                .limit(200)
                .then((r) => r),
            { maxRetries: 2, isMountedRef: isMountedRef }
          ),
          // Owner-only v2 Stats snapshot. This used to be promised as loaded
          // separately but was never called, leaving a dashboard of fabricated
          // zeroes on every profile.
          retryFetch(
            () =>
              supabase
                .rpc('ca_player_stats_overview_v2', { p_user: authUser.id, p_days: null })
                .then((r) => r),
            { maxRetries: 2, isMountedRef: isMountedRef }
          ),
        ]);

        // Fetch basic profile and stats
        const { data: profile, error: profileError } = await retryFetch(
          () =>
            supabase
              .from('profiles')
              .select(
                `id, ${PLAYER_NAME_COLUMNS}, player_number, avatar_url, tier, created_at, diamonds, is_vip, login_streak, bio, player_tags`
              )
              .eq('id', authUser.id)
              .maybeSingle()
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMountedRef }
        );

        if (profileError) throw profileError;

        if (profile && isMounted) {
          setUser({
            id: profile.id,
            username: profile.username || 'Player',
            displayName: playerDisplayName(profile),
            playerNumber: profile.player_number || 0,
            avatarUrl: profile.avatar_url || '',
            vipLevel: profile.tier || 'bronze',
            memberSince: profile.created_at,
            bio: profile.bio || '',
            player_tags: profile.player_tags || [],
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
                  displayName: playerDisplayName(profile),
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
        const [achievementsResult, transactionsResult, statsResult] = await secondaryDataPromise;

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
          // DB returned them descending (newest first). Reverse them so the array is ascending
          // (oldest first) which the chart requires to draw chronologically left-to-right.
          setTransactions([...transactionsResult.value.data].reverse());
        } else {
          setTransactions([]);
        }

        const profileStats =
          statsResult.status === 'fulfilled' && !statsResult.value.error
            ? profileStatsFromV2(statsResult.value.data)
            : null;
        if (profileStats) {
          setStats(profileStats);
          setStatsAvailable(true);
        } else {
          setStats(DEFAULT_STATS);
          setStatsAvailable(false);
        }

        // Notify Master Bus that profile is loaded
        if (profile) {
          masterBus.emit('USER_PROFILE_LOADED', {
            userId: authUser.id,
            avatarUrl: profile.avatar_url || '',
            displayName: playerDisplayName(profile),
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
  }, [isMountedRef, toast]);

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
                  `id, ${PLAYER_NAME_COLUMNS}, player_number, avatar_url, tier, created_at, diamonds, is_vip, login_streak, bio, player_tags`
                )
                .eq('id', authUser.id)
                .maybeSingle()
                .then(({ data: profile }) => {
                  if (profile && isMounted) {
                    setUser({
                      id: profile.id,
                      username: profile.username || 'Player',
                      displayName: playerDisplayName(profile),
                      playerNumber: profile.player_number || 0,
                      avatarUrl: profile.avatar_url || '',
                      vipLevel: profile.tier || 'bronze',
                      memberSince: profile.created_at,
                      bio: profile.bio || '',
                      player_tags: profile.player_tags || [],
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
              supabase
                .rpc('ca_player_stats_overview_v2', { p_user: authUser.id, p_days: null })
                .then(({ data, error }) => {
                  const freshStats = !error ? profileStatsFromV2(data) : null;
                  if (isMounted && freshStats) {
                    setStats(freshStats);
                    setStatsAvailable(true);
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
      (event: any) => {
        if (!isMounted) return;
        // WRAPPER BUG (fixed 2026-08-28): subscribers receive the event
        // WRAPPER ({ type, payload, timestamp }), not the raw payload.
        // Reading .rewardType off the wrapper was always undefined, so the
        // diamond rain celebration never fired. Same class as the 2026-08-19
        // UI_THEME_CHANGED audit.
        const payload = event?.payload ?? event;
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
      (event: any) => {
        if (!isMounted) return;
        // Wrapper unwrap — see the DAILY_REWARD_CLAIMED note above.
        const payload = event?.payload ?? event;
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
      (event: any) => {
        if (!isMounted) return;
        // Wrapper unwrap — the most insidious variant of the class: the
        // WRAPPER has a real `.type` field holding the event NAME
        // ('WHEEL_SPIN_RESULT'), so `payload?.type === 'diamonds'` was
        // silently, permanently false with no undefined to trip a guard.
        // The payload's own `type` (LuckyDrawWheel emits segment type) is
        // what this comparison was written for.
        const payload = event?.payload ?? event;
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

  // Realtime profile/wallet updates: handled GLOBALLY, not by this page.
  //
  // 2026-08-24: a `profile-<uid>` channel used to be created here carrying two
  // listeners - `profiles` (id=eq.<uid>) and `wallets` (user_id=eq.<uid>) - each
  // of which responded by RE-QUERYING profiles. Both were byte-identical
  // duplicates of listeners PostgresSyncHooks already carries on
  // `global_db_sync:<userId>`, created once at sign-in and never torn down by
  // navigation, and that channel emits PROFILE_UPDATED, BALANCE_UPDATED and
  // DIAMOND_BALANCE_CHANGED. This page already subscribes to all three on the
  // bus (see the listeners further up this file), so the refresh path is
  // unchanged - only the duplicate socket subscription, and the whole effect
  // that existed to create it, are gone.
  //
  // Nothing here drove a connection-status indicator. CashierPage's wallets
  // channel does (its onSubscriptionError feeds the degraded-connection
  // banner), which is why that one is deliberately left in place.

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
        <div className={styles.heroArtwork} aria-hidden="true" />
        <div className={styles.heroCopy}>
          <span className={styles.heroEyebrow}>Player Identity // Live Credential</span>
          <span className={styles.heroStatus} role="status">
            <span aria-hidden="true" /> Profile Synced
          </span>
        </div>
        <div className={styles.avatarContainer}>
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt={user.username}
              className={styles.avatar}
              loading="lazy"
              onError={(e) => {
                (e.target as HTMLImageElement).src = generateDefaultAvatar();
              }}
            />
          ) : (
            <div className={styles.avatarDefault}>{user.username.charAt(0).toUpperCase()}</div>
          )}
          <VIPBadge level={user.vipLevel} />
        </div>

        <div className={styles.userInfo}>
          <h1 className={styles.displayName}>
            {user.username}
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
          {user.bio && <p className={styles.bio}>{user.bio}</p>}
          {user.player_tags && user.player_tags.length > 0 && (
            <div className={styles.tagsContainer}>
              {user.player_tags.map((tag) => (
                <span key={tag} className={styles.playerTag}>
                  {tag}
                </span>
              ))}
            </div>
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
          <button className={styles.editButton} onClick={() => navigate('/vip')}>
            {diamonds.toLocaleString()} DIA {isVIP && <span className={styles.vipAction}>VIP</span>}
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
            <section className={`${styles.contentSection} ${styles.vipSection}`}>
              <div className={styles.vipContent}>
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

      {/* Dedicated workspaces own reward claims, deep analytics, promotions,
          and ranking. Profile is their identity index, not a second copy of
          their data loaders and mutation guards. */}
      <nav className={styles.destinationGrid} aria-label="Player Workspaces">
        {[
          { label: 'Player Analytics', meta: 'Deep Stats And Leak Analysis', path: '/stats' },
          { label: 'Bonus Center', meta: 'Daily And Special Claims', path: '/bonuses' },
          { label: 'Challenges', meta: 'Missions And Progress', path: '/challenges' },
          { label: 'Leaderboards', meta: 'Circuit Rankings', path: '/leaderboard' },
          { label: 'Promotions', meta: 'Live Offers And Eligibility', path: '/promotions' },
          { label: 'VIP Status', meta: 'Tier Progress And Benefits', path: '/vip' },
        ].map((destination) => (
          <button
            type="button"
            key={destination.path}
            className={styles.destination}
            onClick={() => navigate(destination.path)}
          >
            <span>{destination.label}</span>
            <small>{destination.meta}</small>
            <i aria-hidden="true">↗</i>
          </button>
        ))}
      </nav>

      {/* Achievement Showcase — always visible */}
      {achievements.filter((a) => a.unlockedAt).length > 0 && (
        <section className={styles.contentSection}>
          <div className={styles.sectionHeading}>
            <h3>Recent Distinctions</h3>
            <button
              type="button"
              onClick={() => selectTab('achievements')}
              className={styles.textAction}
            >
              Inspect All
            </button>
          </div>
          <div className={styles.achievementStrip}>
            {achievements
              .filter((a) => a.unlockedAt)
              .sort((a, b) => new Date(b.unlockedAt!).getTime() - new Date(a.unlockedAt!).getTime())
              .slice(0, 5)
              .map((a) => (
                <div key={a.id} className={styles.achievementChip}>
                  <span aria-hidden="true">{a.icon || '★'}</span>
                  <span>{a.name}</span>
                </div>
              ))}
          </div>
        </section>
      )}

      {/* Tab Navigation */}
      <nav className={styles.tabNav} role="tablist" aria-label="Profile Details">
        {PROFILE_TABS.map((tab, index) => (
          <button
            type="button"
            id={`profile-tab-${tab}`}
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls="profile-tabpanel"
            tabIndex={activeTab === tab ? 0 : -1}
            className={`${styles.tab} ${activeTab === tab ? styles.activeTab : ''}`}
            onClick={() => selectTab(tab)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            {tab === 'stats'
              ? 'Snapshot'
              : tab === 'history'
                ? 'Activity'
                : tab === 'social'
                  ? 'Network'
                  : 'Achievements'}
          </button>
        ))}
      </nav>

      {/* Tab Content */}
      <section
        id="profile-tabpanel"
        className={styles.tabContent}
        role="tabpanel"
        aria-labelledby={`profile-tab-${activeTab}`}
        tabIndex={0}
        {...swipeHandlers}
      >
        {activeTab === 'stats' && (
          <div className={styles.statsContainer}>
            {statsAvailable ? (
              <>
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
                      isVisible={visibleStats.has(3)}
                    />
                    <StatCard
                      value={`${stats.threeBet}%`}
                      label="3-Bet"
                      isVisible={visibleStats.has(4)}
                    />
                    <StatCard
                      value={stats.aggression.toFixed(1)}
                      label="Aggression"
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
                      isVisible={visibleStats.has(6)}
                    />
                    <StatCard
                      value={stats.biggestPot.toLocaleString()}
                      label="Biggest Pot"
                      isVisible={visibleStats.has(7)}
                    />
                    <StatCard
                      value={`${stats.totalProfit > 0 ? '+' : ''}${stats.totalProfit.toLocaleString()}`}
                      label="Total Profit"
                      positive={stats.totalProfit > 0}
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
                      isVisible={visibleStats.has(9)}
                    />
                    <StatCard
                      value={stats.tournamentsWon}
                      label="Won"
                      isVisible={visibleStats.has(10)}
                    />
                    <StatCard
                      value={stats.bountyKOs}
                      label="Bounty KOs"
                      isVisible={visibleStats.has(11)}
                    />
                    <StatCard
                      value={
                        stats.tournamentsPlayed > 0
                          ? `${((stats.tournamentsWon / stats.tournamentsPlayed) * 100).toFixed(1)}%`
                          : '0%'
                      }
                      label="Win Rate"
                      isVisible={visibleStats.has(12)}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className={styles.statsGroup} role="status">
                <h3>Stats Snapshot Unavailable</h3>
                <p>
                  No Verified Player Analytics Payload Is Available Yet. Open The Full Workspace To
                  Retry Or Review The Current Coverage Status.
                </p>
              </div>
            )}
            <button
              type="button"
              className={styles.workspaceCta}
              onClick={() => navigate('/stats')}
            >
              Open Full Player Analytics <span aria-hidden="true">→</span>
            </button>
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
            <div className={styles.milestones}>
              <h3>Financial Milestones</h3>
              <div className={styles.milestoneGrid}>
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
            <button
              type="button"
              className={styles.workspaceCta}
              onClick={() => navigate('/achievements')}
            >
              Open Achievement Vault <span aria-hidden="true">→</span>
            </button>
          </div>
        )}

        {activeTab === 'history' && (
          <div className={styles.historyContainer}>
            {transactions.length > 0 ? (
              <>
                {/* #5: Lazy-loaded Profit Graph */}
                <Suspense fallback={<div className={styles.chartLoading}>Loading Chart...</div>}>
                  <LazyProfitChart transactions={transactions} />
                </Suspense>

                {/* Transaction List */}
                <h3 className={styles.historyHeading}>Recent Transactions</h3>
                <div className={styles.transactionList}>
                  {[...transactions]
                    .reverse()
                    .slice(0, 10)
                    .map((tx) => (
                      <div key={tx.id} className={styles.transactionRow}>
                        <div>
                          <span>{formatPopupText(tx.description || tx.type)}</span>
                          <small>{new Date(tx.created_at).toLocaleDateString()}</small>
                        </div>
                        <span
                          className={
                            tx.type === 'credit'
                              ? styles.transactionCredit
                              : styles.transactionDebit
                          }
                        >
                          {tx.type === 'credit' ? '+' : '-'}
                          {(tx.amount || 0).toLocaleString()}
                        </span>
                      </div>
                    ))}
                </div>
                <button
                  type="button"
                  className={styles.workspaceCta}
                  onClick={() => navigate('/transactions')}
                >
                  Open Complete Transaction History <span aria-hidden="true">→</span>
                </button>
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
            {user.id && <PlayerActivityFeed userId={user.id} />}
            {user.id && <ReferralDashboard userId={user.id} />}
          </div>
        )}
      </section>

      {/* Diamond Rain Gamification Effect */}
      <DiamondRainEffect active={showDiamondRain} onComplete={() => setShowDiamondRain(false)} />

      {showProfileEdit && user && (
        <UserProfileEdit
          isOpen={showProfileEdit}
          onClose={() => setShowProfileEdit(false)}
          initialData={{
            id: user.id || '',
            username: user.username || '',
            displayName: '',
            avatarUrl: user.avatarUrl || '',
            bio: (user as any).bio || '',
            tags: (user as any).player_tags || [],
          }}
          onSave={async (data: UserProfileData) => {
            try {
              const { error } = await supabase
                .from('profiles')
                .update({
                  username: data.username,
                  bio: data.bio,
                  player_tags: data.tags,
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
                bio: data.bio,
                player_tags: data.tags,
              });
              toast.success('Profile saved');
            } catch (err) {
              reportError(err, 'ProfilePage.Profile_update_failed');
              toast.error('Profile could not be saved. Please try again.');
              throw err;
            }
          }}
        />
      )}
    </StandardContentLayout>
  );
}
