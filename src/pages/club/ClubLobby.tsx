/**
 * ♠ CLUB ARENA — Club Lobby Page
 * premium-style club interface with tournaments, tables, and navigation
 *
 * Fixes applied:
 *  1. Show BOTH tables and tournaments (not either/or)
 *  2. Filter logic works for tables AND tournaments
 *  3. Header buttons replaced with SVG icons + wired functionality
 *  4. "+" button navigates to cashier
 *  5. Dynamic club avatar (avatar_url fallback to ♠)
 *  6. Dynamic contact banner (from club owner, hide when empty)
 *  7. Union badge only when club is in a union
 *  8. Removed all `as any` casts where possible
 *  9. Tournament card uses dynamic values (seats, timer, variant)
 * 10. Create Table action for admins/owners
 * 11. Removed dead NavItem component
 * 12. WAITLIST_PROMOTED bus listener
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { ClubsService } from '../../services/ClubsService';
import { tableService } from '../../services/TableService';
import { tournamentService } from '../../services/TournamentService';
import { parseBlindStructure } from '../../utils/parseBlindStructure';
import { WalletService } from '../../services/WalletService';
import { supabase } from '../../lib/supabase';
import {
  useMasterBusSubscription,
  useMasterBusSubscriptions,
} from '../../hooks/useMasterBusSubscription';
import { useMasterBusChannel } from '../../hooks/useMasterBusChannel';
import { useUserStore } from '../../stores/useUserStore';
import { useToast } from '../../components/common/Toast';
import type { Club } from '../../types/club.types';
import type { PokerTable, Tournament } from '../../types/database.types';
import ClubBottomNav from '../../components/club/ClubBottomNav';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { useVisibilityRefresh } from '../../hooks/useVisibilityRefresh';
import { useIsMounted } from '../../hooks/useIsMounted';
import PageSkeleton from '../../components/common/PageSkeleton';
import { FavoriteTablesWidget } from '../../components/quickactions';
import TournamentResultCard, {
  type TournamentResult,
} from '../../components/tournament/TournamentResultCard';
import './ClubLobby.css';
import { reportError } from '../../utils/errorReporter';
// Whole-number tournament money (Dan 2026-08-20).
import { formatBuyInShort } from '../../utils/buyIn';

// Animation utilities
const cardAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(8px)',
  animation: `fadeInUp 0.5s ease-out ${index * 60}ms forwards`,
});

type GameFilter = 'ALL' | "Hold'em" | 'Omaha' | 'Mixed' | 'MTT' | 'Spin-It' | 'SN';

// Map game_variant strings to filter categories
// FIX 116: Dead variants removed — 9 approved variants only
function variantMatchesFilter(variant: string | undefined, filter: GameFilter): boolean {
  if (filter === 'ALL') return true;
  const v = (variant || 'nlh').toLowerCase();
  switch (filter) {
    case "Hold'em":
      return v === 'nlh' || v === 'short_deck';
    case 'Omaha':
      return v.startsWith('plo');
    case 'Mixed':
      return v === 'pineapple' || v === 'crazy_pineapple' || v === 'mixed';
    default:
      return true;
  }
}

// Variant display name
function getVariantLabel(variant: string | undefined): string {
  const v = (variant || 'nlh').toLowerCase();
  const map: Record<string, string> = {
    nlh: 'NLH',
    flh: 'FLH',
    short_deck: '6+',
    plo: 'PLO',
    plo4: 'PLO4',
    plo5: 'PLO5',
    plo6: 'PLO6',
    plo_hilo: 'PLO Hi-Lo',
    plo8: 'PLO8',
    mixed: 'MIXED',
    double_board: '2Board',
    pineapple: 'Pine',
    crazy_pineapple: 'CPine',
  };
  return map[v] || v.toUpperCase();
}

export default function ClubLobby() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { clubId: routeClubId } = useParams<{ clubId?: string }>();
  const clubId = routeClubId || searchParams.get('club') || undefined;

  // ── Tournament result card (Dan 2026-08-20) ───────────────────────────────
  // A finished tournament player is auto-removed from the table and landed
  // HERE, with their result riding in router state. Read it once into local
  // state and immediately clear the history entry, so a refresh or a back
  // press does not replay a result card from ten minutes ago.
  const [tournamentResult, setTournamentResult] = useState<TournamentResult | null>(null);
  useEffect(() => {
    const incoming = (location.state as { tournamentResult?: TournamentResult } | null)
      ?.tournamentResult;
    if (incoming) {
      setTournamentResult(incoming);
      navigate(location.pathname, { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);
  const [club, setClub] = useState<Club | null>(null);
  const [tables, setTables] = useState<PokerTable[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [activeFilter, setActiveFilter] = useState<GameFilter>('ALL');
  const [isLoading, setIsLoading] = useState(true);
  const [chipBalance, setChipBalance] = useState(0);
  const [diamondBalance, setDiamondBalance] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isInUnion, setIsInUnion] = useState(false);
  const [ownerDisplayName, setOwnerDisplayName] = useState<string | null>(null);
  const currentUser = useUserStore((s) => s.user);
  const isMountedRef = useIsMounted();
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'agent' | 'member'>('member');
  const loadingRef = useRef(false);
  const [resolvedClubId, setResolvedClubId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const loadClubDataRef = useRef<() => void>(() => {});

  const hasAdminAccess = userRole === 'owner' || userRole === 'admin';

  // UNION-FIRST: Check if this club is in a union and redirect
  useEffect(() => {
    if (!clubId) {
      setIsLoading(false);
      setResolvedClubId(null);
      return;
    }

    let cancelled = false;

    const init = async () => {
      if (cancelled || !isMountedRef.current) return;

      try {
        const resolvedId = await resolveClubUUID(clubId);
        if (cancelled || !isMountedRef.current) return;

        setResolvedClubId(resolvedId);
        // UNION LAW (Dan 2026-08-20): the club the player entered through owns
        // the chips they sit down with and the rake they generate.
        try {
          useUserStore.getState().setCurrentClub(resolvedId);
        } catch {
          /* non-fatal */
        }

        const { data: ucRow } = await supabase
          .from('union_clubs')
          .select('union_id')
          .eq('club_id', resolvedId)
          .limit(1)
          .maybeSingle();

        // UNION LAW (2026-08-19, Dan): players stay INSIDE their own club
        // lobby. Union games surface here (TableService resolves them by
        // union_id) — never bounce members to the union surface; that page
        // is for the union owner only.
        setIsInUnion(!!ucRow);
      } catch (e) {
        reportError(e, 'ClubLobby.init');
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
  const reload = useCallback(() => loadClubDataRef.current(), []);

  useMasterBusSubscription(
    'BALANCE_UPDATED',
    () => {
      if (!clubId || !currentUser?.id) return;
      Promise.all([
        WalletService.getPlayerBalance(currentUser.id).then((balance) => ({ data: { balance } })),
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
    { debounce: 500 }
  );

  useMasterBusSubscriptions(
    [
      'TABLE_SEATED',
      'TABLE_LEFT',
      'ANNOUNCEMENT_CHANGED',
      'TABLE_CREATED',
      'TABLE_DELETED',
      'TABLE_CLOSED',
    ],
    () => {
      if (clubId) reload();
    },
    { debounce: 300 }
  );

  useMasterBusSubscription(
    'CLUB_UPDATED',
    (payload: Record<string, unknown>) => {
      const payloadClubId = payload?.clubId as string | undefined;
      if (!clubId || !payloadClubId || payloadClubId === clubId) reload();
    },
    { debounce: 300 }
  );

  useMasterBusSubscription(
    'TOURNAMENT_UPDATED',
    () => {
      if (clubId) reload();
    },
    { debounce: 300 }
  );

  // Tournament lifecycle events
  useMasterBusSubscriptions(
    ['TOURNAMENT_STARTED', 'TOURNAMENT_CANCELLED', 'TOURNAMENT_COMPLETE'],
    () => {
      if (clubId) reload();
    },
    { debounce: 300 }
  );

  // Diamond balance changes
  useMasterBusSubscription(
    'DIAMOND_BALANCE_CHANGED',
    () => {
      if (!currentUser?.id) return;
      supabase
        .from('diamond_wallets')
        .select('balance')
        .eq('user_id', currentUser.id)
        .maybeSingle()
        .then(({ data }) => {
          if (isMountedRef.current && data) setDiamondBalance(data.balance || 0);
        });
    },
    { debounce: 500 }
  );

  // Club membership and settings changes
  useMasterBusSubscriptions(
    ['CLUB_JOINED', 'CLUB_LEFT', 'CLUB_SETTINGS_UPDATED'],
    () => {
      if (clubId) reload();
    },
    { debounce: 300 }
  );

  // Fix #12: WAITLIST_PROMOTED listener
  useMasterBusSubscription(
    'WAITLIST_PROMOTED',
    (payload: Record<string, unknown>) => {
      const promotedUserId = payload?.userId as string | undefined;
      const tableName = payload?.tableName as string | undefined;
      if (promotedUserId === currentUser?.id) {
        toast.success(
          `You've been promoted from the waitlist${tableName ? ` for ${tableName}` : ''}!`
        );
      }
      // Refresh tables to update player counts
      if (clubId) reload();
    },
    { debounce: 300 }
  );

  // ── Realtime subscriptions: live table and tournament updates ──
  useMasterBusChannel({
    channelName: resolvedClubId ? `club-lobby-tables-${resolvedClubId}` : null,
    table: 'tables',
    filter: resolvedClubId ? `club_id=eq.${resolvedClubId}` : null,
    event: '*',
    onPayload: (payload) => {
      if (payload.eventType === 'UPDATE' && payload.new) {
        setTables((prev) =>
          prev.map((t) => (t.id === payload.new.id ? { ...t, ...payload.new } : t))
        );
      } else if (payload.eventType === 'INSERT' && payload.new) {
        setTables((prev) => [payload.new as PokerTable, ...prev]);
      } else if (payload.eventType === 'DELETE' && payload.old) {
        setTables((prev) => prev.filter((t) => t.id !== (payload.old as PokerTable).id));
      }
    },
    enabled: !!resolvedClubId,
  });

  useMasterBusChannel({
    channelName: resolvedClubId ? `club-lobby-tournaments-${resolvedClubId}` : null,
    table: 'tournaments',
    filter: resolvedClubId ? `club_id=eq.${resolvedClubId}` : null,
    event: '*',
    onPayload: (payload) => {
      if (payload.eventType === 'UPDATE' && payload.new) {
        setTournaments((prev) =>
          prev.map((t) => (t.id === payload.new.id ? { ...t, ...payload.new } : t))
        );
      } else if (payload.eventType === 'INSERT' && payload.new) {
        setTournaments((prev) => [payload.new as Tournament, ...prev]);
      } else if (payload.eventType === 'DELETE' && payload.old) {
        setTournaments((prev) => prev.filter((t) => t.id !== (payload.old as Tournament).id));
      }
    },
    enabled: !!resolvedClubId,
  });

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
        // Batch all user-specific fetches in parallel
        const [walletBalance, diamondResult, membershipResult] = await Promise.all([
          WalletService.getPlayerBalance(currentUser.id),
          supabase
            .from('diamond_wallets')
            .select('balance')
            .eq('user_id', currentUser.id)
            .maybeSingle(),
          clubData
            ? supabase
                .from('club_members')
                .select('role')
                .eq('club_id', clubData.id)
                .eq('user_id', currentUser.id)
                .maybeSingle()
            : Promise.resolve({ data: null }),
        ]);
        if (!isMountedRef.current) return;
        setChipBalance(walletBalance);
        if (diamondResult.data) setDiamondBalance(diamondResult.data.balance || 0);
        if (membershipResult.data?.role) {
          setUserRole(membershipResult.data.role as 'owner' | 'admin' | 'agent' | 'member');
        }
      }

      // Fetch owner display name for contact banner
      if (clubData?.owner_id) {
        const { data: ownerProfile } = await supabase
          .from('profiles')
          .select('display_name, username')
          .eq('id', clubData.owner_id)
          .maybeSingle();
        if (isMountedRef.current && ownerProfile) {
          setOwnerDisplayName(ownerProfile.display_name || ownerProfile.username || null);
        }
      }
    } catch (err) {
      reportError(err, 'ClubLobby.Failed_to_load_club_data');
    } finally {
      loadingRef.current = false;
      if (isMountedRef.current) setIsLoading(false);
    }
  }, [clubId, currentUser?.id]);

  // Keep ref synced so bus listeners always call the latest version
  useEffect(() => {
    loadClubDataRef.current = loadClubData;
  }, [loadClubData]);

  const filters: GameFilter[] = ['ALL', "Hold'em", 'Omaha', 'Mixed', 'MTT', 'Spin-It', 'SN'];

  // Fix #2: Filter BOTH tables and tournaments
  const searchLower = searchQuery.toLowerCase();

  const filteredTables = tables.filter((t) => {
    if (activeFilter === 'MTT' || activeFilter === 'SN' || activeFilter === 'Spin-It') return false;
    if (!variantMatchesFilter(t.game_variant, activeFilter)) return false;
    if (searchQuery && !t.name.toLowerCase().includes(searchLower)) return false;
    return true;
  });

  const filteredTournaments = tournaments.filter((t) => {
    if (
      activeFilter !== 'ALL' &&
      activeFilter !== 'MTT' &&
      activeFilter !== 'SN' &&
      activeFilter !== 'Spin-It'
    ) {
      // For Hold'em/Omaha/Mixed, filter tournaments by their game_type
      const gameType = (t.game_type || '').toLowerCase();
      if (activeFilter === "Hold'em" && !gameType.includes('nlh') && !gameType.includes('hold'))
        return false;
      if (activeFilter === 'Omaha' && !gameType.includes('plo') && !gameType.includes('omaha'))
        return false;
      if (activeFilter === 'Mixed' && !gameType.includes('mix')) return false;
    }
    if (activeFilter === 'MTT' && t.type !== 'mtt') return false;
    if (activeFilter === 'SN' && t.type !== 'sng') return false;
    if (activeFilter === 'Spin-It' && t.type !== 'spin') return false;
    if (searchQuery && !t.name.toLowerCase().includes(searchLower)) return false;
    return true;
  });

  // Focus search input when opened
  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

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
        <Link to="/" className="btn btn-primary">
          Back to Home
        </Link>
      </div>
    );
  }

  const totalGames = filteredTables.length + filteredTournaments.length;

  return (
    <div className="club-lobby">
      {/* Tournament result card (Dan 2026-08-20): a finished tournament
          player is auto-removed from their table and landed here — this is
          the card that greets them with their place and their money. */}
      {tournamentResult && (
        <TournamentResultCard
          result={tournamentResult}
          onDismiss={() => setTournamentResult(null)}
        />
      )}
      {/* Toolbar */}
      <div className="lobby-toolbar">
        <div className="header-left">
          <div className="header-icons">
            {/* Fix #3: Wired search button */}
            <button
              className="icon-btn"
              aria-label="Search tables"
              onClick={() => {
                setShowSearch((v) => !v);
                if (showSearch) setSearchQuery('');
              }}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
              </svg>
            </button>
          </div>
        </div>
        <div className="header-center">
          <h1 className="lobby-title">{club.name}</h1>
        </div>
        <div className="header-right">
          {club.settings &&
            typeof club.settings === 'object' &&
            'rake_percentage' in club.settings && (
              <div className="jackpot-display">
                <span className="jackpot-label">BAD BEAT</span>
                <span className="jackpot-label">JACKPOT</span>
                <span className="jackpot-amount">{(club.chip_treasury || 0).toLocaleString()}</span>
              </div>
            )}
        </div>
      </div>

      {/* Search Bar (toggleable) */}
      {showSearch && (
        <div className="search-bar">
          <input
            ref={searchInputRef}
            type="text"
            className="search-input"
            placeholder="Search tables & tournaments..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="search-clear" onClick={() => setSearchQuery('')}>
              ✕
            </button>
          )}
        </div>
      )}

      {/* Club Card */}
      <div className="club-card">
        {/* Fix #5: Dynamic club avatar */}
        <div className="club-avatar">
          {club.avatar_url ? (
            <img src={club.avatar_url} alt={club.name} className="club-avatar-img" />
          ) : (
            <span className="club-logo">♠</span>
          )}
        </div>
        <div className="club-info">
          <h2 className="club-name">{club.name}</h2>
          <div className="club-meta">
            <span className="club-id">ID: {club.club_id}</span>
            <span className="member-count"> {club.member_count || 0}</span>
          </div>
        </div>
        <div className="club-balances">
          <div className="balance-row">
            <span className="chip-icon gold">◉</span>
            <span className="balance-amount">
              {chipBalance.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
            {/* Fix #4: Wire add button to cashier */}
            <button
              className="add-btn"
              aria-label="Add chips"
              onClick={() => navigate(`/clubs/${clubId}/cashier`)}
            >
              +
            </button>
          </div>
          <div className="balance-row">
            <span className="chip-icon diamond">◆</span>
            <span className="balance-amount">
              {diamondBalance.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </div>
        </div>
      </div>

      {/* Fix #6: Dynamic contact banner */}
      {ownerDisplayName && (
        <div className="contact-banner">
          <span>Club Owner: {ownerDisplayName}</span>
          {/* Fix #7: Union badge only when in union */}
          {isInUnion && (
            <div className="union-badge">
              <span>UNION</span>
            </div>
          )}
        </div>
      )}

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
      </div>

      {/* Favorite Tables Widget */}
      <FavoriteTablesWidget onJoinTable={(tableId) => navigate(`/table/${tableId}`)} />

      {/* Fix #10: Create Table action for admins/owners */}
      {hasAdminAccess && (
        <div className="admin-actions">
          <Link to={`/clubs/${clubId}/create-table`} className="create-table-btn">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
            </svg>
            <span>Create Table</span>
          </Link>
        </div>
      )}

      {/* Fix #1: Show BOTH sections — tournaments AND tables */}
      <div className="games-container">
        {/* Tournaments Section */}
        {filteredTournaments.length > 0 && (
          <div className="section">
            <h3 className="section-title">
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V19H7v2h10v-2h-4v-3.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z" />
              </svg>
              Tournaments ({filteredTournaments.length})
            </h3>
            <div className="tournament-grid">
              {filteredTournaments.map((tournament, idx) => (
                <div key={tournament.id} style={cardAnimationStyle(idx)}>
                  <TournamentCard tournament={tournament} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tables Section */}
        {filteredTables.length > 0 && (
          <div className="section">
            <h3 className="section-title">
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                <path d="M2 20h20v-4H2v4zm2-3h2v2H4v-2zM2 4v4h20V4H2zm4 3H4V5h2v2zm-4 7h20v-4H2v4zm2-3h2v2H4v-2z" />
              </svg>
              Cash Tables ({filteredTables.length})
            </h3>
            <div className="tournament-grid">
              {filteredTables.map((table, idx) => (
                <div key={table.id} style={cardAnimationStyle(idx)}>
                  <TableCardItem table={table} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {totalGames === 0 && (
          <div className="empty-state">
            <span className="empty-icon">♠</span>
            <p>No games available{searchQuery ? ` matching "${searchQuery}"` : ''}</p>
            <p className="empty-hint">
              {hasAdminAccess
                ? 'Create a table to get started!'
                : 'Check back later for new tables!'}
            </p>
            {hasAdminAccess && (
              <Link to={`/clubs/${clubId}/create-table`} className="create-table-btn compact">
                + Create Table
              </Link>
            )}
          </div>
        )}
      </div>

      {/* Bottom Navigation */}
      {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} clubName={club.name} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tournament Card — Fix #9: Dynamic values
// ═══════════════════════════════════════════════════════════════════════════════
function TournamentCard({ tournament }: { tournament: Tournament }) {
  const getTypeLabel = (t: Tournament): string => {
    const type = (t.type || t.game_type || 'mtt').toLowerCase();
    switch (type) {
      case 'mtt':
        return 'XMTT';
      case 'sng':
        return 'HEADS UP';
      case 'spin':
        return 'SPIN';
      case 'satellite':
        return 'SAT';
      default:
        return type.toUpperCase();
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

  // Fix #9: Dynamic level duration
  const levelDuration =
    parseBlindStructure(tournament.blind_structure)[0]?.durationMinutes ||
    tournament.settings?.level_duration_minutes ||
    10;

  // Fix #9: Dynamic max players
  const maxPlayers = tournament.max_players || 9;

  // Fix #9: Dynamic variant
  const variant = getVariantLabel(tournament.game_type || tournament.variant);

  // Status color
  const statusClass = (tournament.status || '').toLowerCase();

  return (
    <Link to={`/tournaments/${tournament.id}`} className="tournament-card">
      <div className="card-header">
        <div className="trophy-icon">★</div>
        <div className="seats-badge">{maxPlayers} Max</div>
      </div>
      <div className="card-body">
        <div className="buyin-row">
          <span className="buyin-label">Buy-in</span>
          {/* The advertised buy-in is the TOTAL (prize + fee), whole chips. */}
          <span className="buyin-amount">
            {formatBuyInShort(tournament.buy_in_amount || 0, (tournament as any).buy_in_fee)}
          </span>
        </div>
        <div className="timer-row">
          <span className="timer-icon">◷</span>
          <span className="timer-value">{levelDuration}min</span>
        </div>
        {tournament.current_players > 0 && (
          <div className="players-row">
            <span className="players-label">Registered</span>
            <span className="players-value">
              {tournament.current_players}
              {maxPlayers ? `/${maxPlayers}` : ''}
            </span>
          </div>
        )}
      </div>
      <div className="card-footer">
        <span className={`type-badge ${statusClass}`}>{getTypeLabel(tournament)}</span>
        <span className="variant-badge">{variant}</span>
      </div>
      <div className="card-name">
        <span className="tournament-name">{tournament.name}</span>
      </div>
      <div className="card-date">{formatDate(tournament.start_time ?? null)}</div>
    </Link>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Table Card — Animated player count
// ═══════════════════════════════════════════════════════════════════════════════
function TableCardItem({ table }: { table: PokerTable }) {
  const [displayCount, setDisplayCount] = useState(0);

  useEffect(() => {
    const target = table.current_players || 0;
    if (displayCount === target) return;

    const start = displayCount;
    const duration = 400;
    const startTime = performance.now();
    let rafId: number;

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const current = Math.floor(start + (target - start) * progress);
      setDisplayCount(current);

      if (progress < 1) {
        rafId = requestAnimationFrame(animate);
      }
    };

    rafId = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(rafId);
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
        <span className="variant-badge">{getVariantLabel(table.game_variant)}</span>
        <span className={`status-badge ${table.status}`}>{table.status}</span>
      </div>
    </Link>
  );
}
