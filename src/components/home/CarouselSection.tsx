/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CAROUSEL SECTION — Club cards flanking the Shark Club in one swipeable row
 * ═══════════════════════════════════════════════════════════════════════════════
 * Extracted from HomePage.tsx for maintainability.
 */

import { useState, useEffect, useRef, useCallback, useMemo, Suspense, lazy } from 'react';
import { supabase } from '../../lib/supabase';
import type { useToast } from '../common/Toast';
import haptic from '../../services/HapticService';
import PremiumSFX from '../../services/PremiumSFX';
import { formatTimeAgo } from '../../utils/formatTimeAgo';
import styles from '../../pages/HomePage.module.css';

// Lazy-load heavy component
const ClubStatsPanel = lazy(() => import('../club/ClubStatsPanel'));

const LAST_VISITED_KEY = 'club_arena_last_visited';
const LAST_CLUB_KEY = 'club_arena_last_club';
const CLUB_ORDER_KEY = 'club_arena_club_order';

// Card color presets — gradient pairs for club card faces
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

// Unique gradient CSS classes for logo-less club cards
const GRADIENT_CLASSES = [
  styles.clubCardGradient1,
  styles.clubCardGradient2,
  styles.clubCardGradient3,
  styles.clubCardGradient4,
  styles.clubCardGradient5,
] as const;

// ── Types ─────────────────────────────────────────
export interface UserClub {
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

export interface CarouselSectionProps {
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
  onOpenJoinModal: () => void;
  onOpenCreateModal: () => void;
}

export default function CarouselSection({
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
          const aPinned = pinnedClubIds.includes(a.id) ? 1 : 0;
          const bPinned = pinnedClubIds.includes(b.id) ? 1 : 0;
          if (bPinned !== aPinned) return bPinned - aPinned;
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
  // Timer ref for cleanup on unmount (prevents setState-after-unmount)
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    };
  }, []);

  const handleCardTap = useCallback(
    (club: UserClub) => {
      const now = Date.now();
      const last = lastTapRef.current;
      if (last.id === club.id && now - last.time < 350) {
        // Double-tap — navigate
        if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
        haptic.medium();
        PremiumSFX.doubleTap();
        localStorage.setItem(LAST_VISITED_KEY, club.id);
        localStorage.setItem(LAST_CLUB_KEY, club.id);
        navigate(`/clubs/${club.id}`);
        lastTapRef.current = { id: '', time: 0 };
      } else {
        // Single-tap — wait 350ms then flip
        lastTapRef.current = { id: club.id, time: now };
        tapTimerRef.current = setTimeout(() => {
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
          tapTimerRef.current = null;
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
        {pinnedClubIds.includes(club.id) && (
          <span className={styles.pinnedBadge} title="Pinned">
            *
          </span>
        )}
        {isLive && <span className={styles.liveIndicator} title="Live tables active" />}
        <div className={styles.carouselCardPedestal}></div>
        <div className={styles.clubCardFlipInner} style={{ height: '100%' }}>
          <div className={styles.clubCardFront}>
            <div className={styles.clubCardBackFace}></div>
          </div>
          <div className={styles.clubCardBack}>
            {isQuickFlipped ? (
              <div className={styles.carouselCardStatsBack}>
                <span className={styles.statsBackTitle}>STATS</span>
                <div className={styles.statsBackRow}>
                  <span className={styles.statsBackLabel}>Members</span>
                  <span className={styles.statsBackValue}>
                    {(club.member_count || 0).toLocaleString()}
                  </span>
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
                    {club.last_active_at ? formatTimeAgo(club.last_active_at, true) : '—'}
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
                  <span>{(club.member_count || 0).toLocaleString()} MEMBERS</span>
                  {(club.active_tables || 0) > 0 && (
                    <div className={styles.activeTablesBadge}>
                      <span className={styles.activeTablesDot}></span>
                      <span>{club.active_tables} Live</span>
                    </div>
                  )}
                  {club.last_active_at && (
                    <div className={styles.clubCardTimestamp}>
                      {formatTimeAgo(club.last_active_at)}
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
        <Suspense fallback={<div className={styles.cardSkeleton} />}>
          <ClubStatsPanel
            totalMembers={sharkClubStats.totalMembers}
            clubLevel={sharkClubStats.clubLevel}
            activePlayers={sharkClubStats.activePlayers}
          />
        </Suspense>
      </div>

      {rightClubs.map((club, idx) => renderClubCard(club, leftClubs.length + idx))}

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
