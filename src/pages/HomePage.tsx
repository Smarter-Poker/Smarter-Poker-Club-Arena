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
import { supabase } from '../lib/supabase';
import { waitForAuth } from '../utils/waitForAuth';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { ClubsService } from '../services/ClubsService';
import { useToast } from '../components/common/Toast';
import GlobalHeader from '../components/navigation/GlobalHeader';
import haptic from '../services/HapticService';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PremiumSFX from '../services/PremiumSFX';
import { masterBus } from '../core/MasterBus';
import DailyChallenges from '../components/home/DailyChallenges';
import PresenceHub from '../components/home/PresenceHub';
import ClubContextMenu from '../components/home/ClubContextMenu';
import LOBBY_TILES from '../config/lobbyTiles.config';
import { postToParent } from '../utils/parentOrigin';
import styles from './HomePage.module.css';

// Lazy-load heavy components to reduce initial bundle
const CreateClubModal = lazy(() => import('../components/modals/CreateClubModal'));
const FindPlayerModal = lazy(() => import('../components/modals/FindPlayerModal'));
const ClubStatsPanel = lazy(() => import('../components/club/ClubStatsPanel'));

const LAST_VISITED_KEY = 'club_arena_last_visited';
const LAST_CLUB_KEY = 'club_arena_last_club';
const SWR_CACHE_KEY = 'club_arena_clubs_cache';
const PINNED_CLUBS_KEY = 'club_arena_pinned_clubs';
const SOUNDS_ENABLED_KEY = 'club_arena_sounds';
const CARD_COLOR_KEY = 'club_arena_card_color';

// #6: Card color presets — gradient pairs for club card faces
const CARD_COLOR_PRESETS: { id: string; name: string; bg: string; overlay: string }[] = [
  {
    id: 'default',
    name: 'Deep Ocean',
    bg: 'linear-gradient(145deg, rgba(8, 20, 40, 0.9), rgba(5, 12, 28, 0.95))',
    overlay:
      'linear-gradient(135deg, rgba(0, 212, 255, 0.06) 0%, transparent 50%, rgba(0, 255, 136, 0.04) 100%)',
  },
  {
    id: 'emerald',
    name: 'Emerald Night',
    bg: 'linear-gradient(145deg, rgba(5, 30, 20, 0.9), rgba(3, 18, 12, 0.95))',
    overlay:
      'linear-gradient(135deg, rgba(0, 255, 136, 0.08) 0%, transparent 50%, rgba(0, 212, 180, 0.05) 100%)',
  },
  {
    id: 'crimson',
    name: 'Crimson Velvet',
    bg: 'linear-gradient(145deg, rgba(40, 8, 15, 0.9), rgba(28, 5, 10, 0.95))',
    overlay:
      'linear-gradient(135deg, rgba(255, 60, 80, 0.08) 0%, transparent 50%, rgba(255, 100, 50, 0.05) 100%)',
  },
  {
    id: 'royal',
    name: 'Royal Purple',
    bg: 'linear-gradient(145deg, rgba(20, 8, 40, 0.9), rgba(12, 5, 28, 0.95))',
    overlay:
      'linear-gradient(135deg, rgba(140, 80, 255, 0.08) 0%, transparent 50%, rgba(180, 100, 255, 0.05) 100%)',
  },
  {
    id: 'gold',
    name: 'Gold Rush',
    bg: 'linear-gradient(145deg, rgba(35, 28, 8, 0.9), rgba(24, 18, 5, 0.95))',
    overlay:
      'linear-gradient(135deg, rgba(255, 200, 50, 0.08) 0%, transparent 50%, rgba(255, 160, 30, 0.05) 100%)',
  },
  {
    id: 'midnight',
    name: 'Midnight Ice',
    bg: 'linear-gradient(145deg, rgba(5, 10, 35, 0.9), rgba(3, 6, 22, 0.95))',
    overlay:
      'linear-gradient(135deg, rgba(80, 140, 255, 0.08) 0%, transparent 50%, rgba(60, 180, 255, 0.05) 100%)',
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    bg: 'linear-gradient(145deg, rgba(15, 15, 15, 0.9), rgba(8, 8, 8, 0.95))',
    overlay:
      'linear-gradient(135deg, rgba(255, 255, 255, 0.04) 0%, transparent 50%, rgba(200, 200, 200, 0.03) 100%)',
  },
  {
    id: 'neon',
    name: 'Neon Cyber',
    bg: 'linear-gradient(145deg, rgba(5, 15, 25, 0.9), rgba(3, 8, 18, 0.95))',
    overlay:
      'linear-gradient(135deg, rgba(0, 255, 200, 0.08) 0%, transparent 50%, rgba(255, 0, 200, 0.05) 100%)',
  },
];

// Action button images
const ACTION_BAR_HORIZONTAL = `${import.meta.env.BASE_URL}images/icons/action-bar-horizontal.png`;

// Enhancement #9: Unique gradient CSS classes for logo-less club cards
const GRADIENT_CLASSES = [
  styles.clubCardGradient1,
  styles.clubCardGradient2,
  styles.clubCardGradient3,
  styles.clubCardGradient4,
  styles.clubCardGradient5,
] as const;

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

// ═══════════════════════════════════════════════════════════════════════════════
// CAROUSEL SECTION — Club cards flanking the Shark Club in one swipeable row
// ═══════════════════════════════════════════════════════════════════════════════
const CLUB_ORDER_KEY = 'club_arena_club_order';

// ── Home Page Types ─────────────────────────────────────────
interface UserClub {
  id: string;
  name?: string;
  club_id?: number | string;
  logo_url?: string;
  member_count?: number;
  active_tables?: number;
  is_owner?: boolean;
  last_active_at?: string;
  [key: string]: unknown;
}

interface CarouselSectionProps {
  displayClubs: UserClub[];
  sharkClubId: string | null;
  sharkClubStats: { totalMembers: number; clubLevel: number; activePlayers: number };
  flippedCards: Set<number>;
  pinnedClubIds: string[];
  cardColorPreset: string;
  navigate: (path: string) => void;
  toast: ReturnType<typeof useToast>;
  handleContextMenu: (e: React.MouseEvent, club: UserClub) => void;
  handleLongPressStart: (club: UserClub, e: React.TouchEvent) => void;
  handleLongPressEnd: () => void;
  handleClubHoverStart: (clubId: string) => void;
  handleClubHoverEnd: () => void;
  handleTooltipEnter: (club: UserClub, e: React.MouseEvent) => void;
  handleTooltipLeave: () => void;
  onOpenJoinModal: () => void;
  onOpenCreateModal: () => void;
}

function CarouselSection({
  displayClubs,
  sharkClubId,
  sharkClubStats,
  flippedCards,
  pinnedClubIds,
  cardColorPreset,
  navigate,
  toast,
  handleContextMenu,
  handleLongPressStart,
  handleLongPressEnd,
  handleClubHoverStart,
  handleClubHoverEnd,
  handleTooltipEnter,
  handleTooltipLeave,
  onOpenJoinModal,
  onOpenCreateModal,
}: CarouselSectionProps) {
  const carouselRef = useRef<HTMLDivElement>(null);
  const sharkCardRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);

  // Enhancement #3: Quick-flip toggle (single tap = flip, double tap = navigate)
  const [quickFlipped, setQuickFlipped] = useState<Set<string>>(new Set());
  const lastTapRef = useRef<{ id: string; time: number }>({ id: '', time: 0 });

  // Enhancement #8: Drag-to-reorder state
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [orderedClubs, setOrderedClubs] = useState<UserClub[]>(displayClubs);

  // Keep orderedClubs in sync with displayClubs (respecting saved order)
  useEffect(() => {
    try {
      const savedOrder: string[] = JSON.parse(localStorage.getItem(CLUB_ORDER_KEY) || '[]');
      if (savedOrder.length > 0) {
        const orderMap = new Map(savedOrder.map((id, idx) => [id, idx]));
        const sorted = [...displayClubs].sort((a, b) => {
          // Pinned clubs always first
          const aPinned = pinnedClubIds.includes(a.id) ? 1 : 0;
          const bPinned = pinnedClubIds.includes(b.id) ? 1 : 0;
          if (bPinned !== aPinned) return bPinned - aPinned;
          // Then saved order
          const aOrder = orderMap.get(a.id) ?? 999;
          const bOrder = orderMap.get(b.id) ?? 999;
          return aOrder - bOrder;
        });
        setOrderedClubs(sorted);
      } else {
        setOrderedClubs(displayClubs);
      }
    } catch {
      setOrderedClubs(displayClubs);
    }
  }, [displayClubs, pinnedClubIds]);

  // Split user clubs into left half and right half around the Shark Club
  const leftClubs = useMemo(() => {
    const half = Math.ceil(orderedClubs.length / 2);
    return orderedClubs.slice(0, half);
  }, [orderedClubs]);

  const rightClubs = useMemo(() => {
    const half = Math.ceil(orderedClubs.length / 2);
    return orderedClubs.slice(half);
  }, [orderedClubs]);

  // Auto-scroll to center the Shark Club card on initial mount only
  useEffect(() => {
    if (hasScrolledRef.current) return;
    const timeout = setTimeout(() => {
      if (sharkCardRef.current && carouselRef.current) {
        sharkCardRef.current.scrollIntoView({
          behavior: 'smooth',
          inline: 'center',
          block: 'nearest',
        });
        hasScrolledRef.current = true;
      }
    }, 400);
    return () => clearTimeout(timeout);
  }, [orderedClubs.length]);

  // Enhancement #7: Haptic on scroll snap
  useEffect(() => {
    const el = carouselRef.current;
    if (!el) return;
    let snapTimer: ReturnType<typeof setTimeout> | null = null;
    const handleScroll = () => {
      if (snapTimer) clearTimeout(snapTimer);
      snapTimer = setTimeout(() => {
        haptic.light();
        PremiumSFX.scrollSnap();
      }, 150);
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      if (snapTimer) clearTimeout(snapTimer);
    };
  }, []);

  // Enhancement #8: Drag handlers
  const handleDragStart = useCallback((clubId: string) => {
    setDraggedId(clubId);
    PremiumSFX.dragStart();
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, clubId: string) => {
    e.preventDefault();
    setDragOverId(clubId);
  }, []);

  const handleDrop = useCallback(
    (targetId: string) => {
      if (!draggedId || draggedId === targetId) {
        setDraggedId(null);
        setDragOverId(null);
        return;
      }
      setOrderedClubs((prev) => {
        const arr = [...prev];
        const fromIdx = arr.findIndex((c) => c.id === draggedId);
        const toIdx = arr.findIndex((c) => c.id === targetId);
        if (fromIdx === -1 || toIdx === -1) return prev;
        const [moved] = arr.splice(fromIdx, 1);
        arr.splice(toIdx, 0, moved);
        // Persist order
        try {
          localStorage.setItem(CLUB_ORDER_KEY, JSON.stringify(arr.map((c) => c.id)));
        } catch {
          /* */
        }
        return arr;
      });
      setDraggedId(null);
      setDragOverId(null);
      haptic.medium();
      PremiumSFX.dragDrop();
    },
    [draggedId]
  );

  const handleDragEnd = useCallback(() => {
    setDraggedId(null);
    setDragOverId(null);
  }, []);

  // Enhancement #3: Tap handler — single tap flips, double tap navigates
  const handleCardTap = useCallback(
    (club: UserClub) => {
      const now = Date.now();
      const last = lastTapRef.current;
      if (last.id === club.id && now - last.time < 350) {
        // Double tap → navigate
        haptic.medium();
        PremiumSFX.doubleTap();
        localStorage.setItem(LAST_VISITED_KEY, club.id);
        localStorage.setItem(LAST_CLUB_KEY, club.id);
        navigate(`/clubs/${club.id}`);
        lastTapRef.current = { id: '', time: 0 };
      } else {
        // Single tap → flip for stats preview
        lastTapRef.current = { id: club.id, time: now };
        setTimeout(() => {
          if (lastTapRef.current.id === club.id && lastTapRef.current.time === now) {
            haptic.light();
            PremiumSFX.tapFlip();
            setQuickFlipped((prev) => {
              const next = new Set(prev);
              if (next.has(club.id)) next.delete(club.id);
              else next.add(club.id);
              return next;
            });
          }
        }, 350);
      }
    },
    [navigate]
  );

  // Render a single user club card in carousel style
  const renderClubCard = (club: UserClub, idx: number) => {
    const isFlipped = flippedCards.has(idx);
    const isQuickFlipped = quickFlipped.has(club.id);
    const isLive = (club.active_tables || 0) > 0;
    const isDragging = draggedId === club.id;
    const isDragTarget = dragOverId === club.id;

    return (
      <div
        key={club.id}
        className={[
          styles.carouselCard,
          isFlipped ? styles.clubCardFlipped : '',
          isQuickFlipped ? styles.carouselCardQuickFlipped : '',
          isLive ? styles.carouselCardLive : '',
          isDragging ? styles.cardDragging : '',
          isDragTarget ? styles.cardDragOver : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => handleCardTap(club)}
        onContextMenu={(e) => handleContextMenu(e, club)}
        onTouchStart={(e) => handleLongPressStart(club, e)}
        onTouchEnd={handleLongPressEnd}
        onTouchCancel={handleLongPressEnd}
        onMouseEnter={(e) => {
          handleClubHoverStart(club.id);
          handleTooltipEnter(club, e);
        }}
        onMouseLeave={() => {
          handleClubHoverEnd();
          handleTooltipLeave();
        }}
        draggable
        onDragStart={() => handleDragStart(club.id)}
        onDragOver={(e) => handleDragOver(e, club.id)}
        onDrop={() => handleDrop(club.id)}
        onDragEnd={handleDragEnd}
        role="button"
        aria-label={`${club.name || 'Club'} — ${club.is_owner ? 'Owner' : 'Member'}${isLive ? ' — Live' : ''}`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            haptic.medium();
            navigate(`/clubs/${club.id}`);
          }
        }}
      >
        {/* Pinned badge */}
        {pinnedClubIds.includes(club.id) && (
          <span className={styles.pinnedBadge} title="Pinned">
            *
          </span>
        )}
        {/* Phase 8 #3: Live table green pulse indicator */}
        {isLive && <span className={styles.liveIndicator} title="Live tables active" />}
        <div className={styles.carouselCardPedestal}></div>
        <div className={styles.clubCardFlipInner} style={{ height: '100%' }}>
          {/* Card Back (face-down) */}
          <div className={styles.clubCardFront}>
            <div className={styles.clubCardBackFace}></div>
          </div>
          {/* Card Face (data side) */}
          <div className={styles.clubCardBack}>
            {isQuickFlipped ? (
              /* Enhancement #3: Quick stats back-face */
              <div className={styles.carouselCardStatsBack}>
                <span className={styles.statsBackTitle}>STATS</span>
                <div className={styles.statsBackRow}>
                  <span className={styles.statsBackLabel}>Members</span>
                  <span className={styles.statsBackValue}>{club.member_count || 0}</span>
                </div>
                <div className={styles.statsBackRow}>
                  <span className={styles.statsBackLabel}>Tables</span>
                  <span className={styles.statsBackValue}>{club.active_tables || 0}</span>
                </div>
                <div className={styles.statsBackRow}>
                  <span className={styles.statsBackLabel}>Role</span>
                  <span className={styles.statsBackValue}>
                    {club.is_owner ? 'Owner' : 'Member'}
                  </span>
                </div>
                <div className={styles.statsBackRow}>
                  <span className={styles.statsBackLabel}>Activity</span>
                  <span className={styles.statsBackValue}>
                    {club.last_active_at
                      ? (() => {
                          const diff = Date.now() - new Date(club.last_active_at).getTime();
                          const mins = Math.floor(diff / 60000);
                          if (mins < 1) return 'Now';
                          if (mins < 60) return `${mins}m`;
                          const hrs = Math.floor(mins / 60);
                          if (hrs < 24) return `${hrs}h`;
                          return `${Math.floor(hrs / 24)}d`;
                        })()
                      : '—'}
                  </span>
                </div>
                <span className={styles.statsBackHint}>Double-tap to enter</span>
              </div>
            ) : (
              <div
                className={styles.carouselCardFace}
                style={
                  cardColorPreset !== 'default'
                    ? {
                        background: CARD_COLOR_PRESETS.find((p) => p.id === cardColorPreset)?.bg,
                      }
                    : undefined
                }
              >
                {/* Color overlay */}
                {cardColorPreset !== 'default' && (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      borderRadius: 12,
                      pointerEvents: 'none',
                      background: CARD_COLOR_PRESETS.find((p) => p.id === cardColorPreset)?.overlay,
                    }}
                  />
                )}
                <h3 className={styles.carouselCardTitle}>
                  {club.name?.toUpperCase() || 'MY CLUB'}
                </h3>
                <span className={styles.carouselCardRole}>
                  {club.is_owner ? 'OWNER' : 'MEMBER'}
                </span>
                <div className={styles.carouselCardCenter}>
                  {club.logo_url ? (
                    <img
                      src={club.logo_url}
                      alt=""
                      className={styles.carouselCardLogo}
                      loading="lazy"
                    />
                  ) : (
                    <div
                      className={`${styles.carouselCardIcon} ${GRADIENT_CLASSES[idx % GRADIENT_CLASSES.length]}`}
                    >
                      ♣
                    </div>
                  )}
                </div>
                <div className={styles.carouselCardMeta}>
                  <span>{club.member_count || 0} MEMBERS</span>
                  {(club.active_tables || 0) > 0 && (
                    <div className={styles.activeTablesBadge}>
                      <span className={styles.activeTablesDot}></span>
                      <span>{club.active_tables} Live</span>
                    </div>
                  )}
                  {club.last_active_at && (
                    <div className={styles.clubCardTimestamp}>
                      {(() => {
                        const diff = Date.now() - new Date(club.last_active_at).getTime();
                        const mins = Math.floor(diff / 60000);
                        if (mins < 1) return 'Active now';
                        if (mins < 60) return `${mins}m ago`;
                        const hrs = Math.floor(mins / 60);
                        if (hrs < 24) return `${hrs}h ago`;
                        return `${Math.floor(hrs / 24)}d ago`;
                      })()}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.clubCarousel} ref={carouselRef}>
      {/* Enhancement #2: CTA card — Join a Club (when 0 clubs) */}
      {orderedClubs.length === 0 && (
        <div
          className={styles.ctaCard}
          onClick={() => {
            haptic.light();
            PremiumSFX.ctaClick();
            onOpenJoinModal();
          }}
          role="button"
          aria-label="Join a Club"
          tabIndex={0}
        >
          <div className={styles.ctaCardIcon}>+</div>
          <span className={styles.ctaCardLabel}>Join a Club</span>
          <span className={styles.ctaCardSub}>Enter a club code to join an existing club</span>
        </div>
      )}

      {/* Left half of user clubs */}
      {leftClubs.map((club, idx) => renderClubCard(club, idx))}

      {/* SHARK CLUB — featured center card */}
      <div
        className={styles.carouselCardFeatured}
        ref={sharkCardRef}
        onClick={async () => {
          haptic.success();
          PremiumSFX.navigate();
          if (sharkClubId) {
            localStorage.setItem(LAST_VISITED_KEY, sharkClubId);
            localStorage.setItem(LAST_CLUB_KEY, sharkClubId);
            navigate(`/clubs/${sharkClubId}`);
          } else {
            // sharkClubId may not be loaded yet — try a quick lookup before giving up
            try {
              const { data: sharkClub } = await supabase
                .from('clubs')
                .select('id')
                .eq('club_id', 25450)
                .maybeSingle();
              if (sharkClub?.id) {
                localStorage.setItem(LAST_VISITED_KEY, sharkClub.id);
                localStorage.setItem(LAST_CLUB_KEY, sharkClub.id);
                navigate(`/clubs/${sharkClub.id}`);
              } else {
                console.error('[HomePage] Shark Club (25450) not found in DB');
                toast.error('Shark Club not found');
              }
            } catch (err) {
              console.error('[HomePage] Shark Club lookup failed:', err);
              toast.error('Could not load Shark Club');
            }
          }
        }}
      >
        <div className={styles.carouselFeaturedPedestal}></div>
        <Suspense fallback={<div className={styles.cardSkeleton}>Loading...</div>}>
          <ClubStatsPanel
            totalMembers={sharkClubStats.totalMembers}
            clubLevel={sharkClubStats.clubLevel}
            activePlayers={sharkClubStats.activePlayers}
          />
        </Suspense>
      </div>

      {/* Right half of user clubs */}
      {rightClubs.map((club, idx) => renderClubCard(club, leftClubs.length + idx))}

      {/* Enhancement #2: CTA card — Create a Club (when 0 clubs) */}
      {orderedClubs.length === 0 && (
        <div
          className={styles.ctaCard}
          onClick={() => {
            haptic.light();
            PremiumSFX.ctaClick();
            onOpenCreateModal();
          }}
          role="button"
          aria-label="Create a Club"
          tabIndex={0}
        >
          <div className={styles.ctaCardIcon}>+</div>
          <span className={styles.ctaCardLabel}>Create Club</span>
          <span className={styles.ctaCardSub}>Start your own poker club and invite players</span>
        </div>
      )}
    </div>
  );
}

function HomePageInner() {
  const navigate = useNavigate();
  const toast = useToast();

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
      const cached = localStorage.getItem(SWR_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      /* ignore corrupt cache */
    }
    return [];
  });

  // Enhancement #5: Card flip — track which cards have flipped
  const [flippedCards, setFlippedCards] = useState<Set<number>>(new Set());

  // Enhancement #2: Context menu state
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    club: UserClub;
  } | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Enhancement #1: Pull-to-refresh
  const [isRefreshing, setIsRefreshing] = useState(false);
  const pullStartY = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Enhancement #8: Notification badges (unread counts)
  const [tileBadges, setTileBadges] = useState<Record<string, number>>({});

  // #1: Keyboard shortcuts active flag
  const [showShortcutHint, setShowShortcutHint] = useState(false);

  // #2: Pinned clubs (persisted in localStorage)
  const [pinnedClubIds, setPinnedClubIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(PINNED_CLUBS_KEY) || '[]');
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
    return localStorage.getItem(SOUNDS_ENABLED_KEY) !== 'false';
  });

  // #12: Seasonal theme
  const seasonalTheme = useMemo(() => getSeasonalTheme(), []);

  // #13: Tooltip state
  const [tooltipClub, setTooltipClub] = useState<{ club: UserClub; x: number; y: number } | null>(
    null
  );

  // #15: Online status
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  // #6: Card color preset
  const [cardColorPreset, setCardColorPreset] = useState<string>(() => {
    return localStorage.getItem(CARD_COLOR_KEY) || 'default';
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
  useEffect(() => {
    const unsubColor = masterBus.subscribeDebounced(
      'CARD_COLOR_CHANGED',
      (event) => {
        const preset = event.payload?.preset as string;
        if (preset) setCardColorPreset(preset);
      },
      300
    );
    return () => unsubColor();
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════════
  // DATA FETCHING (with SWR cache)
  // ═══════════════════════════════════════════════════════════════════════════════
  // Refresh on tab visibility change
  useVisibilityRefresh(async () => {
    fetchUserData(true);
  });

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
        } = await supabase.auth.getUser();
        if (authUser) {
          const memberships = await ClubsService.getUserMemberships();
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
            localStorage.setItem(SWR_CACHE_KEY, JSON.stringify(clubs));
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
            (colorResult.value.data?.preferences as any)?.card_color_preset
          ) {
            const preset = (colorResult.value.data?.preferences as any)?.card_color_preset;
            if (preset !== localStorage.getItem(CARD_COLOR_KEY)) {
              localStorage.setItem(CARD_COLOR_KEY, preset);
              setCardColorPreset(preset);
            }
          }
        } else {
          if (getIsMounted && !getIsMounted()) return;
          setUserClubs([]);
          try {
            localStorage.removeItem(SWR_CACHE_KEY);
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

  useEffect(() => {
    let isMounted = true;
    fetchUserData(false, () => isMounted);

    let channel: ReturnType<typeof masterBus.getOrCreateChannel> | null = null;
    const setupRealtimeSubscription = async () => {
      const {
        data: { user: authUser },
      } = await supabase.auth.getUser();
      if (!authUser?.id) return;

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

    const unsubJoined = masterBus.subscribeDebounced(
      'CLUB_JOINED',
      () => {
        if (isMounted) fetchUserData(true, () => isMounted);
      },
      500
    );

    const unsubLeft = masterBus.subscribeDebounced(
      'CLUB_LEFT',
      () => {
        if (isMounted) fetchUserData(true, () => isMounted);
      },
      500
    );

    const unsubUpdated = masterBus.subscribeDebounced(
      'CLUB_UPDATED',
      () => {
        if (isMounted) fetchUserData(true, () => isMounted);
      },
      500
    );

    // AUTH_STATE_CHANGED: kept as immediate (auth state must propagate instantly)
    const unsubAuth = masterBus.subscribeDebounced(
      'AUTH_STATE_CHANGED',
      (event) => {
        if (!isMounted) return;
        if (event.payload.isAuthenticated) {
          fetchUserData(false, () => isMounted);
        } else {
          setUserClubs([]);
        }
      },
      300
    );

    // Enhancement #8: Listen for notification badge updates (debounced)
    const unsubNotif = masterBus.subscribeDebounced(
      'NOTIFICATION_READ',
      () => {
        // Clear all badges when notifications are read
        if (isMounted) setTileBadges({});
      },
      500
    );

    // Phase 8 #5: Listen for diamond balance changes from challenge claims (debounced)
    const unsubDiamond = masterBus.subscribeDebounced(
      'DIAMOND_BALANCE_CHANGED',
      (event) => {
        const delta = event.payload?.delta as number;
        if (delta && delta > 0 && isMounted) {
          setTileBadges((prev) => ({
            ...prev,
            'Player Stats': (prev['Player Stats'] || 0) + 1,
          }));
        }
      },
      500
    );

    return () => {
      isMounted = false;
      if (channel) {
        channel.unsubscribe();
      }
      supabase.auth.getUser().then(({ data: { user: authUser } }) => {
        if (authUser?.id) {
          masterBus.removeRegisteredChannel(`home-clubs-${authUser.id}`);
        }
      });
      unsubJoined();
      unsubLeft();
      unsubUpdated();
      unsubAuth();
      unsubNotif();
      unsubDiamond();
    };
  }, [fetchUserData]);

  // Fetch Shark Club stats — ALL data from live Supabase queries
  useEffect(() => {
    let isMounted = true;
    async function fetchSharkClubStats() {
      try {
        // Find Shark Club by club_id = 25450
        const { data: club } = await supabase
          .from('clubs')
          .select('id, member_count')
          .eq('club_id', 25450)
          .maybeSingle();

        if (!club || !isMounted) return;
        setSharkClubId(club.id);

        // 1. Real member count from clubs table (bypasses RLS on club_members)
        const memberCount = club.member_count || 0;

        // 2. Real active players: count occupied seats for THIS CLUB only
        let activePlayers = 0;
        // First get all table IDs belonging to Shark Club
        const { data: sharkTables } = await supabase
          .from('tables')
          .select('id')
          .eq('club_id', club.id);
        if (sharkTables && sharkTables.length > 0) {
          const tableIds = sharkTables.map((t: any) => t.id);
          const { count: seatCount } = await supabase
            .from('table_seats')
            .select('*', { count: 'exact', head: true })
            .in('table_id', tableIds)
            .is('left_at', null);
          activePlayers = seatCount || 0;
        }

        // 3. Club level — no column exists yet, default to 1
        if (!isMounted) return;
        const clubLevel = 1;
        setSharkClubStats({
          totalMembers: memberCount,
          clubLevel,
          activePlayers,
        });
      } catch (err) {
        console.error('Failed to fetch Shark Club stats:', err);
      }
    }
    fetchSharkClubStats();

    // Real-time clubs table updates via MasterBus channel registry
    const sharkChannelKey = 'clubs-live-stats';
    const channel = masterBus.getOrCreateChannel(sharkChannelKey);
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
      .subscribe();

    return () => {
      isMounted = false;
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
  // Enhancement #1: Pull-to-Refresh handlers
  // ═══════════════════════════════════════════════════════════════════════════════
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (containerRef.current && containerRef.current.scrollTop <= 0) {
      pullStartY.current = e.touches[0].clientY;
    }
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (pullStartY.current && !isRefreshing) {
        const delta = e.touches[0].clientY - pullStartY.current;
        if (delta > 80 && containerRef.current && containerRef.current.scrollTop <= 0) {
          setIsRefreshing(true);
          haptic.medium();
          fetchUserData(true).finally(() => {
            setTimeout(() => setIsRefreshing(false), 800);
          });
          pullStartY.current = 0;
        }
      }
    },
    [isRefreshing, fetchUserData]
  );

  const handleTouchEnd = useCallback(() => {
    pullStartY.current = 0;
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════════
  // Enhancement #2: Context Menu handlers
  // ═══════════════════════════════════════════════════════════════════════════════
  const handleContextMenu = useCallback((e: React.MouseEvent, club: UserClub) => {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, club });
  }, []);

  const handleLongPressStart = useCallback((club: UserClub, e: React.TouchEvent) => {
    e.stopPropagation(); // Prevent pull-to-refresh from activating
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
          const lastClub = localStorage.getItem(LAST_CLUB_KEY);
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
          setTooltipClub(null);
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
        localStorage.setItem(PINNED_CLUBS_KEY, JSON.stringify(next));
      } catch {
        /* */
      }
      return next;
    });
  }, []);

  // #4: Leave club with confirmation
  const handleLeaveClub = useCallback(
    async (club: UserClub) => {
      try {
        await ClubsService.leave(club.id);
        toast.success('Left the club');
        masterBus.emit('CLUB_LEFT', { clubId: club.id });
        fetchUserData(true);
        setLeaveConfirm(null);
      } catch (err: any) {
        toast.error(err.message || 'Failed to leave club');
      }
    },
    [toast, fetchUserData]
  );

  // #7: Prefetch club lobby data on hover
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleClubHoverStart = useCallback((clubId: string) => {
    prefetchTimerRef.current = setTimeout(async () => {
      try {
        // Prefetch basic club data into browser fetch cache
        const { data } = await supabase
          .from('club_members')
          .select('*, club:clubs(*)', { count: 'exact', head: false })
          .eq('club_id', await resolveClubUUID(clubId))
          .limit(5);
        // Store in sessionStorage for instant lobby render
        if (data) {
          try {
            sessionStorage.setItem(`prefetch_club_${clubId}`, JSON.stringify(data));
          } catch {
            /* */
          }
        }
      } catch {
        /* silent prefetch */
      }
    }, 300);
  }, []);

  const handleClubHoverEnd = useCallback(() => {
    if (prefetchTimerRef.current) {
      clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
  }, []);

  // BUG FIX #1: Cleanup prefetch timer on unmount
  useEffect(() => {
    return () => {
      if (prefetchTimerRef.current) {
        clearTimeout(prefetchTimerRef.current);
      }
    };
  }, []);

  // #11: Toggle sound effects
  const toggleSounds = useCallback(() => {
    setSoundsEnabled((prev) => {
      const next = !prev;
      localStorage.setItem(SOUNDS_ENABLED_KEY, String(next));
      if (next) PremiumSFX.toggleOn();
      else PremiumSFX.toggleOff();
      return next;
    });
  }, []);

  // #13: Tooltip for desktop hover (club stats)
  const handleTooltipEnter = useCallback((club: UserClub, e: React.MouseEvent) => {
    setTooltipClub({ club, x: e.clientX, y: e.clientY });
  }, []);
  const handleTooltipLeave = useCallback(() => {
    setTooltipClub(null);
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

      if (error || !club) {
        toast.error('Invalid club code. Please check and try again.');
        setIsValidatingCode(false);
        return;
      }

      // Valid club found - show referral prompt
      setValidClubId(club.id);
      setShowReferralPrompt(true);
    } catch (err) {
      console.error('Error validating club code:', err);
      toast.error('Failed to validate club code');
    } finally {
      setIsValidatingCode(false);
    }
  };

  const handleJoinWithReferral = async () => {
    if (!validClubId) return;

    try {
      // Store referral code for future tracking/attribution
      if (referralCode) {
        localStorage.setItem(`referral_${validClubId}`, referralCode);
      }
      await ClubsService.join(validClubId);
      toast.success('Successfully joined the club!');
      setShowJoinModal(false);
      setShowReferralPrompt(false);
      setClubCode('');
      setReferralCode('');
      // Emit bus event + refresh instead of full page reload
      masterBus.emit('CLUB_JOINED', { clubId: validClubId });
      setValidClubId(null);
      fetchUserData(true);
    } catch (err: any) {
      toast.error(err.message || 'Failed to join club');
    }
  };

  const handleJoinWithoutReferral = async () => {
    if (!validClubId) return;

    try {
      await ClubsService.join(validClubId);
      toast.success('Successfully joined the club!');
      setShowJoinModal(false);
      setShowReferralPrompt(false);
      setClubCode('');
      // Emit bus event + refresh instead of full page reload
      masterBus.emit('CLUB_JOINED', { clubId: validClubId });
      setValidClubId(null);
      fetchUserData(true);
    } catch (err: any) {
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
  // Enhancement #5: Staggered card flip after data loads
  // ═══════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!isLoading && displayClubs.length > 0) {
      const timerIds: ReturnType<typeof setTimeout>[] = [];
      displayClubs.forEach((_: UserClub, idx: number) => {
        const id = setTimeout(
          () => {
            setFlippedCards((prev) => new Set(prev).add(idx));
            // #10: Haptic on each card flip
            haptic.light();
            if (soundsEnabled) PremiumSFX.cardFlip();
          },
          300 + idx * 150
        );
        timerIds.push(id);
      });
      return () => {
        timerIds.forEach((id) => clearTimeout(id));
      };
    }
  }, [isLoading, displayClubs.length, soundsEnabled]);
  // Tile action handlers (for bottom row tiles using LOBBY_TILES config)
  const tileActions: Record<string, () => void> = useMemo(
    () => ({
      Cashier: () => {
        haptic.light();
        PremiumSFX.navigate();
        const lastClub = localStorage.getItem(LAST_CLUB_KEY);
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
      ref={containerRef}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
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
        {/* Enhancement #1: Pull-to-Refresh Indicator */}
        <div
          className={`${styles.pullToRefresh} ${isRefreshing ? styles.pullToRefreshActive : ''}`}
        >
          {isRefreshing && (
            <>
              <div className={styles.pullSpinner}></div>
              <span className={styles.pullText}>Refreshing</span>
            </>
          )}
        </div>

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
          flippedCards={flippedCards}
          pinnedClubIds={pinnedClubIds}
          cardColorPreset={cardColorPreset}
          navigate={navigate}
          toast={toast}
          handleContextMenu={handleContextMenu}
          handleLongPressStart={handleLongPressStart}
          handleLongPressEnd={handleLongPressEnd}
          handleClubHoverStart={handleClubHoverStart}
          handleClubHoverEnd={handleClubHoverEnd}
          handleTooltipEnter={handleTooltipEnter}
          handleTooltipLeave={handleTooltipLeave}
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
          <div
            style={{
              textAlign: 'center',
              padding: '24px 16px',
              color: 'rgba(176, 179, 184, 0.6)',
              fontSize: '0.85rem',
              fontWeight: 600,
              letterSpacing: '0.03em',
            }}
          >
            No clubs match "{searchQuery}"
          </div>
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

      {/* #13: Club tooltip (desktop hover) */}
      {tooltipClub && (
        <div
          className={styles.clubTooltip}
          style={{
            top: Math.min(tooltipClub.y - 10, window.innerHeight - 120),
            left: Math.min(tooltipClub.x + 15, window.innerWidth - 220),
          }}
        >
          <div className={styles.tooltipTitle}>{tooltipClub.club.name}</div>
          <div className={styles.tooltipRow}>Members: {tooltipClub.club.member_count || 0}</div>
          <div className={styles.tooltipRow}>
            Active Tables: {tooltipClub.club.active_tables || 0}
          </div>
          <div className={styles.tooltipRow}>
            Role: {tooltipClub.club.is_owner ? 'Owner' : 'Member'}
          </div>
          {tooltipClub.club.club_id && (
            <div className={styles.tooltipRow}>Code: {tooltipClub.club.club_id}</div>
          )}
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
          <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
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
                  <button className={styles.modalButtonPrimary} onClick={handleJoinWithReferral}>
                    Join with Referral
                  </button>
                  <button
                    className={styles.modalButtonSecondary}
                    onClick={handleJoinWithoutReferral}
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
