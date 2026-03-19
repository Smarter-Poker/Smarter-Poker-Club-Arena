/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Clubs Page
 * ═══════════════════════════════════════════════════════════════════════════════
 * Browse, join, and manage clubs
 *
 * NO HARDCODED DATA - All data comes from Supabase
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase, getAuthUser } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { ClubsService } from '../services/ClubsService';
import { unionService } from '../services/UnionService';
import type { Union } from '../services/UnionService';
import { LoadingState, NoClubsEmpty } from '../components/common/EmptyState';
import { CardSkeleton } from '../components/skeletons/CardSkeleton';
import { useToast } from '../components/common/Toast';
import IntroVideo from '../components/IntroVideo';
import haptic from '../services/HapticService';
import { MetalFrame, MetalButton, MetalInput, MetalCard } from '../components/metal-ui';
import ClubDiscovery from '../components/clubs/ClubDiscovery';
import { getClubLevel } from '../utils/clubLevels';
import styles from './ClubsPage.module.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { STORAGE_KEYS } from '../lib/storage';

type Tab = 'discover' | 'my-clubs' | 'create';

interface Club {
  id: string;
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
  const toast = useToast();
  useVisibilityRefresh(() => loadMyClubs());
  const [activeTab, setActiveTab] = useState<Tab>('my-clubs');
  const [joinClubId, setJoinClubId] = useState('');
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // Intro video state - only show once per session
  const [showIntro, setShowIntro] = useState(() => {
    const shown = sessionStorage.getItem(STORAGE_KEYS.INTRO_SHOWN);
    return !shown; // Show intro if not shown yet
  });

  // Real data states
  // SWR — instant render from cache on revisit
  const [myClubs, setMyClubs] = useState<Membership[]>(() => {
    try {
      const cached = localStorage.getItem(STORAGE_KEYS.CLUBS_PAGE_CACHE);
      if (cached) {
        const p = JSON.parse(cached);
        if (Array.isArray(p) && p.length > 0) return p;
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

  // Create club form
  const [clubName, setClubName] = useState('');
  const [clubDescription, setClubDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
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

      // Deduplicate: filter standalone clubs that belong to a loaded union
      let displayedClubs = memberships;
      if (unions.length > 0 && memberships.length > 0) {
        try {
          const unionClubIds = new Set<string>();
          const unionIds = unions.map((u) => u.id);
          const { data: ucRows } = await supabase
            .from('union_clubs')
            .select('club_id')
            .in('union_id', unionIds);
          if (ucRows) ucRows.forEach((r) => unionClubIds.add(r.club_id));
          displayedClubs = memberships.filter((m) => !unionClubIds.has((m.club as any)?.id));
        } catch {
          /* fail-open: show all clubs if dedup fails */
        }
      }

      setMyClubs(displayedClubs);
      setMyUnions(unions);
      // SWR cache write
      try {
        localStorage.setItem(STORAGE_KEYS.CLUBS_PAGE_CACHE, JSON.stringify(displayedClubs));
      } catch {
        /* quota */
      }
      try {
        localStorage.setItem(STORAGE_KEYS.CLUBS_PAGE_UNIONS_CACHE, JSON.stringify(unions));
      } catch {
        /* quota */
      }
    } catch (err) {
      console.error('[CLUBS] Failed to load memberships:', err);
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

    // Realtime: refresh clubs when membership data changes or clubs are modified
    const channelKey = 'clubs-page-realtime';
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on('postgres_changes', { event: '*', schema: 'public', table: 'club_members' }, () => {
        if (isMounted) loadMyClubs(() => isMounted);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clubs' }, () => {
        if (isMounted) loadMyClubs(() => isMounted);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'unions' }, () => {
        if (isMounted) loadMyClubs(() => isMounted);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'union_clubs' }, () => {
        if (isMounted) loadMyClubs(() => isMounted);
      })
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          console.error('[ClubsPage] ❌ Realtime channel error:', err?.message || err);
        }
        if (status === 'TIMED_OUT') {
          console.warn('[ClubsPage] ⏱️ Realtime channel timed out');
        }
      });
    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
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
    ];
    return () => {
      isMounted = false;
      unsubs.forEach((u) => u());
    };
  }, []);

  // Join club by ID
  const handleJoinClub = async () => {
    if (joinClubId.length < 6) return;

    setIsJoining(true);
    setJoinError(null);

    try {
      // Find club by club_id (the 6-digit public ID)
      const { data: club, error } = await supabase
        .from('clubs')
        .select('id')
        .eq('club_id', parseInt(joinClubId))
        .maybeSingle();

      if (error || !club) {
        setJoinError('Club not found. Check the ID and try again.');
        return;
      }

      await ClubsService.join(club.id);

      // Refresh both clubs AND unions (joined club might belong to a union)
      await loadMyClubs();
      setJoinClubId('');
      setActiveTab('my-clubs');
    } catch (err: any) {
      console.error('[CLUBS] Join failed:', err);
      toast.error(err.message || 'Failed to join club');
      setJoinError(err.message || 'Failed to join club');
    } finally {
      setIsJoining(false);
    }
  };

  // Create new club
  const handleCreateClub = async () => {
    if (!clubName.trim()) {
      setCreateError('Club name is required');
      return;
    }

    setIsCreating(true);
    setCreateError(null);

    try {
      const club = await ClubsService.create({
        name: clubName.trim(),
        description: clubDescription.trim() || undefined,
        is_public: isPublic,
        requires_approval: requiresApproval,
      });

      // Emit bus event so ClubCarouselPage, ClubHomePage, etc. react to the new club
      masterBus.emit('CLUB_JOINED', { clubId: club.id, action: 'club_created' });

      // Navigate to the new club
      navigate(`/clubs/${club.id}`);
    } catch (err: any) {
      console.error('[CLUBS] Create failed:', err);
      toast.error(err.message || 'Failed to create club');
      setCreateError(err.message || 'Failed to create club');
    } finally {
      setIsCreating(false);
    }
  };

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
          <p className={styles.subtitle}>Join private poker communities or create your own.</p>
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
          <button
            className={`${styles.tab} ${activeTab === 'create' ? styles.active : ''}`}
            onClick={() => {
              haptic.selection();
              setActiveTab('create');
            }}
          >
            ➕ Create Club
          </button>
        </div>

        {/* Tab Content */}
        <div className={styles.content}>
          {/* Discover Tab - Metal UI */}
          {activeTab === 'discover' && (
            <div className={styles.discoverTab}>
              <MetalFrame title="JOIN A CLUB" variant="form" size="md">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <p style={{ color: '#8899aa', textAlign: 'center', margin: 0 }}>
                    Enter a 6-digit Club ID to join an existing club.
                  </p>

                  {joinError && (
                    <div style={{ color: '#ff6b6b', textAlign: 'center', fontSize: '0.875rem' }}>
                      {joinError}
                    </div>
                  )}

                  <MetalInput
                    label="ENTER CLUB ID:"
                    placeholder="123456"
                    value={joinClubId}
                    onChange={(e) => {
                      setJoinClubId(e.target.value.replace(/\D/g, ''));
                      setJoinError(null);
                    }}
                    maxLength={6}
                    style={{ textAlign: 'center', letterSpacing: '0.2em', fontFamily: 'monospace' }}
                  />

                  <MetalButton
                    variant="primary"
                    fullWidth
                    disabled={joinClubId.length < 6 || isJoining}
                    onClick={() => {
                      haptic.medium();
                      handleJoinClub();
                    }}
                  >
                    {isJoining ? 'Joining...' : 'JOIN CLUB'}
                  </MetalButton>
                </div>
              </MetalFrame>

              {/* Club Discovery Browser */}
              <ClubDiscovery
                onJoinRequest={async (clubId) => {
                  try {
                    await ClubsService.join(clubId);
                    await loadMyClubs();
                    setActiveTab('my-clubs');
                    toast.success('Successfully joined club!');
                  } catch (err: any) {
                    toast.error(err.message || 'Failed to join club');
                  }
                }}
                onViewClub={(club) => navigate(`/clubs/${club.id}`)}
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
                        <MetalCard size="md" glow>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            {/* Club Header */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                              <div
                                style={{
                                  width: '50px',
                                  height: '50px',
                                  fontSize: '24px',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  background: 'linear-gradient(135deg, #1a2a3a 0%, #0d1520 100%)',
                                  border: '1px solid #2a3a4a',
                                  borderRadius: '10px',
                                }}
                              ></div>
                              <div style={{ flex: 1 }}>
                                <h3
                                  style={{
                                    margin: 0,
                                    fontSize: '1.1rem',
                                    color: '#fff',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                  }}
                                >
                                  {membership.club.name}
                                  {levelInfo && (
                                    <span
                                      style={{
                                        fontSize: '0.65rem',
                                        padding: '2px 8px',
                                        borderRadius: '12px',
                                        background: levelInfo.gradient,
                                        color: '#fff',
                                        fontWeight: 700,
                                        letterSpacing: '0.5px',
                                        textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                                      }}
                                    >
                                      Lv.{levelInfo.level}
                                    </span>
                                  )}
                                </h3>
                                <span
                                  style={{
                                    fontSize: '0.75rem',
                                    fontFamily: 'monospace',
                                    color: '#6a7a8a',
                                  }}
                                >
                                  ID: {membership.club.club_id}
                                </span>
                              </div>
                              {membership.role === 'owner' && (
                                <span
                                  style={{
                                    fontSize: '0.7rem',
                                    fontWeight: 600,
                                    color: '#ffd700',
                                    padding: '4px 10px',
                                    background: 'rgba(255, 215, 0, 0.15)',
                                    border: '1px solid rgba(255, 215, 0, 0.4)',
                                    borderRadius: '20px',
                                  }}
                                >
                                  OWNER
                                </span>
                              )}
                            </div>

                            {/* Stats Row */}
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-around',
                                padding: '12px 0',
                                borderTop: '1px solid rgba(255,255,255,0.1)',
                                borderBottom: '1px solid rgba(255,255,255,0.1)',
                              }}
                            >
                              <div style={{ textAlign: 'center' }}>
                                <div
                                  style={{ fontSize: '1.25rem', fontWeight: 700, color: '#00d4ff' }}
                                >
                                  {membership.club.member_count || 0}
                                </div>
                                <div
                                  style={{
                                    fontSize: '0.65rem',
                                    color: '#6a7a8a',
                                    textTransform: 'uppercase',
                                  }}
                                >
                                  Members
                                </div>
                              </div>
                              <div style={{ textAlign: 'center' }}>
                                <div
                                  style={{ fontSize: '1.25rem', fontWeight: 700, color: '#00d4ff' }}
                                >
                                  {membership.role === 'owner'
                                    ? '👑'
                                    : membership.role === 'admin'
                                      ? '⚙️'
                                      : '🎮'}
                                </div>
                                <div
                                  style={{
                                    fontSize: '0.65rem',
                                    color: '#6a7a8a',
                                    textTransform: 'uppercase',
                                  }}
                                >
                                  {membership.role === 'owner'
                                    ? 'Owner'
                                    : membership.role === 'admin'
                                      ? 'Admin'
                                      : 'Player'}
                                </div>
                              </div>
                              <div style={{ textAlign: 'center' }}>
                                <div
                                  style={{ fontSize: '1.25rem', fontWeight: 700, color: '#00d4ff' }}
                                >
                                  Lv.{membership.club.level || 1}
                                </div>
                                <div
                                  style={{
                                    fontSize: '0.65rem',
                                    color: '#6a7a8a',
                                    textTransform: 'uppercase',
                                  }}
                                >
                                  Level
                                </div>
                              </div>
                            </div>

                            {/* Enter Button */}
                            <MetalButton
                              variant="primary"
                              fullWidth
                              onClick={() => {
                                haptic.success();
                                navigate(`/clubs/${membership.club.id}`);
                              }}
                            >
                              ENTER CLUB
                            </MetalButton>
                          </div>
                        </MetalCard>
                      </div>
                    );
                  })}
                </div>
              ) : myUnions.length === 0 ? (
                <NoClubsEmpty onCreate={() => setActiveTab('create')} />
              ) : (
                <p
                  style={{
                    color: '#6a7a8a',
                    textAlign: 'center',
                    padding: '20px 0',
                    fontSize: '0.85rem',
                  }}
                >
                  Your clubs are nested under your unions below.
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
                      <MetalCard size="md" glow>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                          {/* Union Header */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <div
                              style={{
                                width: '50px',
                                height: '50px',
                                fontSize: '24px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: 'linear-gradient(135deg, #2a1a3a 0%, #150d20 100%)',
                                border: '1px solid #4a2a6a',
                                borderRadius: '10px',
                              }}
                            >
                              🏛️
                            </div>
                            <div style={{ flex: 1 }}>
                              <h3
                                style={{
                                  margin: 0,
                                  fontSize: '1.1rem',
                                  color: '#fff',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '8px',
                                }}
                              >
                                {union.name}
                                <span
                                  style={{
                                    fontSize: '0.6rem',
                                    padding: '2px 8px',
                                    borderRadius: '12px',
                                    background: 'linear-gradient(135deg, #9b59b6, #8e44ad)',
                                    color: '#fff',
                                    fontWeight: 700,
                                    letterSpacing: '0.5px',
                                    textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                                  }}
                                >
                                  UNION
                                </span>
                              </h3>
                            </div>
                            <span
                              style={{
                                fontSize: '0.7rem',
                                fontWeight: 600,
                                color: '#b388ff',
                                padding: '4px 10px',
                                background: 'rgba(179, 136, 255, 0.15)',
                                border: '1px solid rgba(179, 136, 255, 0.4)',
                                borderRadius: '20px',
                              }}
                            >
                              {union.ownerId === currentUserId ? 'OWNER' : 'MEMBER'}
                            </span>
                          </div>

                          {/* Stats Row */}
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-around',
                              padding: '12px 0',
                              borderTop: '1px solid rgba(255,255,255,0.1)',
                              borderBottom: '1px solid rgba(255,255,255,0.1)',
                            }}
                          >
                            <div style={{ textAlign: 'center' }}>
                              <div
                                style={{ fontSize: '1.25rem', fontWeight: 700, color: '#b388ff' }}
                              >
                                {union.clubCount || 0}
                              </div>
                              <div
                                style={{
                                  fontSize: '0.65rem',
                                  color: '#6a7a8a',
                                  textTransform: 'uppercase',
                                }}
                              >
                                Clubs
                              </div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                              <div
                                style={{ fontSize: '1.25rem', fontWeight: 700, color: '#b388ff' }}
                              >
                                {union.memberCount || 0}
                              </div>
                              <div
                                style={{
                                  fontSize: '0.65rem',
                                  color: '#6a7a8a',
                                  textTransform: 'uppercase',
                                }}
                              >
                                Members
                              </div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                              <div
                                style={{ fontSize: '1.25rem', fontWeight: 700, color: '#b388ff' }}
                              >
                                {union.totalRake ? `$${union.totalRake.toLocaleString()}` : '—'}
                              </div>
                              <div
                                style={{
                                  fontSize: '0.65rem',
                                  color: '#6a7a8a',
                                  textTransform: 'uppercase',
                                }}
                              >
                                Total Rake
                              </div>
                            </div>
                          </div>

                          {/* Enter Button */}
                          <MetalButton
                            variant="primary"
                            fullWidth
                            onClick={() => {
                              haptic.success();
                              navigate(`/unions/${union.id}`);
                            }}
                          >
                            MANAGE UNION
                          </MetalButton>
                        </div>
                      </MetalCard>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Create Club Tab - Metal UI */}
          {activeTab === 'create' && (
            <div className={styles.createTab}>
              <MetalFrame title="CREATE A CLUB" variant="form" size="md">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <p style={{ color: '#8899aa', textAlign: 'center', margin: 0 }}>
                    Start your own private poker community.
                  </p>

                  {createError && (
                    <div style={{ color: '#ff6b6b', textAlign: 'center', fontSize: '0.875rem' }}>
                      {createError}
                    </div>
                  )}

                  <MetalInput
                    label="CLUB NAME:"
                    placeholder="Enter club name"
                    value={clubName}
                    onChange={(e) => {
                      setClubName(e.target.value);
                      setCreateError(null);
                    }}
                  />

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <label
                      style={{
                        fontFamily: "'Orbitron', 'Rajdhani', sans-serif",
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        color: '#fff',
                        textTransform: 'uppercase',
                        letterSpacing: '1px',
                      }}
                    >
                      DESCRIPTION:
                    </label>
                    <textarea
                      placeholder="Describe your club..."
                      rows={3}
                      value={clubDescription}
                      onChange={(e) => setClubDescription(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '14px 18px',
                        background: 'linear-gradient(180deg, #0d1520 0%, #1a2332 100%)',
                        border: '2px solid #2a3a4a',
                        borderRadius: '6px',
                        color: '#fff',
                        fontSize: '1rem',
                        outline: 'none',
                        resize: 'vertical',
                        minHeight: '80px',
                      }}
                    />
                  </div>

                  <MetalCard size="sm">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '12px',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isPublic}
                          onChange={(e) => {
                            haptic.selection();
                            setIsPublic(e.target.checked);
                          }}
                          style={{ width: '18px', height: '18px', accentColor: '#00d4ff' }}
                        />
                        <span style={{ color: '#8899aa', fontSize: '0.875rem' }}>
                          Public (anyone can find)
                        </span>
                      </label>
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '12px',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={requiresApproval}
                          onChange={(e) => {
                            haptic.selection();
                            setRequiresApproval(e.target.checked);
                          }}
                          style={{ width: '18px', height: '18px', accentColor: '#00d4ff' }}
                        />
                        <span style={{ color: '#8899aa', fontSize: '0.875rem' }}>
                          Require approval for new members
                        </span>
                      </label>
                    </div>
                  </MetalCard>

                  <MetalButton
                    variant="primary"
                    fullWidth
                    onClick={() => {
                      haptic.success();
                      handleCreateClub();
                    }}
                    disabled={isCreating || !clubName.trim()}
                  >
                    {isCreating ? 'Creating...' : 'CREATE CLUB'}
                  </MetalButton>
                </div>
              </MetalFrame>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
