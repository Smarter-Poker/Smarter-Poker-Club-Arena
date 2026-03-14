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

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import IntroVideo from '../components/IntroVideo';
import './ClubCarouselPage.css';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useIsMounted } from '../hooks/useIsMounted';

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

// Session key for intro video
const INTRO_SHOWN_KEY = 'club_arena_intro_shown';

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

  const [clubs, setClubs] = useState<UserClub[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [wallet, setWallet] = useState<UserWallet>({ gold: 0, diamonds: 0 });
  const [visibleCards, setVisibleCards] = useState<Set<string>>(new Set());

  // Intro video state - only show once per session
  const [showIntro, setShowIntro] = useState(() => {
    const shown = sessionStorage.getItem(INTRO_SHOWN_KEY);
    return !shown; // Show intro if not shown yet
  });

  // Handle intro completion
  const handleIntroComplete = () => {
    sessionStorage.setItem(INTRO_SHOWN_KEY, 'true');
    setShowIntro(false);
  };

  const isMounted = useIsMounted();

  useEffect(() => {
    loadUserData();
  }, []);

  // Realtime: refresh when club data changes
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
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  // Stagger animation for club cards
  useEffect(() => {
    if (clubs.length === 0) return;
    setVisibleCards(new Set());
    const timers = clubs.map((club, index) =>
      setTimeout(() => {
        setVisibleCards((prev) => new Set(prev).add(club.id));
      }, index * 60)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [clubs]);

  const loadUserData = async () => {
    setLoading(true);
    try {
      const {
        data: { user: authUser },
      } = await supabase.auth.getUser();
      if (!isMounted.current) return;
      if (!authUser) {
        navigate('/auth');
        return;
      }

      // Load user profile (use only columns that exist in profiles table)
      try {
        const { data: profileData, error: profileError } = await supabase
          .from('profiles')
          .select('id, display_name, avatar_url, diamonds')
          .eq('id', authUser.id)
          .maybeSingle();

        if (!isMounted.current) return;
        if (profileError) {
          // Profile query returned non-critical error
        } else if (profileData) {
          setUserProfile({
            id: profileData.id,
            display_name: profileData.display_name || 'Player',
            avatar_url: profileData.avatar_url,
            player_number: 0, // Not available in profiles table
            vip_level: 'bronze', // Default, not in profiles table
          });
          // Get diamonds from profiles table
          setWallet((prev) => ({ ...prev, diamonds: profileData.diamonds || 0 }));
        }
      } catch (err) {
        // Non-critical profile load error
      }

      if (!isMounted.current) return;

      // Load user's clubs (where they are a member)
      try {
        const { data: memberData, error: memberError } = await supabase
          .from('club_members')
          .select(
            `
                        club_id,
                        role,
                        chip_balance,
                        clubs (
                            id,
                            club_id,
                            name,
                            avatar_url,
                            member_count
                        )
                    `
          )
          .eq('user_id', authUser.id);

        if (!isMounted.current) return;
        if (memberError) {
          // Memberships query returned non-critical error
        } else if (memberData) {
          const userClubs: UserClub[] = memberData
            .filter((m: any) => m.clubs)
            .map((m: any) => ({
              id: m.clubs.id,
              club_id: m.clubs.club_id,
              name: m.clubs.name,
              avatar_url: m.clubs.avatar_url,
              level: 0, // Club level from settings
              member_count: m.clubs.member_count || 0,
              role: m.role,
            }));
          setClubs(userClubs);

          // Calculate total gold from all clubs
          const totalGold = memberData.reduce(
            (sum: number, m: any) => sum + (m.chip_balance || 0),
            0
          );
          setWallet((prev) => ({ ...prev, gold: totalGold }));
        }
      } catch (err) {
        // Non-critical memberships load error
      }
    } catch (error) {
      if (!isMounted.current) return;
      console.error('Error loading user data:', error);
      toast.error('Failed to load club data');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  };

  const handlePrev = () => {
    setActiveIndex((prev) => (prev > 0 ? prev - 1 : clubs.length - 1));
  };

  const handleNext = () => {
    setActiveIndex((prev) => (prev < clubs.length - 1 ? prev + 1 : 0));
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
      {/* Intro Video - plays on first entry while content loads in background */}
      {showIntro && (
        <IntroVideo
          videoSrc="/videos/club-arena-intro.mp4"
          minDuration={3000}
          onComplete={handleIntroComplete}
        />
      )}

      <div className="club-carousel">
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
          <button className="header__menu">≡</button>
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
          {clubs.length === 0 ? (
            <div className="no-clubs">
              <p>You haven't joined any clubs yet</p>
              <button className="join-btn" onClick={handleSearch}>
                Find Clubs
              </button>
            </div>
          ) : (
            <>
              {/* Left Arrow */}
              {clubs.length > 1 && (
                <button className="carousel-arrow left" onClick={handlePrev}>
                  ‹
                </button>
              )}

              {/* Club Cards */}
              <div className="cards-container">
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
              </div>

              {/* Right Arrow */}
              {clubs.length > 1 && (
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
