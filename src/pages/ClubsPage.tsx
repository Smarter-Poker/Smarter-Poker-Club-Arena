/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Clubs Page
 * ═══════════════════════════════════════════════════════════════════════════════
 * Browse, join, and manage clubs
 *
 * NO HARDCODED DATA - All data comes from Supabase
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getAuthUser } from '../lib/supabase';
import { isAgentRole, isClubPrincipal, isClubStaff, roleLabel } from '../types/clubRoles';
import { masterBus } from '../core/MasterBus';
import { ClubsService } from '../services/ClubsService';
import { ClubJoinService } from '../services/ClubJoinService';
import { unionService } from '../services/UnionService';
import type { Union } from '../services/UnionService';
import { NoClubsEmpty } from '../components/common/EmptyState';
import { CardSkeleton } from '../components/skeletons/CardSkeleton';
import CreateClubModal from '../components/modals/CreateClubModal';
import JoinClubModal from '../components/modals/JoinClubModal';
import { useToast } from '../components/common/Toast';
import IntroVideo from '../components/IntroVideo';
import haptic from '../services/HapticService';
// Metal UI removed — using CSS Modules (Facebook Dark)
import ClubDiscovery from '../components/clubs/ClubDiscovery';
import { getClubLevel } from '../utils/clubLevels';
import styles from './ClubsPage.module.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { STORAGE_KEYS } from '../lib/storage';
import { reportError } from '../utils/errorReporter';
import { isJoinableClubCode } from '../utils/clubCode';

// The 'create' tab died with the inline create form — creation now lives in
// CreateClubModal. Keeping the variant around left NoClubsEmpty pointing at a
// tab that rendered nothing.
type Tab = 'discover' | 'my-clubs';

interface Club {
  id: string;
  slug?: string;
  club_id: number;
  name: string;
  member_count: number;
  is_owner?: boolean;
  online_count?: number;
  table_count?: number;
  level?: number;
  player_level?: number;
  hierarchy_level?: number;
  hierarchy_units?: number;
  hierarchy_units_rounded_up?: number;
  player_threshold_current?: number;
  player_threshold_next?: number;
  hierarchy_threshold_current?: number;
  hierarchy_threshold_next?: number;
}

interface Membership {
  id?: string;
  club_id: string;
  role: string;
  club: Club;
}

// Local aliases for centralized storage keys

export default function ClubsPage() {
  useEffect(() => {
    document.title = 'Clubs | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  useVisibilityRefresh(() => loadMyClubs());

  const initialJoinCode = searchParams.get('c') || '';
  const initialReferralCode = searchParams.get('ref') || '';
  const initialTab =
    searchParams.get('join') === 'true' || initialJoinCode ? 'discover' : 'my-clubs';

  const [activeTab, setActiveTab] = useState<Tab>(initialTab as Tab);

  // Deep link (`/clubs-list?c=12345&ref=AB12`, or `?join=true`): captured ONCE,
  // because the effect below strips the params from the URL immediately — a
  // re-render after that must not lose the code the link carried. The captured
  // values open the Join modal prefilled; the old inline join form these params
  // used to feed was removed in the modal redesign, which silently killed every
  // shared join link until this wiring was added.
  const [deepLink] = useState(() => ({
    code: isJoinableClubCode(initialJoinCode) ? initialJoinCode.trim() : '',
    ref: initialReferralCode.trim(),
    join: searchParams.get('join') === 'true',
  }));

  // Clear params from URL without reloading if they exist
  useEffect(() => {
    if (searchParams.has('c') || searchParams.has('join') || searchParams.has('ref')) {
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('c');
      newParams.delete('ref');
      newParams.delete('join');
      setSearchParams(newParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Intro video state - only show once per session
  // DISABLED — intro video turned off. To re-enable, restore the original useState initializer.
  const [showIntro, setShowIntro] = useState(false);

  // Real data states
  // SWR — instant render from cache on revisit
  const [myClubs, setMyClubs] = useState<Membership[]>(() => {
    try {
      const cached = localStorage.getItem(STORAGE_KEYS.CLUBS_PAGE_CACHE);
      if (cached) {
        const p = JSON.parse(cached);
        if (Array.isArray(p) && p.length > 0) {
          // UNION LAW: never flash the union house-club card from a stale
          // cache (pre-law caches may still contain it). The fetch re-adds
          // it for the owner.
          return p.filter((m: any) => {
            const club = m?.club;
            return club && !(club.union_id && club.id === club.union_id);
          });
        }
      }
    } catch {
      /* ignore */
    }
    return [];
  });
  const [myUnions, setMyUnions] = useState<Union[]>(() => {
    try {
      const cached = localStorage.getItem(STORAGE_KEYS.CLUBS_PAGE_UNIONS_CACHE);
      if (cached) {
        const p = JSON.parse(cached);
        if (Array.isArray(p) && p.length > 0) return p;
      }
    } catch {
      /* ignore */
    }
    return [];
  });
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [showCreateModal, setShowCreateModal] = useState(false);
  // A deep-linked code (or ?join=true) opens the Join modal on arrival.
  const [showJoinModal, setShowJoinModal] = useState(() => !!deepLink.code || deepLink.join);
  const [visibleClubCards, setVisibleClubCards] = useState(new Set<number>());

  // #3: Request deduplication — prevent concurrent loadMyClubs() from stacking
  const loadingRef = useRef(false);
  // #5: Differentiate initial load (skeleton) from background refresh (silent)
  const initialLoadDone = useRef(false);

  // Handle intro completion
  const handleIntroComplete = () => {
    sessionStorage.setItem(STORAGE_KEYS.INTRO_SHOWN, 'true');
    setShowIntro(false);
  };

  // Stagger club + union cards on render
  useEffect(() => {
    setVisibleClubCards(new Set());
    const totalItems = myClubs.length + myUnions.length;
    const timers = Array.from({ length: totalItems }, (_, i) =>
      setTimeout(() => setVisibleClubCards((prev) => new Set([...prev, i])), i * 60)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [myClubs.length, myUnions.length]);

  const loadMyClubs = async (getIsMounted?: () => boolean) => {
    // #3: Skip if already loading (prevents concurrent calls from realtime)
    if (loadingRef.current) return;
    loadingRef.current = true;

    // #5: Only show skeleton on initial load, not on background refreshes
    if (!initialLoadDone.current) setIsLoading(true);

    try {
      if (getIsMounted && !getIsMounted()) return;

      // Fetch clubs AND unions in parallel
      const {
        data: { user: authUser },
      } = await getAuthUser();
      const [memberships, unions] = await Promise.all([
        ClubsService.getUserMemberships(authUser),
        authUser
          ? unionService.getMyUnions(authUser.id).catch((err) => {
              console.warn('[ClubsPage] Failed to load unions:', err);
              return [] as Union[];
            })
          : Promise.resolve([] as Union[]),
      ]);
      if (getIsMounted && !getIsMounted()) return;
      setCurrentUserId(authUser?.id || null);

      // UNION LAW (2026-08-19, Dan): players always enter through THEIR club
      // card — union games surface inside the club lobby. The union house-club
      // card (club.id === club.union_id, e.g. Midway Union) is an operations
      // surface shown ONLY to its owner. Union cards are owner-only too.
      const displayedClubs = memberships.filter((m) => {
        const club = m.club as any;
        if (!club) return false;
        const isUnionHouseClub = !!club.union_id && club.id === club.union_id;
        return !isUnionHouseClub || club.owner_id === authUser?.id;
      });
      const visibleUnions = unions.filter((u) => u.ownerId === authUser?.id);

      setMyClubs(displayedClubs);
      setMyUnions(visibleUnions);
      // SWR cache write
      try {
        localStorage.setItem(STORAGE_KEYS.CLUBS_PAGE_CACHE, JSON.stringify(displayedClubs));
      } catch {
        /* quota */
      }
      try {
        localStorage.setItem(STORAGE_KEYS.CLUBS_PAGE_UNIONS_CACHE, JSON.stringify(visibleUnions));
      } catch {
        /* quota */
      }
    } catch (err) {
      reportError(err, 'ClubsPage.Failed_to_load_memberships');
      toast.error('Failed to load your clubs');
      if (getIsMounted && !getIsMounted()) return;
      setMyClubs([]);
      setMyUnions([]);
      // Clear SWR cache on error so stale data isn't shown on next visit
      try {
        localStorage.removeItem(STORAGE_KEYS.CLUBS_PAGE_CACHE);
      } catch {
        /* ignore */
      }
      try {
        localStorage.removeItem(STORAGE_KEYS.CLUBS_PAGE_UNIONS_CACHE);
      } catch {
        /* ignore */
      }
    } finally {
      loadingRef.current = false;
      initialLoadDone.current = true;
      if (!getIsMounted || getIsMounted()) setIsLoading(false);
    }
  };

  // Load user's clubs
  useEffect(() => {
    let isMounted = true;
    loadMyClubs(() => isMounted);

    // NOTE (2026-04-19): Realtime `postgres_changes` listeners on club_members, clubs,
    // unions, union_clubs REMOVED. These were unfiltered global listeners (event: '*',
    // no filter) that fired on EVERY mutation across ALL clubs/unions, generating massive
    // realtime message volume. The MasterBus event listeners below (CLUB_JOINED, CLUB_LEFT,
    // CLUB_UPDATED, UNION_UPDATED, etc.) already handle all cross-page refresh needs.

    return () => {
      isMounted = false;
    };
  }, []);

  // ── Bus Listeners: cross-page event reactivity (debounced) ──
  useEffect(() => {
    let isMounted = true;
    const handler = () => {
      if (isMounted) loadMyClubs(() => isMounted);
    };
    const unsubs = [
      masterBus.subscribeDebounced('CLUB_JOINED', handler, 500),
      masterBus.subscribeDebounced('CLUB_LEFT', handler, 500),
      masterBus.subscribeDebounced('CLUB_UPDATED', handler, 500),
      masterBus.subscribeDebounced('CLUB_SETTINGS_UPDATED', handler, 500),
      masterBus.subscribeDebounced('UNION_UPDATED', handler, 500),
      // Level recompute: role promotions trigger SQL level recalc
      masterBus.subscribeDebounced('AGENT_UPDATED', handler, 500),
      masterBus.subscribeDebounced('MEMBER_ROLE_CHANGED', handler, 500),
    ];
    return () => {
      isMounted = false;
      unsubs.forEach((u) => u());
    };
  }, []);

  return (
    <>
      {/* Intro Video - plays on first load while content loads in background */}
      {showIntro && (
        <IntroVideo
          videoSrc="/videos/club-arena-intro.mp4"
          minDuration={3000}
          onComplete={handleIntroComplete}
        />
      )}

      <div className={styles.page}>
        {/* Header */}
        <div className={styles.pageIntro}>
          <p className={styles.subtitle}>Join Private Poker Communities Or Create Your Own.</p>
        </div>

        {/* Tabs */}
        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${activeTab === 'discover' ? styles.active : ''}`}
            onClick={() => {
              haptic.selection();
              setActiveTab('discover');
            }}
          >
            Discover
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'my-clubs' ? styles.active : ''}`}
            onClick={() => {
              haptic.selection();
              setActiveTab('my-clubs');
            }}
          >
            My Clubs
          </button>
        </div>

        {/* Tab Content */}
        <div className={styles.content}>
          {/* Discover Tab */}
          {activeTab === 'discover' && (
            <div className={styles.discoverTab}>
              <section
                className={styles.joinSection}
                style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}
              >
                <button
                  className={styles.btnPrimary}
                  onClick={() => {
                    haptic.selection();
                    setShowJoinModal(true);
                  }}
                >
                  JOIN WITH CODE
                </button>
                <button
                  className={styles.btnSecondary}
                  style={{
                    background: 'transparent',
                    border: '1px solid rgba(255,255,255,0.2)',
                    color: '#fff',
                  }}
                  onClick={() => {
                    haptic.selection();
                    setShowCreateModal(true);
                  }}
                >
                  CREATE CLUB
                </button>
              </section>

              {/* Club Discovery Browser */}
              <ClubDiscovery
                onJoinRequest={async (clubId) => {
                  try {
                    const joinResult = await ClubJoinService.join({ identifier: clubId });
                    if (!joinResult.success) {
                      throw new Error(joinResult.error || 'Failed to join club');
                    }
                    await loadMyClubs();
                    if (joinResult.status === 'pending') {
                      // Approval-gated club — not a member until approved.
                      toast.success('Request submitted - pending owner approval.');
                    } else {
                      setActiveTab('my-clubs');
                      toast.success('Successfully joined club!');
                    }
                  } catch (err: any) {
                    toast.error(err.message || 'Failed to join club');
                  }
                }}
                onViewClub={(club) => navigate(`/clubs/${club.slug || club.id}`)}
              />
            </div>
          )}

          {/* My Clubs Tab */}
          {activeTab === 'my-clubs' && (
            <div className={styles.myClubsTab}>
              {isLoading ? (
                <div className={styles.clubsGrid}>
                  {[1, 2, 3].map((i) => (
                    <CardSkeleton key={i} hasImage={false} lines={3} />
                  ))}
                </div>
              ) : myClubs.length > 0 ? (
                <div className={styles.clubsGrid}>
                  {myClubs.map((membership, index) => {
                    const levelInfo = getClubLevel({
                      level: membership.club.level || 1,
                      playerCount: membership.club.member_count || 0,
                      hierarchyUnits: membership.club.hierarchy_units_rounded_up || 0,
                      playerThresholdCurrent: membership.club.player_threshold_current || 0,
                      playerThresholdNext: membership.club.player_threshold_next || 0,
                      hierarchyThresholdCurrent: membership.club.hierarchy_threshold_current || 0,
                      hierarchyThresholdNext: membership.club.hierarchy_threshold_next || 0,
                    });

                    return (
                      <div
                        key={membership.club_id || membership.id || `club-${index}`}
                        style={{
                          opacity: visibleClubCards.has(index) ? 1 : 0,
                          transform: visibleClubCards.has(index)
                            ? 'translateY(0)'
                            : 'translateY(8px)',
                          transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                        }}
                      >
                        <div className={styles.clubCard}>
                          {/* Club Header */}
                          <div className={styles.clubHeader}>
                            <div className={styles.clubAvatar}></div>
                            <div className={styles.clubInfo}>
                              <h3 className={styles.clubName}>
                                {membership.club.name}
                                {levelInfo && (
                                  <span
                                    className={styles.levelBadge}
                                    style={{ background: levelInfo.gradient }}
                                  >
                                    Lv.{levelInfo.level}
                                  </span>
                                )}
                              </h3>
                              <span className={styles.clubId}>ID: {membership.club.club_id}</span>
                            </div>
                            {membership.role === 'owner' && (
                              <span className={styles.ownerBadge}>OWNER</span>
                            )}
                          </div>

                          {/* Stats Row */}
                          <div className={styles.clubStats}>
                            <div className={styles.clubStat}>
                              <span className={styles.statValue}>
                                {membership.club.member_count || 0}
                              </span>
                              <span className={styles.statLabel}>Members</span>
                            </div>
                            <div className={styles.clubStat}>
                              {/* Three names for seven roles: a co-owner, a
                                  super agent, an agent and a sub agent all read
                                  as "Player" on their own club card. */}
                              <span className={styles.statValue}>
                                {isClubPrincipal(membership.role)
                                  ? '♛'
                                  : isClubStaff(membership.role)
                                    ? '⚙'
                                    : isAgentRole(membership.role)
                                      ? '◈'
                                      : '▦'}
                              </span>
                              <span className={styles.statLabel}>{roleLabel(membership.role)}</span>
                            </div>
                            <div className={styles.clubStat}>
                              <span className={styles.statValue} style={{ color: levelInfo.color }}>
                                Lv.{levelInfo.level}
                              </span>
                              <span className={styles.statLabel}>{levelInfo.tierLabel}</span>
                            </div>
                          </div>

                          {/* Enter Button */}
                          <button
                            className={styles.btnPrimary}
                            onClick={() => {
                              haptic.success();
                              navigate(`/clubs/${membership.club.slug || membership.club.id}`);
                            }}
                          >
                            ENTER CLUB
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : myUnions.length === 0 ? (
                <NoClubsEmpty onCreate={() => setShowCreateModal(true)} />
              ) : (
                <p
                  style={{
                    color: '#6a7a8a',
                    textAlign: 'center',
                    padding: '20px 0',
                    fontSize: '0.85rem',
                  }}
                >
                  Your Clubs Are Nested Under Your Unions Below.
                </p>
              )}

              {/* ── Unions Section ── */}
              {myUnions.length > 0 && (
                <div className={styles.clubsGrid}>
                  {myUnions.map((union, index) => (
                    <div
                      key={union.id}
                      style={{
                        opacity: visibleClubCards.has(myClubs.length + index) ? 1 : 0,
                        transform: visibleClubCards.has(myClubs.length + index)
                          ? 'translateY(0)'
                          : 'translateY(8px)',
                        transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                      }}
                    >
                      <div className={styles.clubCard}>
                        {/* Union Header */}
                        <div className={styles.clubHeader}>
                          <div className={styles.unionAvatar}>◆</div>
                          <div className={styles.clubInfo}>
                            <h3 className={styles.clubName}>
                              {union.name}
                              <span className={styles.unionTag}>UNION</span>
                            </h3>
                          </div>
                          <span className={styles.unionBadge}>
                            {union.ownerId === currentUserId ? 'OWNER' : 'MEMBER'}
                          </span>
                        </div>

                        {/* Stats Row */}
                        <div className={styles.clubStats}>
                          <div className={styles.clubStat}>
                            <span className={styles.unionStatValue}>{union.clubCount || 0}</span>
                            <span className={styles.statLabel}>Clubs</span>
                          </div>
                          <div className={styles.clubStat}>
                            <span className={styles.unionStatValue}>{union.memberCount || 0}</span>
                            <span className={styles.statLabel}>Members</span>
                          </div>
                          <div className={styles.clubStat}>
                            <span className={styles.unionStatValue}>
                              {union.totalRake ? `$${union.totalRake.toLocaleString()}` : '-'}
                            </span>
                            <span className={styles.statLabel}>Total Rake</span>
                          </div>
                        </div>

                        {/* Enter Button */}
                        <button
                          className={styles.btnPrimary}
                          onClick={() => {
                            haptic.success();
                            navigate(`/unions/${union.id}`);
                          }}
                        >
                          MANAGE UNION
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <CreateClubModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSuccess={(id) => navigate(`/clubs/${id}`)}
      />
      <JoinClubModal
        isOpen={showJoinModal}
        onClose={() => setShowJoinModal(false)}
        initialCode={deepLink.code}
        initialRef={deepLink.ref}
      />
    </>
  );
}
// Trigger CI Wed Aug 26 18:13:36 CDT 2026
