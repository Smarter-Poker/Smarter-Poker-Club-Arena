/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Clubs Page
 * ═══════════════════════════════════════════════════════════════════════════════
 * Browse, join, and manage clubs
 *
 * NO HARDCODED DATA - All data comes from Supabase
 *
 * ── ON THE SPADE CONSOLE (#ClubArenaConsole) ────────────────────────────────
 * This page used to be a rounded tab pill above a grid of rounded, blurred
 * club tiles: `--gradient-card` faces, `backdrop-filter`, a `--radius-full`
 * OWNER capsule, a level badge painted with `levelInfo.gradient`, an empty
 * 50px `clubAvatar` box, and four glyphs (a crown, a cog, a lozenge, a grid)
 * stuck on top of the stat row to say what `roleLabel()` already said in
 * words. Every one of those was CSS pretending to be a control, which is the
 * exact shape the standard exists to remove.
 *
 * It is now Dan's approved spade master, cut into head / rails / foot by
 * SpadeConsole, with the live text printed into its measured zones:
 *
 *   - a header console: CLUBS engraved in the well, the club count in the
 *     painted pill slot, the two doors on the painted plates in the foot
 *     (JOIN WITH CODE on steel, CREATE CLUB on the blue glass) and the two
 *     views as lit words on the glass between them;
 *   - a MY CLUBS console: every club a row on the glass, its name in engraved
 *     silver and its figures as label/value pairs in the master's lit blue and
 *     silver, separated by engraved rules rather than drawn dividers. Dan
 *     2026-09-09, on the four-bay deck: "I DON'T LIKE THE 4 BOXES, AND THE WAY
 *     IT STICKS OUT ON THE SIDES" - the bays belong to the buy-in family, and
 *     everything else prints rows;
 *   - a UNIONS console, same shape.
 *
 * ClubDiscovery keeps its own art and stays OUTSIDE the console: a frame may
 * never sit on a frame.
 *
 * Nothing about the data changed. Every handler, guard, ref, timer, bus
 * subscription, SWR cache and union filter below is the one that was here.
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getAuthUser } from '../lib/supabase';
import { roleLabel } from '../types/clubRoles';
import { masterBus } from '../core/MasterBus';
import { ClubsService } from '../services/ClubsService';
import { ClubJoinService } from '../services/ClubJoinService';
import { unionService } from '../services/UnionService';
import type { Union } from '../services/UnionService';
import { NoClubsEmpty } from '../components/common/EmptyState';
import PageSkeleton from '../components/common/PageSkeleton';
import CreateClubModal from '../components/modals/CreateClubModal';
import JoinClubModal from '../components/modals/JoinClubModal';
import { useToast } from '../components/common/Toast';
import IntroVideo from '../components/IntroVideo';
import haptic from '../services/HapticService';
import ClubDiscovery from '../components/clubs/ClubDiscovery';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { getClubLevel } from '../utils/clubLevels';
import { compactChips } from '../utils/format';
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

/** The stagger that walks each row on. Unchanged; the animation law keeps it. */
const rowAnimationStyle = (shown: boolean) => ({
  opacity: shown ? 1 : 0,
  transform: shown ? 'translateY(0)' : 'translateY(8px)',
  transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
});

/** Singular and plural, because "1 Clubs" in the pill slot reads unfinished. */
const countPill = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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

  /* The painted pill slot carries the state of the page: how many clubs the
     player is in, or that they are in none. It stays blank while the first
     load is still running rather than printing a zero that is not yet true. */
  const clubsPill = isLoading
    ? undefined
    : myClubs.length === 0
      ? 'Empty'
      : countPill(myClubs.length, 'Club', 'Clubs');

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

      <StandardContentLayout className="clubs-page">
        <div className={styles.page}>
          {/* ── The header console: the two doors on the painted plates ─── */}
          <SpadeConsole
            className={styles.console}
            aria-busy={isLoading || undefined}
            eyebrow="Club Arena"
            title="Clubs"
            pill={clubsPill}
            pillInk={myClubs.length === 0 ? 'muted' : 'blue'}
            foot="plates"
            plates={{
              secondary: {
                label: 'Join With Code',
                onClick: () => {
                  haptic.selection();
                  setShowJoinModal(true);
                },
              },
              primary: {
                label: 'Create Club',
                ink: 'white',
                onClick: () => {
                  haptic.selection();
                  setShowCreateModal(true);
                },
              },
            }}
          >
            <p className="sc-copy sc-copy--center">
              Join Private Poker Communities Or Create Your Own.
            </p>

            {/* The two views are lit words cut into the glass, not drawn tabs:
                the art paints no tab, so nothing here draws one either. */}
            <div className={styles.viewRail} role="tablist" aria-label="Club Views">
              <button
                type="button"
                role="tab"
                id="clubs-tab-discover"
                /* No aria-controls: only the ACTIVE panel is mounted, so the
                   inactive tab would point at an id that is not in the
                   document. The panel names its tab instead, which always
                   resolves. */
                aria-selected={activeTab === 'discover'}
                className={`${styles.viewWord} ${
                  activeTab === 'discover' ? 'sc-ink--silver' : 'sc-ink--muted'
                }`}
                onClick={() => {
                  haptic.selection();
                  setActiveTab('discover');
                }}
              >
                Discover
              </button>
              <button
                type="button"
                role="tab"
                id="clubs-tab-my-clubs"
                aria-selected={activeTab === 'my-clubs'}
                className={`${styles.viewWord} ${
                  activeTab === 'my-clubs' ? 'sc-ink--silver' : 'sc-ink--muted'
                }`}
                onClick={() => {
                  haptic.selection();
                  setActiveTab('my-clubs');
                }}
              >
                My Clubs
              </button>
            </div>
          </SpadeConsole>

          {/* ── Discover: ClubDiscovery keeps its own art, outside the frame ── */}
          {activeTab === 'discover' && (
            <div
              id="clubs-panel-discover"
              role="tabpanel"
              aria-labelledby="clubs-tab-discover"
              className={styles.panel}
            >
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

          {/* ── My Clubs: rows on the glass ──────────────────────────────── */}
          {activeTab === 'my-clubs' && (
            <div
              id="clubs-panel-my-clubs"
              role="tabpanel"
              aria-labelledby="clubs-tab-my-clubs"
              className={styles.panel}
            >
              {isLoading ? (
                <SpadeConsole
                  className={styles.console}
                  eyebrow="Clubs"
                  title="My Clubs"
                  foot="foot"
                >
                  <div className="loading-state">
                    <PageSkeleton variant="list" />
                  </div>
                </SpadeConsole>
              ) : myClubs.length > 0 ? (
                <SpadeConsole
                  className={styles.console}
                  eyebrow="Clubs"
                  title="My Clubs"
                  foot="foot"
                >
                  <ol className={styles.list}>
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
                        <li
                          key={membership.club_id || membership.id || `club-${index}`}
                          className={styles.row}
                          style={rowAnimationStyle(visibleClubCards.has(index))}
                        >
                          <div className={styles.rowHead}>
                            <h3 className={`${styles.rowName} sc-ink--silver`}>
                              {membership.club.name}
                            </h3>
                            {membership.role === 'owner' && (
                              <span className={`${styles.rowFlag} sc-label sc-ink--gold`}>
                                Owner
                              </span>
                            )}
                          </div>

                          <dl className={styles.facts}>
                            <div className={styles.fact}>
                              <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>
                                Members
                              </dt>
                              <dd className={`${styles.factValue} sc-ink--silver`}>
                                {compactChips(membership.club.member_count || 0)}
                              </dd>
                            </div>
                            <div className={styles.fact}>
                              {/* Seven roles, seven names. This used to be a
                                  crown / cog / lozenge / grid glyph stuck on
                                  top of the label; roleLabel already
                                  distinguishes all seven in words. */}
                              <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Role</dt>
                              <dd className={`${styles.factValue} sc-ink--silver`}>
                                {roleLabel(membership.role)}
                              </dd>
                            </div>
                            <div className={styles.fact}>
                              <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Level</dt>
                              <dd className={`${styles.factValue} sc-ink--silver`}>
                                {`Lv.${levelInfo.level} ${levelInfo.tierLabel}`}
                              </dd>
                            </div>
                            <div className={styles.fact}>
                              <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>
                                Club ID
                              </dt>
                              <dd className={`${styles.factValue} sc-ink--silver`}>
                                {membership.club.club_id}
                              </dd>
                            </div>
                          </dl>

                          {/* One action, so it is a lit word on the glass: the
                              foot paints BOTH plates, and a single plate would
                              leave the other painted and empty. */}
                          <button
                            type="button"
                            className={`${styles.rowWord} sc-ink--blue`}
                            aria-label={`Enter ${membership.club.name}`}
                            onClick={() => {
                              haptic.success();
                              navigate(`/clubs/${membership.club.slug || membership.club.id}`);
                            }}
                          >
                            Enter Club
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </SpadeConsole>
              ) : myUnions.length === 0 ? (
                <NoClubsEmpty onCreate={() => setShowCreateModal(true)} />
              ) : (
                <SpadeConsole
                  className={styles.console}
                  eyebrow="Clubs"
                  title="My Clubs"
                  foot="foot"
                >
                  <p className="sc-copy sc-copy--center">
                    Your Clubs Are Nested Under Your Unions Below.
                  </p>
                </SpadeConsole>
              )}

              {/* ── Unions ─────────────────────────────────────────────── */}
              {myUnions.length > 0 && (
                <SpadeConsole
                  className={styles.console}
                  eyebrow="Clubs"
                  title="Unions"
                  pill={countPill(myUnions.length, 'Union', 'Unions')}
                  foot="foot"
                >
                  <ol className={styles.list}>
                    {myUnions.map((union, index) => (
                      <li
                        key={union.id}
                        className={styles.row}
                        style={rowAnimationStyle(visibleClubCards.has(myClubs.length + index))}
                      >
                        <div className={styles.rowHead}>
                          <h3 className={`${styles.rowName} sc-ink--silver`}>{union.name}</h3>
                          <span className={`${styles.rowFlag} sc-label sc-ink--blue`}>Union</span>
                          <span
                            className={`${styles.rowFlag} sc-label ${
                              union.ownerId === currentUserId ? 'sc-ink--gold' : 'sc-ink--muted'
                            }`}
                          >
                            {union.ownerId === currentUserId ? 'Owner' : 'Member'}
                          </span>
                        </div>

                        <dl className={styles.facts}>
                          <div className={styles.fact}>
                            <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Clubs</dt>
                            <dd className={`${styles.factValue} sc-ink--silver`}>
                              {compactChips(union.clubCount || 0)}
                            </dd>
                          </div>
                          <div className={styles.fact}>
                            <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>Members</dt>
                            <dd className={`${styles.factValue} sc-ink--silver`}>
                              {compactChips(union.memberCount || 0)}
                            </dd>
                          </div>
                          <div className={styles.fact}>
                            <dt className={`${styles.factLabel} sc-label sc-ink--blue`}>
                              Total Rake
                            </dt>
                            <dd className={`${styles.factValue} sc-ink--silver`}>
                              {/* The dash, not a zero: a union with no rake
                                  figure yet has no figure, and printing 0
                                  would be inventing one. */}
                              {union.totalRake ? compactChips(union.totalRake) : '-'}
                            </dd>
                          </div>
                        </dl>

                        <button
                          type="button"
                          className={`${styles.rowWord} sc-ink--blue`}
                          aria-label={`Manage ${union.name}`}
                          onClick={() => {
                            haptic.success();
                            navigate(`/unions/${union.slug || union.id}`);
                          }}
                        >
                          Manage Union
                        </button>
                      </li>
                    ))}
                  </ol>
                </SpadeConsole>
              )}
            </div>
          )}
        </div>
      </StandardContentLayout>

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
