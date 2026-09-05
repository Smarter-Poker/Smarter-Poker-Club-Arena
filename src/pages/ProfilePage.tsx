/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — Profile Page (Player Identity Credential)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The player's own credential: who the felt calls them, what they have earned,
 * how they are running. Dedicated workspaces (/stats, /vip, /achievements,
 * /transactions, /bonuses ...) own the deep data; this page is the index.
 *
 * NO HARDCODED DATA. Every number rendered here is read from Supabase:
 *
 *   profiles                       identity, wallet flags, streak
 *   vip_points                     the VIP tier source (same as /vip)
 *   ca_player_stats_overview_v2    every poker stat, daily P/L, sessions
 *   training_user_achievements     distinctions (via achievementService)
 *   wallet_transactions            the chip ledger, newest first
 *
 * 2026-09-04 audit (#smarterCasinoRealism rebuild). What was wrong before:
 *   - ROI rendered as "+1.6500000000000001%": raw ratio x 100, never rounded.
 *   - VIP tier was derived from DIAMONDS against thresholds that exist nowhere
 *     else; /vip derives it from vip_points via constants/vipTiers. Same
 *     player, two tiers. The badge itself never rendered because
 *     profiles.tier is "Newcomer" for all 1,310 rows.
 *   - The streak multiplier was 1 + 0.1 x days (7 days = "1.7x"); the reward
 *     path pays fn_get_streak_multiplier (7 days = 1.5x).
 *   - The P/L chart was built from wallet flow (buy-ins, add-ons, diamond
 *     purchases) while the real daily P/L series sat unused in the same
 *     stats payload.
 *   - Achievement progress divided by training_achievement_definitions
 *     .threshold, which is 0 for every row - NaN bars. /achievements uses the
 *     client definitions; so does this page now.
 *   - The header printed `username` while the tables print the alias; the
 *     editor wrote `username` (unique index, generic failure) and offered six
 *     CSP-blocked avatar URLs it never saved.
 *   - The hands chip showed the 750-hand analysis window as if it were the
 *     player's lifetime count.
 */

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  Suspense,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase, getAuthUser } from '../lib/supabase';
import { LoadingState } from '../components/common/EmptyState';
import FriendListPanel from '../components/social/FriendListPanel';
import UserProfileEdit, {
  type UserProfileData,
  validateHandle,
} from '../components/social/UserProfileEdit';
import { DiamondService } from '../services/DiamondService';
import {
  achievementService,
  type Achievement as AchievementDef,
} from '../services/AchievementService';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { masterBus } from '../core/MasterBus';
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
import { resolveHeaderPortrait, resolveActiveVip } from '../stores/useHeaderDataStore';
import { getTierByPoints, getNextTier } from '../constants/vipTiers';
import { streakMultiplier, daysToNextStreakStep } from '../utils/streakMultiplier';
import {
  formatPct,
  formatSignedPct,
  formatSignedChips,
  formatChips,
  formatCount,
  formatRatio,
  formatHours,
  relativeTimeTitle,
  formatMemberSince,
  ordinal,
} from '../utils/format';
import { mediaUrl } from '../utils/mediaBase';
import {
  EMPTY_STATS,
  finiteStat,
  profileStatsFromV2,
  type PokerStats,
} from '../utils/profileStats';

// Recharts is only fetched when the Activity panel opens.
const LazyProfitChart = lazyWithRetry(() => import('../components/profile/ProfitChart'));

const PROFILE_TABS = ['stats', 'achievements', 'history', 'social'] as const;
type ProfileTab = (typeof PROFILE_TABS)[number];

const TAB_LABEL: Record<ProfileTab, string> = {
  stats: 'Snapshot',
  achievements: 'Distinctions',
  history: 'Activity',
  social: 'Network',
};

function isProfileTab(value: string | null): value is ProfileTab {
  return PROFILE_TABS.includes(value as ProfileTab);
}

const AVATAR_STUDIO_PATH = '/hub/avatars';
const PROFILE_CACHE_VERSION = 'v2';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface AchievementRow {
  id: string;
  name: string;
  description: string;
  rarity: AchievementDef['rarity'];
  category: AchievementDef['category'];
  unlockedAt?: string;
  progress: number;
  requirement: number;
}

interface LedgerRow {
  id: string;
  type: string;
  amount: number;
  created_at: string;
  description?: string | null;
  category?: string | null;
  balance_after?: number | null;
}

interface VipPointsRow {
  current: number;
  lifetime: number;
}

interface UserProfile {
  id: string;
  /** The arena handle - what the felt calls this player (alias -> username). */
  handle: string;
  username: string;
  alias: string;
  playerNumber: number;
  /** What the header orb shows: the player's own portrait preference. */
  portraitUrl: string;
  /** What the tables show: library art on arena_avatar_url. */
  arenaAvatarUrl: string;
  memberSince: string;
  bio: string;
  playerTags: string[];
}

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

const RARITY_GLYPH: Record<AchievementDef['rarity'], string> = {
  common: '◆',
  rare: '◈',
  epic: '✦',
  legendary: '★',
};

// ═══════════════════════════════════════════════════════════════════════════════
// SMALL COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

const StatPlate = ({
  value,
  label,
  tone,
  hint,
}: {
  value: string;
  label: string;
  tone?: 'up' | 'down' | null;
  hint?: string;
}) => (
  <div className={styles.statPlate} title={hint}>
    <span
      className={`${styles.statValue} ${tone === 'up' ? styles.up : tone === 'down' ? styles.down : ''}`}
    >
      {value}
    </span>
    <span className={styles.statLabel}>{label}</span>
  </div>
);

const toneOf = (n: number): 'up' | 'down' | null => (n > 0 ? 'up' : n < 0 ? 'down' : null);
const toneClass = (n: number): string => styles[toneOf(n) || ''] || '';

const AchievementCard = ({ achievement }: { achievement: AchievementRow }) => {
  const isUnlocked = !!achievement.unlockedAt;
  const requirement = achievement.requirement > 0 ? achievement.requirement : 0;
  const pct =
    requirement > 0 ? Math.min(100, Math.round((achievement.progress / requirement) * 100)) : 0;

  return (
    <div
      className={`${styles.achievementCard} ${isUnlocked ? styles.unlocked : styles.locked} ${styles[`rarity_${achievement.rarity}`] || ''}`}
    >
      <span className={styles.achievementGlyph} aria-hidden="true">
        {RARITY_GLYPH[achievement.rarity] || '◆'}
      </span>
      <div className={styles.achievementInfo}>
        <h4>{achievement.name}</h4>
        <p>{achievement.description}</p>
        {!isUnlocked && requirement > 0 && (
          <div
            className={styles.achievementProgress}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={`${achievement.name} Progress`}
          >
            <div className={styles.achievementProgressFill} style={{ width: `${pct}%` }} />
            <span>
              {formatCount(Math.min(achievement.progress, requirement))} /{' '}
              {formatCount(requirement)}
            </span>
          </div>
        )}
      </div>
      <span className={styles.achievementMeta}>
        <small>{achievement.rarity}</small>
        {isUnlocked && (
          <time dateTime={achievement.unlockedAt}>
            {new Date(achievement.unlockedAt!).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            })}
          </time>
        )}
      </span>
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
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showDiamondRain, setShowDiamondRain] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const [user, setUser] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<PokerStats>(EMPTY_STATS);
  const [statsAvailable, setStatsAvailable] = useState(false);
  const [achievements, setAchievements] = useState<AchievementRow[]>([]);
  const [diamonds, setDiamonds] = useState(0);
  const [isVIP, setIsVIP] = useState(false);
  const [vipExpiresAt, setVipExpiresAt] = useState<string | null>(null);
  const [vipPoints, setVipPoints] = useState<VipPointsRow>({ current: 0, lifetime: 0 });
  const [dailyStreak, setDailyStreak] = useState(0);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);

  useVisibilityRefresh(async () => {
    const {
      data: { user: au },
    } = await getAuthUser();
    if (!au) return;
    const { data: p, error } = await supabase
      .from('profiles')
      .select('diamonds, login_streak, is_vip, vip_expires_at')
      .eq('id', au.id)
      .maybeSingle();
    if (error) {
      reportError(error, 'ProfilePage.visibilityRefresh');
      return;
    }
    if (p) {
      setDiamonds(p.diamonds || 0);
      setDailyStreak(p.login_streak || 0);
      setIsVIP(resolveActiveVip(p.is_vip === true, p.vip_expires_at ?? null));
      setVipExpiresAt(p.vip_expires_at ?? null);
    }
  });

  // ── Tabs ─────────────────────────────────────────────────────────────────
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

  // Gauges are SVG-sized; the content scales to fit one 375px screen.
  const [gaugeSize, setGaugeSize] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 480px)').matches ? 92 : 116
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 480px)');
    const apply = () => setGaugeSize(mq.matches ? 92 : 116);
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // ── Load ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    let isMounted = true;

    const safetyTimer = setTimeout(() => {
      if (isMounted) {
        console.warn('[PROFILE] Safety timeout - forcing loading off after 12s');
        setIsLoading(false);
      }
    }, 12000);

    async function loadProfile() {
      setIsLoading(true);
      setLoadFailed(false);
      try {
        const {
          data: { user: authUser },
        } = await getAuthUser();
        if (!authUser || !isMounted) return;

        // Cached credential shows instantly; the fresh read replaces it.
        const swrKey = `profile_cache_${PROFILE_CACHE_VERSION}_${authUser.id}`;
        try {
          const cached = sessionStorage.getItem(swrKey);
          if (cached) {
            const cp = JSON.parse(cached);
            if (cp.user) setUser(cp.user);
            if (cp.diamonds != null) setDiamonds(cp.diamonds);
            if (cp.isVIP != null) setIsVIP(cp.isVIP);
            if (cp.dailyStreak != null) setDailyStreak(cp.dailyStreak);
            if (cp.vipPoints) setVipPoints(cp.vipPoints);
            setIsLoading(false);
          }
        } catch (e) {
          reportError(e, 'ProfilePage.loadProfile.cache');
        }

        // Everything that needs only the auth id starts NOW, in parallel with
        // the profile row, so the page pays one round trip rather than two.
        const secondaryDataPromise = Promise.allSettled([
          retryFetch(() => achievementService.getUserAchievements(authUser.id), {
            maxRetries: 2,
            isMountedRef,
          }),
          retryFetch(
            () =>
              supabase
                .from('wallet_transactions')
                .select('id, type, amount, created_at, description, category, balance_after')
                .eq('user_id', authUser.id)
                .order('created_at', { ascending: false })
                .limit(12)
                .then((r) => r),
            { maxRetries: 2, isMountedRef }
          ),
          retryFetch(
            () =>
              supabase
                .rpc('ca_player_stats_overview_v2', { p_user: authUser.id, p_days: null })
                .then((r) => r),
            { maxRetries: 2, isMountedRef }
          ),
          retryFetch(
            () =>
              supabase
                .from('vip_points')
                .select('current_points, lifetime_points')
                .eq('user_id', authUser.id)
                .maybeSingle()
                .then((r) => r),
            { maxRetries: 2, isMountedRef }
          ),
        ]);

        const { data: profile, error: profileError } = await retryFetch(
          () =>
            supabase
              .from('profiles')
              .select(
                `id, ${PLAYER_NAME_COLUMNS}, player_number, avatar_url, arena_avatar_url, use_avatar_as_profile_pic, created_at, diamonds, is_vip, vip_expires_at, login_streak, bio, player_tags`
              )
              .eq('id', authUser.id)
              .maybeSingle()
              .then((r) => r),
          { maxRetries: 2, isMountedRef }
        );

        if (profileError) throw profileError;

        let nextUser: UserProfile | null = null;
        if (profile && isMounted) {
          nextUser = {
            id: profile.id,
            handle: playerDisplayName(profile, 'arena'),
            username: profile.username || '',
            alias: profile.alias || '',
            playerNumber: Number(profile.player_number) || 0,
            portraitUrl:
              resolveHeaderPortrait(
                profile.avatar_url || null,
                profile.arena_avatar_url || null,
                profile.use_avatar_as_profile_pic === true
              ) || '',
            arenaAvatarUrl: profile.arena_avatar_url || '',
            memberSince: profile.created_at,
            bio: profile.bio || '',
            playerTags: Array.isArray(profile.player_tags) ? profile.player_tags : [],
          };
          setUser(nextUser);
          setDiamonds(profile.diamonds || 0);
          setIsVIP(resolveActiveVip(profile.is_vip === true, profile.vip_expires_at ?? null));
          setVipExpiresAt(profile.vip_expires_at ?? null);
          setDailyStreak(profile.login_streak || 0);
        }

        const [achievementsResult, ledgerResult, statsResult, vipResult] =
          await secondaryDataPromise;
        if (!isMounted) return;

        // Distinctions: the same definitions /achievements renders, so the two
        // surfaces can never disagree about a requirement.
        if (achievementsResult.status === 'fulfilled') {
          const rows = achievementsResult.value
            .map((ua): AchievementRow | null => {
              const def = ua.achievement ?? achievementService.getById(ua.achievementId);
              if (!def) return null;
              return {
                id: def.id,
                name: def.name,
                description: def.description,
                rarity: def.rarity,
                category: def.category,
                unlockedAt: ua.unlockedAt,
                progress: finiteStat(ua.progress),
                requirement: finiteStat(def.requirement),
              };
            })
            .filter((r): r is AchievementRow => r !== null);
          setAchievements(rows);
        } else {
          reportError(achievementsResult.reason, 'ProfilePage.achievements');
          setAchievements([]);
        }

        if (ledgerResult.status === 'fulfilled') {
          if (ledgerResult.value.error) {
            reportError(ledgerResult.value.error, 'ProfilePage.ledger');
            setLedger([]);
          } else {
            setLedger((ledgerResult.value.data as LedgerRow[]) || []);
          }
        } else {
          reportError(ledgerResult.reason, 'ProfilePage.ledger');
          setLedger([]);
        }

        const profileStats =
          statsResult.status === 'fulfilled' && !statsResult.value.error
            ? profileStatsFromV2(statsResult.value.data)
            : null;
        if (statsResult.status === 'fulfilled' && statsResult.value.error) {
          reportError(statsResult.value.error, 'ProfilePage.stats');
        }
        if (profileStats) {
          setStats(profileStats);
          setStatsAvailable(true);
        } else {
          setStats(EMPTY_STATS);
          setStatsAvailable(false);
        }

        let nextVip: VipPointsRow = { current: 0, lifetime: 0 };
        if (vipResult.status === 'fulfilled') {
          if (vipResult.value.error) {
            reportError(vipResult.value.error, 'ProfilePage.vipPoints');
          } else if (vipResult.value.data) {
            nextVip = {
              current: finiteStat(vipResult.value.data.current_points),
              lifetime: finiteStat(vipResult.value.data.lifetime_points),
            };
          }
        }
        setVipPoints(nextVip);

        if (profile && nextUser) {
          try {
            sessionStorage.setItem(
              swrKey,
              JSON.stringify({
                user: nextUser,
                diamonds: profile.diamonds || 0,
                isVIP: resolveActiveVip(profile.is_vip === true, profile.vip_expires_at ?? null),
                dailyStreak: profile.login_streak || 0,
                vipPoints: nextVip,
              })
            );
          } catch (e) {
            reportError(e, 'ProfilePage.cacheWrite');
          }

          masterBus.emit('USER_PROFILE_LOADED', {
            userId: authUser.id,
            avatarUrl: nextUser.arenaAvatarUrl,
            displayName: nextUser.handle,
          });
        }
      } catch (err: any) {
        reportError(err, 'ProfilePage.Load_failed');
        if (isMounted) {
          setLoadFailed(true);
          toast.error(err?.message || 'Failed to load profile data');
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }
    loadProfile();
    return () => {
      isMounted = false;
      clearTimeout(safetyTimer);
    };
  }, [isMountedRef, toast, reloadToken]);

  // ── Bus listeners: cross-page reactivity ─────────────────────────────────
  useEffect(() => {
    let isMounted = true;

    const invalidateProfileCache = () => {
      try {
        Object.keys(sessionStorage).forEach((k) => {
          if (k.startsWith('profile_cache_')) sessionStorage.removeItem(k);
        });
      } catch {
        /* storage unavailable */
      }
    };

    const refreshDiamonds = () => {
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

    const refreshProfileRow = (columns: string) => {
      supabase.auth
        .getUser()
        .then(({ data: { user: authUser } }) => {
          if (!authUser || !isMounted) return;
          supabase
            .from('profiles')
            .select(columns)
            .eq('id', authUser.id)
            .maybeSingle()
            .then(({ data, error }) => {
              if (error) {
                reportError(error, 'ProfilePage.busRefresh');
                return;
              }
              const row = data as any;
              if (!row || !isMounted) return;
              if ('diamonds' in row) setDiamonds(row.diamonds || 0);
              if ('login_streak' in row) setDailyStreak(row.login_streak || 0);
              if ('is_vip' in row) {
                setIsVIP(resolveActiveVip(row.is_vip === true, row.vip_expires_at ?? null));
                setVipExpiresAt(row.vip_expires_at ?? null);
              }
            });
        })
        .catch((e) => console.warn('[Profile] Refreshing profile row failed:', e));
    };

    const unsubProfile = masterBus.subscribeDebounced(
      'PROFILE_UPDATED',
      () => {
        invalidateProfileCache();
        setReloadToken((t) => t + 1);
      },
      500
    );
    const unsubHand = masterBus.subscribeDebounced(
      'HAND_COMPLETED',
      () => {
        invalidateProfileCache();
        supabase.auth
          .getUser()
          .then(({ data: { user: authUser } }) => {
            if (authUser && isMounted) {
              supabase
                .rpc('ca_player_stats_overview_v2', { p_user: authUser.id, p_days: null })
                .then(({ data, error }) => {
                  if (error) {
                    reportError(error, 'ProfilePage.handStatsRefresh');
                    return;
                  }
                  const freshStats = profileStatsFromV2(data);
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
        refreshDiamonds();
      },
      500
    );
    const unsubDiamond = masterBus.subscribeDebounced(
      'DIAMOND_BALANCE_CHANGED',
      () => {
        invalidateProfileCache();
        refreshDiamonds();
      },
      500
    );

    // Subscribers receive the event WRAPPER ({ type, payload, timestamp }),
    // never the raw payload - see the 2026-08-28 diamond-rain fix.
    const unsubDailyReward = masterBus.subscribeDebounced(
      'DAILY_REWARD_CLAIMED',
      (event: any) => {
        if (!isMounted) return;
        const payload = event?.payload ?? event;
        if (payload?.rewardType === 'diamonds') setShowDiamondRain(true);
        refreshProfileRow('diamonds, login_streak');
      },
      500
    );
    const unsubMissionClaim = masterBus.subscribeDebounced(
      'MISSION_CLAIMED',
      (event: any) => {
        if (!isMounted) return;
        const payload = event?.payload ?? event;
        if (payload?.rewardType === 'diamonds') setShowDiamondRain(true);
        refreshProfileRow('diamonds');
      },
      500
    );
    const unsubWheelSpin = masterBus.subscribeDebounced(
      'WHEEL_SPIN_RESULT',
      (event: any) => {
        if (!isMounted) return;
        // The wrapper's own `.type` is the event NAME; the segment type the
        // wheel emits lives on the payload.
        const payload = event?.payload ?? event;
        if (payload?.type === 'diamonds') setShowDiamondRain(true);
        refreshProfileRow('diamonds');
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

  // Realtime profile/wallet rows are handled GLOBALLY by PostgresSyncHooks on
  // `global_db_sync:<userId>`, which emits the bus events subscribed above.
  // No page-level channel is created here (2026-08-24).

  // ── Derived ──────────────────────────────────────────────────────────────
  const vipTier = useMemo(() => getTierByPoints(vipPoints.current), [vipPoints]);
  const vipNext = useMemo(() => getNextTier(vipTier.id), [vipTier.id]);
  const vipProgress = useMemo(() => {
    if (!vipNext) return 100;
    const span = vipNext.minPoints - vipTier.minPoints;
    if (span <= 0) return 100;
    return Math.max(0, Math.min(100, ((vipPoints.current - vipTier.minPoints) / span) * 100));
  }, [vipNext, vipTier.minPoints, vipPoints]);

  const multiplier = streakMultiplier(dailyStreak);
  const daysToNext = daysToNextStreakStep(dailyStreak);
  const lastHandLabel = relativeTimeTitle(stats.lastHandAt);
  const unlockedAchievements = useMemo(
    () =>
      achievements
        .filter((a) => a.unlockedAt)
        .sort((a, b) => new Date(b.unlockedAt!).getTime() - new Date(a.unlockedAt!).getTime()),
    [achievements]
  );

  const openAvatarStudio = useCallback(() => {
    // Same origin, same tab: the studio writes arena_avatar_url and the
    // header orb picks it up through the PROFILE_UPDATED bus event on return.
    window.location.assign(AVATAR_STUDIO_PATH);
  }, []);

  const shareProfile = useCallback(async () => {
    if (!user) return;
    const link = `${window.location.origin}/hub/club-arena/profile/${user.id}`;
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: `${user.handle} On Smarter Poker`, url: link });
        return;
      }
      await navigator.clipboard.writeText(link);
      toast.success('Profile link copied');
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      reportError(err, 'ProfilePage.share');
      toast.error('Could not copy the profile link');
    }
  }, [toast, user]);

  const saveProfile = useCallback(
    async (data: UserProfileData) => {
      if (!user) return;
      const problem = validateHandle(data.handle);
      if (problem) throw new Error(problem);

      // Handles are distinct at the tables: refuse a handle that already
      // belongs to another player's alias OR username, case-insensitively.
      const { data: clash, error: clashError } = await supabase
        .from('profiles')
        .select('id')
        .or(`alias.ilike.${data.handle},username.ilike.${data.handle}`)
        .neq('id', user.id)
        .limit(1);
      if (clashError) throw clashError;
      if (clash && clash.length > 0) {
        throw new Error('That Handle Already Belongs To Another Player');
      }

      const { error } = await supabase
        .from('profiles')
        .update({ alias: data.handle, bio: data.bio, player_tags: data.tags })
        .eq('id', user.id);
      if (error) throw error;

      setUser({
        ...user,
        alias: data.handle,
        handle: data.handle,
        bio: data.bio,
        playerTags: data.tags,
      });
      try {
        Object.keys(sessionStorage).forEach((k) => {
          if (k.startsWith('profile_cache_')) sessionStorage.removeItem(k);
        });
      } catch {
        /* storage unavailable */
      }
      masterBus.emit('PROFILE_UPDATED', {
        userId: user.id,
        updates: { alias: data.handle, bio: data.bio, player_tags: data.tags },
      });
      toast.success('Profile saved');
    },
    [toast, user]
  );

  // ── Render ───────────────────────────────────────────────────────────────
  if (isLoading) {
    return <LoadingState message="Loading profile..." />;
  }

  if (!user) {
    return (
      <StandardContentLayout className={styles.page}>
        <div className={styles.emptyProfile} role="status">
          <span className={styles.heroEyebrow}>Player Identity // Credential</span>
          <p>{loadFailed ? 'Profile Could Not Be Loaded' : 'Profile Not Found'}</p>
          <div className={styles.emptyActions}>
            <button
              type="button"
              className={styles.consoleButton}
              onClick={() => setReloadToken((t) => t + 1)}
            >
              Retry
            </button>
            <button
              type="button"
              className={styles.consoleButton}
              onClick={() => navigate('/settings')}
            >
              Open Settings
            </button>
          </div>
        </div>
      </StandardContentLayout>
    );
  }

  const portraitSrc = user.portraitUrl || user.arenaAvatarUrl || generateDefaultAvatar();
  const tierStyle = { '--tier-color': vipTier.color } as CSSProperties;

  return (
    <StandardContentLayout className={styles.page}>
      {/* ── Credential hero ─────────────────────────────────────────────── */}
      <section className={styles.credential} aria-labelledby="profile-heading" style={tierStyle}>
        <header className={styles.credentialTop}>
          <span className={styles.heroEyebrow}>Player Identity // Live Credential</span>
          <span className={styles.liveStatus} role="status">
            <span className={styles.liveDot} aria-hidden="true" />
            {lastHandLabel ? `Last Hand ${lastHandLabel}` : 'No Hands Recorded Yet'}
          </span>
        </header>

        {/* The stage: the rendered dock at its own 3:2 aspect. At 600px and
            up the portrait is set INTO the dock's medallion socket (measured
            centre 49.7% / 45.8%, diameter 18% of the width); below that the
            dock is a backdrop and the portrait stacks above the copy. */}
        <div className={styles.credentialBody}>
          <div className={styles.credentialArt} aria-hidden="true">
            <picture>
              <source
                media="(max-width: 760px)"
                srcSet={mediaUrl('images/profile/identity-dock-v1-768.webp')}
              />
              <img
                src={mediaUrl('images/profile/identity-dock-v1.webp')}
                alt=""
                width={1536}
                height={1024}
                decoding="async"
                fetchPriority="high"
              />
            </picture>
          </div>
          <div className={styles.portraitWell}>
            <div className={styles.portraitRing}>
              <img
                src={portraitSrc}
                alt={`${user.handle} Portrait`}
                className={styles.portrait}
                width={148}
                height={148}
                decoding="async"
                fetchPriority="high"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = generateDefaultAvatar();
                }}
              />
            </div>
            <span className={styles.tierPin}>{vipTier.name}</span>
          </div>

          <div className={styles.identity}>
            <h1 id="profile-heading" className={styles.handle}>
              {user.handle}
            </h1>
            <div className={styles.identityLine}>
              <span className={styles.tierPin}>{vipTier.name}</span>
              {user.playerNumber > 0 && <span>Player #{user.playerNumber}</span>}
              <span>Member Since {formatMemberSince(user.memberSince)}</span>
              {isVIP && (
                <span className={styles.vipFlag}>
                  VIP Member
                  {vipExpiresAt
                    ? ` Through ${new Date(vipExpiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                    : ''}
                </span>
              )}
            </div>
            {user.bio && <p className={styles.bio}>{user.bio}</p>}
            {user.playerTags.length > 0 && (
              <ul className={styles.tags} aria-label="Player Tags">
                {user.playerTags.map((tag) => (
                  <li key={tag}>{tag}</li>
                ))}
              </ul>
            )}
            <div className={styles.streakPlate} aria-label="Login Streak">
              <strong>{dailyStreak > 0 ? `${dailyStreak} Day Streak` : 'No Active Streak'}</strong>
              <span>{multiplier.toFixed(1)}x Rewards</span>
              {daysToNext !== null && (
                <small>
                  {daysToNext} {daysToNext === 1 ? 'Day' : 'Days'} To Next Step
                </small>
              )}
            </div>
          </div>
        </div>

        <dl className={styles.telemetry} aria-label="Player Telemetry">
          <div>
            <dt>Lifetime Hands</dt>
            <dd>{statsAvailable ? formatCount(stats.lifetimeHands) : '-'}</dd>
          </div>
          <div>
            <dt>VPIP / PFR</dt>
            <dd>
              {statsAvailable ? `${formatPct(stats.vpip, 0)} / ${formatPct(stats.pfr, 0)}` : '-'}
            </dd>
          </div>
          <div>
            <dt>Tourney ROI</dt>
            <dd className={statsAvailable ? toneClass(stats.roi) : ''}>
              {statsAvailable ? formatSignedPct(stats.roi) : '-'}
            </dd>
          </div>
          <div>
            <dt>Hours On Felt</dt>
            <dd>{statsAvailable ? formatHours(stats.hoursPlayed) : '-'}</dd>
          </div>
          <div>
            <dt>Diamonds</dt>
            <dd>{formatCount(diamonds)}</dd>
          </div>
          <div>
            <dt>VIP Points</dt>
            <dd>{formatCount(vipPoints.current)}</dd>
          </div>
        </dl>
      </section>

      {/* ── Actions console ──────────────────────────────────────────────── */}
      <nav className={styles.console} aria-label="Profile Actions">
        <button type="button" className={styles.consoleButton} onClick={openAvatarStudio}>
          Change Avatar
        </button>
        <button
          type="button"
          className={styles.consoleButton}
          onClick={() => setShowProfileEdit(true)}
        >
          Edit Profile
        </button>
        <button type="button" className={styles.consoleButton} onClick={shareProfile}>
          Share Profile
        </button>
        <button
          type="button"
          className={`${styles.consoleButton} ${styles.consolePrimary}`}
          onClick={() => navigate('/cashier')}
        >
          Cashier
        </button>
      </nav>

      {/* ── VIP plate: the SAME tier source as /vip ──────────────────────── */}
      <section className={styles.vipPlate} aria-labelledby="vip-heading" style={tierStyle}>
        <div className={styles.vipBadge}>
          <span className={styles.vipGlyph} aria-hidden="true">
            {vipTier.icon}
          </span>
          <div>
            <h2 id="vip-heading">{vipTier.name} Tier</h2>
            <p>
              {formatCount(vipPoints.current)} VIP Points
              {vipPoints.lifetime > vipPoints.current
                ? ` // ${formatCount(vipPoints.lifetime)} Lifetime`
                : ''}
            </p>
          </div>
        </div>
        <div className={styles.vipTrack}>
          <div
            className={styles.vipBar}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(vipProgress)}
            aria-label={vipNext ? `Progress To ${vipNext.name}` : 'Top Tier Reached'}
          >
            <span style={{ width: `${vipProgress}%` }} />
          </div>
          <p>
            {vipNext
              ? `${formatCount(vipNext.minPoints - vipPoints.current)} Points To ${vipNext.name}`
              : 'Top Tier Reached'}
          </p>
        </div>
        <ul className={styles.vipPerks} aria-label="Tier Privileges">
          <li>
            <strong>{vipTier.rakeback}%</strong>
            <span>Rakeback</span>
          </li>
          <li>
            <strong>{vipTier.multiplier}x</strong>
            <span>Points Rate</span>
          </li>
          <li>
            <strong>{vipTier.tournyTickets}</strong>
            <span>Tourney Tickets</span>
          </li>
          <li>
            <strong>{vipTier.priority ? 'Yes' : 'No'}</strong>
            <span>Priority Seating</span>
          </li>
        </ul>
        <button type="button" className={styles.textAction} onClick={() => navigate('/vip')}>
          Open VIP Lounge <span aria-hidden="true">→</span>
        </button>
      </section>

      {/* Dedicated workspaces own reward claims, deep analytics, promotions
          and ranking. Profile is their identity index. */}
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

      {unlockedAchievements.length > 0 && (
        <section className={styles.contentSection} aria-labelledby="distinctions-heading">
          <div className={styles.sectionHeading}>
            <h3 id="distinctions-heading">Recent Distinctions</h3>
            <button
              type="button"
              onClick={() => selectTab('achievements')}
              className={styles.textAction}
            >
              Inspect All
            </button>
          </div>
          <div className={styles.achievementStrip}>
            {unlockedAchievements.slice(0, 5).map((a) => (
              <div
                key={a.id}
                className={`${styles.achievementChip} ${styles[`rarity_${a.rarity}`] || ''}`}
              >
                <span aria-hidden="true">{RARITY_GLYPH[a.rarity] || '◆'}</span>
                <span>{a.name}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
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
            {TAB_LABEL[tab]}
          </button>
        ))}
      </nav>

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
                  <div className={styles.groupHeading}>
                    <h3>Core Read</h3>
                    <small>
                      {stats.analysisCapped
                        ? `Last ${formatCount(stats.totalHands)} Hands`
                        : `${formatCount(stats.totalHands)} Hands`}
                    </small>
                  </div>
                  <div className={styles.gaugeRow}>
                    <div className={styles.gauge}>
                      <CircularGauge
                        value={stats.vpip}
                        label="VPIP"
                        sublabel="Volun. Put In Pot"
                        accent="#00d4ff"
                        size={gaugeSize}
                      />
                    </div>
                    <div className={styles.gauge}>
                      <CircularGauge
                        value={stats.pfr}
                        label="PFR"
                        sublabel="Pre-Flop Raise"
                        accent="#ffc93c"
                        size={gaugeSize}
                      />
                    </div>
                    <div className={styles.gauge}>
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
                    <StatPlate value={formatPct(stats.threeBet)} label="3-Bet" />
                    <StatPlate value={formatRatio(stats.aggression)} label="Aggression" />
                    <StatPlate value={formatPct(stats.wtsd)} label="WTSD" hint="Went To Showdown" />
                    <StatPlate
                      value={formatPct(stats.showdownWinRate)}
                      label="Won At SD"
                      hint="Showdowns Won"
                    />
                  </div>
                </div>

                <div className={styles.statsGroup}>
                  <div className={styles.groupHeading}>
                    <h3>Cash</h3>
                    <small>{formatCount(stats.cashHands)} Hands</small>
                  </div>
                  <div className={styles.statsGrid}>
                    <StatPlate
                      value={formatSignedChips(stats.totalProfit)}
                      label="Net Result"
                      tone={toneOf(stats.totalProfit)}
                    />
                    <StatPlate
                      value={formatRatio(stats.bbPer100)}
                      label="BB/100"
                      tone={toneOf(stats.bbPer100)}
                    />
                    <StatPlate value={formatChips(stats.biggestPot)} label="Biggest Pot" />
                    <StatPlate
                      value={formatSignedChips(stats.biggestLoss)}
                      label="Worst Hand"
                      tone={toneOf(stats.biggestLoss)}
                    />
                  </div>
                </div>

                <div className={styles.statsGroup}>
                  <div className={styles.groupHeading}>
                    <h3>Tournaments</h3>
                    <small>{formatCount(stats.tourneyHands)} Hands</small>
                  </div>
                  <div className={styles.statsGrid}>
                    <StatPlate value={formatCount(stats.tournamentsPlayed)} label="Entries" />
                    <StatPlate value={formatCount(stats.tournamentsWon)} label="Wins" />
                    <StatPlate value={formatPct(stats.itmPercent)} label="ITM" />
                    <StatPlate value={ordinal(stats.bestFinish)} label="Best Finish" />
                    <StatPlate
                      value={formatSignedChips(stats.tournamentNet)}
                      label="Net Result"
                      tone={toneOf(stats.tournamentNet)}
                    />
                    <StatPlate
                      value={formatSignedPct(stats.roi)}
                      label="ROI"
                      tone={toneOf(stats.roi)}
                    />
                    <StatPlate value={formatCount(stats.bountyKOs)} label="Bounty KOs" />
                    <StatPlate value={formatCount(stats.tournamentCashes)} label="Cashes" />
                  </div>
                </div>

                {stats.variants.length > 0 && (
                  <div className={styles.statsGroup}>
                    <div className={styles.groupHeading}>
                      <h3>By Variant</h3>
                    </div>
                    <ul className={styles.variantList}>
                      {[...stats.variants]
                        .sort((a, b) => b.hands - a.hands)
                        .slice(0, 5)
                        .map((v) => (
                          <li key={v.variant}>
                            <span>{variantLabel(v.variant)}</span>
                            <span>{formatCount(v.hands)} Hands</span>
                            <span className={toneClass(v.profit)}>
                              {formatSignedChips(v.profit)}
                            </span>
                            <span className={toneClass(v.bb100)}>
                              {formatRatio(v.bb100)} BB/100
                            </span>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <div className={styles.statsGroup} role="status">
                <h3>Stats Snapshot Unavailable</h3>
                <p className={styles.muted}>
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
                  {[...achievements]
                    .sort((a, b) => {
                      if (!!a.unlockedAt !== !!b.unlockedAt) return a.unlockedAt ? -1 : 1;
                      if (a.unlockedAt && b.unlockedAt) {
                        return new Date(b.unlockedAt).getTime() - new Date(a.unlockedAt).getTime();
                      }
                      const pa = a.requirement > 0 ? a.progress / a.requirement : 0;
                      const pb = b.requirement > 0 ? b.progress / b.requirement : 0;
                      return pb - pa;
                    })
                    .map((achievement) => (
                      <AchievementCard key={achievement.id} achievement={achievement} />
                    ))}
                </div>
              </>
            ) : (
              <div className={styles.emptyPanel}>
                <p>No Distinctions Yet. Every Hand You Play Counts Toward The First One.</p>
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
                  {stats.sessions.slice(0, 5).map((s) => (
                    <li key={s.id}>
                      <div>
                        <strong>
                          {new Date(s.date).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </strong>
                        <small>
                          {formatCount(s.hands)} Hands // {formatCount(s.minutes)} Min // In{' '}
                          {formatChips(s.buyIn)} Out {formatChips(s.cashOut)}
                        </small>
                      </div>
                      <span className={toneClass(s.profit)}>{formatSignedChips(s.profit)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className={styles.statsGroup}>
              <div className={styles.groupHeading}>
                <h3>Chip Ledger</h3>
                <small>Newest First</small>
              </div>
              {ledger.length > 0 ? (
                <ul className={styles.transactionList}>
                  {ledger.slice(0, 10).map((tx) => (
                    <li key={tx.id} className={styles.transactionRow}>
                      <div>
                        <span>{formatPopupText(tx.description || tx.category || tx.type)}</span>
                        <small>
                          {new Date(tx.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </small>
                      </div>
                      <span className={tx.type === 'credit' ? styles.up : styles.down}>
                        {tx.type === 'credit' ? '+' : '-'}
                        {formatChips(Math.abs(Number(tx.amount) || 0))}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className={styles.emptyPanel}>
                  <p>No Chip Movements Yet.</p>
                </div>
              )}
              <button
                type="button"
                className={styles.workspaceCta}
                onClick={() => navigate('/transactions')}
              >
                Open Complete Transaction History <span aria-hidden="true">→</span>
              </button>
            </div>
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

      <DiamondRainEffect active={showDiamondRain} onComplete={() => setShowDiamondRain(false)} />

      {showProfileEdit && user && (
        <UserProfileEdit
          isOpen={showProfileEdit}
          onClose={() => setShowProfileEdit(false)}
          onChangeAvatar={openAvatarStudio}
          initialData={{
            id: user.id,
            handle: user.alias || user.username || user.handle,
            avatarUrl: user.arenaAvatarUrl,
            bio: user.bio,
            tags: user.playerTags,
          }}
          onSave={async (data: UserProfileData) => {
            try {
              await saveProfile(data);
            } catch (err) {
              reportError(err, 'ProfilePage.Profile_update_failed');
              throw err instanceof Error ? err : new Error('Profile could not be saved.');
            }
          }}
        />
      )}
    </StandardContentLayout>
  );
}
