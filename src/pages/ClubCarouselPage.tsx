/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLUB CAROUSEL PAGE — Premium-Style Club Selection
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shows user's clubs in a swipeable carousel format:
 * - Header with player info, VIP, gold/diamond balances
 * - Create club button
 * - Search button
 * - Club cards carousel (swipe or arrow navigation)
 * - Each card: Club avatar, ID, name, level, member count
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase, getAuthUser } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { unionService } from '../services/UnionService';
import type { Union } from '../services/UnionService';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import './ClubCarouselPage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useIsMounted } from '../hooks/useIsMounted';
import haptic from '../services/HapticService';
import { soundService } from '../services/SoundService';
import { STORAGE_KEYS } from '../lib/storage';
import { getClubLevel, getUnionLevel } from '../utils/clubLevels';
import { reportError } from '../utils/errorReporter';

const SWIPE_THRESHOLD = 50; // px minimum for a horizontal swipe

interface UserClub {
  id: string;
  club_id: number;
  name: string;
  avatar_url: string | null;
  level: number;
  member_count: number;
  role: string;
  hierarchy_units_rounded_up?: number;
  player_threshold_current?: number;
  player_threshold_next?: number;
  hierarchy_threshold_current?: number;
  hierarchy_threshold_next?: number;
}

interface UserWallet {
  gold: number;
  diamonds: number;
}

interface UserProfile {
  id: string;
  display_name: string;
  avatar_url: string | null;
  player_number: number;
  vip_level: string;
}

// Frame images for club cards (randomly assigned per club)
// Use BASE_URL for correct path resolution with Vite base path
const FRAME_IMAGES = [
  `${import.meta.env.BASE_URL}images/frames/frame-1.jpg`,
  `${import.meta.env.BASE_URL}images/frames/frame-2.jpg`,
  `${import.meta.env.BASE_URL}images/frames/frame-3.jpg`,
  `${import.meta.env.BASE_URL}images/frames/frame-4.jpg`,
  `${import.meta.env.BASE_URL}images/frames/frame-5.jpg`,
];

// Get consistent frame for a club based on its ID
const getFrameForClub = (clubId: number): string => {
  const index = clubId % FRAME_IMAGES.length;
  return FRAME_IMAGES[index];
};

export default function ClubCarouselPage() {
  useEffect(() => {
    document.title = 'My Clubs | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuthUser();
  useVisibilityRefresh(() => {
    if (user?.id) loadUserData();
  });
  const toast = useToast();

  // SWR — instant render from cache
  const [clubs, setClubs] = useState<UserClub[]>(() => {
    try {
      const cached = localStorage.getItem(STORAGE_KEYS.CAROUSEL_CLUBS_CACHE);
      if (cached) {
        const p = JSON.parse(cached);
        if (Array.isArray(p) && p.length > 0) return p;
      }
    } catch {
      /* ignore */
    }
    return [];
  });
  const [userUnions, setUserUnions] = useState<Union[]>(() => {
    try {
      const cached = localStorage.getItem(STORAGE_KEYS.CAROUSEL_UNIONS_CACHE);
      if (cached) {
        const p = JSON.parse(cached);
        if (Array.isArray(p) && p.length > 0) return p;
      }
    } catch {
      /* ignore */
    }
    return [];
  });
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [wallet, setWallet] = useState<UserWallet>({ gold: 0, diamonds: 0 });
  const [visibleCards, setVisibleCards] = useState<Set<string>>(new Set());

  // #5: Search/filter
  const [searchQuery, setSearchQuery] = useState('');

  // #3: Offline banner
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  // #9: Connection health
  const [wsConnected, setWsConnected] = useState(true);

  // #8: Notification badges per club
  const [clubBadges, setClubBadges] = useState<Record<string, number>>({});

  // Pull-to-refresh state
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const touchStartY = useRef(0);
  const touchStartX = useRef(0); // #1: Swipe gesture
  const containerRef = useRef<HTMLDivElement>(null);

  const isMounted = useIsMounted();

  // Request deduplication — prevent concurrent loadUserData() from realtime events
  const loadingRef = useRef(false);
  // Differentiate initial load (skeleton) from background refresh (silent)
  const initialLoadDone = useRef(false);

  useEffect(() => {
    loadUserData();
  }, []);

  // #3: Online/Offline detection
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

  // NOTE (2026-04-19): Realtime `postgres_changes` listeners on club_members, clubs,
  // unions, union_clubs REMOVED. These were unfiltered global listeners that fired on
  // EVERY mutation across ALL clubs/unions. The MasterBus event listeners below
  // (CLUB_JOINED, CLUB_LEFT, CLUB_UPDATED, UNION_UPDATED, CLUB_SETTINGS_UPDATED)
  // already handle all cross-page refresh needs.

  // ── Bus Listeners: cross-page event reactivity (debounced) ──
  useEffect(() => {
    const unsubs = [
      masterBus.subscribeDebounced(
        'CLUB_JOINED',
        () => {
          if (isMounted.current) loadUserData();
        },
        500
      ),
      masterBus.subscribeDebounced(
        'CLUB_LEFT',
        () => {
          if (isMounted.current) loadUserData();
        },
        500
      ),
      masterBus.subscribeDebounced(
        'CLUB_UPDATED',
        () => {
          if (isMounted.current) loadUserData();
        },
        500
      ),
      masterBus.subscribeDebounced(
        'UNION_UPDATED',
        () => {
          if (isMounted.current) loadUserData();
        },
        500
      ),
      masterBus.subscribeDebounced(
        'CLUB_SETTINGS_UPDATED',
        () => {
          if (isMounted.current) loadUserData();
        },
        500
      ),
      // Refresh notification badges when a notification arrives
      masterBus.subscribeDebounced(
        'NOTIFICATION_RECEIVED',
        () => {
          if (!isMounted.current || clubs.length === 0) return;
          (async () => {
            try {
              const {
                data: { user: authUser },
              } = await getAuthUser();
              if (!authUser || !isMounted.current) return;
              const { data: notifs } = await supabase
                .from('notifications')
                .select('club_id')
                .eq('user_id', authUser.id)
                .eq('read', false);
              if (!isMounted.current || !notifs) return;
              const badges: Record<string, number> = {};
              for (const n of notifs) {
                if (n.club_id) badges[n.club_id] = (badges[n.club_id] || 0) + 1;
              }
              setClubBadges(badges);
            } catch (e) {
              reportError(e, 'ClubCarouselPage.async');
              /* non-critical */
            }
          })();
        },
        500
      ),
      // Refresh wallet balance when it changes from another tab/page
      masterBus.subscribeDebounced(
        'BALANCE_UPDATED',
        (payload: any) => {
          if (!isMounted.current) return;
          if (payload?.diamonds !== undefined) {
            setWallet((prev) => ({ ...prev, diamonds: payload.diamonds }));
          }
          if (payload?.gold !== undefined) {
            setWallet((prev) => ({ ...prev, gold: payload.gold }));
          }
        },
        500
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [clubs]);

  // #5: Filtered clubs based on search
  // MUST be declared before keyboard nav, deep link, stagger animation, and clamp effects
  const displayedClubs = useMemo(() => {
    if (!searchQuery.trim()) return clubs;
    const q = searchQuery.toLowerCase();
    return clubs.filter((c) => c.name?.toLowerCase().includes(q) || String(c.club_id).includes(q));
  }, [clubs, searchQuery]);

  // #6: Keyboard navigation
  // BUG FIX: Must use displayedClubs (filtered), not clubs (unfiltered).
  // Otherwise Enter navigates to wrong club when search is active.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return; // don't hijack search input
      const tc = displayedClubs.length + userUnions.length;
      // Wrap-around to match arrow button behavior
      const kbPrev = () => setActiveIndex((prev) => (prev > 0 ? prev - 1 : tc - 1));
      const kbNext = () => setActiveIndex((prev) => (prev < tc - 1 ? prev + 1 : 0));

      if (e.key === 'ArrowLeft') {
        kbPrev();
        haptic.light();
      } else if (e.key === 'ArrowRight') {
        kbNext();
        haptic.light();
      } else if (e.key === 'Enter' && tc > 0) {
        // Use displayedClubs — matches what's rendered in the carousel
        if (activeIndex < displayedClubs.length) {
          navigate(`/clubs/${displayedClubs[activeIndex].id}`);
          haptic.medium();
        } else {
          const uIdx = activeIndex - displayedClubs.length;
          if (userUnions[uIdx]) navigate(`/unions/${userUnions[uIdx].id}`);
        }
      } else if (e.key === 'Escape') setSearchQuery('');
      else if (e.key === '/') {
        e.preventDefault();
        setSearchQuery(''); /* focus search input */
      } else if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < tc) {
          setActiveIndex(idx);
          haptic.light();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeIndex, displayedClubs, userUnions]);

  // Clamp activeIndex when search narrows the list
  useEffect(() => {
    const maxIdx = displayedClubs.length + userUnions.length - 1;
    if (maxIdx < 0) {
      setActiveIndex(0);
    } else {
      setActiveIndex((prev) => Math.min(prev, maxIdx));
    }
  }, [displayedClubs.length, userUnions.length]);

  // #7: Deep link support — ?club=UUID jumps to that club
  useEffect(() => {
    const deepClubId = searchParams.get('club');
    if (deepClubId && displayedClubs.length > 0) {
      const idx = displayedClubs.findIndex((c) => c.id === deepClubId);
      if (idx >= 0) setActiveIndex(idx);
    }
  }, [displayedClubs, searchParams]);

  // #10: Stagger premium 3D card entrance animation
  // Uses `clubs` (not displayedClubs) to avoid re-staggering on every search keystroke.
  // The JSX renders displayedClubs and checks visibleCards.has(id), which works because
  // all displayedClubs IDs are a subset of clubs IDs already in the Set.
  useEffect(() => {
    if (clubs.length === 0 && userUnions.length === 0) return;
    setVisibleCards(new Set());
    const allItems = [...clubs.map((c) => c.id), ...userUnions.map((u) => u.id)];
    const timers = allItems.map((itemId, index) =>
      setTimeout(() => {
        setVisibleCards((prev) => new Set(prev).add(itemId));
      }, index * 80)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [clubs, userUnions]);

  // #8: Fetch notification badges per club
  useEffect(() => {
    if (clubs.length === 0) return;
    (async () => {
      try {
        const {
          data: { user: authUser },
        } = await getAuthUser();
        if (!authUser) return;
        const { data: notifs } = await supabase
          .from('notifications')
          .select('club_id')
          .eq('user_id', authUser.id)
          .eq('read', false);
        if (!isMounted.current || !notifs) return;
        const badges: Record<string, number> = {};
        for (const n of notifs) {
          if (n.club_id) badges[n.club_id] = (badges[n.club_id] || 0) + 1;
        }
        setClubBadges(badges);
      } catch (e) {
        reportError(e, 'ClubCarouselPage.async');
        /* non-critical */
      }
    })();
  }, [clubs, isMounted]);

  // ── #6: Decomposed data loading helpers ──
  const loadProfile = useCallback(
    async (userId: string) => {
      try {
        const { data: profileData, error: profileError } = await supabase
          .from('profiles')
          .select('id, display_name, avatar_url, diamonds, tier, player_number')
          .eq('id', userId)
          .maybeSingle();
        if (!isMounted.current) return;
        if (!profileError && profileData) {
          setUserProfile({
            id: profileData.id,
            display_name: profileData.display_name || 'Player',
            avatar_url: profileData.avatar_url,
            player_number: profileData.player_number || 0,
            vip_level: profileData.tier || 'bronze',
          });
          setWallet((prev) => ({ ...prev, diamonds: profileData.diamonds || 0 }));
        }
      } catch (e) {
        reportError(e, 'ClubCarouselPage.setWallet');
        /* non-critical */
      }
    },
    [isMounted]
  );

  const enrichMemberCounts = useCallback(
    async (clubList: UserClub[]): Promise<UserClub[]> => {
      if (clubList.length === 0) return clubList;
      try {
        const clubIds = clubList.map((c) => c.id);
        // #1: RPC returns {club_id, member_count} grouped — 1 row per club
        const { data: counts } = await supabase.rpc('fn_batch_club_member_counts', {
          p_club_ids: clubIds,
        });
        if (!isMounted.current) return clubList;
        const countMap = new Map<string, number>();
        for (const row of counts || []) {
          countMap.set(row.club_id, Number(row.member_count));
        }
        for (const club of clubList) {
          if (countMap.has(club.id)) club.member_count = countMap.get(club.id)!;
        }
      } catch (e) {
        console.warn('[ClubCarouselPage] Live member count enrichment failed:', e);
      }
      return clubList;
    },
    [isMounted]
  );

  const filterUnionClubs = useCallback(
    async (clubList: UserClub[], loadedUnions: Union[]): Promise<UserClub[]> => {
      if (clubList.length === 0 || loadedUnions.length === 0) return clubList;
      try {
        const { data: ucRows } = await supabase
          .from('union_clubs')
          .select('club_id, union_id')
          .in(
            'club_id',
            clubList.map((c) => c.id)
          );
        if (!isMounted.current) return clubList;
        if (ucRows && ucRows.length > 0) {
          const clubToUnionMap = new Map(ucRows.map((r) => [r.club_id, r.union_id]));
          const loadedUnionIds = new Set(loadedUnions.map((u) => u.id));
          return clubList.filter((c) => {
            const parentUnionId = clubToUnionMap.get(c.id);
            if (!parentUnionId) return true;
            return !loadedUnionIds.has(parentUnionId);
          });
        }
      } catch (e) {
        reportError(e, 'ClubCarouselPage.filter');
        /* fail-open */
      }
      return clubList;
    },
    [isMounted]
  );

  const loadUserData = async () => {
    // Skip if already loading (prevents concurrent calls from realtime)
    if (loadingRef.current) return;
    loadingRef.current = true;

    // Only show skeleton on initial load, not background refreshes
    if (!initialLoadDone.current) setLoading(true);

    try {
      const {
        data: { user: authUser },
      } = await getAuthUser();
      if (!isMounted.current) return;
      if (!authUser) {
        console.warn('[ClubCarouselPage] getUser() returned null — skipping data load');
        setLoading(false);
        return;
      }

      // #3: Run profile + clubs/unions in parallel (profile doesn't block clubs)
      const [, memberResult, unionsResult] = await Promise.allSettled([
        loadProfile(authUser.id),
        supabase
          .from('club_members')
          .select(
            `club_id, role, chip_balance, clubs (id, club_id, name, avatar_url, member_count, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next)`
          )
          .eq('user_id', authUser.id),
        unionService.getMyUnions(authUser.id),
      ]);

      if (!isMounted.current) return;

      let displayedClubCount = clubs.length;
      let loadedUnions: Union[] = [];
      if (unionsResult.status === 'fulfilled') loadedUnions = unionsResult.value;

      if (memberResult.status === 'fulfilled') {
        const { data: memberData, error: memberError } = memberResult.value;
        if (!memberError && memberData) {
          const allUserClubs: UserClub[] = memberData
            .filter((m: any) => m.clubs)
            .map((m: any) => ({
              id: m.clubs.id,
              club_id: m.clubs.club_id,
              name: m.clubs.name,
              avatar_url: m.clubs.avatar_url,
              level: m.clubs.level || 1,
              member_count: m.clubs.member_count || 0,
              role: m.role,
              hierarchy_units_rounded_up: m.clubs.hierarchy_units_rounded_up || 0,
              player_threshold_current: m.clubs.player_threshold_current || 0,
              player_threshold_next: m.clubs.player_threshold_next || 0,
              hierarchy_threshold_current: m.clubs.hierarchy_threshold_current || 0,
              hierarchy_threshold_next: m.clubs.hierarchy_threshold_next || 0,
            }));

          // #3: Run enrichment + union filtering in parallel
          const [enriched, filtered] = await Promise.all([
            enrichMemberCounts(allUserClubs),
            filterUnionClubs(allUserClubs, loadedUnions),
          ]);
          if (!isMounted.current) return;

          // Apply enriched counts to filtered set
          const countLookup = new Map(enriched.map((c) => [c.id, c.member_count]));
          for (const c of filtered) {
            if (countLookup.has(c.id)) c.member_count = countLookup.get(c.id)!;
          }

          setClubs(filtered);
          displayedClubCount = filtered.length;

          // #7: SWR cache write
          try {
            localStorage.setItem(STORAGE_KEYS.CAROUSEL_CLUBS_CACHE, JSON.stringify(filtered));
          } catch {
            /* quota */
          }

          const totalGold = memberData.reduce(
            (sum: number, m: any) => sum + (m.chip_balance || 0),
            0
          );
          setWallet((prev) => ({ ...prev, gold: totalGold }));
        }
      }

      let newUnionCount = userUnions.length;
      if (loadedUnions.length > 0) {
        setUserUnions(loadedUnions);
        newUnionCount = loadedUnions.length;
        try {
          localStorage.setItem(STORAGE_KEYS.CAROUSEL_UNIONS_CACHE, JSON.stringify(loadedUnions));
        } catch {
          /* quota */
        }
      } else if (unionsResult.status === 'rejected') {
        console.warn('[ClubCarouselPage] Failed to load unions:', unionsResult.reason);
      } else {
        setUserUnions([]);
        newUnionCount = 0;
      }

      const newTotal = displayedClubCount + newUnionCount;
      if (newTotal > 0) {
        setActiveIndex((prev) => Math.min(prev, newTotal - 1));
      } else {
        setActiveIndex(0);
      }
    } catch (error) {
      if (!isMounted.current) return;
      reportError(error, 'ClubCarouselPage.Error_loading_user_data');
      toast.error('Failed to load club data');
      // Clear SWR cache on error so stale data isn't shown on next visit
      try {
        localStorage.removeItem(STORAGE_KEYS.CAROUSEL_CLUBS_CACHE);
      } catch {
        /* ignore */
      }
      try {
        localStorage.removeItem(STORAGE_KEYS.CAROUSEL_UNIONS_CACHE);
      } catch {
        /* ignore */
      }
    } finally {
      loadingRef.current = false;
      initialLoadDone.current = true;
      if (isMounted.current) setLoading(false);
    }
  };

  // ── #5: Prefetch adjacent club detail on swipe ──
  const prefetchClubDetail = useCallback((club: UserClub) => {
    const cacheKey = `club_detail_${club.id}`;
    if (sessionStorage.getItem(cacheKey)) return; // already cached
    (async () => {
      try {
        const { data } = await supabase.from('clubs').select('*').eq('id', club.id).maybeSingle();
        if (data) {
          try {
            sessionStorage.setItem(cacheKey, JSON.stringify(data));
          } catch {
            /* quota */
          }
        }
      } catch {
        /* best effort */
      }
    })();
  }, []);

  // Touch handlers: pull-to-refresh + #1 horizontal swipe
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    if (containerRef.current && containerRef.current.scrollTop === 0) {
      touchStartY.current = e.touches[0].clientY;
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartY.current === 0) return;
    const diffY = e.touches[0].clientY - touchStartY.current;
    if (diffY > 0 && diffY < 150) setPullDistance(diffY);
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      // #1: Detect horizontal swipe
      const endX = e.changedTouches[0].clientX;
      const diffX = endX - touchStartX.current;
      if (Math.abs(diffX) > SWIPE_THRESHOLD) {
        if (diffX < 0) {
          handleNext();
          haptic.light();
        } else {
          handlePrev();
          haptic.light();
        }
        touchStartY.current = 0;
        touchStartX.current = 0;
        setPullDistance(0);
        return;
      }
      // Pull-to-refresh (vertical)
      if (pullDistance > 60 && !isRefreshing) {
        setIsRefreshing(true);
        setPullDistance(0);
        haptic.medium();
        Promise.resolve(loadUserData()).then(
          () => {
            if (isMounted.current) setIsRefreshing(false);
          },
          () => {
            if (isMounted.current) setIsRefreshing(false);
          }
        );
      } else {
        setPullDistance(0);
      }
      touchStartY.current = 0;
      touchStartX.current = 0;
    },
    [pullDistance, isRefreshing, isMounted]
  );

  const totalCards = displayedClubs.length + userUnions.length;

  const handlePrev = () => {
    haptic.light(); // #4
    setActiveIndex((prev) => {
      const next = prev > 0 ? prev - 1 : totalCards - 1;
      if (next < displayedClubs.length) prefetchClubDetail(displayedClubs[next]);
      return next;
    });
  };

  const handleNext = () => {
    haptic.light(); // #4
    setActiveIndex((prev) => {
      const next = prev < totalCards - 1 ? prev + 1 : 0;
      if (next < displayedClubs.length) prefetchClubDetail(displayedClubs[next]);
      return next;
    });
  };

  const handleClubClick = (club: UserClub) => {
    haptic.medium(); // #4
    navigate(`/clubs/${club.id}`);
  };

  const handleCreateClub = () => {
    soundService.playButtonClick();
    navigate('/clubs/create');
  };

  const handleSearch = () => {
    soundService.playButtonClick();
    navigate('/clubs'); // Go to full clubs list for search/join
  };

  const formatNumber = (num: number) => {
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // #2: Card-shaped skeleton loading
  if (loading && clubs.length === 0) {
    return (
      <div className="club-carousel loading">
        <div className="carousel-skeleton">
          <div className="skeleton-header">
            <div className="skeleton-avatar shimmer" />
            <div className="skeleton-text-group">
              <div className="skeleton-line w60 shimmer" />
              <div className="skeleton-line w40 shimmer" />
            </div>
          </div>
          <div className="skeleton-cards">
            {[0, 1, 2].map((i) => (
              <div key={i} className={`skeleton-card shimmer ${i === 1 ? 'center' : 'side'}`} />
            ))}
          </div>
          <div className="skeleton-dots">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton-dot shimmer" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        className="club-carousel"
        ref={containerRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Pull-to-refresh indicator */}
        {(pullDistance > 0 || isRefreshing) && (
          <div
            className="pull-refresh-indicator"
            style={{
              height: isRefreshing ? 40 : pullDistance * 0.5,
              opacity: isRefreshing ? 1 : Math.min(pullDistance / 60, 1),
            }}
          >
            <span className={`pull-refresh-spinner ${isRefreshing ? 'spinning' : ''}`}>↻</span>
            <span>
              {isRefreshing
                ? 'Refreshing…'
                : pullDistance > 60
                  ? 'Release to refresh'
                  : 'Pull to refresh'}
            </span>
          </div>
        )}

        {/* #3: Offline banner */}
        {!isOnline && (
          <div className="carousel-offline-banner" role="alert">
            <span>⚠ Offline — showing cached data</span>
          </div>
        )}

        {/* #9: Connection health indicator */}
        <div
          className={`ws-status-dot ${wsConnected ? 'connected' : 'disconnected'}`}
          title={wsConnected ? 'Live connection' : 'Reconnecting…'}
        />

        {/* HEADER */}
        <header className="club-carousel__header">
          <div className="header__user">
            <div className="user-avatar">
              {userProfile?.avatar_url ? (
                <img src={userProfile.avatar_url} alt="avatar" loading="lazy" />
              ) : (
                <span className="avatar-placeholder">P</span>
              )}
            </div>
            <div className="user-info">
              <span className="user-name">-{userProfile?.display_name || 'Player'}-</span>
              <span className="user-id">
                ID:{userProfile?.player_number?.toString().padStart(7, '0') || '0000000'}
              </span>
            </div>
          </div>
        </header>

        {/* Wallet Row */}
        <div className="club-carousel__wallet">
          <div className="vip-badge">VIP</div>
          <div className="wallet-balances">
            <div className="balance gold">
              <span className="balance-icon">♠</span>
              <span className="balance-amount">{formatNumber(wallet.gold)}</span>
              <button
                className="balance-add"
                onClick={() => {
                  haptic.light();
                  navigate('/clubs');
                }}
              >
                +
              </button>
            </div>
            <div className="balance diamond">
              <span className="balance-icon">◆</span>
              <span className="balance-amount">{wallet.diamonds.toLocaleString()}</span>
              <button
                className="balance-add"
                onClick={() => {
                  haptic.light();
                  navigate('/clubs');
                }}
              >
                +
              </button>
            </div>
          </div>
        </div>

        {/* ACTION BUTTONS + #5 Search Bar */}
        <div className="club-carousel__actions">
          <button className="action-btn create" onClick={handleCreateClub}>
            <span className="action-icon">+</span>
          </button>
          {clubs.length > 3 && (
            <div className="carousel-search-bar">
              <input
                type="text"
                className="carousel-search-input"
                placeholder="Search clubs…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search clubs"
              />
              {searchQuery && (
                <button className="carousel-search-clear" onClick={() => setSearchQuery('')}>
                  ×
                </button>
              )}
            </div>
          )}
          <button className="action-btn search" onClick={handleSearch} aria-label="Search clubs">
            <span className="action-icon" aria-hidden="true">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
          </button>
        </div>

        {/* ═══════════════════════════════════════════════════════════════════
                CLUB CAROUSEL
            ═══════════════════════════════════════════════════════════════════ */}
        <div className="club-carousel__cards">
          {displayedClubs.length === 0 && userUnions.length === 0 ? (
            <div className="no-clubs">
              <p>
                {searchQuery ? 'No clubs match your search' : "You haven't joined any clubs yet"}
              </p>
              {!searchQuery && (
                <button className="join-btn" onClick={handleSearch}>
                  Find Clubs
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Left Arrow */}
              {totalCards > 1 && (
                <button
                  className="carousel-arrow left"
                  onClick={handlePrev}
                  aria-label="Previous club"
                >
                  ‹
                </button>
              )}

              {/* Club + Union Cards */}
              <div className="cards-container">
                {/* Club Cards */}
                {displayedClubs.map((club, index) => {
                  const offset = index - activeIndex;
                  const isActive = index === activeIndex;
                  const badge = clubBadges[club.id] || 0;
                  const levelInfo = getClubLevel({
                    level: club.level || 1,
                    playerCount: club.member_count || 0,
                    hierarchyUnits: club.hierarchy_units_rounded_up || 0,
                    playerThresholdCurrent: club.player_threshold_current || 0,
                    playerThresholdNext: club.player_threshold_next || 0,
                    hierarchyThresholdCurrent: club.hierarchy_threshold_current || 0,
                    hierarchyThresholdNext: club.hierarchy_threshold_next || 0,
                  });

                  return (
                    <div
                      key={club.id}
                      className={`club-card ${isActive ? 'active' : ''} ${visibleCards.has(club.id) ? 'card-enter' : 'hidden'}`}
                      style={{
                        transform: `translateX(${offset * 120}%) scale(${isActive ? 1 : 0.8}) ${isActive ? 'rotateY(0deg)' : `rotateY(${offset > 0 ? -8 : 8}deg)`}`,
                        opacity: visibleCards.has(club.id)
                          ? Math.abs(offset) > 1
                            ? 0
                            : isActive
                              ? 1
                              : 0.6
                          : 0,
                        zIndex: isActive ? 10 : 5 - Math.abs(offset),
                      }}
                      onClick={() => isActive && handleClubClick(club)}
                      role="button"
                      tabIndex={isActive ? 0 : -1}
                      aria-label={`${club.name}, ${club.member_count} members`}
                    >
                      {/* #8: Notification badge */}
                      {badge > 0 && (
                        <div className="club-card__badge">{badge > 9 ? '9+' : badge}</div>
                      )}

                      {/* Frame overlay */}
                      <img
                        src={getFrameForClub(club.club_id)}
                        alt=""
                        className="club-card__frame"
                      />

                      <div className="club-card__content">
                        <div className="club-card__id">ID:{club.club_id}</div>
                        <div className="club-card__graphic">
                          {club.avatar_url ? (
                            <img src={club.avatar_url} alt={club.name} loading="lazy" />
                          ) : (
                            <div className="club-card__placeholder">
                              <span className="chip-icon">♠</span>
                            </div>
                          )}
                        </div>
                        <div className="club-card__footer">
                          <div className="club-avatar">
                            {club.avatar_url ? (
                              <img src={club.avatar_url} alt="" loading="lazy" />
                            ) : (
                              <span>♠</span>
                            )}
                          </div>
                          <div className="club-info">
                            <span className="club-name">{club.name}</span>
                            <span className="club-meta">
                              <span
                                style={{
                                  fontSize: '0.65rem',
                                  padding: '1px 6px',
                                  borderRadius: '8px',
                                  background: levelInfo.gradient,
                                  color: '#fff',
                                  fontWeight: 700,
                                  letterSpacing: '0.5px',
                                  textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                                  marginRight: '6px',
                                }}
                              >
                                Lv.{levelInfo.level}
                              </span>
                              <span className="member-count">
                                {(club.member_count || 0).toLocaleString()}
                              </span>
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Union Cards */}
                {userUnions.map((union, unionIdx) => {
                  const index = displayedClubs.length + unionIdx;
                  const offset = index - activeIndex;
                  const isActive = index === activeIndex;

                  return (
                    <div
                      key={`union-${union.id}`}
                      className={`club-card ${isActive ? 'active' : ''} ${visibleCards.has(union.id) ? 'card-enter' : 'hidden'}`}
                      style={{
                        transform: `translateX(${offset * 120}%) scale(${isActive ? 1 : 0.8}) ${isActive ? 'rotateY(0deg)' : `rotateY(${offset > 0 ? -8 : 8}deg)`}`,
                        opacity: visibleCards.has(union.id)
                          ? Math.abs(offset) > 1
                            ? 0
                            : isActive
                              ? 1
                              : 0.6
                          : 0,
                        zIndex: isActive ? 10 : 5 - Math.abs(offset),
                      }}
                      onClick={() => isActive && navigate(`/unions/${union.id}`)}
                      role="button"
                      tabIndex={isActive ? 0 : -1}
                      aria-label={`Union: ${union.name}`}
                    >
                      {/* Union-specific card content */}
                      <div
                        className="club-card__content"
                        style={{
                          background:
                            'linear-gradient(135deg, rgba(155, 89, 182, 0.15) 0%, rgba(142, 68, 173, 0.08) 100%)',
                        }}
                      >
                        <div className="club-card__id" style={{ color: '#b388ff' }}>
                          UNION
                        </div>
                        <div className="club-card__graphic">
                          {union.avatarUrl ? (
                            <img src={union.avatarUrl} alt={union.name} loading="lazy" />
                          ) : (
                            <div className="club-card__placeholder">
                              <span
                                className="chip-icon"
                                aria-label="Union"
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                <svg
                                  width="56"
                                  height="56"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.6"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <polygon
                                    points="12,2 22,7 2,7"
                                    fill="currentColor"
                                    fillOpacity="0.15"
                                  />
                                  <line x1="2" y1="7" x2="22" y2="7" />
                                  <line x1="5" y1="9" x2="5" y2="18" />
                                  <line x1="9.5" y1="9" x2="9.5" y2="18" />
                                  <line x1="14.5" y1="9" x2="14.5" y2="18" />
                                  <line x1="19" y1="9" x2="19" y2="18" />
                                  <line x1="3" y1="21" x2="21" y2="21" />
                                  <line x1="2" y1="18" x2="22" y2="18" />
                                </svg>
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="club-card__footer">
                          <div
                            className="club-avatar"
                            style={{
                              background: 'linear-gradient(135deg, #9b59b6, #8e44ad)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: '#fff',
                            }}
                            aria-label="Union"
                          >
                            <svg
                              width="18"
                              height="18"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <polygon points="12,3 22,8 2,8" />
                              <line x1="5" y1="10" x2="5" y2="18" />
                              <line x1="10" y1="10" x2="10" y2="18" />
                              <line x1="14" y1="10" x2="14" y2="18" />
                              <line x1="19" y1="10" x2="19" y2="18" />
                              <line x1="3" y1="21" x2="21" y2="21" />
                            </svg>
                          </div>
                          <div className="club-info">
                            <span className="club-name">{union.name}</span>
                            <span className="club-meta">
                              {(() => {
                                const uLevel = getUnionLevel({
                                  level: union.level,
                                  playerLevel: union.playerLevel,
                                  hierarchyLevel: union.hierarchyLevel,
                                  totalPlayers: union.totalPlayers || union.memberCount,
                                  hierarchyUnitsRoundedUp: union.hierarchyUnitsRoundedUp,
                                  playerThresholdCurrent: union.playerThresholdCurrent,
                                  playerThresholdNext: union.playerThresholdNext,
                                  hierarchyThresholdCurrent: union.hierarchyThresholdCurrent,
                                  hierarchyThresholdNext: union.hierarchyThresholdNext,
                                });
                                return (
                                  <>
                                    <span
                                      style={{
                                        fontSize: '0.65rem',
                                        padding: '1px 6px',
                                        borderRadius: '8px',
                                        background: uLevel.gradient,
                                        color: '#fff',
                                        fontWeight: 700,
                                        letterSpacing: '0.5px',
                                        textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                                        marginRight: '6px',
                                      }}
                                    >
                                      Lv.{uLevel.level} — {uLevel.tierLabel}
                                    </span>
                                    <span className="member-count">
                                      {union.memberCount.toLocaleString()}
                                    </span>
                                  </>
                                );
                              })()}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Right Arrow */}
              {totalCards > 1 && (
                <button
                  className="carousel-arrow right"
                  onClick={handleNext}
                  aria-label="Next club"
                >
                  ›
                </button>
              )}
            </>
          )}
        </div>

        {/* Background */}
        <div className="club-carousel__background"></div>
      </div>
    </>
  );
}
