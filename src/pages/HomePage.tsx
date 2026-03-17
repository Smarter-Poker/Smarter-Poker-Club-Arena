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

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  lazy,
  Suspense,
  Component,
  useMemo,
  type ReactNode,
  type ErrorInfo,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase, getAuthUser } from '../lib/supabase';
import { waitForAuth } from '../utils/waitForAuth';

import { ClubsService } from '../services/ClubsService';
import { useToast } from '../components/common/Toast';
import GlobalHeader from '../components/navigation/GlobalHeader';
import haptic from '../services/HapticService';

import PremiumSFX from '../services/PremiumSFX';
import { masterBus } from '../core/MasterBus';
import { useMasterBusSubscription } from '../hooks/useMasterBusSubscription';
import DailyChallenges from '../components/home/DailyChallenges';
import PresenceHub from '../components/home/PresenceHub';
import ClubContextMenu from '../components/home/ClubContextMenu';
import LOBBY_TILES from '../config/lobbyTiles.config';
import { postToParent } from '../utils/parentOrigin';
import CarouselSection from '../components/home/CarouselSection';
import { getClubLevel } from '../utils/clubLevels';
import type { UserClub, ClubStats } from '../components/home/CarouselSection';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { STORAGE_KEYS } from '../lib/storage';
import styles from './HomePage.module.css';

// Lazy-load heavy components to reduce initial bundle
const CreateClubModal = lazy(() => import('../components/modals/CreateClubModal'));
const FindPlayerModal = lazy(() => import('../components/modals/FindPlayerModal'));

const SWR_CACHE_TTL = 60 * 60 * 1000; // 1 hour — skip stale cache from old sessions

// Typed shape for the user preferences JSON column
interface UserPreferences {
  card_color_preset?: string;
  [key: string]: unknown;
}

// Action button images
const ACTION_BAR_HORIZONTAL = `${import.meta.env.BASE_URL}images/icons/action-bar-horizontal.png`;

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
    console.error('[HomePage ErrorBoundary]', error, info);
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

  // Detect if running inside iframe (World Hub embedding)
  const [isInIframe, setIsInIframe] = useState(false);

  useEffect(() => {
    const inIframe = window.parent !== window;
    setIsInIframe(inIframe);
    if (inIframe) {
      document.body.classList.add('embedded-in-iframe');
    }
    return () => {
      document.body.classList.remove('embedded-in-iframe');
    };
  }, []);

  // Real data states
  const [isLoading, setIsLoading] = useState(true);
  const [userClubs, setUserClubs] = useState<UserClub[]>(() => {
    // SWR — instant render from cache, but ONLY if we're NOT in an iframe.
    // In iframe mode, auth comes from postMessage and the cache might be stale
    // (from a different user or an unauthenticated session).
    const inIframe = window.parent !== window;
    if (inIframe) return [];
    try {
      const cached = localStorage.getItem(STORAGE_KEYS.CLUBS_CACHE);
      const cacheTs = localStorage.getItem(STORAGE_KEYS.CLUBS_CACHE_TS);
      const isFresh = cacheTs && Date.now() - Number(cacheTs) < SWR_CACHE_TTL;
      if (cached && isFresh) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      /* ignore corrupt cache */
    }
    return [];
  });

  // Per-club stats for featured card rendering
  const [clubStats, setClubStats] = useState<Record<string, ClubStats>>({});

  // Enhancement #2: Context menu state
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    club: UserClub;
  } | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Enhancement #8: Notification badges (unread counts)
  const [tileBadges, setTileBadges] = useState<Record<string, number>>({});

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

  // #9: Search/filter
  const [searchQuery, setSearchQuery] = useState('');

  // #11: Sound effects toggle
  const [soundsEnabled, setSoundsEnabled] = useState(() => {
    return localStorage.getItem(STORAGE_KEYS.SOUNDS) !== 'false';
  });

  // #12: Seasonal theme
  const seasonalTheme = useMemo(() => getSeasonalTheme(), []);

  // #15: Online status
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  // #6: Card color preset
  const [cardColorPreset, setCardColorPreset] = useState<string>(() => {
    return localStorage.getItem(STORAGE_KEYS.CARD_COLOR) || 'default';
  });

  // JOIN A CLUB modal state
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showCreateClubModal, setShowCreateClubModal] = useState(false);
  const [clubCode, setClubCode] = useState('');
  const [isValidatingCode, setIsValidatingCode] = useState(false);
  const [showReferralPrompt, setShowReferralPrompt] = useState(false);
  const [validClubId, setValidClubId] = useState<string | null>(null);
  const [referralCode, setReferralCode] = useState('');
  const joinInputRef = useRef<HTMLInputElement>(null);

  // Focus trapping for modals (accessibility)
  const leaveModalRef = useFocusTrap(!!leaveConfirm?.visible);
  const joinModalRef = useFocusTrap(showJoinModal);

  // Find Player modal state
  const [showFindPlayerModal, setShowFindPlayerModal] = useState(false);

  // Shark Club stats state
  const [sharkClubId, setSharkClubId] = useState<string | null>(null);
  const [sharkClubStats, setSharkClubStats] = useState({
    totalMembers: 0,
    clubLevel: 1,
    activePlayers: 0,
  });

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

  // #6: Listen for card color changes from hamburger menu (debounced)
  useMasterBusSubscription(
    'CARD_COLOR_CHANGED',
    (payload: any) => {
      const preset = payload?.preset as string;
      if (preset) setCardColorPreset(preset);
    },
    { debounce: 300 }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // DATA FETCHING (with SWR cache)
  // ═══════════════════════════════════════════════════════════════════════════════

  const fetchUserData = useCallback(
    async (skipLoading = false, getIsMounted?: () => boolean) => {
      if (!skipLoading) setIsLoading(true);

      // Safety timeout: never show loading spinner for more than 12 seconds
      const loadingTimeout = setTimeout(() => {
        if (!getIsMounted || getIsMounted()) setIsLoading(false);
      }, 12_000);

      try {
        // In iframe context, wait for auth to be set by the parent via postMessage.
        const authReady = await waitForAuth(getIsMounted || undefined);
        if (!authReady) {
          console.warn('[HomePage] Auth not ready — proceeding anyway');
        }
        if (getIsMounted && !getIsMounted()) {
          clearTimeout(loadingTimeout);
          return;
        }

        const {
          data: { user: authUser },
        } = await getAuthUser();
        if (authUser) {
          const memberships = await ClubsService.getUserMemberships(authUser);
          const clubs =
            memberships?.map(
              (m) =>
                ({
                  ...m.club,
                  is_owner: m.role === 'owner',
                  member_count: m.club?.member_count || 0,
                }) as UserClub
            ) || [];
          if (getIsMounted && !getIsMounted()) return;
          setUserClubs(clubs);
          // Enhancement #9: Update SWR cache
          try {
            localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, JSON.stringify(clubs));
            localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE_TS, String(Date.now()));
          } catch {
            /* quota */
          }

          // ── Batch: notification badges + card color sync in parallel ──
          const [notifResult, colorResult] = await Promise.allSettled([
            supabase
              .from('notifications')
              .select('*', { count: 'exact', head: true })
              .eq('user_id', authUser.id)
              .eq('is_read', false),
            supabase.from('profiles').select('preferences').eq('id', authUser.id).maybeSingle(),
          ]);

          if (getIsMounted && !getIsMounted()) return;

          // Process notification badges
          if (
            notifResult.status === 'fulfilled' &&
            notifResult.value.count &&
            notifResult.value.count > 0
          ) {
            setTileBadges({ 'Player Stats': notifResult.value.count });
          }

          // Process card color sync
          if (
            colorResult.status === 'fulfilled' &&
            (colorResult.value.data?.preferences as UserPreferences | null)?.card_color_preset
          ) {
            const preset = (colorResult.value.data?.preferences as UserPreferences)
              .card_color_preset!;
            if (preset !== localStorage.getItem(STORAGE_KEYS.CARD_COLOR)) {
              localStorage.setItem(STORAGE_KEYS.CARD_COLOR, preset);
              setCardColorPreset(preset);
            }
          }
        } else {
          if (getIsMounted && !getIsMounted()) return;
          setUserClubs([]);
          try {
            localStorage.removeItem(STORAGE_KEYS.CLUBS_CACHE);
          } catch {
            /* */
          }
        }
      } catch (err) {
        console.error('Error fetching user data:', err);
        toast.error('Failed to load user data');
      } finally {
        clearTimeout(loadingTimeout);
        if (!getIsMounted || getIsMounted()) setIsLoading(false);
      }
    },
    [toast]
  );

  // ── Visibility Refresh — refresh data when user returns to tab ──
  const { isRefreshing } = useVisibilityRefresh(() => fetchUserData(true));

  useEffect(() => {
    let isMounted = true;
    fetchUserData(false, () => isMounted);

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
        .subscribe();
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
      }
    },
    { debounce: 300 }
  );

  // Enhancement #8: Listen for notification badge updates (debounced)
  useMasterBusSubscription(
    'NOTIFICATION_READ',
    () => {
      // Clear all badges when notifications are read
      setTileBadges({});
    },
    { debounce: 500 }
  );

  // Phase 8 #5: Listen for diamond balance changes from challenge claims (debounced)
  useMasterBusSubscription(
    'DIAMOND_BALANCE_CHANGED',
    (payload: any) => {
      const delta = payload?.delta as number;
      if (delta && delta > 0) {
        setTileBadges((prev) => ({
          ...prev,
          'Player Stats': (prev['Player Stats'] || 0) + 1,
        }));
      }
    },
    { debounce: 500 }
  );

  // Fetch Shark Club stats — ALL data from live Supabase queries
  // Hardcoded club_id for Shark Club — permanent fixture of the platform
  const SHARK_CLUB_NUMERIC_ID = 25450;
  const SHARK_SWR_KEY = STORAGE_KEYS.SHARK_STATS_SWR;
  const SWR_TTL_MS = 5 * 60 * 1000; // 5-minute cache TTL

  // SWR: show cached Shark Club stats instantly on mount (skip if >5 min old)
  useEffect(() => {
    try {
      const cached = sessionStorage.getItem(SHARK_SWR_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        const age = parsed.cachedAt ? Date.now() - parsed.cachedAt : Infinity;
        if (parsed.totalMembers > 0 && age < SWR_TTL_MS) setSharkClubStats(parsed);
      }
    } catch {
      /* */
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    async function fetchSharkClubStats(retryOnFail = false) {
      try {
        // Wait for auth to be ready before querying — prevents RLS null results in iframe
        await waitForAuth(() => isMounted);
        if (!isMounted) return;

        // Find Shark Club by club_id = 25450 — include level threshold columns
        const { data: clubRaw } = await supabase
          .from('clubs')
          .select(
            'id, member_count, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
          )
          .eq('club_id', SHARK_CLUB_NUMERIC_ID)
          .maybeSingle();

        const club = clubRaw as any;
        if (!club || !isMounted) return;
        setSharkClubId(club.id);

        // Parallelize independent queries: member count + active players
        const [memberResult, tablesResult] = await Promise.allSettled([
          ClubsService.getLiveMemberCount(club.id),
          supabase.from('tables').select('id').eq('club_id', club.id),
        ]);

        if (!isMounted) return;

        // Use live count if available, fall back to denormalized column when RLS blocks
        let memberCount = memberResult.status === 'fulfilled' ? memberResult.value : 0;
        if (memberCount === 0 && club.member_count && club.member_count > 0) {
          memberCount = club.member_count;
        }

        let activePlayers = 0;
        // Try batch RPC first (single query), fall back to 2-query pattern if RPC not deployed
        try {
          const { data: rpcCount } = await supabase.rpc('fn_get_active_player_count', {
            p_club_id: club.id,
          });
          activePlayers = Number(rpcCount) || 0;
        } catch {
          // RPC not deployed yet — use legacy 2-query fallback
          if (tablesResult.status === 'fulfilled' && tablesResult.value.data?.length) {
            const tableIds = tablesResult.value.data.map((t: any) => t.id);
            const { count: seatCount } = await supabase
              .from('table_seats')
              .select('*', { count: 'exact', head: true })
              .in('table_id', tableIds)
              .is('left_at', null);
            activePlayers = seatCount || 0;
          }
        }

        // Compute live club level from DB thresholds
        const levelInfo = getClubLevel({
          level: club.level || 1,
          playerCount: memberCount,
          hierarchyUnits: club.hierarchy_units_rounded_up || 0,
          playerThresholdCurrent: club.player_threshold_current || 0,
          playerThresholdNext: club.player_threshold_next || 0,
          hierarchyThresholdCurrent: club.hierarchy_threshold_current || 0,
          hierarchyThresholdNext: club.hierarchy_threshold_next || 0,
        });

        if (!isMounted) return;
        const stats = {
          totalMembers: memberCount,
          clubLevel: levelInfo.level,
          activePlayers,
        };
        setSharkClubStats(stats);

        // SWR: cache for instant display on revisit (with TTL timestamp)
        try {
          sessionStorage.setItem(SHARK_SWR_KEY, JSON.stringify({ ...stats, cachedAt: Date.now() }));
        } catch {
          /* */
        }
      } catch (err) {
        console.error('[HomePage] Failed to fetch Shark Club stats:', err);
        // Single retry after 3s — only on initial mount, not on real-time refreshes
        if (retryOnFail && isMounted) {
          setTimeout(() => {
            if (isMounted) fetchSharkClubStats(false);
          }, 3000);
        }
      }
    }
    fetchSharkClubStats(true);

    // Real-time clubs table updates via MasterBus channel registry
    const sharkChannelKey = 'clubs-live-stats';
    const channel = masterBus.getOrCreateChannel(sharkChannelKey);

    // Debounce club_members changes — fires on ALL clubs, so collapse rapid events
    let sharkDebounce: ReturnType<typeof setTimeout> | null = null;
    const debouncedSharkRefresh = () => {
      if (sharkDebounce) clearTimeout(sharkDebounce);
      sharkDebounce = setTimeout(() => {
        if (isMounted) fetchSharkClubStats();
      }, 2000);
    };

    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'clubs',
          filter: 'club_id=eq.25450',
        },
        () => {
          if (isMounted) fetchSharkClubStats();
        }
      )
      // Listen to club_members changes (debounced — no filter available for
      // specific club_id, so this fires on all clubs)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'club_members',
        },
        debouncedSharkRefresh
      )
      .subscribe();

    // Bus listeners: refresh Shark Club stats when members join/leave any club
    const unsubJoined = masterBus.subscribeDebounced(
      'CLUB_JOINED',
      () => {
        if (isMounted) fetchSharkClubStats();
      },
      1000
    );
    const unsubLeft = masterBus.subscribeDebounced(
      'CLUB_LEFT',
      () => {
        if (isMounted) fetchSharkClubStats();
      },
      1000
    );

    return () => {
      isMounted = false;
      if (sharkDebounce) clearTimeout(sharkDebounce);
      unsubJoined();
      unsubLeft();
      masterBus.removeRegisteredChannel(sharkChannelKey);
    };
  }, []);

  // Enhancement #6: Real-time stats refresh for ALL club cards (debounced)
  useEffect(() => {
    let isMounted = true;
    const allClubsKey = 'clubs-all-live-stats';
    const allClubsChannel = masterBus.getOrCreateChannel(allClubsKey);
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedFetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (isMounted) fetchUserData(true, () => isMounted);
      }, 500);
    };
    allClubsChannel
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'club_members' },
        debouncedFetch
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'table_seats' },
        debouncedFetch
      )
      .subscribe();

    return () => {
      isMounted = false;
      if (debounceTimer) clearTimeout(debounceTimer);
      masterBus.removeRegisteredChannel(allClubsKey);
    };
  }, [fetchUserData]);

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
      // Don't trigger when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key.toLowerCase();
      switch (key) {
        case '1':
          haptic.light();
          navigate('/profile');
          break;
        case '2':
          haptic.light();
          navigate('/leaderboard');
          break;
        case '3': {
          haptic.light();
          const lastClub = localStorage.getItem(STORAGE_KEYS.LAST_CLUB);
          if (lastClub) navigate(`/clubs/${lastClub}/cashier`);
          else if (userClubs.length > 0) navigate(`/clubs/${userClubs[0].id}/cashier`);
          break;
        }
        case '4': {
          haptic.light();
          // FIX: Use consistent navigation pattern — postToParent for iframe, navigate for standalone
          // Previous code used unsafe window.top! which can throw in cross-origin iframes
          const inIframe = typeof window !== 'undefined' && window.parent !== window;
          if (inIframe) {
            postToParent({ type: 'NAVIGATE', path: '/hub/marketplace' });
          } else {
            navigate('/marketplace');
          }
          break;
        }
        case '5':
          haptic.light();
          navigate('/hands');
          break;
        case 'j':
          setShowJoinModal(true);
          break;
        case 'c':
          setShowCreateClubModal(true);
          break;
        case 'f':
          setShowFindPlayerModal(true);
          break;
        case '/':
          e.preventDefault();
          setSearchQuery('');
          document.getElementById('club-search-input')?.focus();
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
  }, [navigate, userClubs]);

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
        masterBus.emit('CLUB_LEFT', { clubId: club.id });
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

  // #11: Toggle sound effects
  const toggleSounds = useCallback(() => {
    setSoundsEnabled((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEYS.SOUNDS, String(next));
      if (next) PremiumSFX.toggleOn();
      else PremiumSFX.toggleOff();
      return next;
    });
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════════
  // JOIN A CLUB LOGIC
  // ═══════════════════════════════════════════════════════════════════════════════
  const handleJoinClubSubmit = async () => {
    if (!clubCode.trim()) {
      toast.error('Please enter a club code');
      return;
    }

    // Validate that it's a 5-digit number
    const numericCode = parseInt(clubCode.trim(), 10);
    if (isNaN(numericCode) || numericCode < 10000 || numericCode > 99999) {
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

      // Valid club found - show referral prompt
      setValidClubId(club.id);
      setShowReferralPrompt(true);
    } catch (err) {
      if (!isMountedRef.current) return;
      console.error('Error validating club code:', err);
      toast.error('Failed to validate club code');
    } finally {
      if (isMountedRef.current) setIsValidatingCode(false);
    }
  };

  const handleJoinClub = async (withReferral = false) => {
    if (!validClubId) return;

    try {
      if (withReferral && referralCode) {
        localStorage.setItem(`referral_${validClubId}`, referralCode);
      }
      await ClubsService.join(validClubId);
      if (!isMountedRef.current) return;
      // #2: Optimistic UI — add placeholder club immediately
      const optimisticClub: UserClub = {
        id: validClubId,
        club_id: 0,
        name: 'Loading...',
        avatar_url: null,
        member_count: 1,
        is_owner: false,
      } as UserClub;
      setUserClubs((prev) => [...prev, optimisticClub]);
      toast.success('Successfully joined the club!');
      setShowJoinModal(false);
      setShowReferralPrompt(false);
      setClubCode('');
      setReferralCode('');
      masterBus.emit('CLUB_JOINED', { clubId: validClubId });
      setValidClubId(null);
      // Background refresh to get real club data
      fetchUserData(true, () => isMountedRef.current);
    } catch (err: any) {
      if (!isMountedRef.current) return;
      toast.error(err.message || 'Failed to join club');
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════════
  // USER'S CLUBS — sorted (pinned first), filtered, excluding Shark Club
  // ═══════════════════════════════════════════════════════════════════════════════
  // BUG FIX #4: Track unfiltered count separately so search bar doesn't vanish mid-query
  const unfilteredClubCount = useMemo(() => {
    return userClubs.filter((club) => club.id !== sharkClubId).length;
  }, [userClubs, sharkClubId]);

  const displayClubs = useMemo(() => {
    let clubs = userClubs.filter((club) => club.id !== sharkClubId);
    // #9: Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      clubs = clubs.filter((c) => c.name?.toLowerCase().includes(q));
    }
    // Phase 7 #3: Sort -- pinned first, then by member count descending
    clubs.sort((a, b) => {
      const aPinned = pinnedClubIds.includes(a.id) ? 1 : 0;
      const bPinned = pinnedClubIds.includes(b.id) ? 1 : 0;
      if (bPinned !== aPinned) return bPinned - aPinned;
      return (b.member_count || 0) - (a.member_count || 0);
    });
    return clubs;
  }, [userClubs, sharkClubId, searchQuery, pinnedClubIds]);

  // ═══════════════════════════════════════════════════════════════════════════════
  // Per-club stats fetching — member count, club level, active players
  // ═══════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (displayClubs.length === 0) return;
    let isMounted = true;

    async function fetchAllClubStats() {
      const clubIds = displayClubs.map((c) => c.id);
      try {
        // Batch fetch club rows for level info
        const { data: clubRows } = await supabase
          .from('clubs')
          .select(
            'id, member_count, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
          )
          .in('id', clubIds);

        if (!isMounted || !clubRows) return;

        const statsMap: Record<string, ClubStats> = {};

        // Process each club in parallel
        await Promise.allSettled(
          clubRows.map(async (club: any) => {
            const memberCount = club.member_count || 0;

            // Try RPC for active player count
            let activePlayers = 0;
            try {
              const { data: rpcCount } = await supabase.rpc('fn_get_active_player_count', {
                p_club_id: club.id,
              });
              activePlayers = Number(rpcCount) || 0;
            } catch {
              // RPC not deployed — skip
            }

            // Compute club level
            const levelInfo = getClubLevel({
              level: club.level || 1,
              playerCount: memberCount,
              hierarchyUnits: club.hierarchy_units_rounded_up || 0,
              playerThresholdCurrent: club.player_threshold_current || 0,
              playerThresholdNext: club.player_threshold_next || 0,
              hierarchyThresholdCurrent: club.hierarchy_threshold_current || 0,
              hierarchyThresholdNext: club.hierarchy_threshold_next || 0,
            });

            if (isMounted) {
              statsMap[club.id] = {
                totalMembers: memberCount,
                clubLevel: levelInfo.level,
                activePlayers,
              };
            }
          })
        );

        if (isMounted) setClubStats(statsMap);
      } catch (err) {
        console.error('[HomePage] Failed to fetch club stats:', err);
      }
    }

    fetchAllClubStats();
    return () => {
      isMounted = false;
    };
  }, [displayClubs.length, displayClubs.map((c) => c.id).join(',')]);

  // Sound effects ref for other uses
  const soundsEnabledRef = useRef(soundsEnabled);
  useEffect(() => {
    soundsEnabledRef.current = soundsEnabled;
  }, [soundsEnabled]);
  // Tile action handlers (for bottom row tiles using LOBBY_TILES config)
  const tileActions: Record<string, () => void> = useMemo(
    () => ({
      Cashier: () => {
        haptic.light();
        PremiumSFX.navigate();
        const lastClub = localStorage.getItem(STORAGE_KEYS.LAST_CLUB);
        if (lastClub) navigate(`/clubs/${lastClub}/cashier`);
        else if (userClubs.length > 0) navigate(`/clubs/${userClubs[0].id}/cashier`);
        else toast.info('Join a club first to access the cashier');
      },
      Marketplace: () => {
        haptic.light();
        PremiumSFX.navigate();
        if (window.parent !== window) {
          postToParent({ type: 'NAVIGATE', path: '/hub/marketplace' });
        } else {
          navigate('/marketplace');
        }
      },
    }),
    [navigate, userClubs, toast]
  );

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
      {isRefreshing && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 9999,
            height: '2px',
            background: 'linear-gradient(90deg, transparent, #00d4ff, #8b5cf6, transparent)',
            opacity: 0.8,
          }}
        />
      )}
      {/* Enhancement #6: Circuit brain background overlay */}
      <div className={styles.circuitOverlay}></div>
      {/* Enhancement #1: Neuron lights — traveling cyan pulses */}
      <div className={styles.neuronLights}></div>
      {/* P4-1: Floating dust particles */}
      <div className={styles.dustParticles}></div>

      {/* GLOBAL HEADER - Hub-style, hide when embedded in iframe */}
      {!isInIframe && <GlobalHeader />}

      {/* #15: Offline indicator banner */}
      {!isOnline && (
        <div className={styles.offlineBanner} role="alert">
          <span>Offline -- showing cached data</span>
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
                ['/', 'Search Clubs'],
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
              loading="lazy"
            />
            {/* Clickable zones positioned over the image */}
            <button
              className={styles.actionZoneLeft}
              onClick={() => setShowCreateClubModal(true)}
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
        <CarouselSection
          displayClubs={displayClubs}
          sharkClubId={sharkClubId}
          sharkClubStats={sharkClubStats}
          clubStats={clubStats}
          pinnedClubIds={pinnedClubIds}
          navigate={navigate}
          toast={toast}
          handleContextMenu={handleContextMenu}
          handleLongPressStart={handleLongPressStart}
          handleLongPressEnd={handleLongPressEnd}
          onOpenJoinModal={() => setShowJoinModal(true)}
          onOpenCreateModal={() => setShowCreateClubModal(true)}
        />

        {/* Enhancement #5: Skeleton loading while clubs data is loading */}
        {isLoading && (
          <div className={styles.clubCardsSkeleton}>
            <div className={styles.clubCardSkeletonItem}></div>
            <div className={styles.clubCardSkeletonItem}></div>
            <div className={styles.clubCardSkeletonItem}></div>
          </div>
        )}

        {/* No Clubs Message */}
        {!isLoading && userClubs.length === 0 && (
          <div className={styles.noClubsMessage}>
            <p>Welcome to Club Arena</p>
            <p>Create or join a club to get started!</p>
          </div>
        )}

        {/* #9: Search bar (show when user has 3+ clubs) — uses unfiltered count to avoid catch-22 */}
        {(unfilteredClubCount >= 3 || searchQuery) && (
          <div className={styles.searchBarContainer}>
            <input
              id="club-search-input"
              type="text"
              className={styles.searchInput}
              placeholder="Search clubs... (press /)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search clubs"
            />
            {searchQuery && (
              <button
                className={styles.searchClear}
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
        )}

        {/* Phase 8 #7: Search empty state */}
        {searchQuery.trim() && displayClubs.length === 0 && (
          <div className={styles.searchEmptyState}>No clubs match "{searchQuery}"</div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════
                    DAILY CHALLENGES — Extracted Component (#16)
                ═══════════════════════════════════════════════════════════════════════ */}
        {/* P4-2: Presence section with glass container */}
        <div className={styles.presenceSection}>
          <PresenceHub />
        </div>
        {/* P4-4: Section separator */}
        <div className={styles.sectionSeparator}></div>
        <DailyChallenges />
        <div className={styles.sectionSeparator}></div>

        {/* ═══════════════════════════════════════════════════════════════════════
                    BOTTOM ROW — from lobbyTiles.config.ts (#18)
                ═══════════════════════════════════════════════════════════════════════ */}
        <div className={styles.bottomRow} role="navigation" aria-label="Quick actions">
          {LOBBY_TILES.map((tile) => (
            <button
              key={tile.alt}
              className={styles.tileCard}
              onClick={() => {
                if (tile.route) {
                  haptic.light();
                  navigate(tile.route);
                } else if (tileActions[tile.alt]) {
                  tileActions[tile.alt]();
                }
              }}
              aria-label={`${tile.alt} (press ${tile.shortcutKey})`}
            >
              <div className={styles.tilePedestal}></div>
              <div className={styles.tileImageWrapper}>
                <img src={tile.img} alt={tile.alt} className={styles.tileImage} loading="lazy" />
                <span className={styles.tileLabel}>{tile.alt}</span>
                {tileBadges[tile.alt] && tileBadges[tile.alt] > 0 && (
                  <span className={styles.tileBadge}>{tileBadges[tile.alt]}</span>
                )}
              </div>
              <div className={styles.tileEdge}></div>
            </button>
          ))}
        </div>

        {/* #11: Sound toggle + #1: Shortcut hint button */}
        <div className={styles.controlsRow}>
          <button
            className={styles.controlButton}
            onClick={toggleSounds}
            aria-label={soundsEnabled ? 'Mute sounds' : 'Enable sounds'}
            title={soundsEnabled ? 'Sounds On' : 'Sounds Off'}
          >
            {soundsEnabled ? 'ON' : 'OFF'}
            <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.03em' }}>
              {soundsEnabled ? 'Sound On' : 'Sound Off'}
            </span>
          </button>
          <button
            className={styles.controlButton}
            onClick={() => setShowShortcutHint(true)}
            aria-label="Keyboard shortcuts"
            title="Keyboard Shortcuts (?)"
          >
            ?
            <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.03em' }}>
              Shortcuts
            </span>
          </button>
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
              Are you sure you want to leave{' '}
              <strong>{leaveConfirm.club?.name || 'this club'}</strong>? This action cannot be
              undone.
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
          }}
        >
          <div
            ref={joinModalRef}
            className={styles.modalContent}
            onClick={(e) => e.stopPropagation()}
          >
            {!showReferralPrompt ? (
              <>
                <h2 className={styles.modalTitle}>Join a Club</h2>
                <div className={styles.inputGroup}>
                  <input
                    ref={joinInputRef}
                    type="tel"
                    inputMode="numeric"
                    pattern="[0-9]{5}"
                    maxLength={5}
                    className={styles.clubCodeInput}
                    placeholder="Enter 5-Digit Club Code"
                    value={clubCode}
                    onChange={(e) => setClubCode(e.target.value.replace(/\D/g, '').slice(0, 5))}
                    onKeyDown={(e) => e.key === 'Enter' && handleJoinClubSubmit()}
                  />
                </div>
                <div className={styles.modalButtons}>
                  <button
                    className={styles.modalButtonPrimary}
                    onClick={handleJoinClubSubmit}
                    disabled={isValidatingCode}
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
                <h2 className={styles.modalTitle}>Referral Code</h2>
                <p className={styles.modalSubtitle}>Enter a referral code or join without one</p>
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
                  >
                    Join with Referral
                  </button>
                  <button
                    className={styles.modalButtonSecondary}
                    onClick={() => handleJoinClub(false)}
                  >
                    Join Without Referral
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

      {/* Loading indicator */}
      {isLoading && !userClubs.length && (
        <div className={styles.loadingOverlay}>
          <div className={styles.spinner}></div>
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
