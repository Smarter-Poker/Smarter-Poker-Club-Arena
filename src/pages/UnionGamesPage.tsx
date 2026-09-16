import { normalizeTournamentMaxPlayers } from '../../server/src/tournament/tournamentEntryCapacity';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Union Games Page
 *  3 Tabs: Tournaments | Tables | BBJ Pool
 *  Ported from World Hub native page → Club Arena TSX
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useUnionRouteId } from '../hooks/useUnionRouteId';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { masterBus } from '../core/MasterBus';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { tournamentService, tournamentUnregisterSuccessText } from '../services/TournamentService';
import PageSkeleton from '../components/common/PageSkeleton';
import styles from './UnionGamesPage.module.css';
import { useIsMounted } from '../hooks/useIsMounted';
import { fmt, fmtChips } from '../utils/format';
import { reportError } from '../utils/errorReporter';
import { useTournamentRegistration } from '../hooks/useTournamentRegistration';
import CasinoSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import GameCreationActions from '../components/club/GameCreationActions';
import { unionService } from '../services/UnionService';

const formatDate = (ts: string | null) => {
  if (!ts) return '-';
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    registering: { bg: '#31A24C22', color: '#31A24C' },
    running: { bg: '#F5A62322', color: '#F5A623' },
    completed: { bg: '#3A3B3C', color: '#B0B3B8' },
    cancelled: { bg: '#FA383E22', color: '#FA383E' },
    active: { bg: '#31A24C22', color: '#31A24C' },
    waiting: { bg: '#F5A62322', color: '#F5A623' },
    closed: { bg: '#3A3B3C', color: '#B0B3B8' },
  };
  const c = map[status?.toLowerCase()] || { bg: '#3A3B3C', color: '#B0B3B8' };
  return (
    <span className={styles.statusBadge} style={{ background: c.bg, color: c.color }}>
      {status?.toUpperCase() || '-'}
    </span>
  );
}

interface UnionTournament {
  id: string;
  name: string;
  status: string;
  buy_in: number;
  max_players: number | null;
  tournament_type?: string | null;
  variant?: string | null;
  registered_count?: number;
  start_time?: string;
  prize_pool?: number;
  club_id?: string;
  clubs?: { name: string } | null;
  is_xmtt?: boolean;
}

interface UnionTable {
  id: string;
  name: string;
  status: string;
  game_type?: string;
  game_variant?: string;
  small_blind: number;
  big_blind: number;
  max_players: number;
  current_players: number;
  club_id?: string;
}

interface BBJPool {
  total_pool: number;
  qualifying_hands: number;
  last_hit?: string;
  contribution_rate: number;
}

export default function UnionGamesPage() {
  const { register: registerMtt, isRegistering: isRegisteringMtt } = useTournamentRegistration();

  const { user } = useAuthUser();
  const toast = useToast();
  const { unionId: paramUnionId, unionRef } = useUnionRouteId();
  const [searchParams] = useSearchParams();

  const [tab, setTab] = useState<'tournaments' | 'tables' | 'bbj'>('tournaments');
  const [loading, setLoading] = useState(true);
  const [unionId, setUnionId] = useState<string | null>(paramUnionId || null);
  const [unionName, setUnionName] = useState('');
  const [canManageGames, setCanManageGames] = useState(false);

  // Tournaments
  const [tournaments, setTournaments] = useState<UnionTournament[]>([]);
  const [tournFilter, setTournFilter] = useState<'all' | 'registering' | 'running' | 'completed'>(
    'all'
  );

  // Tables
  const [tables, setTables] = useState<UnionTable[]>([]);

  // BBJ
  const [bbjPool, setBbjPool] = useState<BBJPool | null>(null);

  const mountedRef = useIsMounted();

  const loadingRef = useRef(false);

  // ── CRITICAL: Reset per-union state when navigating between unions ──
  useEffect(() => {
    setTab('tournaments');
    setTournFilter('all');
    setCanManageGames(false);
    loadingRef.current = false;
  }, [paramUnionId]);

  // ── Load Data ────────────────────────────────────────────
  const loadUnionData = useCallback(
    async (uId?: string) => {
      const targetUnion = uId || unionId;
      if (!targetUnion) return;
      if (loadingRef.current) return;
      loadingRef.current = true;
      try {
        setLoading(true);

        // Load union info + clubs
        const [{ data: unionData }, { data: unionClubs }] = await Promise.all([
          supabase
            .from('unions')
            .select('id, name, code, description, owner_id, created_at')
            .eq('id', targetUnion)
            .maybeSingle(),
          supabase.from('union_clubs').select('club_id').eq('union_id', targetUnion),
        ]);

        if (!mountedRef.current) return;
        setUnionName(unionData?.name || 'Union');
        const cIds = (unionClubs || []).map((c: any) => c.club_id).filter(Boolean);
        if (cIds.length === 0) {
          setTournaments([]);
          setTables([]);
          setLoading(false);
          return;
        }

        // Parallel load
        const [{ data: tournData }, { data: tableData }, { data: bbjData }] = await Promise.all([
          // PRIVACY FIX 2026-08-19: this listed tournaments by member club id,
          // so every club's PRIVATE tournaments were exposed union-wide. The
          // union lobby shows union-OWNED games only; private club games carry
          // union_id = NULL and are visible solely inside their own club.
          supabase
            .from('tournaments')
            .select('*, clubs(name)')
            .eq('union_id', targetUnion)
            .order('start_time', { ascending: false })
            .limit(50),
          supabase
            .from('tables')
            .select(
              'id, name, status, game_type, game_variant, small_blind, big_blind, max_players, current_players, club_id, union_id'
            )
            .eq('union_id', targetUnion)
            // Cash lobby hygiene: no tournament tables, no closed/deleted rows.
            .is('tournament_id', null)
            .eq('is_deleted', false)
            .neq('status', 'closed')
            .order('current_players', { ascending: false })
            .limit(200),
          supabase.rpc('get_bbj_pool', { p_union_id: targetUnion }).maybeSingle(),
        ]);

        if (!mountedRef.current) return;

        // Sort tournaments: registering first, then running, then completed
        const statusOrder: Record<string, number> = {
          registering: 0,
          announced: 1,
          running: 2,
          completed: 3,
          cancelled: 4,
        };
        const sorted = (tournData || []).sort((a: any, b: any) => {
          const aOrd = statusOrder[a.status?.toLowerCase()] ?? 5;
          const bOrd = statusOrder[b.status?.toLowerCase()] ?? 5;
          if (aOrd !== bOrd) return aOrd - bOrd;
          return new Date(b.start_time || 0).getTime() - new Date(a.start_time || 0).getTime();
        });

        setTournaments(sorted);
        setTables(tableData || []);
        setBbjPool(bbjData as BBJPool | null);
      } catch (err: any) {
        console.warn('[UnionGames] Load fail:', err.message);
      } finally {
        loadingRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    },
    [unionId]
  );

  // Init
  useEffect(() => {
    if (!user) return;
    let isMounted = true;
    const init = async () => {
      let targetUnion = paramUnionId || searchParams.get('union') || searchParams.get('unionId');

      if (!targetUnion) {
        // Find user's union through their club membership
        const { data: mem } = await supabase
          .from('club_members')
          .select('club_id')
          .eq('user_id', user.id)
          .limit(1)
          .maybeSingle();
        if (mem?.club_id) {
          const { data: uc } = await supabase
            .from('union_clubs')
            .select('union_id')
            .eq('club_id', mem.club_id)
            .limit(1)
            .maybeSingle();
          targetUnion = uc?.union_id || null;
        }
      }

      if (targetUnion && isMounted) {
        setUnionId(targetUnion);
        const operator = await unionService.isUnionAdmin(targetUnion, user.id);
        if (!isMounted) return;
        setCanManageGames(operator);
        loadUnionData(targetUnion);
      } else if (isMounted) {
        toast.error('No union found.');
        setLoading(false);
      }
    };
    init();
    return () => {
      isMounted = false;
    };
  }, [user, paramUnionId, searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  // Realtime (debounced)
  useEffect(() => {
    if (!unionId) return;
    const refresh = () => loadUnionData(unionId);
    const unsubs = [
      masterBus.subscribeDebounced('TOURNAMENT_REGISTERED', refresh, 500),
      masterBus.subscribeDebounced('TABLE_UPDATED', refresh, 500),
    ];

    // WebSocket: live tournament updates for this union
    const channelKey = `union-games-${unionId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournaments',
          /* DB LOAD PASS 2026-08-24: unfiltered, this reloaded the whole union
             games list on every tournament write anywhere on the platform.
             `union_id` is the page's own scope — the effect already returns
             early without it. Do not widen this. */
          filter: `union_id=eq.${unionId}`,
        },
        () => refresh()
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'UnionGamesPage._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[UnionGamesPage] Realtime channel timed out');
        }
      });

    return () => {
      unsubs.forEach((u) => u());
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [unionId, loadUnionData]);

  useVisibilityRefresh(async () => {
    if (unionId) loadUnionData(unionId);
  });

  // Filtered tournaments
  const filteredTournaments = useMemo(() => {
    if (tournFilter === 'all') return tournaments;
    return tournaments.filter((t) => t.status?.toLowerCase() === tournFilter);
  }, [tournaments, tournFilter]);

  // Table grouping
  const activeTables = useMemo(() => tables.filter((t) => (t.current_players || 0) > 0), [tables]);
  const emptyTables = useMemo(() => tables.filter((t) => (t.current_players || 0) === 0), [tables]);

  // Register / Unregister
  /**
   * Dan 2026-08-25 (binding): one confirmation per buy-in — and this page had
   * ZERO. Direct `registerPlayer`, one tap, chips gone, while `registerMtt`
   * sat destructured and unused at the top of the file.
   *
   * Routed through the shared hook. `club_id` is carried because a union game
   * is bought with the chips of the club the player entered through, and the
   * balance on the card has to be read against that same club or it can refuse
   * a player who is perfectly well funded.
   */
  const handleRegister = async (tournamentId: string) => {
    if (!user) return;
    const t = tournaments.find((x) => x.id === tournamentId);
    if (!t) {
      toast.error('That Tournament Is No Longer Listed');
      return;
    }
    await registerMtt(
      {
        id: t.id,
        name: t.name,
        buy_in_amount: Number((t as any).buy_in_amount ?? (t as any).buy_in ?? 0),
        buy_in_fee: Number((t as any).buy_in_fee ?? 0),
        start_time: (t as any).start_time ?? null,
        /* Deliberately NOT `t.club_id`. A union-owned tournament carries the
           UNION container in that column, and a union id handed to
           `fn_player_spendable_balance` resolves to no wallet at all. Null lets
           the hook fall back to the player's ambient club, which is the club
           they entered through and the one that will actually be charged. */
        club_id: null,
        bounty_amount: (t as any).is_bounty ? (t as any).bounty_amount || 0 : 0,
        is_pko: !!(t as any).is_pko,
        is_mystery_bounty: !!(t as any).is_mystery_bounty,
        status: t.status,
      },
      () => loadUnionData(unionId || undefined)
    );
  };

  const handleUnregister = async (tournamentId: string) => {
    if (!user) return;
    try {
      // unregisterPlayer handles buy-in refund, status validation, CAS deletion, and rollback
      const result = await tournamentService.unregisterPlayer(tournamentId, user.id);
      toast.success(tournamentUnregisterSuccessText(result));
      loadUnionData(unionId || undefined);
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  if (loading) return <PageSkeleton variant="dashboard" />;

  return (
    <div className={styles.page}>
      <CasinoSurfaceHeader
        crest="club"
        eyebrow="Union Network / Games"
        title={`${unionName || 'Union'} Games`}
        description="Enter Active Union Tables, Register For Network Tournaments, And Inspect The Shared Bad-Beat Pool Through The Existing Game Services."
        artPath="assets/club-buttons/wallets/desktop/wallet-union-bank-v1.webp"
        status="UNION GAMES // LIVE"
        metrics={[
          {
            label: 'Active Events',
            value: tournaments.filter((t) =>
              ['registering', 'running'].includes(t.status?.toLowerCase())
            ).length,
            tone: 'attention',
          },
          { label: 'Live Tables', value: activeTables.length, tone: 'live' },
          {
            label: 'Seated',
            value: tables.reduce((sum, table) => sum + (table.current_players || 0), 0),
          },
        ]}
        actions={
          <>
            {unionId && canManageGames && (
              <>
                <Link
                  to={`/unions/${unionRef || unionId}/table-management`}
                  className={styles.btnGhost}
                >
                  Table Management
                </Link>
                <GameCreationActions
                  managementPath={`/unions/${unionRef || unionId}/table-management`}
                  compact
                />
              </>
            )}
            {unionId && (
              <Link to={`/unions/${unionRef || unionId}`} className={styles.btnGhost}>
                Union
              </Link>
            )}
            <Link to="/" className={styles.btnGhost}>
              Lobby
            </Link>
            <button onClick={() => loadUnionData(unionId || undefined)} className={styles.btnGhost}>
              Refresh
            </button>
          </>
        }
      />

      {/* Stats Row */}
      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <div className={styles.statValueGold}>
            {fmt(
              tournaments.filter((t) =>
                ['registering', 'running'].includes(t.status?.toLowerCase())
              ).length
            )}
          </div>
          <div className={styles.statLabel}>Active Tournaments</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statValueGreen}>{fmt(activeTables.length)}</div>
          <div className={styles.statLabel}>Live Tables</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statValueBlue}>
            {fmt(tables.reduce((sum, t) => sum + (t.current_players || 0), 0))}
          </div>
          <div className={styles.statLabel}>Players At Tables</div>
        </div>
        {bbjPool && (
          <div className={styles.statCard}>
            <div className={styles.statValuePurple}>{fmtChips(bbjPool.total_pool)}</div>
            <div className={styles.statLabel}>BBJ Pool</div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <nav className={styles.tabNav}>
        <button
          className={`${styles.tab} ${tab === 'tournaments' ? styles.tabActive : ''}`}
          onClick={() => setTab('tournaments')}
        >
          Tournaments <span className={styles.tabBadge}>{tournaments.length}</span>
        </button>
        <button
          className={`${styles.tab} ${tab === 'tables' ? styles.tabActive : ''}`}
          onClick={() => setTab('tables')}
        >
          Tables <span className={styles.tabBadge}>{tables.length}</span>
        </button>
        <button
          className={`${styles.tab} ${tab === 'bbj' ? styles.tabActive : ''}`}
          onClick={() => setTab('bbj')}
        >
          BBJ Pool
        </button>
      </nav>

      {/* ═══════════ TAB: TOURNAMENTS ═══════════════ */}
      {tab === 'tournaments' && (
        <div className={styles.section}>
          {/* Filter */}
          <div className={styles.filterBar}>
            {(['all', 'registering', 'running', 'completed'] as const).map((f) => (
              <button
                key={f}
                className={tournFilter === f ? styles.btnPrimary : styles.btnGhost}
                onClick={() => setTournFilter(f)}
                style={{ textTransform: 'capitalize' }}
              >
                {f}
              </button>
            ))}
          </div>

          {filteredTournaments.length === 0 ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>★</span>
              <span className={styles.emptyText}>No Tournaments Match The Filter.</span>
            </div>
          ) : (
            <div className={styles.cardList}>
              {filteredTournaments.map((t) => (
                <div key={t.id} className={styles.tournCard}>
                  <div className={styles.tournHeader}>
                    <div>
                      <div className={styles.tournName}>{t.name || 'Tournament'}</div>
                      <div className={styles.tournClub}>
                        {(t.clubs as any)?.name || ''}{' '}
                        {t.is_xmtt && <span className={styles.xmttBadge}>XMTT</span>}
                      </div>
                    </div>
                    <StatusBadge status={t.status} />
                  </div>
                  <div className={styles.tournMeta}>
                    <span> {fmtChips(t.buy_in)}</span>
                    <span>
                      {t.registered_count || 0}
                      {normalizeTournamentMaxPlayers(t) !== null ? `/${t.max_players}` : ''}
                    </span>
                    <span> {formatDate(t.start_time || null)}</span>
                    {t.prize_pool ? <span> {fmtChips(t.prize_pool)}</span> : null}
                  </div>
                  <div className={styles.tournActions}>
                    <Link to={`/tournaments/${t.id}`} className={styles.btnGhost}>
                      View Details
                    </Link>
                    {t.status?.toLowerCase() === 'registering' && (
                      <>
                        <button onClick={() => handleRegister(t.id)} className={styles.btnRegister}>
                          Register
                        </button>
                        <button onClick={() => handleUnregister(t.id)} className={styles.btnGhost}>
                          Unregister
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══════════ TAB: TABLES ═══════════════════ */}
      {tab === 'tables' && (
        <div className={styles.section}>
          {tables.length === 0 ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>▦</span>
              <span className={styles.emptyText}>No Tables Running Across Union Clubs.</span>
            </div>
          ) : (
            <>
              {activeTables.length > 0 && (
                <>
                  <h3 className={styles.subsectionTitle}>Active Tables ({activeTables.length})</h3>
                  <div className={styles.tableGrid}>
                    {activeTables.map((table) => (
                      <Link key={table.id} to={`/table/${table.id}`} className={styles.tableCard}>
                        <div className={styles.tableCardHeader}>
                          <span className={styles.tableName}>{table.name}</span>
                          <span className={styles.playerCountActive}>
                            {table.current_players}/{table.max_players}
                          </span>
                        </div>
                        <div className={styles.tableCardMeta}>
                          <span>
                            {table.small_blind}/{table.big_blind}
                          </span>
                          <span>{table.game_variant || 'NLH'}</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </>
              )}

              {emptyTables.length > 0 && (
                <>
                  <h3 className={styles.subsectionTitle} style={{ marginTop: 24 }}>
                    Empty Tables ({emptyTables.length})
                  </h3>
                  <div className={styles.tableGrid}>
                    {emptyTables.map((table) => (
                      <Link
                        key={table.id}
                        to={`/table/${table.id}`}
                        className={styles.tableCard}
                        style={{ opacity: 0.6 }}
                      >
                        <div className={styles.tableCardHeader}>
                          <span className={styles.tableName}>{table.name}</span>
                          <span className={styles.playerCountEmpty}>0/{table.max_players}</span>
                        </div>
                        <div className={styles.tableCardMeta}>
                          <span>
                            {table.small_blind}/{table.big_blind}
                          </span>
                          <span>{table.game_variant || 'NLH'}</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* ═══════════ TAB: BBJ POOL ═════════════════ */}
      {tab === 'bbj' && (
        <div className={styles.section}>
          {!bbjPool ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>◆</span>
              <span className={styles.emptyText}>
                Bad Beat Jackpot Is Not Enabled For This Union.
              </span>
            </div>
          ) : (
            <div className={styles.bbjContainer}>
              <div className={styles.bbjPoolCard}>
                <div className={styles.bbjLabel}>Current BBJ Pool</div>
                <div className={styles.bbjAmount}>{fmtChips(bbjPool.total_pool)}</div>
                <div className={styles.bbjSublabel}>Bad Beat Jackpot</div>
              </div>

              <div className={styles.statsGrid}>
                <div className={styles.statCard}>
                  <div className={styles.statValue}>{fmt(bbjPool.qualifying_hands)}</div>
                  <div className={styles.statLabel}>Qualifying Hands</div>
                </div>
                <div className={styles.statCard}>
                  <div className={styles.statValue}>
                    {(bbjPool.contribution_rate * 100).toFixed(1)}%
                  </div>
                  <div className={styles.statLabel}>Contribution Rate</div>
                </div>
                <div className={styles.statCard}>
                  <div className={styles.statValue}>
                    {bbjPool.last_hit ? formatDate(bbjPool.last_hit) : 'Never'}
                  </div>
                  <div className={styles.statLabel}>Last Hit</div>
                </div>
              </div>

              <div className={styles.bbjInfo}>
                <h3>How The Bad Beat Jackpot Works</h3>
                <ul>
                  <li>A Small Percentage Of Each Eligible Pot Is Contributed To The BBJ Pool</li>
                  <li>
                    When A Qualifying Hand Occurs (E.G., Quad Jacks Beaten), The Pool Is Distributed
                  </li>
                  <li>
                    The Loser (Bad Beat) Receives The Largest Share, Followed By The Winner, And
                    Remaining Table Players
                  </li>
                  <li>All Clubs In The Union Participate In And Benefit From The Shared Jackpot</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
