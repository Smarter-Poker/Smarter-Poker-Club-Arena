/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Profile Page
 * User profile with DNA, VIP status, and achievements
 *
 * NO HARDCODED DATA - All data comes from Supabase
 *
 * 2026-09-04 #SmarterCasinoRealism audit. The page is the player's identity
 * credential: a machined plate with the portrait, the arena handle, the
 * player number, the live telemetry rail, and the access plates into the
 * dedicated workspaces. Every number on it is either real or a hyphen.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, Suspense, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase, getAuthUser } from '../lib/supabase';
import { LoadingState } from '../components/common/EmptyState';
import FriendListPanel from '../components/social/FriendListPanel';
import UserProfileEdit, { UserProfileData } from '../components/social/UserProfileEdit';
import { AvatarGallery } from '../components/customization/AvatarGallery';
import { DiamondService } from '../services/DiamondService';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { masterBus } from '../core/MasterBus';
import { StreakFire } from '../components/gamification/StreakFire';
import StreakMultiplier from '../components/gamification/StreakMultiplier';
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
import { mediaUrl } from '../utils/mediaBase';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import { resolveHeaderPortrait } from '../stores/useHeaderDataStore';
import { resolveVipStatus, vipStatusLabel, type VipStatus } from '../utils/vipStatus';
import { VIP_MONTHLY_ALLOWANCES } from '../services/VIPService';
import {
  achievementService,
  type Achievement as AchievementDef,
} from '../services/AchievementService';
import { streakMultiplier } from '../utils/streakMultiplier';
import { ordinal, relativeTimeTitle } from '../utils/format';
import {
  EMPTY_STATS as DEFAULT_STATS,
  profileStatsFromV2,
  type PokerStats,
} from '../utils/profileStats';

// #5: Lazy-load Recharts (387KB) — only imported when History tab is opened
const LazyProfitChart = lazyWithRetry(() => import('../components/profile/ProfitChart'));

const PROFILE_TABS = ['stats', 'achievements', 'history', 'social'] as const;
type ProfileTab = (typeof PROFILE_TABS)[number];

function isProfileTab(value: string | null): value is ProfileTab {
  return PROFILE_TABS.includes(value as ProfileTab);
}

/** Purpose-built hero for this route (public/images/account). */
const HERO_ART = mediaUrl('images/account/identity-vault-hero-v1.webp');

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  playerNumber: string;
  /** The portrait the global header shows: the social photo unless the
   *  player opted to use the arena avatar everywhere. */
  avatarUrl: string;
  /** The library art opponents see at the table. */
  arenaAvatarUrl: string;
  /** VIP / Lifetime VIP / none. There is no tier ladder (utils/vipStatus). */
  vipStatus: VipStatus;
  /** Monthly membership renewal/expiry, ISO. Null for lifetime and non-VIP. */
  vipExpiresAt: string | null;
  memberSince: string;
  bio?: string;
  player_tags?: string[];
}

interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  rarity?: AchievementDef['rarity'];
  unlockedAt?: string;
  progress?: number;
  maxProgress?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT VALUES (for new users with no data)
// ═══════════════════════════════════════════════════════════════════════════════

const finiteStat = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * STANDING DIRECTIVE: "ABSOLUTELY ZERO ROUNDING ANYWHERE EVER". Every figure
 * on this page is truncated, never rounded — `toFixed` was used in three
 * places and each one could print a number the ledger never produced.
 */
const truncTo = (raw: number, decimals: number): number => {
  /* Binary floats: 2183.7 * 100 is 218369.99999999997, and a bare trunc
     prints -2,183.69 for a ledger row that says -2,183.70. A nudge of one
     part in a billion toward the sign keeps exact decimals exact and cannot
     lift a genuinely lower figure over a boundary. */
  const value = raw + Math.sign(raw) * 1e-9;
  const factor = 10 ** decimals;
  return Math.trunc(value * factor) / factor;
};
const fixedTrunc = (value: number, decimals: number): string =>
  truncTo(value, decimals).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
const signed = (formatted: string, value: number): string =>
  value > 0 ? `+${formatted}` : formatted;
/* Player copy carries no em dashes (check-ui-text gate). A plain hyphen is
   the truthful 'no figure yet' glyph. */
const NO_DATA = '-';

const VARIANT_LABEL: Record<string, string> = {
  nlh: "Hold'em",
  plo4: 'PLO4',
  plo5: 'PLO5',
  plo6: 'PLO6',
  pineapple: 'Pineapple',
  ofc: 'OFC',
  short_deck: 'Short Deck',
};
const variantLabel = (v: string) => VARIANT_LABEL[v] || v.toUpperCase();

/** The columns the credential needs. One string, used by every reader here. */
const PROFILE_COLUMNS = `id, ${PLAYER_NAME_COLUMNS}, player_number, avatar_url, arena_avatar_url, use_avatar_as_profile_pic, created_at, diamonds, is_vip, vip_tier, vip_expires_at, login_streak, bio, player_tags`;

function toUserProfile(profile: any): UserProfile {
  const photo = profile.avatar_url || '';
  const arena = profile.arena_avatar_url || '';
  return {
    id: profile.id,
    username: profile.username || 'Player',
    displayName: playerDisplayName(profile),
    playerNumber: profile.player_number ? String(profile.player_number) : '',
    avatarUrl:
      resolveHeaderPortrait(photo, arena, profile.use_avatar_as_profile_pic === true) || '',
    arenaAvatarUrl: arena,
    vipStatus: resolveVipStatus(profile),
    vipExpiresAt:
      resolveVipStatus(profile) === 'vip' && profile.vip_expires_at ? profile.vip_expires_at : null,
    memberSince: profile.created_at,
    bio: profile.bio || '',
    player_tags: profile.player_tags || [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

/* Brass for lifetime, chrome-blue for a monthly membership, nothing for
   non-members. There is no bronze/silver/gold ladder to draw. */
const VIPBadge = ({ status }: { status: VipStatus }) => {
  if (status === 'none') return null;
  return (
    <span className={`${styles.vipBadge} ${status === 'lifetime' ? styles.vipBadgeLifetime : ''}`}>
      {status === 'lifetime' ? 'LIFETIME VIP' : 'VIP'}
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
  <div className={`${styles.statCard} ${isVisible ? styles.visible : styles.hidden}`}>
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
      <span className={styles.achievementIcon} aria-hidden="true">
        {achievement.icon || '★'}
      </span>
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
      {isComplete && <span className={styles.achievementComplete} aria-label="Complete" />}
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
  const [showAvatarGallery, setShowAvatarGallery] = useState(false);
  useVisibilityRefresh(async () => {
    const {
      data: { user: au },
    } = await getAuthUser();
    if (!au) return;
    const { data: p, error } = await supabase
      .from('profiles')
      .select('diamonds, login_streak, is_vip')
      .eq('id', au.id)
      .maybeSingle();
    if (error) {
      reportError(error, 'ProfilePage.visibilityRefresh');
      return;
    }
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
      const statCount = 21;
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
            // v2 cache shape carries arenaAvatarUrl; an older entry (a tab
            // opened before this build) is ignored rather than painted with a
            // missing field.
            if (cp.v === 2 && cp.user) setUser(cp.user);
            if (cp.diamonds != null) setDiamonds(cp.diamonds);
            if (cp.isVIP != null) setIsVIP(cp.isVIP);
            if (cp.dailyStreak != null) setDailyStreak(cp.dailyStreak);
            if (cp.v === 2 && cp.user) setIsLoading(false); // Show cached UI instantly
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
          // Distinctions: the SAME definitions /achievements renders. The old
          // embed read `threshold` from training_achievement_definitions,
          // which is 0 on every row, so every progress bar divided by zero.
          retryFetch(() => achievementService.getUserAchievements(authUser.id), {
            maxRetries: 2,
            isMountedRef: isMountedRef,
          }),
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
              .select(PROFILE_COLUMNS)
              .eq('id', authUser.id)
              .maybeSingle()
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMountedRef }
        );

        if (profileError) throw profileError;

        if (profile && isMounted) {
          setUser(toUserProfile(profile));
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
                v: 2,
                user: toUserProfile(profile),
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
        if (achievementsResult.status === 'fulfilled') {
          setAchievements(
            achievementsResult.value.flatMap((ua): Achievement[] => {
              const def = ua.achievement ?? achievementService.getById(ua.achievementId);
              if (!def) return [];
              return [
                {
                  id: def.id,
                  name: def.name,
                  description: def.description,
                  icon: def.icon,
                  rarity: def.rarity,
                  unlockedAt: ua.unlockedAt,
                  progress: finiteStat(ua.progress),
                  maxProgress:
                    finiteStat(def.requirement) > 0 ? finiteStat(def.requirement) : undefined,
                },
              ];
            })
          );
        } else {
          reportError(achievementsResult.reason, 'ProfilePage.achievements');
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
                .select(PROFILE_COLUMNS)
                .eq('id', authUser.id)
                .maybeSingle()
                .then(({ data: profile }) => {
                  if (profile && isMounted) {
                    setUser(toUserProfile(profile));
                    setDiamonds(profile.diamonds || 0);
                    setIsVIP(profile.is_vip || false);
                    setDailyStreak(profile.login_streak || 0);
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
    const refreshDiamondBalance = () => {
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
    };
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      refreshDiamondBalance,
      500
    );
    const unsubDiamond = masterBus.subscribeDebounced(
      'DIAMOND_BALANCE_CHANGED',
      refreshDiamondBalance,
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

  const unlockedAchievements = achievements.filter((a) => a.unlockedAt);
  const tourneyWinRate =
    stats.tournamentsPlayed > 0 ? (stats.tournamentsWon / stats.tournamentsPlayed) * 100 : 0;
  const lastHandLabel = relativeTimeTitle(stats.lastHandAt);
  const memberSinceLabel = new Date(user.memberSince).toLocaleDateString('en-US', {
    month: 'short',
    year: '2-digit',
  });

  return (
    <StandardContentLayout className={styles.page}>
      {/* Profile Header — the credential plate */}
      <section className={styles.profileHeader} aria-labelledby="profile-heading">
        <div
          className={styles.heroArtwork}
          style={{ backgroundImage: `url("${HERO_ART}")` }}
          aria-hidden="true"
        />
        <div className={styles.heroCopy}>
          <span className={styles.heroEyebrow}>Player Identity // Live Credential</span>
          <span className={styles.heroStatus} role="status">
            <span aria-hidden="true" />{' '}
            {lastHandLabel ? `Last Hand ${lastHandLabel}` : 'No Hands Recorded Yet'}
          </span>
        </div>

        <div className={styles.avatarContainer}>
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt={user.displayName}
              className={styles.avatar}
              width={116}
              height={116}
              decoding="async"
              fetchPriority="high"
              onError={(e) => {
                (e.target as HTMLImageElement).src = generateDefaultAvatar();
              }}
            />
          ) : (
            <div className={styles.avatarDefault} aria-hidden="true">
              {user.displayName.charAt(0).toUpperCase()}
            </div>
          )}
          <VIPBadge status={user.vipStatus} />
        </div>

        <div className={styles.userInfo}>
          <h1 id="profile-heading" className={styles.displayName}>
            {user.displayName}
            {dailyStreak > 0 && <StreakFire streakCount={dailyStreak} size="sm" showLabel />}
            {dailyStreak > 0 && (
              <StreakMultiplier
                streak={dailyStreak}
                multiplier={streakMultiplier(dailyStreak)}
                size="sm"
              />
            )}
          </h1>
          {/* 2026-08-20: this was `profile.player_number || Math.floor(Math.random() * 9999) + 1`
              in three separate places in this file. When a profile had no
              player_number the page invented one — a DIFFERENT one on every load,
              and a different one again depending on which of the three code paths
              produced it. A player's own ID visibly changing between refreshes is
              not a cosmetic issue in a card room. Show nothing when there is no
              number rather than something untrue. */}
          {user.playerNumber && <p className={styles.playerNumber}>Player #{user.playerNumber}</p>}
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
        </div>

        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.editButton}
            onClick={() => setShowAvatarGallery(true)}
          >
            Change Avatar
          </button>
          <button
            type="button"
            className={styles.editButton}
            onClick={() => setShowProfileEdit(true)}
          >
            Edit Profile
          </button>
          <button
            type="button"
            className={`${styles.editButton} ${styles.diamondButton}`}
            onClick={() => navigate('/vip')}
            aria-label={`${diamonds.toLocaleString()} Diamonds. Open VIP Status`}
          >
            {diamonds.toLocaleString()} DIA{' '}
            {user.vipStatus !== 'none' && <span className={styles.vipAction}>VIP</span>}
          </button>
        </div>

        {/* Telemetry rail. Real figures or a hyphen, never a fabricated zero
            while the Stats contract has not answered. */}
        <dl className={styles.telemetry} aria-label="Player Telemetry">
          <div className={styles.telemetryCell}>
            <dt>Member</dt>
            <dd>{memberSinceLabel}</dd>
          </div>
          <div className={styles.telemetryCell}>
            <dt>Hands</dt>
            <dd>{statsAvailable ? stats.lifetimeHands.toLocaleString() : NO_DATA}</dd>
          </div>
          <div className={styles.telemetryCell}>
            <dt>VPIP</dt>
            <dd>{statsAvailable ? `${fixedTrunc(stats.vpip, 1)}%` : NO_DATA}</dd>
          </div>
          <div className={styles.telemetryCell}>
            <dt>ROI</dt>
            <dd>{statsAvailable ? `${signed(fixedTrunc(stats.roi, 1), stats.roi)}%` : NO_DATA}</dd>
          </div>
          <div className={styles.telemetryCell}>
            <dt>Streak</dt>
            <dd>{dailyStreak > 0 ? `${dailyStreak}D` : NO_DATA}</dd>
          </div>
          <div className={styles.telemetryCell}>
            <dt>Table Avatar</dt>
            <dd className={styles.telemetryAvatar}>
              {user.arenaAvatarUrl ? (
                <img src={user.arenaAvatarUrl} alt="" width={28} height={28} loading="lazy" />
              ) : (
                <span>Not Set</span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      {/* VIP ledger plate. Reads the same constants the VIP page quotes
          (VIP_MONTHLY_ALLOWANCES), so this can never promise something /vip does not.
          Dan 2026-09-04: no tiers, nothing "unlimited". */}
      <section className={`${styles.contentSection} ${styles.vipSection}`} aria-label="VIP Status">
        <div className={styles.vipRow}>
          <div className={styles.vipIdentity}>
            <span className={styles.vipEyebrow}>Membership</span>
            <strong
              className={`${styles.vipTitle} ${user.vipStatus === 'none' ? styles.vipTitleOff : ''}`}
            >
              {vipStatusLabel(user.vipStatus)}
            </strong>
            <span className={styles.vipMeta}>
              {user.vipStatus === 'lifetime'
                ? 'Never Expires'
                : user.vipStatus === 'vip'
                  ? user.vipExpiresAt
                    ? `Renews ${new Date(user.vipExpiresAt).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}`
                    : 'Active'
                  : 'Membership Benefits Are Open On The VIP Page'}
            </span>
          </div>
          {user.vipStatus !== 'none' && (
            <ul className={styles.vipBenefits} aria-label="Included Each Month">
              {/* 2026-09-05: the last two tiles were "3 Premium Themes" and
                  "+6% Leaderboard Boost". Nothing reads a theme allowance, and
                  LeaderboardService applies no boost of any kind, so both were
                  removed from VIP_MONTHLY_ALLOWANCES along with the tier ladder
                  they came in with. These four are metered: rabbit hunts by
                  fn_consume_rabbit_hunt, the bank by fn_time_bank_allowance,
                  and both packs by fn_increment_vip_usage. */}
              <li>
                <strong>{VIP_MONTHLY_ALLOWANCES.rabbitHunts}</strong>
                <span>Rabbit Hunts / Mo</span>
              </li>
              <li>
                <strong>{VIP_MONTHLY_ALLOWANCES.timeBankSeconds}s</strong>
                <span>Time Bank / Mo</span>
              </li>
              <li>
                <strong>{VIP_MONTHLY_ALLOWANCES.emojis.toLocaleString()}</strong>
                <span>Emojis / Mo</span>
              </li>
              <li>
                <strong>{VIP_MONTHLY_ALLOWANCES.tags.toLocaleString()}</strong>
                <span>Player Tags / Mo</span>
              </li>
              <li>
                <strong>{VIP_MONTHLY_ALLOWANCES.throwables}</strong>
                <span>Throwables / Mo</span>
              </li>
            </ul>
          )}
          <button
            type="button"
            className={`${styles.editButton} ${styles.vipCta}`}
            onClick={() => navigate('/vip')}
          >
            {user.vipStatus === 'none' ? 'See VIP Benefits' : 'Open VIP Ledger'}{' '}
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </section>

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
          { label: 'VIP Status', meta: 'Membership And Benefits', path: '/vip' },
          { label: 'Wallet', meta: 'Balances And Cashier Access', path: '/wallet' },
          { label: 'Settings', meta: 'Table, Alerts And Security', path: '/settings' },
          { label: 'Notifications', meta: 'Seat Calls And Signals', path: '/notifications' },
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
      {unlockedAchievements.length > 0 && (
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
            {[...unlockedAchievements]
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
                        accent="#3aa8ff"
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
                        accent="#d6ad52"
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
                        accent="#65d89b"
                        size={gaugeSize}
                      />
                    </div>
                  </div>
                  <div className={styles.statsGrid}>
                    <StatCard
                      value={stats.totalHands.toLocaleString()}
                      label={stats.analysisCapped ? 'Hands Analyzed' : 'Hands Played'}
                      isVisible={visibleStats.has(3)}
                    />
                    <StatCard
                      value={`${fixedTrunc(stats.threeBet, 1)}%`}
                      label="3-Bet"
                      isVisible={visibleStats.has(4)}
                    />
                    <StatCard
                      value={fixedTrunc(stats.aggression, 2)}
                      label="Aggression"
                      isVisible={visibleStats.has(5)}
                    />
                    <StatCard
                      value={`${fixedTrunc(stats.wtsd, 1)}%`}
                      label="WTSD"
                      isVisible={visibleStats.has(13)}
                    />
                    <StatCard
                      value={`${fixedTrunc(stats.showdownWinRate, 1)}%`}
                      label="Won At SD"
                      isVisible={visibleStats.has(14)}
                    />
                    <StatCard
                      value={fixedTrunc(stats.hoursPlayed, 1)}
                      label="Hours"
                      isVisible={visibleStats.has(15)}
                    />
                  </div>
                </div>

                <div className={styles.statsGroup}>
                  <h3>Financial</h3>
                  <div className={styles.statsGrid}>
                    <StatCard
                      value={signed(fixedTrunc(stats.bbPer100, 2), stats.bbPer100)}
                      label="BB/100"
                      positive={stats.bbPer100 > 0 ? true : stats.bbPer100 < 0 ? false : null}
                      isVisible={visibleStats.has(6)}
                    />
                    <StatCard
                      value={fixedTrunc(stats.biggestPot, 2)}
                      label="Biggest Pot"
                      isVisible={visibleStats.has(7)}
                    />
                    <StatCard
                      value={signed(fixedTrunc(stats.totalProfit, 2), stats.totalProfit)}
                      label="Total Profit"
                      positive={stats.totalProfit > 0 ? true : stats.totalProfit < 0 ? false : null}
                      isVisible={visibleStats.has(8)}
                    />
                    <StatCard
                      value={signed(fixedTrunc(stats.biggestLoss, 2), stats.biggestLoss)}
                      label="Worst Hand"
                      positive={stats.biggestLoss < 0 ? false : null}
                      isVisible={visibleStats.has(16)}
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
                      value={`${fixedTrunc(tourneyWinRate, 1)}%`}
                      label="Win Rate"
                      isVisible={visibleStats.has(12)}
                    />
                    <StatCard
                      value={`${fixedTrunc(stats.itmPercent, 1)}%`}
                      label="ITM"
                      isVisible={visibleStats.has(17)}
                    />
                    <StatCard
                      value={stats.bestFinish > 0 ? ordinal(stats.bestFinish) : NO_DATA}
                      label="Best Finish"
                      isVisible={visibleStats.has(18)}
                    />
                    <StatCard
                      value={stats.tournamentCashes}
                      label="Cashes"
                      isVisible={visibleStats.has(19)}
                    />
                    <StatCard
                      value={signed(fixedTrunc(stats.tournamentNet, 2), stats.tournamentNet)}
                      label="Net Result"
                      positive={
                        stats.tournamentNet > 0 ? true : stats.tournamentNet < 0 ? false : null
                      }
                      isVisible={visibleStats.has(20)}
                    />
                  </div>
                </div>

                {stats.variants.length > 0 && (
                  <div className={styles.statsGroup}>
                    <h3>By Variant</h3>
                    <ul className={styles.variantList}>
                      {[...stats.variants]
                        .sort((a, b) => b.hands - a.hands)
                        .slice(0, 5)
                        .map((v) => (
                          <li key={v.variant}>
                            <span>{variantLabel(v.variant)}</span>
                            <span>{v.hands.toLocaleString()} Hands</span>
                            <span
                              className={
                                v.profit > 0 ? styles.positive : v.profit < 0 ? styles.negative : ''
                              }
                            >
                              {signed(fixedTrunc(v.profit, 2), v.profit)}
                            </span>
                            <span>{signed(fixedTrunc(v.bb100, 1), v.bb100)} BB/100</span>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}
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
                  <span>{unlockedAchievements.length}</span>
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
            {/* Cumulative P/L from settled hand results (the stats payload's
                daily series), never from wallet flow: a buy-in is not a loss
                and a diamond purchase is not a session. */}
            <div className={styles.statsGroup}>
              <div className={styles.groupHeading}>
                <h3>Cumulative P/L</h3>
                <small>Settled Hand Results By Day</small>
              </div>
              <Suspense fallback={<div className={styles.chartLoading}>Loading Chart...</div>}>
                <LazyProfitChart series={stats.daily} />
              </Suspense>
            </div>

            {stats.sessions.length > 0 && (
              <div className={styles.statsGroup}>
                <div className={styles.groupHeading}>
                  <h3>Recent Sessions</h3>
                </div>
                <ul className={styles.sessionList}>
                  {stats.sessions.slice(0, 5).map((session) => (
                    <li key={session.id}>
                      <div>
                        <strong>
                          {new Date(session.date).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </strong>
                        <small>
                          {session.hands.toLocaleString()} Hands // {Math.trunc(session.minutes)}{' '}
                          Min // In {fixedTrunc(session.buyIn, 2)} Out{' '}
                          {fixedTrunc(session.cashOut, 2)}
                        </small>
                      </div>
                      <span
                        className={
                          session.profit > 0
                            ? styles.transactionCredit
                            : session.profit < 0
                              ? styles.transactionDebit
                              : ''
                        }
                      >
                        {signed(fixedTrunc(session.profit, 2), session.profit)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {transactions.length > 0 ? (
              <>
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
                          <small>{new Date(tx.created_at).toLocaleString()}</small>
                        </div>
                        <span
                          className={
                            tx.type === 'credit'
                              ? styles.transactionCredit
                              : styles.transactionDebit
                          }
                        >
                          {tx.type === 'credit' ? '+' : '-'}
                          {fixedTrunc(Math.abs(finiteStat(tx.amount)), 2)}
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
                <span className={styles.emptyIcon} aria-hidden="true" />
                <p>No Recent Transactions To Display.</p>
                <button type="button" className={styles.playButton} onClick={() => navigate('/')}>
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

      {/* The arena avatar picker — the same library gallery the hamburger and
          first-run flow use, so the profile writes arena_avatar_url through
          AvatarService and never touches the social photo. */}
      <AvatarGallery
        isOpen={showAvatarGallery}
        onClose={() => setShowAvatarGallery(false)}
        userId={user.id}
        currentAvatarUrl={user.arenaAvatarUrl || generateDefaultAvatar()}
        isVip={isVIP}
        onAvatarChanged={(newUrl) => {
          // The gallery also emits PLAYER_APPEARANCE_CHANGED, which the
          // header store consumes; this keeps the credential in step.
          setUser((prev) => (prev ? { ...prev, arenaAvatarUrl: newUrl } : prev));
        }}
      />

      {showProfileEdit && user && (
        <UserProfileEdit
          isOpen={showProfileEdit}
          onClose={() => setShowProfileEdit(false)}
          onChangeAvatar={() => {
            setShowProfileEdit(false);
            setShowAvatarGallery(true);
          }}
          initialData={{
            id: user.id || '',
            username: user.displayName || user.username || '',
            displayName: user.displayName,
            avatarUrl: user.avatarUrl || '',
            bio: user.bio || '',
            tags: user.player_tags || [],
          }}
          onSave={async (data: UserProfileData) => {
            try {
              /* The field is labelled Poker Alias, and playerDisplayName
                 resolves alias -> username. Writing only `username` (as this
                 did until 2026-09-04) left every player with an `alias` row
                 value seeing their old handle after a "successful" save. Both
                 columns now carry the handle, so the resolver, the table and
                 the header all agree. */
              const { error } = await supabase
                .from('profiles')
                .update({
                  username: data.username,
                  alias: data.username,
                  bio: data.bio,
                  player_tags: data.tags,
                })
                .eq('id', user.id);

              if (error) {
                if (error.code === '23505') {
                  throw new Error('That Poker Alias is already taken. Choose another.');
                }
                throw error;
              }

              /* Legacy mirror. `users` still exists (id, username, email,
                 avatar_url) and AuthPage upserts it on sign-up; a stale copy
                 there is a rendering bug for anything that still reads it,
                 but it is not the record of truth, so a refused write is
                 reported and does not fail the save the player was told about. */
              const { error: userError } = await supabase
                .from('users')
                .update({ username: data.username })
                .eq('id', user.id);
              if (userError) reportError(userError, 'ProfilePage.users_mirror_update_failed');

              setUser({
                ...user,
                username: data.username,
                displayName: data.username,
                bio: data.bio,
                player_tags: data.tags,
              });
              masterBus.emit('PROFILE_UPDATED', {
                userId: user.id,
                updates: { username: data.username, alias: data.username, bio: data.bio },
              });
              toast.success('Profile saved');
            } catch (err) {
              reportError(err, 'ProfilePage.Profile_update_failed');
              const message =
                err instanceof Error && err.message.includes('Poker Alias')
                  ? err.message
                  : 'Profile could not be saved. Please try again.';
              toast.error(message);
              throw new Error(message);
            }
          }}
        />
      )}
    </StandardContentLayout>
  );
}
