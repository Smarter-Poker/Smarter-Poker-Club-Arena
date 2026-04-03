/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CAROUSEL SECTION — All club cards rendered as fully displayed featured cards
 * ═══════════════════════════════════════════════════════════════════════════════
 * Every club (Shark Club, Club JAQK, Midway Union, user-created clubs, etc.)
 * renders as a premium, clickable card with the metal-frame background and
 * live stats. Single-click navigates to the club's lobby.
 */

import { useState, useEffect, useRef, useCallback, useMemo, Suspense, lazy } from 'react';
import { supabase } from '../../lib/supabase';
import type { useToast } from '../common/Toast';
import haptic from '../../services/HapticService';
import PremiumSFX from '../../services/PremiumSFX';
import { STORAGE_KEYS } from '../../lib/storage';
import { SHARK_CLUB_ID } from '../../lib/constants';
import styles from '../../pages/HomePage.module.css';
import { PageErrorBoundary } from '../common/PageErrorBoundary';
import { reportError } from '../../utils/errorReporter';

// Lazy-load heavy component
const ClubStatsPanel = lazy(() => import('../club/ClubStatsPanel'));
const ClubCardPanel = lazy(() => import('../club/ClubCardPanel'));

// ── Types ─────────────────────────────────────────
export interface UserClub {
  id: string;
  name?: string;
  club_id?: number | string;
  logo_url?: string;
  card_image_url?: string;
  member_count?: number;
  active_tables?: number;
  is_owner?: boolean;
  last_active_at?: string;
  entity_type?: 'club' | 'union';
  [key: string]: unknown;
}

export interface ClubStats {
  totalMembers: number;
  clubLevel: number;
  activePlayers: number;
}

export interface CarouselSectionProps {
  displayClubs: UserClub[];
  sharkClubId: string | null;
  sharkClubStats: { totalMembers: number | null; clubLevel: number | null; activePlayers: number | null };
  clubStats: Record<string, ClubStats>;
  pinnedClubIds: string[];
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
  clubStats,
  pinnedClubIds,
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

  // Enhancement #8: Drag-to-reorder state
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [orderedClubs, setOrderedClubs] = useState<UserClub[]>(displayClubs);

  // Keep orderedClubs in sync with displayClubs (respecting saved order)
  useEffect(() => {
    try {
      const savedOrder: string[] = JSON.parse(
        localStorage.getItem(STORAGE_KEYS.CLUB_ORDER) || '[]'
      );
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
    } catch (e) {
      reportError(e, 'CarouselSection.sort');
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
  // Dep array is [] — hasScrolledRef prevents re-scroll; orderedClubs is not needed
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
     
  }, []);

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
          localStorage.setItem(STORAGE_KEYS.CLUB_ORDER, JSON.stringify(arr.map((c) => c.id)));
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

  // Single-click handler: navigate directly to club lobby
  const handleClubCardClick = useCallback(
    (club: UserClub) => {
      haptic.success();
      PremiumSFX.navigate();
      localStorage.setItem(STORAGE_KEYS.LAST_VISITED, club.id);
      localStorage.setItem(STORAGE_KEYS.LAST_CLUB, club.id);
      navigate(`/clubs/${club.id}`);
    },
    [navigate]
  );

  // Shark Club click handler — extracted so both onClick and onKeyDown share the same logic
  const handleSharkClick = useCallback(async () => {
    haptic.success();
    PremiumSFX.navigate();
    if (sharkClubId) {
      localStorage.setItem(STORAGE_KEYS.LAST_VISITED, sharkClubId);
      localStorage.setItem(STORAGE_KEYS.LAST_CLUB, sharkClubId);
      navigate(`/clubs/${sharkClubId}`);
    } else {
      // Fallback: query DB with a 5s timeout to prevent indefinite hangs
      try {
        const fetchWithTimeout = Promise.race([
          supabase.from('clubs').select('id').eq('club_id', SHARK_CLUB_ID).maybeSingle(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        const { data: sharkClub } = await fetchWithTimeout;
        if (sharkClub?.id) {
          localStorage.setItem(STORAGE_KEYS.LAST_VISITED, sharkClub.id);
          localStorage.setItem(STORAGE_KEYS.LAST_CLUB, sharkClub.id);
          navigate(`/clubs/${sharkClub.id}`);
          return;
        }
      } catch {
        // Timed out or failed — fall through to last resort
      }
      // Last resort: navigate using the integer club_id (ClubHomePage resolves it)
      navigate(`/clubs/${SHARK_CLUB_ID}`);
    }
  }, [sharkClubId, navigate]);

  // Render a single user club card as a featured-style card — memoized to prevent
  // unnecessary re-creation on every render cycle
  const renderClubCard = useCallback(
    (club: UserClub) => {
      const isDragging = draggedId === club.id;
      const isDragTarget = dragOverId === club.id;
      const stats = clubStats[club.id];

      return (
        <div
          key={club.id}
          className={[
            styles.carouselCardFeatured,
            isDragging ? styles.cardDragging : '',
            isDragTarget ? styles.cardDragOver : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => handleClubCardClick(club)}
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
          aria-label={`${club.name || 'Club'} — Click to enter lobby`}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleClubCardClick(club);
            }
          }}
        >
          {pinnedClubIds.includes(club.id) && (
            <span className={styles.pinnedBadge} title="Pinned">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
              </svg>
            </span>
          )}
          <div className={styles.carouselFeaturedPedestal}></div>
          <Suspense fallback={<div className={styles.cardSkeleton} />}>
            <PageErrorBoundary pageName={club.name || 'Club Card'}>
              <ClubCardPanel
                clubName={club.name?.toUpperCase() || 'MY CLUB'}
                totalMembers={stats?.totalMembers ?? club.member_count ?? 0}
                clubLevel={stats?.clubLevel ?? 1}
                activePlayers={stats?.activePlayers ?? 0}
                clubId={club.club_id}
                cardImageUrl={club.card_image_url || (Number(club.club_id) === SHARK_CLUB_ID ? `${import.meta.env.BASE_URL || '/'}images/shark-club-card-v25.jpg` : undefined)}
                logoUrl={club.logo_url}
                entityType={club.entity_type || 'club'}
              />
            </PageErrorBoundary>
          </Suspense>
        </div>
      );
    },
    [
      draggedId,
      dragOverId,
      clubStats,
      handleClubCardClick,
      handleContextMenu,
      handleLongPressStart,
      handleLongPressEnd,
      handleDragStart,
      handleDragOver,
      handleDrop,
      handleDragEnd,
      pinnedClubIds,
    ]
  );

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
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              haptic.light();
              PremiumSFX.ctaClick();
              onOpenJoinModal();
            }
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

      {leftClubs.map((club) => renderClubCard(club))}

      {/* SHARK CLUB — featured center card */}
      <div
        className={styles.carouselCardFeatured}
        ref={sharkCardRef}
        role="button"
        aria-label="Shark Club — Click to enter lobby"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleSharkClick();
          }
        }}
        onClick={handleSharkClick}
      >
        <div className={styles.carouselFeaturedPedestal}></div>
        <div className={styles.featuredClubLabel}>★ FEATURED CLUB ★</div>
        <Suspense fallback={<div className={styles.cardSkeleton} />}>
          <PageErrorBoundary pageName="Shark Club">
            <ClubStatsPanel
              totalMembers={sharkClubStats.totalMembers}
              clubLevel={sharkClubStats.clubLevel}
              activePlayers={sharkClubStats.activePlayers}
            />
          </PageErrorBoundary>
        </Suspense>
      </div>

      {rightClubs.map((club) => renderClubCard(club))}

      {orderedClubs.length === 0 && (
        <div
          className={styles.ctaCard}
          onClick={() => {
            haptic.light();
            PremiumSFX.ctaClick();
            onOpenCreateModal();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              haptic.light();
              PremiumSFX.ctaClick();
              onOpenCreateModal();
            }
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
