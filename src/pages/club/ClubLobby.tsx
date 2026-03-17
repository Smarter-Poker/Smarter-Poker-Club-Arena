/**
 * ♠ CLUB ARENA — Club Lobby Page
 * PokerBros-style club interface with tournaments, tables, and navigation
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link, useSearchParams, useNavigate } from 'react-router-dom';
import { ClubsService } from '../../services/ClubsService';
import { tableService } from '../../services/TableService';
import { tournamentService } from '../../services/TournamentService';
import { supabase } from '../../lib/supabase';
import { waitForAuth } from '../../utils/waitForAuth';
import { masterBus } from '../../core/MasterBus';
import { useUserStore } from '../../stores/useUserStore';
import type { Club } from '../../types/club.types';
import type { PokerTable, Tournament } from '../../types/database.types';
import ClubBottomNav from '../../components/club/ClubBottomNav';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { useVisibilityRefresh } from '../../hooks/useVisibilityRefresh';
import { useIsMounted } from '../../hooks/useIsMounted';
import PageSkeleton from '../../components/common/PageSkeleton';
import './ClubLobby.css';

// Animation utilities
const cardAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(8px)',
  animation: `fadeInUp 0.5s ease-out ${index * 60}ms forwards`,
});

type GameFilter = 'ALL' | "Hold'em" | 'Omaha' | 'Mixed' | 'MTT' | 'Spin-It' | 'SN';

export default function ClubLobby() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { clubId: routeClubId } = useParams<{ clubId?: string }>();
  const clubId = routeClubId || searchParams.get('club') || undefined;
  const [club, setClub] = useState<Club | null>(null);
  const [tables, setTables] = useState<PokerTable[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [activeFilter, setActiveFilter] = useState<GameFilter>('ALL');
  const [isLoading, setIsLoading] = useState(true);
  const [chipBalance, setChipBalance] = useState(0);
  const [diamondBalance, setDiamondBalance] = useState(0);
  const currentUser = useUserStore((s) => s.user);
  const isMountedRef = useIsMounted();
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'agent' | 'member'>('member');
  const loadingRef = useRef(false);

  // UNION-FIRST: Check if this club is in a union and redirect
  // Combined with initial data load to prevent race condition where
  // "Club not found" flashes before data arrives
  useEffect(() => {
    if (!clubId) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    const init = async () => {
      // In iframe context, wait for auth to be set by the parent via postMessage.
      const authReady = await waitForAuth(() => !cancelled && isMountedRef.current);
      if (!authReady) {
        console.warn('[ClubLobby] Auth not ready — proceeding anyway');
      }
      if (cancelled || !isMountedRef.current) return;

      // Check union membership first
      try {
        const resolvedId = await resolveClubUUID(clubId);
        if (cancelled || !isMountedRef.current) return;
        const { data: ucRow } = await supabase
          .from('union_clubs')
          .select('union_id')
          .eq('club_id', resolvedId)
          .limit(1)
          .maybeSingle();
        if (ucRow && !cancelled && isMountedRef.current) {
          navigate(`/unions/${ucRow.union_id}`, { replace: true });
          return;
        }
      } catch {
        // Fail-open for standalone clubs
      }

      // Now load club data (only if not redirected)
      if (!cancelled && isMountedRef.current) {
        loadClubData();
      }
    };

    init();

    return () => {
      cancelled = true;
    };
  }, [clubId, currentUser?.id, navigate]);

  // ── Visibility Refresh: reload data when user tabs back ──
  useVisibilityRefresh(() => {
    if (clubId) loadClubData();
  });

  // ── Bus Listeners: cross-page reactivity ──
  useEffect(() => {
    if (!clubId) return;
    const reload = () => loadClubData();
    const unsubs = [
      masterBus.subscribeDebounced(
        'BALANCE_UPDATED',
        () => {
          if (!currentUser?.id) return;
          Promise.all([
            supabase
              .from('wallets')
              .select('balance')
              .eq('user_id', currentUser.id)
              .eq('wallet_type', 'PLAYER')
              .maybeSingle(),
            supabase
              .from('diamond_wallets')
              .select('balance')
              .eq('user_id', currentUser.id)
              .maybeSingle(),
          ])
            .then(([chipRes, diamondRes]) => {
              if (!isMountedRef.current) return;
              if (chipRes.data) setChipBalance(chipRes.data.balance || 0);
              if (diamondRes.data) setDiamondBalance(diamondRes.data.balance || 0);
            })
            .catch((e) => console.warn('[ClubLobby] Failed to refresh wallet balances:', e));
        },
        500
      ),
      masterBus.subscribeDebounced('TABLE_SEATED', reload, 300),
      masterBus.subscribeDebounced('TABLE_LEFT', reload, 300),
      masterBus.subscribeDebounced(
        'CLUB_UPDATED',
        (payload: any) => {
          if (!payload?.clubId || payload.clubId === clubId) reload();
        },
        300
      ),
      masterBus.subscribeDebounced(
        'TOURNAMENT_UPDATED',
        () => {
          // Reload when any tournament changes — payload has tournamentId, not clubId
          reload();
        },
        300
      ),
      masterBus.subscribeDebounced('ANNOUNCEMENT_CHANGED', reload, 300),
    ];
    return () => unsubs.forEach((u) => u());
  }, [clubId, currentUser?.id]);

  // ── Realtime subscription: live table and tournament updates ──
  useEffect(() => {
    if (!clubId) return;
    let cancelled = false;
    let activeChannelKey: string | null = null;

    const setup = async () => {
      // Resolve to UUID so the WS filter works even when clubId is a short code
      const resolvedId = await resolveClubUUID(clubId);
      if (cancelled) return;

      const channelKey = `club-lobby-${resolvedId}`;
      activeChannelKey = channelKey;
      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'tables',
            filter: `club_id=eq.${resolvedId}`,
          },
          (payload) => {
            if (payload.eventType === 'UPDATE' && payload.new) {
              setTables((prev) =>
                prev.map((t) => (t.id === payload.new.id ? { ...t, ...payload.new } : t))
              );
            } else if (payload.eventType === 'INSERT' && payload.new) {
              setTables((prev) => [payload.new as any, ...prev]);
            } else if (payload.eventType === 'DELETE' && payload.old) {
              setTables((prev) => prev.filter((t) => t.id !== (payload.old as any).id));
            }
          }
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'tournaments',
            filter: `club_id=eq.${resolvedId}`,
          },
          (payload) => {
            if (payload.eventType === 'UPDATE' && payload.new) {
              setTournaments((prev) =>
                prev.map((t) => (t.id === payload.new.id ? { ...t, ...payload.new } : t))
              );
            } else if (payload.eventType === 'INSERT' && payload.new) {
              setTournaments((prev) => [payload.new as any, ...prev]);
            } else if (payload.eventType === 'DELETE' && payload.old) {
              setTournaments((prev) => prev.filter((t) => t.id !== (payload.old as any).id));
            }
          }
        )
        .subscribe();
    };

    setup();

    return () => {
      cancelled = true;
      if (activeChannelKey) masterBus.removeRegisteredChannel(activeChannelKey);
    };
  }, [clubId]);

  const loadClubData = useCallback(async () => {
    if (!clubId) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setIsLoading(true);
    try {
      const [clubData, tableData, tournamentData] = await Promise.all([
        ClubsService.get(clubId),
        tableService.getClubTables(clubId),
        tournamentService.getTournaments(clubId),
      ]);
      if (!isMountedRef.current) return;
      setClub(clubData);
      setTables(tableData);
      setTournaments(tournamentData);

      if (currentUser?.id) {
        const { data: walletData } = await supabase
          .from('wallets')
          .select('wallet_type, balance')
          .eq('user_id', currentUser.id)
          .eq('wallet_type', 'PLAYER')
          .maybeSingle();
        if (isMountedRef.current && walletData) setChipBalance(walletData.balance || 0);

        const { data: diamondData } = await supabase
          .from('diamond_wallets')
          .select('balance')
          .eq('user_id', currentUser.id)
          .maybeSingle();
        if (isMountedRef.current && diamondData) setDiamondBalance(diamondData.balance || 0);

        // Fetch user role for BottomNav — reuse clubData.id (UUID) instead of re-resolving
        if (clubData)
          try {
            const { data: membership } = await supabase
              .from('club_members')
              .select('role')
              .eq('club_id', clubData.id)
              .eq('user_id', currentUser.id)
              .maybeSingle();
            if (isMountedRef.current && membership?.role) {
              setUserRole(membership.role as 'owner' | 'admin' | 'agent' | 'member');
            }
          } catch {
            /* non-critical */
          }
      }
    } catch (err) {
      console.error('[ClubLobby] Failed to load club data:', err);
    } finally {
      loadingRef.current = false;
      if (isMountedRef.current) setIsLoading(false);
    }
  }, [clubId, currentUser?.id]);

  const filters: GameFilter[] = ['ALL', "Hold'em", 'Omaha', 'Mixed', 'MTT', 'Spin-It', 'SN'];

  const filteredTournaments = tournaments.filter((t) => {
    if (activeFilter === 'ALL') return true;
    if (activeFilter === 'MTT') return t.type === 'mtt';
    if (activeFilter === 'SN') return t.type === 'sng';
    return true;
  });

  if (isLoading) {
    return (
      <div className="club-lobby loading">
        <PageSkeleton variant="default" />
      </div>
    );
  }

  if (!club) {
    return (
      <div className="club-lobby error">
        <h2>Club not found</h2>
        <Link to="/clubs" className="btn btn-primary">
          Back to Clubs
        </Link>
      </div>
    );
  }

  return (
    <div className="club-lobby">
      {/* Header */}
      <header className="lobby-header">
        <div className="header-left">
          <Link to="/clubs" className="back-btn">
            ‹‹
          </Link>
          <div className="header-icons">
            <button className="icon-btn">Menu</button>
            <button className="icon-btn">Search</button>
          </div>
        </div>
        <div className="header-center">
          <span className="vip-badge"> VIP</span>
        </div>
        <div className="header-right">
          <div className="jackpot-display">
            <span className="jackpot-label">BAD BEAT</span>
            <span className="jackpot-label">JACKPOT</span>
            <span className="jackpot-amount">
              {((club as any)?.bad_beat_jackpot || 0).toLocaleString()}
            </span>
          </div>
        </div>
      </header>

      {/* Club Card */}
      <div className="club-card">
        <div className="club-avatar">
          <span className="club-logo">♠</span>
        </div>
        <div className="club-info">
          <h2 className="club-name">{club.name}</h2>
          <div className="club-meta">
            <span className="club-id">ID: {club.club_id}</span>
            <span className="member-count"> {(club as any).member_count || 0}</span>
          </div>
        </div>
        <div className="club-balances">
          <div className="balance-row">
            <span className="chip-icon gold"></span>
            <span className="balance-amount">
              {chipBalance.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
            <button className="add-btn">+</button>
          </div>
          <div className="balance-row">
            <span className="chip-icon diamond"></span>
            <span className="balance-amount">
              {diamondBalance.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </div>
        </div>
      </div>

      {/* Contact Banner */}
      <div className="contact-banner">
        <span>Questions or concerns? Contact @Johnnyd44 on telegram</span>
        <div className="union-badge">
          <span> UNION</span>
        </div>
      </div>

      {/* Game Type Filters */}
      <div className="filter-tabs">
        {filters.map((filter) => (
          <button
            key={filter}
            className={`filter-tab ${activeFilter === filter ? 'active' : ''}`}
            onClick={() => setActiveFilter(filter)}
          >
            {filter}
          </button>
        ))}
        <button className="filter-more">▼</button>
      </div>

      {/* Tournament Grid */}
      <div className="tournament-grid">
        {filteredTournaments.length > 0 ? (
          filteredTournaments.map((tournament, idx) => (
            <div key={tournament.id} style={cardAnimationStyle(idx)}>
              <TournamentCard tournament={tournament} clubId={clubId!} />
            </div>
          ))
        ) : tables.length > 0 ? (
          tables.map((table, idx) => (
            <div key={table.id} style={cardAnimationStyle(idx)}>
              <TableCard table={table} clubId={clubId!} />
            </div>
          ))
        ) : (
          <div className="empty-state">
            <span className="empty-icon">♠</span>
            <p>No games available</p>
            <p className="empty-hint">Check back later for new tables!</p>
          </div>
        )}
      </div>

      {/* Bottom Navigation */}
      {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} />}
    </div>
  );
}

// Tournament Card Component
function TournamentCard({ tournament, clubId }: { tournament: Tournament; clubId: string }) {
  const getTypeLabel = (type: string | undefined) => {
    if (!type) return 'MTT';
    switch (type) {
      case 'mtt':
        return 'XMTT';
      case 'sng':
        return 'SNG';
      default:
        return (type || 'MTT').toUpperCase();
    }
  };

  const formatDate = (date: string | null) => {
    if (!date) return 'TBD';
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <Link to={`/clubs/${clubId}/tournament/${tournament.id}`} className="tournament-card">
      <div className="card-header">
        <div className="trophy-icon">T</div>
        <div className="seats-badge">9 Max</div>
      </div>
      <div className="card-body">
        <div className="buyin-row">
          <span className="buyin-label">Buy-in</span>
          <span className="buyin-amount">{tournament.buy_in_amount}</span>
        </div>
        <div className="timer-row">
          <span className="timer-icon">◷</span>
          <span className="timer-value">10min</span>
        </div>
      </div>
      <div className="card-footer">
        <span className={`type-badge ${tournament.game_type || tournament.type || 'mtt'}`}>
          {getTypeLabel(tournament.game_type || tournament.type || 'mtt')}
        </span>
        <span className="variant-badge">NLH</span>
      </div>
      <div className="card-name">
        <span className="prize-icon">●</span>
        <span className="tournament-name">{tournament.name}</span>
      </div>
      <div className="card-date">{formatDate(tournament.start_time ?? null)}</div>
    </Link>
  );
}

// Table Card Component
function TableCard({ table, clubId }: { table: PokerTable; clubId: string }) {
  const [displayCount, setDisplayCount] = useState(0);

  useEffect(() => {
    const target = table.current_players || 0;
    if (displayCount === target) return;

    const start = displayCount;
    const duration = 400;
    const startTime = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const current = Math.floor(start + (target - start) * progress);
      setDisplayCount(current);

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    requestAnimationFrame(animate);
  }, [table.current_players, displayCount]);

  return (
    <Link to={`/table/${table.id}`} className="table-card">
      <div className="card-header">
        <div className="table-icon">♠</div>
        <div className="seats-badge">{table.max_players} Max</div>
      </div>
      <div className="card-body">
        <h3 className="table-name">{table.name}</h3>
        <div className="stakes">{table.stakes}</div>
        <div className="players-count">
          {displayCount}/{table.max_players} players
        </div>
      </div>
      <div className="card-footer">
        <span className="variant-badge">{(table.game_variant || 'NLH').toUpperCase()}</span>
        <span className={`status-badge ${table.status}`}>{table.status}</span>
      </div>
    </Link>
  );
}

// Nav Item Component
function NavItem({
  icon,
  label,
  active = false,
}: {
  icon: string;
  label: string;
  active?: boolean;
}) {
  return (
    <button className={`nav-item ${active ? 'active' : ''}`}>
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
    </button>
  );
}
