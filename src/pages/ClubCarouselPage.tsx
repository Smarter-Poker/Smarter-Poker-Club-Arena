/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLUB CAROUSEL PAGE — PokerBros-Style Club Selection
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shows user's clubs in a swipeable carousel format:
 * - Header with player info, VIP, gold/diamond balances
 * - Create club button
 * - Search button
 * - Club cards carousel (swipe or arrow navigation)
 * - Each card: Club avatar, ID, name, level, member count
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import HamburgerMenu from '../components/navigation/HamburgerMenu';
import { useNavigate } from 'react-router-dom';
import { supabase, getAuthUser } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { unionService } from '../services/UnionService';
import type { Union } from '../services/UnionService';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import './ClubCarouselPage.css';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useIsMounted } from '../hooks/useIsMounted';

const SWR_CAROUSEL_KEY = 'club_carousel_clubs_cache';
const SWR_UNIONS_KEY = 'club_carousel_unions_cache';

interface UserClub {
  id: string;
  club_id: number;
  name: string;
  avatar_url: string | null;
  level: number;
  member_count: number;
  role: string;
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
  const navigate = useNavigate();
  const { user } = useAuthUser();
  useVisibilityRefresh(() => {
    if (user?.id) loadUserData();
  });
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);

  // #7: SWR — instant render from cache
  const [clubs, setClubs] = useState<UserClub[]>(() => {
    try {
      const cached = localStorage.getItem(SWR_CAROUSEL_KEY);
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
      const cached = localStorage.getItem(SWR_UNIONS_KEY);
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

  // #4: Pull-to-refresh state
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const touchStartY = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const isMounted = useIsMounted();

  useEffect(() => {
    loadUserData();
  }, []);

  // Realtime: refresh when club, union, or union_clubs data changes
  useEffect(() => {
    const channelKey = 'club-carousel-live';
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on('postgres_changes', { event: '*', schema: 'public', table: 'club_members' }, () => {
        if (isMounted.current) loadUserData();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'clubs' }, () => {
        if (isMounted.current) loadUserData();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'unions' }, () => {
        if (isMounted.current) loadUserData();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'union_clubs' }, () => {
        if (isMounted.current) loadUserData();
      })
      .subscribe();
    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, []);

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
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  // Stagger animation for club + union cards
  useEffect(() => {
    if (clubs.length === 0 && userUnions.length === 0) return;
    setVisibleCards(new Set());
    const allItems = [...clubs.map((c) => c.id), ...userUnions.map((u) => u.id)];
    const timers = allItems.map((itemId, index) =>
      setTimeout(() => {
        setVisibleCards((prev) => new Set(prev).add(itemId));
      }, index * 60)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [clubs, userUnions]);

  // ── #6: Decomposed data loading helpers ──
  const loadProfile = useCallback(
    async (userId: string) => {
      try {
        const { data: profileData, error: profileError } = await supabase
          .from('profiles')
          .select('id, display_name, avatar_url, diamonds, tier')
          .eq('id', userId)
          .maybeSingle();
        if (!isMounted.current) return;
        if (!profileError && profileData) {
          setUserProfile({
            id: profileData.id,
            display_name: profileData.display_name || 'Player',
            avatar_url: profileData.avatar_url,
            player_number: 0,
            vip_level: profileData.tier || 'bronze',
          });
          setWallet((prev) => ({ ...prev, diamonds: profileData.diamonds || 0 }));
        }
      } catch {
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
      } catch {
        /* fail-open */
      }
      return clubList;
    },
    [isMounted]
  );

  const loadUserData = async () => {
    setLoading(true);
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
            `club_id, role, chip_balance, clubs (id, club_id, name, avatar_url, member_count)`
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
              level: 0,
              member_count: m.clubs.member_count || 0,
              role: m.role,
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
            localStorage.setItem(SWR_CAROUSEL_KEY, JSON.stringify(filtered));
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
          localStorage.setItem(SWR_UNIONS_KEY, JSON.stringify(loadedUnions));
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
      console.error('Error loading user data:', error);
      toast.error('Failed to load club data');
    } finally {
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

  // #4: Pull-to-refresh touch handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (containerRef.current && containerRef.current.scrollTop === 0) {
      touchStartY.current = e.touches[0].clientY;
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartY.current === 0) return;
    const diff = e.touches[0].clientY - touchStartY.current;
    if (diff > 0 && diff < 150) setPullDistance(diff);
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (pullDistance > 60 && !isRefreshing) {
      setIsRefreshing(true);
      setPullDistance(0);
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
  }, [pullDistance, isRefreshing, isMounted]);

  const totalCards = clubs.length + userUnions.length;

  const handlePrev = () => {
    setActiveIndex((prev) => {
      const next = prev > 0 ? prev - 1 : totalCards - 1;
      // #5: Prefetch the club we're about to show
      if (next < clubs.length) prefetchClubDetail(clubs[next]);
      return next;
    });
  };

  const handleNext = () => {
    setActiveIndex((prev) => {
      const next = prev < totalCards - 1 ? prev + 1 : 0;
      if (next < clubs.length) prefetchClubDetail(clubs[next]);
      return next;
    });
  };

  const handleClubClick = (club: UserClub) => {
    navigate(`/clubs/${club.id}`);
  };

  const handleCreateClub = () => {
    navigate('/clubs/create');
  };

  const handleSearch = () => {
    navigate('/clubs'); // Go to full clubs list for search/join
  };

  const formatNumber = (num: number) => {
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  if (loading) {
    return (
      <div className="club-carousel loading">
        <PageSkeleton variant="stats" />
      </div>
    );
  }

  return (
    <>
      <HamburgerMenu isOpen={menuOpen} onClose={() => setMenuOpen(false)} />
      <div
        className="club-carousel"
        ref={containerRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* #4: Pull-to-refresh indicator */}
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
        {/* ═══════════════════════════════════════════════════════════════════
                    HEADER - Player Info + Wallet
                ═══════════════════════════════════════════════════════════════════ */}
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
          <button className="header__menu" onClick={() => setMenuOpen(true)}>
            ≡
          </button>
        </header>

        {/* Wallet Row */}
        <div className="club-carousel__wallet">
          <div className="vip-badge">VIP</div>
          <div className="wallet-balances">
            <div className="balance gold">
              <span className="balance-icon">♠</span>
              <span className="balance-amount">{formatNumber(wallet.gold)}</span>
              <button className="balance-add">+</button>
            </div>
            <div className="balance diamond">
              <span className="balance-icon">◆</span>
              <span className="balance-amount">{wallet.diamonds.toLocaleString()}</span>
              <button className="balance-add">+</button>
            </div>
          </div>
        </div>

        {/* ═══════════════════════════════════════════════════════════════════
                ACTION BUTTONS - Create Club + Search
            ═══════════════════════════════════════════════════════════════════ */}
        <div className="club-carousel__actions">
          <button className="action-btn create" onClick={handleCreateClub}>
            <span className="action-icon">+</span>
          </button>
          <button className="action-btn search" onClick={handleSearch}>
            <span className="action-icon">SEARCH</span>
          </button>
        </div>

        {/* ═══════════════════════════════════════════════════════════════════
                CLUB CAROUSEL
            ═══════════════════════════════════════════════════════════════════ */}
        <div className="club-carousel__cards">
          {clubs.length === 0 && userUnions.length === 0 ? (
            <div className="no-clubs">
              <p>You haven't joined any clubs yet</p>
              <button className="join-btn" onClick={handleSearch}>
                Find Clubs
              </button>
            </div>
          ) : (
            <>
              {/* Left Arrow */}
              {clubs.length + userUnions.length > 1 && (
                <button className="carousel-arrow left" onClick={handlePrev}>
                  ‹
                </button>
              )}

              {/* Club + Union Cards */}
              <div className="cards-container">
                {/* Club Cards */}
                {clubs.map((club, index) => {
                  const offset = index - activeIndex;
                  const isActive = index === activeIndex;

                  return (
                    <div
                      key={club.id}
                      className={`club-card ${isActive ? 'active' : ''} ${visibleCards.has(club.id) ? 'fadeInUp' : 'hidden'}`}
                      style={{
                        transform: `translateX(${offset * 120}%) scale(${isActive ? 1 : 0.8})`,
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
                    >
                      {/* Frame overlay */}
                      <img
                        src={getFrameForClub(club.club_id)}
                        alt=""
                        className="club-card__frame"
                      />

                      {/* Card content (behind frame) */}
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
                              LVL: {club.level}
                              <span className="member-count">{club.member_count}</span>
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Union Cards */}
                {userUnions.map((union, unionIdx) => {
                  const index = clubs.length + unionIdx;
                  const offset = index - activeIndex;
                  const isActive = index === activeIndex;

                  return (
                    <div
                      key={`union-${union.id}`}
                      className={`club-card ${isActive ? 'active' : ''} ${visibleCards.has(union.id) ? 'fadeInUp' : 'hidden'}`}
                      style={{
                        transform: `translateX(${offset * 120}%) scale(${isActive ? 1 : 0.8})`,
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
                              <span className="chip-icon" style={{ fontSize: '2rem' }}>
                                🏛️
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="club-card__footer">
                          <div
                            className="club-avatar"
                            style={{ background: 'linear-gradient(135deg, #9b59b6, #8e44ad)' }}
                          >
                            <span>🏛️</span>
                          </div>
                          <div className="club-info">
                            <span className="club-name">{union.name}</span>
                            <span className="club-meta">
                              {union.clubCount || 0} clubs
                              <span className="member-count">{union.memberCount || 0}</span>
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Right Arrow */}
              {clubs.length + userUnions.length > 1 && (
                <button className="carousel-arrow right" onClick={handleNext}>
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
