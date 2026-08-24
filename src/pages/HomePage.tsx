/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLUB ARENA — Home Page (World Hub Cinematic Design)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Phase 4: 16 Advanced Enhancements
 * - Architecture: Extracted DailyChallenges, ClubContextMenu, lobbyTiles config
 * - Core UX: Keyboard shortcuts, pin favorites, leave confirmation, timestamps
 * - Polish: Card entrance, prefetch, search, haptic, sound, seasonal, tooltip
 * - Accessibility: ARIA, focus traps, keyboard nav, offline indicator
 */

import { MEDIA_BASE } from '../utils/mediaBase';
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  Suspense,
  Component,
  useMemo,
  type ReactNode,
  type ErrorInfo,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { SHARK_CLUB_ID } from '../lib/constants';
import { supabase, getAuthUser } from '../lib/supabase';
import { ClubsService } from '../services/ClubsService';
import { backfillClubCards } from '../services/ClubCardBackfill';
import { useToast } from '../components/common/Toast';
import GlobalHeader from '../components/navigation/GlobalHeader';
import FloatingOrbs from '../components/home/FloatingOrbs';
import haptic from '../services/HapticService';

import PremiumSFX from '../services/PremiumSFX';
import { masterBus } from '../core/MasterBus';
import { useMasterBusSubscription } from '../hooks/useMasterBusSubscription';

import ClubContextMenu from '../components/home/ClubContextMenu';
import ClubQuickLinkTile from '../components/home/ClubQuickLinkTile';
import LOBBY_TILES from '../config/lobbyTiles.config';
import { preloadRoute } from '../utils/ChunkPreloader';
import {
  eligibleQuickLinkClubs,
  resolveTargetClub,
  readLastClubId,
  rememberLastClub,
  primeUnionFlags,
} from '../utils/clubQuickLink';
import CarouselSection from '../components/home/CarouselSection';
import { getClubLevelFromMembers } from '../utils/clubLevels';
import { sanitizeInput } from '../utils/sanitizeInput';
import type { UserClub, ClubStats } from '../components/home/CarouselSection';
import { useFocusTrap } from '../hooks/useFocusTrap';

import { STORAGE_KEYS } from '../lib/storage';
import styles from './HomePage.module.css';
import { reportError } from '../utils/errorReporter';
import { lazyWithRetry } from '../utils/lazyWithRetry';

// Lazy-load heavy components to reduce initial bundle
const CreateClubModal = lazyWithRetry(() => import('../components/modals/CreateClubModal'));
const FindPlayerModal = lazyWithRetry(() => import('../components/modals/FindPlayerModal'));

const SWR_CACHE_TTL = 60 * 60 * 1000; // 1 hour — skip stale cache from old sessions

// Typed shape for the user preferences JSON column
interface UserPreferences {
  card_color_preset?: string;
  [key: string]: unknown;
}

// Action button images
const ACTION_BAR_HORIZONTAL = `${MEDIA_BASE}images/icons/action-bar-horizontal.webp`;

// #12: Seasonal theme detection
function getSeasonalTheme(): string {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  if (month === 12 && day >= 15) return 'christmas';
  if (month === 1 && day <= 7) return 'newyear';
  if (month === 6 || month === 7) return 'wsop'; // WSOP season
  if (month === 10 && day >= 25) return 'halloween';
  return 'default';
}

// #12: Seasonal gradient overrides
const SEASONAL_GRADIENTS: Record<string, string> = {
  christmas: 'linear-gradient(180deg, #0a1218 0%, #0d1a0d 50%, #0a1218 100%)',
  newyear: 'linear-gradient(180deg, #0a0a12 0%, #1a0a1a 50%, #0a0a12 100%)',
  wsop: 'linear-gradient(180deg, #0a0a12 0%, #1a1205 50%, #0a0a12 100%)',
  halloween: 'linear-gradient(180deg, #0a0a12 0%, #1a0f05 50%, #0a0a12 100%)',
  default: '',
};

// ═══════════════════════════════════════════════════════════════════════════════
// Enhancement #10: Error Boundary Wrapper
// ═══════════════════════════════════════════════════════════════════════════════
interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

class HomePageErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, errorMessage: '' };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, errorMessage: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(info, 'HomePage.HomePage_ErrorBoundary');
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className={styles.errorBoundary}>
          <div className={styles.errorBoundaryIcon}>!</div>
          <h2 className={styles.errorBoundaryTitle}>Something Went Wrong</h2>
          <p className={styles.errorBoundaryMessage}>
            {this.state.errorMessage || 'An unexpected error occurred. Please try again.'}
          </p>
          <button
            className={styles.errorBoundaryRetry}
            onClick={() => this.setState({ hasError: false, errorMessage: '' })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function HomePageInner() {
  useEffect(() => {
    document.title = 'Home | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const toast = useToast();

  // Component-level mount guard — prevents setState after unmount in user-triggered handlers
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  /** True when the membership fetch threw. Distinguishes "you have no clubs"
   *  from "we could not find out", which the lobby previously conflated. */
  const [loadFailed, setLoadFailed] = useState(false);

  // Real data states — start as NOT loading if SWR cache provides clubs
  const [userClubs, setUserClubs] = useState<UserClub[]>(() => {
    // SWR — instant render from cache
    try {
      const cached = localStorage.getItem(STORAGE_KEYS.CLUBS_CACHE);
      const cacheTs = localStorage.getItem(STORAGE_KEYS.CLUBS_CACHE_TS);
      const isFresh = cacheTs && Date.now() - Number(cacheTs) < SWR_CACHE_TTL;
      if (cached && isFresh) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          if (
            parsed.some(
              (c: any) => c.slug === undefined && c.id !== 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
            )
          )
            return [];
          return parsed;
        }
      }
    } catch {
      /* ignore corrupt cache */
    }
    return [];
  });
  const [isLoading, setIsLoading] = useState(() => {
    // If SWR cache already gave us clubs, skip loading state entirely
    try {
      const cached = localStorage.getItem(STORAGE_KEYS.CLUBS_CACHE);
      const cacheTs = localStorage.getItem(STORAGE_KEYS.CLUBS_CACHE_TS);
      const isFresh = cacheTs && Date.now() - Number(cacheTs) < SWR_CACHE_TTL;
      if (cached && isFresh) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          if (
            parsed.some(
              (c: any) => c.slug === undefined && c.id !== 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
            )
          )
            return true;
          return false;
        }
      }
    } catch {
      /* */
    }
    return true;
  });

  // Per-club stats for featured card rendering
  const [clubStats, setClubStats] = useState<Record<string, ClubStats>>(() => {
    try {
      const cached = localStorage.getItem(STORAGE_KEYS.CLUB_STATS_CACHE);
      const cacheTs = localStorage.getItem(STORAGE_KEYS.CLUB_STATS_CACHE_TS);
      const isFresh = cacheTs && Date.now() - Number(cacheTs) < SWR_CACHE_TTL;
      if (cached && isFresh) {
        return JSON.parse(cached);
      }
    } catch {
      /* ignore corrupt cache */
    }
    return {};
  });
  // Guard: prevent welcome toast from firing before first server fetch completes
  const hasFetchedOnceRef = useRef(false);

  // Enhancement #2: Context menu state
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    club: UserClub;
  } | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // #1: Keyboard shortcuts active flag
  const [showShortcutHint, setShowShortcutHint] = useState(false);

  // #2: Pinned clubs (persisted in localStorage)
  const [pinnedClubIds, setPinnedClubIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEYS.PINNED_CLUBS) || '[]');
    } catch {
      return [];
    }
  });

  // #4: Leave confirmation modal
  const [leaveConfirm, setLeaveConfirm] = useState<{ visible: boolean; club: UserClub } | null>(
    null
  );

  // Club quick links (Cashier/Marketplace tiles) — target club selection
  const [quickLinkClubId, setQuickLinkClubId] = useState<string | null>(() => readLastClubId());

  // #12: Seasonal theme
  const seasonalTheme = useMemo(() => getSeasonalTheme(), []);

  // #15: Online status
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  // JOIN A CLUB modal state
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showCreateClubModal, setShowCreateClubModal] = useState(false);
  const [clubCode, setClubCode] = useState('');
  const [isValidatingCode, setIsValidatingCode] = useState(false);
  const [showReferralPrompt, setShowReferralPrompt] = useState(false);
  const [validClubId, setValidClubId] = useState<string | null>(null);
  const [validClubName, setValidClubName] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [referralCode, setReferralCode] = useState('');
  const joinInputRef = useRef<HTMLInputElement>(null);

  // Focus trapping for modals (accessibility)
  const leaveModalRef = useFocusTrap(!!leaveConfirm?.visible);
  const joinModalRef = useFocusTrap(showJoinModal);

  // Find Player modal state
  const [showFindPlayerModal, setShowFindPlayerModal] = useState(false);

  // NOTE (2026-08-19): dedicated Shark Club stats state/machinery REMOVED.
  // The featured shark card is gone — the Shark Club renders as a normal
  // carousel card and its stats flow through the same per-club batch fetch
  // (fetchAllClubStats) as every other club. The old dedicated pipeline kept
  // a 20-second poll + realtime channel running with no consumer.

  // #15: Online/Offline detection
  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // #6: Listen for card color changes from hamburger menu — sync to localStorage only
  useMasterBusSubscription(
    'CARD_COLOR_CHANGED',
    (payload: any) => {
      const preset = payload?.preset as string;
      if (preset) {
        try {
          localStorage.setItem(STORAGE_KEYS.CARD_COLOR, preset);
        } catch {
          /* quota */
        }
      }
    },
    { debounce: 300 }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // DATA FETCHING (with SWR cache)
  // ═══════════════════════════════════════════════════════════════════════════════

  const fetchUserData = useCallback(
    async (skipLoading = false, getIsMounted?: () => boolean) => {
      if (!skipLoading) setIsLoading(true);

      // Safety timeout: never show loading spinner for more than 6 seconds.
      // Was 12 — on a saturated database that is 12 seconds of dimmed screen;
      // the SWR cache + retry UI handle the rest.
      const loadingTimeout = setTimeout(() => {
        if (!getIsMounted || getIsMounted()) setIsLoading(false);
      }, 6_000);

      try {
        if (getIsMounted && !getIsMounted()) {
          clearTimeout(loadingTimeout);
          return;
        }

        const {
          data: { user: authUser },
        } = await getAuthUser();
        if (authUser) {
          // PERF 2026-08-23: the card-colour preference needs only
          // authUser.id, and was sitting behind the membership fetch for no
          // reason but code order. Started here, awaited unchanged below, so
          // the two round trips overlap. The rejection handler keeps a
          // pre-await failure from surfacing as an unhandled rejection.
          const colorPrefPromise = supabase
            .from('profiles')
            .select('preferences')
            .eq('id', authUser.id)
            .maybeSingle()
            .then(
              (r) => r,
              (error) => ({ data: null, error })
            );

          const memberships = await ClubsService.getUserMemberships(authUser);
          const clubs =
            memberships?.map(
              (m) =>
                ({
                  ...m.club,
                  is_owner: m.role === 'owner',
                  member_count: m.club?.member_count || 0,
                  // Detect union entities via union_id FK + name heuristic.
                  // A club row with union_id set AND "union" in the name is the union's
                  // display stub. Regular member clubs also have union_id but don't
                  // have "union" in their name.
                  entity_type:
                    (m.club as any)?.union_id && /union/i.test(m.club?.name || '')
                      ? 'union'
                      : 'club',
                }) as UserClub
            ) || [];
          // UNION LAW (2026-08-19, Dan): the union house-club card (club.id ===
          // club.union_id) is only shown to its owner. Players enter through
          // their own club; union games appear inside the club lobby.
          const lawFilteredClubs = clubs.filter((c) => {
            const uid = (c as any).union_id as string | undefined;
            const isUnionHouseClub = c.entity_type === 'union' || (!!uid && c.id === uid);
            return !isUnionHouseClub || (c as any).is_owner;
          });
          if (getIsMounted && !getIsMounted()) return;
          setLoadFailed(false);
          setUserClubs(lawFilteredClubs);
          // Enhancement #9: Update SWR cache (stats re-fetch keys off
          // displayClubIdsKey — no manual refresh counter needed)
          try {
            localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, JSON.stringify(lawFilteredClubs));
            localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE_TS, String(Date.now()));
          } catch {
            /* quota */
          }
          /**
           * UNION LAW (2026-08-24). These rows came straight from `clubs` with
           * an authoritative `is_union`, so hand them to the union-flag memo
           * while we have them. Two reasons, and the second is the real one:
           *
           *  - it saves a `clubs.is_union` round trip per candidate the first
           *    time UnionSkinGuard or resolveLobbyClubId asks about a club;
           *  - it seeds that memo from the NETWORK rather than from
           *    localStorage. A legacy cache row carries no union signal at
           *    all, which is what let a stale cache hand back the union hub as
           *    a lobby destination (see cachedUnionFlag). Priming here means
           *    the fresh answer is already in memory before any stale row can
           *    be consulted.
           *
           * Deliberately AFTER the write above: if setItem throws on quota the
           * priming is still valid, and the flags are the half that matters.
           */
          primeUnionFlags(lawFilteredClubs);

          // ── Batch: card color sync ──
          const [colorResult] = await Promise.allSettled([colorPrefPromise]);

          if (getIsMounted && !getIsMounted()) return;

          // Process card color sync — persist to localStorage for other components
          if (
            colorResult.status === 'fulfilled' &&
            (colorResult.value.data?.preferences as UserPreferences | null)?.card_color_preset
          ) {
            const preset = (colorResult.value.data?.preferences as UserPreferences)
              .card_color_preset!;
            if (preset !== localStorage.getItem(STORAGE_KEYS.CARD_COLOR)) {
              try {
                localStorage.setItem(STORAGE_KEYS.CARD_COLOR, preset);
              } catch {
                /* quota */
              }
            }
          }
        } else {
          if (getIsMounted && !getIsMounted()) return;
          setUserClubs([]);
          try {
            localStorage.removeItem(STORAGE_KEYS.CLUBS_CACHE);
            localStorage.removeItem(STORAGE_KEYS.CLUBS_CACHE_TS);
          } catch {
            /* */
          }
        }
      } catch (err) {
        // 2026-08-21: this used to only toast. userClubs stayed at its initial
        // [], displayClubs then INJECTED the hardcoded Shark Club, and the
        // lobby rendered a confident one-club carousel - so a database outage
        // was indistinguishable from "you have been removed from your clubs".
        // That is exactly what happened when Postgres briefly refused
        // connections (57P03) and Midway Union and Club JAQK vanished.
        //
        // Record the failure so the carousel can say "could not load" instead
        // of quietly inventing a club list.
        if (!getIsMounted || getIsMounted()) setLoadFailed(true);
        reportError(err, 'HomePage.Error_fetching_user_data');
        toast.error('Could Not Load Your Clubs');
      } finally {
        clearTimeout(loadingTimeout);
        if (!getIsMounted || getIsMounted()) {
          setIsLoading(false);
          hasFetchedOnceRef.current = true;
        }
      }
    },
    [toast]
  );

  // Real-time updates handled by Supabase subscriptions + bus listeners below
  // No visibility refresh needed — data stays live via real-time channels

  useEffect(() => {
    let isMounted = true;
    // Fix 2: If SWR cache already gave us clubs, skip loading state (background refresh)
    const hasCachedClubs = userClubs.length > 0;
    fetchUserData(hasCachedClubs, () => isMounted);

    let channel: ReturnType<typeof masterBus.getOrCreateChannel> | null = null;
    let cachedAuthUserId: string | null = null; // Cache for cleanup — avoids async getAuthUser() in teardown
    const setupRealtimeSubscription = async () => {
      const {
        data: { user: authUser },
      } = await getAuthUser();
      if (!authUser?.id) return;
      cachedAuthUserId = authUser.id; // Cache for cleanup

      const channelKey = `home-clubs-${authUser.id}`;
      channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'club_members',
            filter: `user_id=eq.${authUser.id}`,
          },
          () => {
            if (isMounted) fetchUserData(true, () => isMounted);
          }
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'HomePage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[HomePage] Realtime channel timed out');
          }
        });
    };

    setupRealtimeSubscription();

    // ═══════════════════════════════════════════════════════════════════════
    // MASTER BUS LISTENERS — cross-page state sync
    // ═══════════════════════════════════════════════════════════════════════

    return () => {
      isMounted = false;
      if (channel) {
        channel.unsubscribe();
      }
      // Use cached userId from setup — avoids async getAuthUser() call in cleanup
      // which was fire-and-forget and could leak channels if auth state changed
      if (cachedAuthUserId) {
        masterBus.removeRegisteredChannel(`home-clubs-${cachedAuthUserId}`);
      }
    };
  }, [fetchUserData]);

  useMasterBusSubscription(
    'CLUB_JOINED',
    () => {
      fetchUserData(true);
    },
    { debounce: 500 }
  );

  useMasterBusSubscription(
    'CLUB_LEFT',
    () => {
      fetchUserData(true);
    },
    { debounce: 500 }
  );

  useMasterBusSubscription(
    'CLUB_UPDATED',
    () => {
      fetchUserData(true);
    },
    { debounce: 500 }
  );

  // AUTH_STATE_CHANGED: kept as immediate (auth state must propagate instantly)
  useMasterBusSubscription(
    'AUTH_STATE_CHANGED',
    (payload: any) => {
      if (payload.isAuthenticated) {
        fetchUserData(false);
      } else {
        setUserClubs([]);
        // Clear SWR cache to prevent stale club data leaking across logins
        try {
          localStorage.removeItem(STORAGE_KEYS.CLUBS_CACHE);
          localStorage.removeItem(STORAGE_KEYS.CLUBS_CACHE_TS);
        } catch {
          /* */
        }
      }
    },
    { debounce: 300 }
  );

  // Welcome toast for new users — auto-dismiss, once per device
  // Guard: only fires AFTER first fetch completes (prevents false-fire on cache miss)
  useEffect(() => {
    if (isLoading || !hasFetchedOnceRef.current || userClubs.length > 0) return;
    const key = 'club_arena_welcome_shown';
    if (localStorage.getItem(key)) return;
    try {
      localStorage.setItem(key, '1');
    } catch {
      /* quota */
    }
    toast.info('Welcome to Club Arena - Create or join a club to get started!');
  }, [isLoading, userClubs.length, toast]);

  // Enhancement #6: Real-time stats refresh for ALL club cards
  // NOTE (2026-04-19): Unfiltered `club_members` + `table_seats` global listeners REMOVED.
  // These generated massive message volume. Club card stats now refresh via MasterBus events
  // (CLUB_JOINED, CLUB_LEFT, CLUB_UPDATED) already subscribed above.

  // ═══════════════════════════════════════════════════════════════════════════════
  // Enhancement #2: Context Menu handlers
  // ═══════════════════════════════════════════════════════════════════════════════
  const handleContextMenu = useCallback((e: React.MouseEvent, club: UserClub) => {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, club });
  }, []);

  const handleLongPressStart = useCallback((club: UserClub, e: React.TouchEvent) => {
    e.stopPropagation();
    longPressTimer.current = setTimeout(() => {
      haptic.medium();
      const touch = e.touches[0];
      setContextMenu({ visible: true, x: touch.clientX, y: touch.clientY, club });
    }, 500);
  }, []);

  const handleLongPressEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Cleanup longPressTimer on unmount to prevent stale state updates
  useEffect(() => {
    return () => {
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current);
      }
    };
  }, []);

  // #1: Keyboard shortcut navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger when typing in inputs or when modals are open
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (showJoinModal || showCreateClubModal || showFindPlayerModal || leaveConfirm?.visible) {
        // Only allow Escape when a modal is open
        if (e.key === 'Escape') {
          setContextMenu(null);
          setShowJoinModal(false);
          setShowCreateClubModal(false);
          setShowFindPlayerModal(false);
          setLeaveConfirm(null);
          setShowShortcutHint(false);
        }
        return;
      }
      const key = e.key.toLowerCase();
      switch (key) {
        case '1':
          haptic.light();
          navigate('/challenges'); // Daily Challenges
          break;
        case '2':
          haptic.light();
          navigate('/stats'); // Player Stats
          break;
        case '3':
          haptic.light();
          navigate('/leaderboard'); // Leaderboards
          break;
        case '4': {
          haptic.light();
          PremiumSFX.navigate();
          const target = resolveTargetClub(userClubs);
          if (target) navigate(`/clubs/${target.slug || target.id}/cashier`);
          else toast.info('Join a club first to access the cashier');
          break;
        }
        case '5': {
          haptic.light();
          PremiumSFX.navigate();
          const target = resolveTargetClub(userClubs);
          navigate(target ? `/marketplace?club=${target.id}` : '/marketplace');
          break;
        }
        case 'j':
          setShowJoinModal(true);
          break;
        case 'c':
          setShowCreateClubModal(true);
          break;
        case 'f':
          setShowFindPlayerModal(true);
          break;

        case '?':
          setShowShortcutHint((prev) => !prev);
          break;
        case 'escape':
          setContextMenu(null);
          setShowJoinModal(false);
          setShowCreateClubModal(false);
          setShowFindPlayerModal(false);
          setLeaveConfirm(null);
          setShowShortcutHint(false);
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    navigate,
    userClubs,
    showJoinModal,
    showCreateClubModal,
    showFindPlayerModal,
    leaveConfirm?.visible,
  ]);

  // #2: Pin/unpin club
  const togglePinClub = useCallback((clubId: string) => {
    setPinnedClubIds((prev) => {
      const next = prev.includes(clubId) ? prev.filter((id) => id !== clubId) : [...prev, clubId];
      try {
        localStorage.setItem(STORAGE_KEYS.PINNED_CLUBS, JSON.stringify(next));
      } catch {
        /* */
      }
      return next;
    });
  }, []);

  // #4: Leave club with confirmation
  const handleLeaveClub = useCallback(
    async (club: UserClub) => {
      // #2: Optimistic UI — immediately remove from list
      const previousClubs = [...userClubs];
      setUserClubs((prev) => prev.filter((c) => c.id !== club.id));
      try {
        await ClubsService.leave(club.id);
        if (!isMountedRef.current) return;
        toast.success('Left the club');
        // NOTE: ClubsService.leaveClub() already emits CLUB_LEFT + CLUB_UPDATED via bus
        // Background refresh to reconcile server state
        fetchUserData(true, () => isMountedRef.current);
        setLeaveConfirm(null);
      } catch (err: any) {
        if (!isMountedRef.current) return;
        // Rollback optimistic update
        setUserClubs(previousClubs);
        toast.error(err.message || 'Failed to leave club');
      }
    },
    [toast, fetchUserData, userClubs]
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // JOIN A CLUB LOGIC
  // ═══════════════════════════════════════════════════════════════════════════════
  const handleJoinClubSubmit = async () => {
    if (!clubCode.trim()) {
      toast.error('Please enter a club code');
      return;
    }

    // Sanitize input for defense-in-depth, then validate the numeric code.
    // Canonical codes are 5-digit, but 6-digit codes exist from a legacy
    // generation bug — accept both so those clubs remain joinable.
    const sanitized = sanitizeInput(clubCode.trim());
    const numericCode = parseInt(sanitized, 10);
    if (isNaN(numericCode) || numericCode < 10000 || numericCode > 999999) {
      toast.error('Club code must be a 5-digit number');
      return;
    }

    setIsValidatingCode(true);
    try {
      // Validate club code exists by club_id (5-digit integer)
      const { data: club, error } = await supabase
        .from('clubs')
        .select('id, name, club_id')
        .eq('club_id', numericCode)
        .maybeSingle();

      if (!isMountedRef.current) return;

      if (error || !club) {
        toast.error('Invalid club code. Please check and try again.');
        setIsValidatingCode(false);
        return;
      }

      // Check if user is already a member of this club
      const {
        data: { user: currentUser },
      } = await getAuthUser();
      if (currentUser) {
        const { data: existingMembership } = await supabase
          .from('club_members')
          .select('user_id, status')
          .eq('club_id', club.id)
          .eq('user_id', currentUser.id)
          .maybeSingle();
        if (existingMembership) {
          if (existingMembership.status === 'pending') {
            toast.info('Your join request for this club is still pending approval.');
          } else {
            toast.info('You are already a member of this club!');
          }
          setIsValidatingCode(false);
          return;
        }

        // Pre-check the 4-club limit for faster, friendlier feedback than the RPC error
        const { canJoin } = await ClubsService.canJoinMoreClubs();
        if (!canJoin) {
          toast.error('You can only be a member of up to 4 clubs. Leave a club to join a new one.');
          setIsValidatingCode(false);
          return;
        }
      }

      // Valid club found - show referral prompt
      setValidClubId(club.id);
      setValidClubName(club.name || null);
      setShowReferralPrompt(true);
    } catch (err) {
      if (!isMountedRef.current) return;
      reportError(err, 'HomePage.Error_validating_club_code');
      toast.error('Failed to validate club code');
    } finally {
      if (isMountedRef.current) setIsValidatingCode(false);
    }
  };

  const handleJoinClub = async (withReferral = false) => {
    if (!validClubId || isJoining) return;

    setIsJoining(true);
    try {
      if (withReferral && referralCode) {
        localStorage.setItem(`referral_${validClubId}`, referralCode);
      }
      const membership = await ClubsService.join(validClubId);
      if (!isMountedRef.current) return;

      if (membership?.status === 'pending') {
        // Approval-required club — request queued, NOT yet a member.
        // No optimistic club card; it would vanish on the next refresh.
        toast.info(
          `Join request sent to ${validClubName || 'the club'} - you'll be added once an admin approves.`
        );
      } else {
        // #2: Optimistic UI — add placeholder club immediately
        const optimisticClub: UserClub = {
          id: validClubId,
          club_id: 0,
          name: validClubName || 'Loading...',
          avatar_url: null,
          member_count: 1,
          is_owner: false,
        } as UserClub;
        setUserClubs((prev) => [...prev, optimisticClub]);
        toast.success(`Successfully joined ${validClubName || 'the club'}!`);
      }

      setShowJoinModal(false);
      setShowReferralPrompt(false);
      setClubCode('');
      setReferralCode('');
      // NOTE: ClubsService.join() already emits CLUB_JOINED via bus
      setValidClubId(null);
      setValidClubName(null);
      // Background refresh to get real club data
      fetchUserData(true, () => isMountedRef.current);
    } catch (err: any) {
      if (!isMountedRef.current) return;
      toast.error(err.message || 'Failed to join club');
    } finally {
      if (isMountedRef.current) setIsJoining(false);
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════════
  // USER'S CLUBS — sorted (pinned first); Shark Club renders like any other club
  // ═══════════════════════════════════════════════════════════════════════════════

  const displayClubs = useMemo(() => {
    const clubs = [...userClubs];

    /* Inject Shark Club as the public featured demo, but ONLY once we actually
       know what the player's clubs are. Two separate ways that goes wrong, and
       both are covered here:

         loadFailed  - injecting after a failed fetch turns "we could not reach
           the database" into "you have exactly one club", which is both
           alarming and false.
         isLoading   - injecting DURING the first fetch renders a single fake
           Shark card, built from the hardcoded stub below with its fixed 580
           member count, which is then swapped for the real clubs seconds
           later. Measured on production: one fake card at 1.5s, three real
           ones by nine. It is also a tappable card for a club the player may
           not be in, shown before we know what they are in.

       The cold-start skeleton further down already covers the loading moment
       properly, so there is nothing to fill here. */
    const stillLoadingFirstList = isLoading && userClubs.length === 0;
    if (
      !loadFailed &&
      !stillLoadingFirstList &&
      !clubs.some((c) => Number(c.club_id) === SHARK_CLUB_ID)
    ) {
      clubs.push({
        id: 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
        club_id: SHARK_CLUB_ID,
        name: 'Shark Club',
        member_count: 580,
        entity_type: 'club',
      });
    }

    // Phase 7 #3: Sort -- pinned first, then by member count descending, then alphabetical tiebreaker
    clubs.sort((a, b) => {
      const aPinned = pinnedClubIds.includes(a.id) ? 1 : 0;
      const bPinned = pinnedClubIds.includes(b.id) ? 1 : 0;
      if (bPinned !== aPinned) return bPinned - aPinned;
      const memberDiff = (b.member_count || 0) - (a.member_count || 0);
      if (memberDiff !== 0) return memberDiff;
      return (a.name || '').localeCompare(b.name || '');
    });
    return clubs;
  }, [userClubs, pinnedClubIds, loadFailed, isLoading]);

  // Stable string identity of club IDs — avoids .map().join() allocation on every render
  const displayClubIdsKey = useMemo(() => displayClubs.map((c) => c.id).join(','), [displayClubs]);

  // ═══════════════════════════════════════════════════════════════════════════════
  // Per-club stats fetching — member count, club level, active players
  // ═══════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (displayClubs.length === 0) return;
    let isMounted = true;

    async function fetchAllClubStats() {
      // Offline Guard: Prevent Sentry log spam and failed network requests
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;

      const clubIds = displayClubs.map((c) => c.id);
      try {
        // Batch fetch club rows for level info
        // PERF 2026-08-23: the counts RPC was called with clubRows.map(c => c.id),
        // which is just clubIds filtered to rows that exist - so it waited a
        // whole round trip to learn something it already knew. Asking for a
        // count of a club id that does not exist simply returns nothing for it,
        // and the lookup below is by id, so a superset is harmless. Both now
        // fly at once.
        const activeCountsPromise = supabase
          .rpc('fn_batch_active_player_counts', { p_club_ids: clubIds })
          .then(
            (r) => r,
            (error) => ({ data: null, error })
          );

        const { data: clubRows } = await supabase
          .from('clubs')
          .select(
            'id, member_count, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
          )
          .in('id', clubIds);

        if (!isMounted || !clubRows) return;

        const statsMap: Record<string, ClubStats> = {};

        // Batch ALL clubs' active-player counts into ONE RPC instead of one per
        // club (was a fan-out on the hottest page).
        const activeCountMap = new Map<string, number>();
        try {
          const { data: batchCounts } = await activeCountsPromise;
          for (const r of batchCounts || [])
            activeCountMap.set(r.club_id, Number(r.active_count) || 0);
        } catch (e) {
          reportError(e, 'HomePage.batchActiveCounts');
        }

        /* The LIVE member count, not the denormalised column.
           ClubsService.getUserMemberships already replaces club.member_count
           with an fn_batch_club_member_counts result precisely because the
           column goes stale. This effect re-queries `clubs` and would otherwise
           throw that away and go back to the stale number - which then feeds
           BOTH the level ladder and the active-player clamp below, so one stale
           column silently wrongs three stats at once. */
        const liveMemberCounts = new Map<string, number>(
          displayClubs.map((c) => [c.id, Number(c.member_count) || 0])
        );

        // Process each club in parallel
        await Promise.allSettled(
          clubRows.map(async (club: any) => {
            const memberCount = Math.max(
              Number(club.member_count) || 0,
              liveMemberCounts.get(club.id) || 0
            );

            const activePlayers = activeCountMap.get(club.id) || 0;

            // Auto-recompute club level if stuck at default
            // Session dedup: only fire the RPC once per session per club
            let effectiveLevel = club.level || 1;
            const levelRecomputeKey = `level_recomputed_${club.id}`;
            if (effectiveLevel <= 1 && !sessionStorage.getItem(levelRecomputeKey)) {
              try {
                const { error: rpcErr } = await supabase.rpc('recompute_club_levels', {
                  p_club_id: club.id,
                });
                if (!rpcErr) {
                  sessionStorage.setItem(levelRecomputeKey, '1');
                  const { data: refreshed } = await supabase
                    .from('clubs')
                    .select(
                      'level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
                    )
                    .eq('id', club.id)
                    .maybeSingle();
                  if (refreshed && refreshed.level > 1) {
                    effectiveLevel = refreshed.level;
                    club.hierarchy_units_rounded_up =
                      refreshed.hierarchy_units_rounded_up ?? club.hierarchy_units_rounded_up;
                    club.player_threshold_current =
                      refreshed.player_threshold_current ?? club.player_threshold_current;
                    club.player_threshold_next =
                      refreshed.player_threshold_next ?? club.player_threshold_next;
                    club.hierarchy_threshold_current =
                      refreshed.hierarchy_threshold_current ?? club.hierarchy_threshold_current;
                    club.hierarchy_threshold_next =
                      refreshed.hierarchy_threshold_next ?? club.hierarchy_threshold_next;
                  }
                }
              } catch (e) {
                reportError(e, 'HomePage');
                // RPC not available
              }
            }

            /* Dan 2026-08-20: "a true 'club level' level 1-55 that is
               determined based on how many players are inside a club."

               This used to be getClubLevel(), a MAX() of a player curve and a
               HIERARCHY curve — so a club levelled up by appointing agents,
               and the badge answered a question nobody was asking. Level is
               now purely member count, on the published 1-55 ladder that
               public.fn_club_level_for_members mirrors. `effectiveLevel` (the
               stored clubs.level) is left alone for the progress bars that
               still read the legacy threshold columns. */
            const clubLevel = getClubLevelFromMembers(memberCount);
            void effectiveLevel;

            if (isMounted) {
              statsMap[club.id] = {
                totalMembers: memberCount,
                clubLevel,
                /* Active players cannot exceed members - but only clamp when we
                   actually KNOW the member count. Clamping against an unknown
                   (0) protects nothing; it just reports zero players at a club
                   with tables running, which is the more alarming of the two
                   wrong answers. */
                activePlayers:
                  memberCount > 0 ? Math.min(activePlayers, memberCount) : activePlayers,
              };
            }
          })
        );

        // ── Union stats overlay: fetch from `unions` table for union-type clubs ──
        // The `clubs` table row for unions has stale/minimal data (level=1, member_count=1).
        // The real aggregated stats (level=26, total_players=622) live in the `unions` table.
        // IMPORTANT: clubs.id ≠ unions.id — we use clubs.union_id (FK) to bridge.
        const unionTypeClubs = displayClubs.filter((c) => c.entity_type === 'union');
        if (unionTypeClubs.length > 0 && isMounted) {
          try {
            // Build mapping: union UUID (from clubs.union_id FK) → club.id (for statsMap key)
            const unionIdToClubId: Record<string, string> = {};
            const realUnionIds: string[] = [];
            for (const c of unionTypeClubs) {
              const uid = (c as any).union_id as string | undefined;
              if (uid) {
                unionIdToClubId[uid] = c.id;
                realUnionIds.push(uid);
              }
            }

            if (realUnionIds.length === 0) throw new Error('No union_id FK found on union clubs');

            const { data: unionRows } = await supabase
              .from('unions')
              .select(
                'id, level, total_players, member_count, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
              )
              .in('id', realUnionIds);

            if (unionRows && isMounted) {
              /* ── Dan 2026-08-20: "'active players' isn't working inside the
                 club cards." ──

                 For unions it was flatly wrong, not merely stale. This summed
                 per-club active counts over `union_clubs` — the union's MEMBER
                 clubs — and never looked at the union's OWN club row, which is
                 exactly where its tables live. Midway Union had 377 players
                 seated across 72 running tables and its card read 0. Summing
                 per-club counts also double-counted anyone seated in two member
                 clubs at once.

                 fn_union_active_player_counts answers for the union directly:
                 DISTINCT users across the union's own club row AND its member
                 clubs, in one query. */
              const unionActiveMap: Record<string, number> = {};
              try {
                const { data: unionCounts } = await supabase.rpc('fn_union_active_player_counts', {
                  p_union_ids: realUnionIds,
                });
                for (const r of unionCounts || []) {
                  unionActiveMap[(r as any).union_id] = Number((r as any).active_count) || 0;
                }
              } catch (e) {
                reportError(e, 'HomePage.unionActiveCounts');
              }

              for (const u of unionRows) {
                const clubId = unionIdToClubId[u.id]; // Map back to clubs.id for statsMap
                if (!clubId) continue;
                const totalMembers = u.total_players || u.member_count || 0;
                // Same 1-55 member ladder as a club — a union is measured by
                // the players under it, on the same scale, so the two numbers
                // sitting side by side on a carousel mean the same thing.
                const clubLevel = getClubLevelFromMembers(totalMembers);
                const unionActive = unionActiveMap[u.id] || 0;
                statsMap[clubId] = {
                  totalMembers,
                  clubLevel,
                  // Same reasoning as the club clamp above: only clamp against a
                  // member count we actually have.
                  activePlayers:
                    totalMembers > 0 ? Math.min(unionActive, totalMembers) : unionActive,
                };
              }
            }
          } catch (e) {
            reportError(e, 'HomePage.Union_stats_overlay_failed');
          }
        }

        if (isMounted) {
          setClubStats(statsMap);
          localStorage.setItem(STORAGE_KEYS.CLUB_STATS_CACHE, JSON.stringify(statsMap));
          localStorage.setItem(STORAGE_KEYS.CLUB_STATS_CACHE_TS, String(Date.now()));

          // Lazy-backfill baked card images for clubs missing card_image_url
          const backfillTargets = displayClubs
            .filter((c) => c.logo_url && !c.card_image_url && c.club_id)
            .map((c) => ({
              id: c.id,
              club_id: Number(c.club_id),
              name: c.name || 'Club',
              logo_url: c.logo_url!,
            }));
          if (backfillTargets.length > 0) {
            backfillClubCards(backfillTargets).catch(() => {});
          }
        }
      } catch (err) {
        reportError(err, 'HomePage.Failed_to_fetch_club_stats');
      }
    }

    fetchAllClubStats();
    // BUGFIX 2026-07-24: near-real-time active counts for every visible club card
    // via a 20s poll (the table_seats realtime listener was removed for write volume).
    const allStatsPoll = setInterval(fetchAllClubStats, 20000);
    return () => {
      isMounted = false;
      clearInterval(allStatsPoll);
    };
    // Stats re-fetch naturally when displayClubIdsKey changes (membership changes)
  }, [displayClubs.length, displayClubIdsKey]);

  // Club quick links — shared resolution (utils/clubQuickLink): last-used
  // club if still a member, else first club; unions excluded
  const quickLinkClubs = useMemo(() => eligibleQuickLinkClubs(userClubs), [userClubs]);
  const quickLinkClub = useMemo(
    () => resolveTargetClub(quickLinkClubs, quickLinkClubId),
    [quickLinkClubs, quickLinkClubId]
  );

  const openClubCashier = useCallback(
    (club: UserClub) => {
      rememberLastClub(club.id);
      setQuickLinkClubId(club.id);
      haptic.light();
      PremiumSFX.navigate();
      navigate(`/clubs/${club.slug || club.id}/cashier`);
    },
    [navigate]
  );

  const openClubMarketplace = useCallback(
    (club: UserClub) => {
      rememberLastClub(club.id);
      setQuickLinkClubId(club.id);
      haptic.light();
      PremiumSFX.navigate();
      navigate(`/marketplace?club=${club.id}`);
    },
    [navigate]
  );

  const cashierEmpty = useCallback(() => {
    haptic.light();
    toast.info('Join a club to access the cashier');
    setShowJoinModal(true);
  }, [toast]);

  const marketplaceEmpty = useCallback(() => {
    haptic.light();
    PremiumSFX.navigate();
    navigate('/marketplace');
  }, [navigate]);

  return (
    <div
      className={styles.container}
      style={
        SEASONAL_GRADIENTS[seasonalTheme]
          ? { background: SEASONAL_GRADIENTS[seasonalTheme] }
          : undefined
      }
      role="main"
      aria-label="Club Arena Home"
    >
      {/* ═══════════════════════════════════════════════════════════════════════
                CINEMATIC BACKGROUND LAYERS — World Hub Aesthetic
            ═══════════════════════════════════════════════════════════════════════ */}
      <div className={styles.gridFloor}></div>
      <div className={styles.volumetricLight}></div>
      <div className={styles.vignette}></div>

      {/* Enhancement #6: Circuit brain background overlay */}
      <div className={styles.circuitOverlay}></div>
      {/* Enhancement #1 & P4-1: 100% Random Floating Orbs replacing static dust/neurons */}
      <FloatingOrbs count={20} color="rgba(0, 212, 255, 0.8)" />

      {/* GLOBAL HEADER */}
      <GlobalHeader />

      {/* #15: Offline indicator banner */}
      {!isOnline && (
        <div className={styles.offlineBanner} role="alert">
          <span>Offline -- Showing Cached Data</span>
        </div>
      )}

      {/* #1: Keyboard shortcut hint overlay */}
      {showShortcutHint && (
        <div className={styles.shortcutOverlay} onClick={() => setShowShortcutHint(false)}>
          <div className={styles.shortcutPanel} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.shortcutTitle}>Keyboard Shortcuts</h3>
            <div className={styles.shortcutGrid}>
              {[
                ['1-5', 'Navigate Bottom Tiles'],
                ['J', 'Join a Club'],
                ['C', 'Create a Club'],
                ['F', 'Find a Player'],

                ['?', 'Toggle This Help'],
                ['Esc', 'Close Modals'],
              ].map(([key, desc]) => (
                <div key={key} className={styles.shortcutRow}>
                  <kbd className={styles.shortcutKey}>{key}</kbd>
                  <span className={styles.shortcutDesc}>{desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
                MAIN CONTENT — Scrollable card layout
            ═══════════════════════════════════════════════════════════════════════ */}
      <div className={styles.mainContent}>
        {/* ═══════════════════════════════════════════════════════════════════════
                    HORIZONTAL ACTION BAR
                ═══════════════════════════════════════════════════════════════════════ */}
        <div className={styles.actionBarRow}>
          <div className={styles.actionBarWrapper}>
            <img
              src={ACTION_BAR_HORIZONTAL}
              alt="Action Bar"
              className={styles.actionBarImage}
              loading="eager"
              width={1024}
              height={682}
            />
            {/* Clickable zones positioned over the image */}
            <button
              className={styles.actionZoneLeft}
              onClick={() => {
                haptic.light();
                setShowCreateClubModal(true);
              }}
              aria-label="Create a Club"
            />
            <button
              className={styles.actionZoneCenter}
              onClick={() => {
                haptic.medium();
                setShowFindPlayerModal(true);
              }}
              aria-label="Find a Player"
            />
            <button
              className={styles.actionZoneRight}
              onClick={() => {
                haptic.light();
                setShowJoinModal(true);
                setTimeout(() => joinInputRef.current?.focus(), 100);
              }}
              aria-label="Join a Club"
            />
          </div>
        </div>

        {/* ═══════════════════════════════════════════════════════════════════════
                    CLUB CAROUSEL — Swipeable: [User Clubs ← SHARK CLUB (center) → User Clubs]
                ═══════════════════════════════════════════════════════════════════════ */}
        <div className={styles.carouselScrollFade}>
          <HomePageErrorBoundary>
            <CarouselSection
              displayClubs={displayClubs}
              clubStats={clubStats}
              pinnedClubIds={pinnedClubIds}
              navigate={navigate}
              handleContextMenu={handleContextMenu}
              handleLongPressStart={handleLongPressStart}
              handleLongPressEnd={handleLongPressEnd}
              onOpenJoinModal={() => setShowJoinModal(true)}
              onOpenCreateModal={() => setShowCreateClubModal(true)}
            />
          </HomePageErrorBoundary>
        </div>

        {/* Load FAILED — say so. Previously this case fell through to the
            hardcoded Shark Club injection and the lobby presented a confident
            one-club carousel, so an outage looked exactly like losing your
            clubs. "We could not find out" and "you have none" are different
            statements and must not render the same. */}
        {!isLoading && loadFailed && (
          <div className={styles.emptyStateCard}>
            <div className={styles.emptyStateIcon}>!</div>
            <h3 className={styles.emptyStateTitle}>Could Not Load Your Clubs</h3>
            <p className={styles.emptyStateDesc}>
              Your Clubs Are Still There - We Just Could Not Reach Them Right Now. This Is Usually
              Brief. Try Again In A Moment.
            </p>
            <div className={styles.emptyStateActions}>
              <button
                className={styles.emptyStateBtnPrimary}
                onClick={() => {
                  setLoadFailed(false);
                  fetchUserData(false, () => true);
                }}
              >
                Try Again
              </button>
            </div>
          </div>
        )}

        {/* Empty state — premium onboarding when user has no clubs */}
        {!isLoading && !loadFailed && hasFetchedOnceRef.current && displayClubs.length === 0 && (
          <div className={styles.emptyStateCard}>
            <div className={styles.emptyStateIcon}>♠</div>
            <h3 className={styles.emptyStateTitle}>Welcome To Club Arena</h3>
            <p className={styles.emptyStateDesc}>
              Join A Club To Play Poker With Friends, Compete On Leaderboards, And Earn Rewards.
            </p>
            <div className={styles.emptyStateActions}>
              <button
                className={styles.emptyStateBtnPrimary}
                onClick={() => {
                  haptic.medium();
                  setShowJoinModal(true);
                }}
              >
                Join A Club
              </button>
              <button
                className={styles.emptyStateBtnSecondary}
                onClick={() => {
                  haptic.light();
                  setShowCreateClubModal(true);
                }}
              >
                Create One
              </button>
            </div>
          </div>
        )}

        {/* Welcome message for new users is handled as a toast popup (auto-dismiss) */}

        {/* ═══════════════════════════════════════════════════════════════════════
                    DAILY CHALLENGES — Extracted Component (#16)
                ═══════════════════════════════════════════════════════════════════════ */}
        {/* P4-2: Presence section removed — was the blue bar */}
        {/* P4-4: Section separator removed */}

        {/* ═══════════════════════════════════════════════════════════════════════
                    BOTTOM ROW — from lobbyTiles.config.ts (#18)
                ═══════════════════════════════════════════════════════════════════════ */}
        <div className={styles.bottomRow} role="navigation" aria-label="Quick actions">
          {LOBBY_TILES.map((tile) =>
            tile.alt === 'Cashier' || tile.alt === 'Marketplace' ? (
              /* Club-aware quick links — club name on the tile, quick-switch
                 popover (tap the corner button or long-press) for multi-club users */
              <ClubQuickLinkTile
                key={tile.alt}
                tile={tile}
                clubs={quickLinkClubs}
                targetClub={quickLinkClub}
                menuTitle={tile.alt === 'Cashier' ? 'Open Cashier For' : 'Open Marketplace For'}
                onSelect={tile.alt === 'Cashier' ? openClubCashier : openClubMarketplace}
                onEmpty={tile.alt === 'Cashier' ? cashierEmpty : marketplaceEmpty}
                preloadPath={tile.alt === 'Cashier' ? '/cashier' : '/marketplace'}
              />
            ) : (
              <button
                key={tile.alt}
                className={styles.tileCard}
                onClick={() => {
                  if (tile.route) {
                    haptic.light();
                    navigate(tile.route);
                  }
                }}
                /* PERF PASS 2026-08-22 (handoff item 8): warm the destination
                   chunk on first intent, exactly like the quick-link tiles
                   above. Matters most for Player Stats, whose recharts chunk
                   (~314KB) is deliberately not in the boot-time preload list.
                   preloadRoute is idempotent — a repeated dynamic import of a
                   loaded module resolves from cache — so no dedupe ref. */
                onMouseEnter={() => tile.route && preloadRoute(tile.route)}
                onTouchStart={() => tile.route && preloadRoute(tile.route)}
                onFocus={() => tile.route && preloadRoute(tile.route)}
                aria-label={`${tile.alt} (press ${tile.shortcutKey})`}
              >
                <div className={styles.tilePedestal}></div>
                <div className={styles.tileImageWrapper}>
                  <img
                    src={tile.img}
                    alt={tile.alt}
                    className={styles.tileImage}
                    loading="eager"
                    width={640}
                    height={1024}
                  />
                </div>
              </button>
            )
          )}
        </div>
      </div>

      {/* #17: Extracted Context Menu Component */}
      {contextMenu?.visible && (
        <ClubContextMenu
          club={contextMenu.club}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
          onLeave={() => {
            // #4: Show leave confirmation instead of immediate leave
            setLeaveConfirm({ visible: true, club: contextMenu.club });
            closeContextMenu();
          }}
          onPin={togglePinClub}
          isPinned={pinnedClubIds.includes(contextMenu.club.id)}
        />
      )}

      {/* #4: Leave Confirmation Modal */}
      {leaveConfirm?.visible && (
        <div className={styles.modalOverlay} onClick={() => setLeaveConfirm(null)}>
          <div
            ref={leaveModalRef}
            className={styles.modalContent}
            onClick={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-labelledby="leave-confirm-title"
          >
            <h2 className={styles.modalTitle} id="leave-confirm-title">
              Leave Club?
            </h2>
            <p className={styles.modalSubtitle}>
              Are You Sure You Want To Leave{' '}
              <strong>{leaveConfirm.club?.name || 'this club'}</strong>? This Action Cannot Be
              Undone.
            </p>
            <div className={styles.modalButtons}>
              <button
                className={`${styles.modalButtonPrimary} ${styles.modalButtonDanger}`}
                onClick={() => handleLeaveClub(leaveConfirm.club)}
              >
                Yes, Leave Club
              </button>
              <button className={styles.modalButtonSecondary} onClick={() => setLeaveConfirm(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
                JOIN A CLUB MODAL
            ═══════════════════════════════════════════════════════════════════════ */}
      {showJoinModal && (
        <div
          className={styles.modalOverlay}
          onClick={() => {
            setShowJoinModal(false);
            setShowReferralPrompt(false);
            setClubCode('');
            setReferralCode('');
            setValidClubId(null);
            setValidClubName(null);
          }}
        >
          <div
            ref={joinModalRef}
            className={styles.modalContent}
            onClick={(e) => e.stopPropagation()}
          >
            {!showReferralPrompt ? (
              <>
                <h2 className={styles.modalTitle}>Join A Club</h2>
                <div className={styles.inputGroup}>
                  <input
                    ref={joinInputRef}
                    type="tel"
                    inputMode="numeric"
                    pattern="[0-9]{5,6}"
                    maxLength={6}
                    className={styles.clubCodeInput}
                    placeholder="Enter 5-Digit Club Code"
                    value={clubCode}
                    onChange={(e) => setClubCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    onKeyDown={(e) => e.key === 'Enter' && handleJoinClubSubmit()}
                  />
                </div>
                <div className={styles.modalButtons}>
                  <button
                    className={styles.modalButtonPrimary}
                    onClick={handleJoinClubSubmit}
                    disabled={isValidatingCode || clubCode.length < 5}
                  >
                    {isValidatingCode ? 'Validating...' : 'Continue'}
                  </button>
                  <button
                    className={styles.modalButtonSecondary}
                    onClick={() => setShowJoinModal(false)}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className={styles.modalTitle}>
                  {validClubName ? `Join ${validClubName}` : 'Referral Code'}
                </h2>
                <p className={styles.modalSubtitle}>Enter A Referral Code Or Join Without One</p>
                <div className={styles.inputGroup}>
                  <input
                    type="text"
                    className={styles.clubCodeInput}
                    placeholder="Referral Code (Optional)"
                    value={referralCode}
                    onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                  />
                </div>
                <div className={styles.modalButtons}>
                  <button
                    className={styles.modalButtonPrimary}
                    onClick={() => handleJoinClub(true)}
                    disabled={isJoining}
                  >
                    {isJoining ? 'Joining...' : 'Join with Referral'}
                  </button>
                  <button
                    className={styles.modalButtonSecondary}
                    onClick={() => handleJoinClub(false)}
                    disabled={isJoining}
                  >
                    {isJoining ? 'Joining...' : 'Join Without Referral'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* CREATE A CLUB MODAL */}
      <Suspense fallback={null}>
        <CreateClubModal
          isOpen={showCreateClubModal}
          onClose={() => setShowCreateClubModal(false)}
          onSuccess={(clubId) => {
            setShowCreateClubModal(false);
            navigate(`/clubs/${clubId}`);
          }}
        />
      </Suspense>

      {/* FIND A PLAYER MODAL */}
      <Suspense fallback={null}>
        <FindPlayerModal
          isOpen={showFindPlayerModal}
          onClose={() => setShowFindPlayerModal(false)}
        />
      </Suspense>

      {/* Fix 1: Loading indicator — only on true cold start (no SWR cache), positioned
          inline so bottom row tiles always render regardless of loading state */}
      {isLoading && !userClubs.length && !hasFetchedOnceRef.current && (
        <div className={styles.loadingOverlay}>
          <div className={styles.skeletonRow}>
            <div className={styles.skeletonCard}>
              <div className={styles.skeletonStat} />
            </div>
            <div className={styles.skeletonCardFeatured}>
              <div className={styles.skeletonStat} />
            </div>
            <div className={styles.skeletonCard}>
              <div className={styles.skeletonStat} />
            </div>
          </div>
          <span className={styles.loadingText}>Loading Arena</span>
        </div>
      )}
    </div>
  );
}

// Enhancement #10: Export wrapped with Error Boundary
export default function HomePage() {
  return (
    <HomePageErrorBoundary>
      <HomePageInner />
    </HomePageErrorBoundary>
  );
}
