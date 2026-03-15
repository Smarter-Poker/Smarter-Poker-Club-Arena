/**
 *  CLUB ENGINE — Lobby Page
 * Main game lobby with tables, game types, and quick actions
 * WITH REAL-TIME UPDATES
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import styles from './LobbyPage.module.css';
import TableCard from '../components/lobby/TableCard';
import GameTypeTabs from '../components/lobby/GameTypeTabs';
import QuickActions from '../components/lobby/QuickActions';
import LobbyHeroBanner from '../components/lobby/LobbyHeroBanner';
import { tableService } from '../services/TableService';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { dailyChallengeService } from '../services/DailyChallengeService';
import { useAuthUser } from '../hooks/useAuthUser';
import type { PokerTable } from '../types/database.types';
import DailyLoginReward from '../components/gamification/DailyLoginReward';
import LuckyDrawWheel from '../components/gamification/LuckyDrawWheel';
import { bonusService } from '../services/BonusService';
import { useToast } from '../components/common/Toast';
import OnlineFriendsPill from '../components/social/OnlineFriendsPill';
import PromotionCarousel from '../components/promotions/PromotionCarousel';
import NotificationBell from '../components/common/NotificationBell';
import { BBJBanner, BBJModal, useBBJ } from '../components/bbj/BBJDisplay';
import LiveActionTicker from '../components/lobby/LiveActionTicker';
import LobbyStatsBar from '../components/lobby/LobbyStatsBar';
import CreateGameModal from '../components/lobby/CreateGameModal';
import { useIsMounted } from '../hooks/useIsMounted';
import { retryFetch } from '../utils/retryFetch';
type GameFilter = 'all' | 'nlh' | 'plo' | 'ofc' | 'tournaments' | 'favorites';

export default function LobbyPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuthUser();
  useVisibilityRefresh(() => {
    tableService
      .getActiveTables()
      .then(setTables)
      .catch(() => {});
  });
  const [activeFilter, setActiveFilter] = useState<GameFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [stakeFilter, setStakeFilter] = useState<string>('any');
  const [tables, setTables] = useState<PokerTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [onlinePlayers, setOnlinePlayers] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Waitlist state (ported from WH lobby.js)
  const [waitlistPositions, setWaitlistPositions] = useState<Record<string, number>>({});
  const [waitlistProcessing, setWaitlistProcessing] = useState<string | null>(null);

  // Admin table controls state
  const [userRole, setUserRole] = useState<string | null>(null);
  const [tableActionProcessing, setTableActionProcessing] = useState<string | null>(null);

  // Club ID for BBJ and LiveActionTicker
  const [userClubId, setUserClubId] = useState<string | null>(null);
  const [showBBJModal, setShowBBJModal] = useState(false);
  const { bbjData } = useBBJ(userClubId);

  // Gamification overlays
  const [showDailyReward, setShowDailyReward] = useState(false);
  const [dailyRewardData, setDailyRewardData] = useState<{
    amount: number;
    rewardType: 'diamonds' | 'chips';
    streakDay: number;
  } | null>(null);
  const [showLuckyWheel, setShowLuckyWheel] = useState(false);
  const [canSpin, setCanSpin] = useState(false);
  const [showCreateGame, setShowCreateGame] = useState(false);
  const [wheelStats, setWheelStats] = useState({ totalSpins: 0, streakMultiplier: 1 });

  // Favorite Tables (stored in localStorage)
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('favorite_tables') || '[]');
      return new Set(stored);
    } catch {
      return new Set();
    }
  });

  const toggleFavorite = (tableId: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(tableId)) next.delete(tableId);
      else next.add(tableId);
      localStorage.setItem('favorite_tables', JSON.stringify([...next]));
      return next;
    });
  };

  const isMounted = useIsMounted();

  // ── Check daily bonus eligibility on mount ──
  useEffect(() => {
    if (!user?.id) return;
    bonusService
      .getBonusStatus(user.id)
      .then((status) => {
        if (!isMounted.current) return;
        if (status.canClaimDaily) {
          const dayReward = status.dailyBonuses[status.currentDay - 1];
          setDailyRewardData({
            amount: dayReward?.reward || 100,
            rewardType: dayReward?.rewardType === 'vip_points' ? 'diamonds' : 'chips',
            streakDay: status.currentDay,
          });
          setShowDailyReward(true);
        }
      })
      .catch((err) => {
        // Non-critical: daily bonus check failed
      });

    // Check spin eligibility and fetch stats
    bonusService
      .canSpinToday(user.id)
      .then((eligible) => {
        if (isMounted.current) setCanSpin(eligible);
      })
      .catch(() => {});
    bonusService
      .getWheelStats(user.id)
      .then((stats) => {
        if (isMounted.current) setWheelStats(stats);
      })
      .catch(() => {});

    // Trigger push notification event if daily reset is available
    dailyChallengeService.emitDailyResetReminder();

    // Listen for balance updates (e.g., from wheel spins or daily claims) to force profile refresh (debounced)
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        masterBus.emit('PROFILE_UPDATED', { userId: user.id || '', updates: {} });
      },
      500
    );

    // ── EventBus listeners ported from World Hub lobby.js ──
    // These cross-page events trigger a lobby refresh when admin/cashier actions
    // occur elsewhere in the app (table created, chips distributed, etc.)
    const refreshTables = () => {
      tableService
        .getActiveTables()
        .then((t) => {
          if (isMounted.current) setTables(t);
        })
        .catch(() => {});
    };
    const LOBBY_REFRESH_EVENTS = [
      'TABLE_CREATED',
      'TABLE_UPDATED',
      'ANNOUNCEMENT_CHANGED',
      'PLAYER_KICKED',
      'CHIPS_DISTRIBUTED',
      'TABLE_DELETED',
      'TABLE_CLOSED',
      'CLUB_SETTINGS_UPDATED',
    ] as const;
    const unsubEvents = LOBBY_REFRESH_EVENTS.map((ev) =>
      masterBus.subscribeDebounced(ev, refreshTables, 500)
    );

    return () => {
      unsubBalance();
      unsubEvents.forEach((unsub) => unsub());
    };
  }, [user?.id]);

  // ── Detect user role for admin controls ──
  useEffect(() => {
    if (!user?.id || !userClubId) return;
    (async () => {
      try {
        const { data: mem } = await retryFetch(
          () =>
            supabase
              .from('club_members')
              .select('role')
              .eq('user_id', user.id)
              .eq('club_id', userClubId)
              .maybeSingle()
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        );
        if (isMounted.current && mem?.role) setUserRole(mem.role);
      } catch {
        /* non-critical */
      }
    })();
  }, [user?.id, userClubId]);

  // ── Waitlist position loader ──
  const loadWaitlistPositions = useCallback(
    async (tableIds: string[]) => {
      if (!user?.id) return;
      const results = await Promise.allSettled(
        tableIds.map(async (tid) => {
          const { data } = await supabase
            .from('table_waitlist')
            .select('position')
            .eq('table_id', tid)
            .eq('user_id', user.id)
            .maybeSingle();
          return { tid, position: data?.position };
        })
      );
      const positions: Record<string, number> = {};
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.position) {
          positions[r.value.tid] = r.value.position;
        }
      }
      if (isMounted.current) setWaitlistPositions(positions);
    },
    [user?.id]
  );

  // Load waitlist positions when tables change
  useEffect(() => {
    if (!user?.id || !tables.length) return;
    const fullTables = tables.filter((t) => t.current_players >= (t.max_players || 9));
    if (fullTables.length > 0) loadWaitlistPositions(fullTables.map((t) => t.id));
  }, [tables, user?.id, loadWaitlistPositions]);

  // ── Waitlist Join/Leave handlers ──
  const handleWaitlistJoin = async (tableId: string) => {
    if (!user?.id) return;
    setWaitlistProcessing(tableId);
    try {
      const { data, error: wErr } = await supabase
        .from('table_waitlist')
        .insert({ table_id: tableId, user_id: user.id })
        .select('position')
        .maybeSingle();
      if (wErr) throw wErr;
      setWaitlistPositions((prev) => ({ ...prev, [tableId]: data?.position || 1 }));
      masterBus.emit('WAITLIST_POSITION_CHANGED', {
        tableId,
        position: data?.position || 1,
        tableName: '',
      });
    } catch (err: any) {
      toast.error(err.message || 'Failed to join waitlist');
    } finally {
      setWaitlistProcessing(null);
    }
  };

  const handleWaitlistLeave = async (tableId: string) => {
    if (!user?.id) return;
    setWaitlistProcessing(tableId);
    try {
      const { error: wlErr } = await supabase
        .from('table_waitlist')
        .delete()
        .eq('table_id', tableId)
        .eq('user_id', user.id);
      if (wlErr) throw wlErr;
      setWaitlistPositions((prev) => {
        const n = { ...prev };
        delete n[tableId];
        return n;
      });
    } catch (err: any) {
      toast.error(err.message || 'Failed to leave waitlist');
    } finally {
      setWaitlistProcessing(null);
    }
  };

  // ── Admin Table Actions ──
  const isAdmin = userRole === 'owner' || userRole === 'admin';
  const handleTableAction = async (
    tableId: string,
    action: 'pause' | 'resume' | 'close' | 'delete'
  ) => {
    // Confirmation for destructive actions
    if (action === 'close' && !confirm('Close this table? Players will be refunded.')) return;
    if (action === 'delete' && !confirm('Permanently delete this table? This cannot be undone.'))
      return;

    setTableActionProcessing(tableId);
    try {
      if (action === 'pause') {
        await tableService.pauseTable(tableId);
        masterBus.emit('TABLE_UPDATED', { tableId, status: 'paused' });
      } else if (action === 'resume') {
        await tableService.resumeTable(tableId);
        masterBus.emit('TABLE_UPDATED', { tableId, status: 'running' });
      } else if (action === 'close') {
        await tableService.closeTable(tableId);
        masterBus.emit('TABLE_CLOSED', { tableId, clubId: userClubId || undefined });
      } else if (action === 'delete') {
        await tableService.deleteTable(tableId, userClubId || '');
        masterBus.emit('TABLE_DELETED', { tableId, clubId: userClubId || undefined });
      }
    } catch (err: any) {
      toast.error(err.message || `Failed to ${action} table`);
    } finally {
      setTableActionProcessing(null);
    }
  };

  // UNION-FIRST: Check if user belongs to a union and redirect to union lobby
  useEffect(() => {
    const checkUnionMembership = async () => {
      if (!user?.id) return;
      try {
        // Find clubs the user belongs to
        const { data: memberships } = await retryFetch(
          () =>
            supabase
              .from('club_members')
              .select('club_id')
              .eq('user_id', user.id)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        );

        if (!memberships?.length || !isMounted.current) return;

        // Check if any of these clubs are in a union
        const clubIds = memberships.map((m) => m.club_id);
        const { data: unionClub } = await retryFetch(
          () =>
            supabase
              .from('union_clubs')
              .select('union_id')
              .in('club_id', clubIds)
              .limit(1)
              .maybeSingle()
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        );

        if (unionClub && isMounted.current) {
          // User's club is in a union — redirect to union lobby
          navigate(`/unions/${unionClub.union_id}`, { replace: true });
          return;
        }

        // Store clubId for BBJ and LiveActionTicker
        if (clubIds.length > 0 && isMounted.current) {
          setUserClubId(clubIds[0]);
        }
      } catch (err) {
        if (!isMounted.current) return;
        // Non-critical: union check failed, showing all tables
      }
    };

    checkUnionMembership();
  }, [user?.id, navigate]);

  // Fetch tables and subscribe to real-time updates
  useEffect(() => {
    // Safety timeout: never show loading spinner for more than 10 seconds
    const loadingTimeout = setTimeout(() => {
      if (isMounted.current) setLoading(false);
    }, 10_000);

    const fetchTables = async () => {
      try {
        setLoading(true);
        // For users in unions, they'll be redirected above.
        // This fallback shows all tables for standalone (non-union) users.
        const activeTables = await tableService.getActiveTables();
        if (isMounted.current) {
          setTables(activeTables);
          setLastRefreshed(new Date());
        }
      } catch (error) {
        if (!isMounted.current) return;
        console.error('Failed to fetch tables:', error);
        setTables([]);
      } finally {
        clearTimeout(loadingTimeout);
        if (isMounted.current) setLoading(false);
      }
    };

    fetchTables();

    // Subscribe to real-time table changes via Channel Registry
    const tableChannelKey = 'lobby-tables';
    const channel = masterBus.getOrCreateChannel(tableChannelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tables',
        },
        (payload) => {
          if (payload.eventType === 'INSERT' && payload.new) {
            setTables((prev) => [...prev, payload.new as PokerTable]);
          } else if (payload.eventType === 'UPDATE' && payload.new) {
            setTables((prev) =>
              prev.map((t) => (t.id === payload.new.id ? (payload.new as PokerTable) : t))
            );
          } else if (payload.eventType === 'DELETE' && payload.old) {
            setTables((prev) => prev.filter((t) => t.id !== payload.old.id));
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'table_seats',
        },
        () => {
          // Debounce seat changes to avoid rapid refetching
          if (debounceRef.current) clearTimeout(debounceRef.current);
          debounceRef.current = setTimeout(() => {
            tableService
              .getActiveTables()
              .then(setTables)
              .catch((err) => {
                console.error('[LobbyPage] Failed to refresh tables on seat change:', err);
              });
          }, 500);
        }
      )
      .subscribe();

    // Get online player count via Channel Registry
    const presenceKey = 'online-users';
    const presenceChannel = masterBus.getOrCreateChannel(presenceKey);
    presenceChannel
      .on('presence', { event: 'sync' }, () => {
        const presenceState = presenceChannel.presenceState();
        setOnlinePlayers(Object.keys(presenceState).length);
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await presenceChannel.track({ online: true });
        }
      });

    // Cleanup — untrack presence + remove channels + clear debounce
    return () => {
      clearTimeout(loadingTimeout);
      presenceChannel.untrack().catch(() => {});
      masterBus.removeRegisteredChannel(tableChannelKey);
      masterBus.removeRegisteredChannel(presenceKey);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const filteredTables = tables.filter((table) => {
    if (activeFilter === 'favorites') return favorites.has(table.id);
    if (activeFilter !== 'all') {
      if (activeFilter === 'nlh' && !['nlh', 'short_deck', 'flh'].includes(table.game_variant))
        return false;
      if (activeFilter === 'plo' && !table.game_variant.startsWith('plo')) return false;
      if (activeFilter === 'ofc' && !table.game_variant.startsWith('ofc')) return false;
      if (activeFilter === 'tournaments' && (table as any).game_type !== 'tournament') return false;
    }
    if (searchQuery && !(table.name || '').toLowerCase().includes(searchQuery.toLowerCase()))
      return false;

    // Stake range filter
    if (stakeFilter !== 'any' && table.stakes) {
      const bbMatch = table.stakes.match(/(\d+)\/(\d+)/);
      const bb = bbMatch ? parseInt(bbMatch[2]) : 0;
      if (stakeFilter === 'low' && bb > 10) return false;
      if (stakeFilter === 'mid' && (bb <= 10 || bb > 50)) return false;
      if (stakeFilter === 'high' && bb <= 50) return false;
    }

    return true;
  });

  const totalPlaying = tables.reduce((sum, t) => sum + (t.current_players || 0), 0);

  return (
    <div className={styles.lobby}>
      {/* Hero Section */}
      <section className={styles.hero}>
        <div className={styles.heroContent}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h1 className={styles.heroTitle}>
              <span className={styles.heroIcon}>♠</span>
              Club Engine
            </h1>
            <NotificationBell />
          </div>
          <p className={styles.heroSubtitle}>Private poker clubs, better than ever.</p>
          <div className={styles.liveStats}>
            <span>{onlinePlayers} online</span>
            <span className={styles.divider}>•</span>
            <span>{totalPlaying} playing</span>
            <span className={styles.divider}>•</span>
            <span>{tables.length} tables</span>
            {bbjData && bbjData.pool.amount > 0 && (
              <>
                <span className={styles.divider}>•</span>
                <span style={{ color: '#FFD700', fontWeight: 700 }}>
                  🏆 BBJ: {bbjData.pool.amount.toLocaleString()}
                </span>
              </>
            )}
          </div>
        </div>
        <QuickActions />
        {/* Gamification triggers */}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            onClick={() => {
              if (!dailyRewardData && user?.id) {
                bonusService
                  .getBonusStatus(user.id)
                  .then((status) => {
                    if (!isMounted.current) return;
                    const dayReward =
                      status.dailyBonuses[(status.currentDay - 1) % status.dailyBonuses.length];
                    setDailyRewardData({
                      amount: dayReward?.reward || 100,
                      rewardType: dayReward?.rewardType === 'vip_points' ? 'diamonds' : 'chips',
                      streakDay: status.currentDay,
                    });
                    setShowDailyReward(true);
                  })
                  .catch(() => {});
              } else {
                setShowDailyReward(true);
              }
            }}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              background: 'linear-gradient(135deg, #ff6d00, #ffa726)',
              border: 'none',
              color: '#fff',
              fontWeight: 700,
              fontSize: '0.75rem',
              cursor: 'pointer',
            }}
          >
            🎁 Daily Bonus
          </button>
          <button
            onClick={() => setShowLuckyWheel(true)}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
              border: 'none',
              color: '#fff',
              fontWeight: 700,
              fontSize: '0.75rem',
              cursor: 'pointer',
            }}
          >
            🍀 Lucky Draw
          </button>
        </div>
      </section>

      {/* Session Performance Widget (Initiative 14) */}
      <div className={styles.sessionWidget}>
        <span className={styles.sessionLive}>● LIVE</span>
        <span className={styles.sessionStat}>{tables.length} tables open</span>
        <span className={styles.sessionDivider}>|</span>
        <span className={styles.sessionStat}>{onlinePlayers} players online</span>
        <span className={styles.sessionDivider}>|</span>
        <span className={styles.sessionStat}>{totalPlaying} now playing</span>
      </div>

      {/* Lobby Stats Bar — styled stat pills */}
      <LobbyStatsBar games={tables as any} />

      {/* Promotional Banner Carousel */}
      <LobbyHeroBanner />

      {/* Active Promotions Carousel */}
      <PromotionCarousel />

      {/* BBJ Banner (clickable → opens modal) */}
      {bbjData && bbjData.pool.amount > 0 && (
        <div style={{ padding: '0 16px' }}>
          <BBJBanner
            amount={bbjData.pool.amount}
            hourlyRate={bbjData.hourlyRate || 0}
            onClick={() => setShowBBJModal(true)}
          />
        </div>
      )}

      {/* Live Action Ticker */}
      <LiveActionTicker clubId={userClubId} />

      {/* Online Friends Quick-Invite */}
      {user?.id && (
        <OnlineFriendsPill
          userId={user.id}
          onFriendClick={(friendId) => navigate(`/messages/new?userId=${friendId}`)}
        />
      )}

      {/* Game Type Tabs */}
      <section className={styles.filterSection}>
        <GameTypeTabs activeFilter={activeFilter} onFilterChange={setActiveFilter} />

        <div className={styles.searchBox}>
          <span className={styles.searchIcon}></span>
          <input
            type="text"
            placeholder="Search tables..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className={styles.searchInput}
          />
          <select
            value={stakeFilter}
            onChange={(e) => setStakeFilter(e.target.value)}
            style={{
              padding: '6px 10px',
              borderRadius: 8,
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: '#aaa',
              fontSize: '0.72rem',
              marginLeft: 6,
            }}
          >
            <option value="any">All Stakes</option>
            <option value="low">Low (≤10 BB)</option>
            <option value="mid">Mid (10-50 BB)</option>
            <option value="high">High (50+ BB)</option>
          </select>
        </div>
      </section>

      {/* Tables Grid */}
      <section className={styles.tablesSection}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Active Tables</h2>
          <span className={styles.tableCount}>{filteredTables.length} tables</span>
          <span style={{ fontSize: '11px', color: '#6a7a8a', marginLeft: 'auto' }}>
            Updated {lastRefreshed.toLocaleTimeString()}
          </span>
        </div>

        {loading ? (
          <div className={styles.tablesGrid}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className={styles.skeletonCard}>
                <div className={styles.skeletonHeader} />
                <div className={styles.skeletonBody}>
                  <div className={styles.skeletonLine} style={{ width: '70%' }} />
                  <div className={styles.skeletonLine} style={{ width: '50%' }} />
                  <div className={styles.skeletonLine} style={{ width: '85%' }} />
                </div>
                <div className={styles.skeletonFooter}>
                  <div className={styles.skeletonDot} />
                  <div className={styles.skeletonLine} style={{ width: '40%' }} />
                </div>
              </div>
            ))}
          </div>
        ) : filteredTables.length > 0 ? (
          <div className={styles.tablesGrid}>
            {filteredTables.map((table, index) => (
              <div
                key={table.id}
                style={{
                  position: 'relative',
                  animation: `tableSlideIn 0.5s ease-out ${index * 50}ms both`,
                }}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFavorite(table.id);
                  }}
                  style={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    zIndex: 10,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: '1.1rem',
                    filter: favorites.has(table.id) ? 'none' : 'grayscale(1) opacity(0.4)',
                    transition: 'filter 0.2s ease',
                  }}
                  title={favorites.has(table.id) ? 'Remove from favorites' : 'Add to favorites'}
                >
                  ⭐
                </button>
                {/* Live pulse indicator for active tables */}
                {table.current_players > 0 && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 12,
                      right: 44,
                      zIndex: 10,
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: '#ef4444',
                      boxShadow: '0 0 8px #ef4444',
                      animation: 'livePulse 2s infinite',
                    }}
                    title={`${table.current_players} players live`}
                  />
                )}
                <TableCard table={table} />

                {/* Waitlist controls for full tables */}
                {table.current_players >= (table.max_players || 9) && (
                  <div
                    style={{
                      position: 'absolute',
                      bottom: 8,
                      left: 8,
                      right: 8,
                      zIndex: 10,
                      display: 'flex',
                      justifyContent: 'center',
                      gap: 6,
                    }}
                  >
                    {waitlistPositions[table.id] ? (
                      <>
                        <span
                          style={{
                            fontSize: '11px',
                            color: '#F5A623',
                            fontWeight: 600,
                            padding: '4px 8px',
                            background: 'rgba(245,166,35,0.15)',
                            borderRadius: 6,
                          }}
                        >
                          📋 #{waitlistPositions[table.id]}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            handleWaitlistLeave(table.id);
                          }}
                          disabled={waitlistProcessing === table.id}
                          style={{
                            fontSize: '10px',
                            padding: '3px 8px',
                            borderRadius: 6,
                            background: 'rgba(250,56,62,0.15)',
                            border: '1px solid rgba(250,56,62,0.3)',
                            color: '#FA383E',
                            cursor: 'pointer',
                            fontWeight: 600,
                          }}
                        >
                          {waitlistProcessing === table.id ? '...' : '✕ Leave'}
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          handleWaitlistJoin(table.id);
                        }}
                        disabled={waitlistProcessing === table.id}
                        style={{
                          fontSize: '10px',
                          padding: '3px 10px',
                          borderRadius: 6,
                          background: 'rgba(49,162,76,0.15)',
                          border: '1px solid rgba(49,162,76,0.3)',
                          color: '#31A24C',
                          cursor: 'pointer',
                          fontWeight: 600,
                        }}
                      >
                        {waitlistProcessing === table.id ? 'Joining...' : '📋 Join Waitlist'}
                      </button>
                    )}
                  </div>
                )}

                {/* Admin table controls (owner/admin only) */}
                {isAdmin && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 36,
                      right: 8,
                      zIndex: 10,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                    }}
                  >
                    {(table as any).status !== 'paused' ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTableAction(table.id, 'pause');
                        }}
                        disabled={tableActionProcessing === table.id}
                        style={{
                          fontSize: '9px',
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: 'rgba(245,166,35,0.15)',
                          border: '1px solid rgba(245,166,35,0.25)',
                          color: '#F5A623',
                          cursor: 'pointer',
                          fontWeight: 600,
                        }}
                      >
                        {tableActionProcessing === table.id ? '...' : '⏸'}
                      </button>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTableAction(table.id, 'resume');
                        }}
                        disabled={tableActionProcessing === table.id}
                        style={{
                          fontSize: '9px',
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: 'rgba(49,162,76,0.15)',
                          border: '1px solid rgba(49,162,76,0.25)',
                          color: '#31A24C',
                          cursor: 'pointer',
                          fontWeight: 600,
                        }}
                      >
                        {tableActionProcessing === table.id ? '...' : '▶'}
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTableAction(table.id, 'close');
                      }}
                      disabled={tableActionProcessing === table.id}
                      style={{
                        fontSize: '9px',
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: 'rgba(250,56,62,0.1)',
                        border: '1px solid rgba(250,56,62,0.2)',
                        color: '#FA383E',
                        cursor: 'pointer',
                        fontWeight: 600,
                      }}
                    >
                      {tableActionProcessing === table.id ? '...' : '✕'}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTableAction(table.id, 'delete');
                      }}
                      disabled={tableActionProcessing === table.id}
                      style={{
                        fontSize: '9px',
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: 'rgba(150,30,30,0.15)',
                        border: '1px solid rgba(150,30,30,0.25)',
                        color: '#c0392b',
                        cursor: 'pointer',
                        fontWeight: 600,
                      }}
                    >
                      {tableActionProcessing === table.id ? '...' : '🗑'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className={`${styles.emptyState} ${styles.emptyStatePremium}`}>
            <span className={styles.emptyIcon}>♠</span>
            <h3>No tables found</h3>
            <p>Try adjusting your filters or create a new table.</p>
            <button
              className="btn btn-primary"
              onClick={() => navigate('/clubs')}
              style={{
                marginTop: 16,
                padding: '10px 20px',
                borderRadius: 8,
                background: 'linear-gradient(135deg, #0099ff, #00d4ff)',
                border: 'none',
                color: '#000',
                fontWeight: 700,
                cursor: 'pointer',
                transition: 'all 0.3s ease',
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLElement).style.transform = 'translateY(-2px)';
                (e.target as HTMLElement).style.boxShadow = '0 8px 20px rgba(0, 180, 255, 0.4)';
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLElement).style.transform = 'translateY(0)';
                (e.target as HTMLElement).style.boxShadow = 'none';
              }}
            >
              Create Table
            </button>
          </div>
        )}
      </section>

      {/* Gamification Overlays */}
      {showDailyReward && dailyRewardData && (
        <DailyLoginReward
          amount={dailyRewardData.amount}
          rewardType={dailyRewardData.rewardType}
          streakDay={dailyRewardData.streakDay}
          onClaim={() => {
            if (user?.id) {
              bonusService
                .claimDailyBonus(user.id)
                .then(() => toast.success('Daily reward claimed!'))
                .catch((err) => toast.error(err.message || 'Failed to claim reward'));
            }
          }}
          onClose={() => setShowDailyReward(false)}
        />
      )}

      {showLuckyWheel && (
        <LuckyDrawWheel
          spinsRemaining={canSpin ? 1 : 0}
          totalSpins={wheelStats.totalSpins}
          streakMultiplier={wheelStats.streakMultiplier}
          onSpin={async () => {
            if (!user?.id) throw new Error('User not loaded');
            if (!canSpin) throw new Error('You have already spun the wheel today!');
            try {
              const result = await bonusService.spinLuckyWheel(user.id);
              setCanSpin(false); // Optimistically disable further spins
              return result.segmentId;
            } catch (err: any) {
              toast.error(err.message || 'Failed to spin wheel');
              throw err;
            }
          }}
          onClose={() => setShowLuckyWheel(false)}
        />
      )}

      {/* BBJ Full Modal */}
      {showBBJModal && <BBJModal data={bbjData} onClose={() => setShowBBJModal(false)} />}

      {/* Create Game Modal (unified table + tournament creation) */}
      {showCreateGame && userClubId && (
        <CreateGameModal
          clubId={userClubId}
          onClose={() => setShowCreateGame(false)}
          onCreated={() => setShowCreateGame(false)}
        />
      )}
    </div>
  );
}
