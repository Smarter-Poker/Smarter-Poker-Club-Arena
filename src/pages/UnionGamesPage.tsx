/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Union Games Page
 *  3 Tabs: Tournaments | Tables | BBJ Pool
 *  Ported from World Hub native page → Club Arena TSX
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { masterBus } from '../core/MasterBus';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PageSkeleton from '../components/common/PageSkeleton';
import styles from './UnionGamesPage.module.css';

const fmt = (n: number) => Number(n || 0).toLocaleString();
const fmtChips = (n: number) => {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return fmt(v);
};
const formatDate = (ts: string | null) => {
  if (!ts) return '—';
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
      {status?.toUpperCase() || '—'}
    </span>
  );
}

interface UnionTournament {
  id: string;
  name: string;
  status: string;
  buy_in: number;
  max_players: number;
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
  const { user } = useAuthUser();
  const toast = useToast();
  const { unionId: paramUnionId } = useParams<{ unionId: string }>();
  const [searchParams] = useSearchParams();

  const [tab, setTab] = useState<'tournaments' | 'tables' | 'bbj'>('tournaments');
  const [loading, setLoading] = useState(true);
  const [unionId, setUnionId] = useState<string | null>(paramUnionId || null);
  const [unionName, setUnionName] = useState('');

  // Tournaments
  const [tournaments, setTournaments] = useState<UnionTournament[]>([]);
  const [tournFilter, setTournFilter] = useState<'all' | 'registering' | 'running' | 'completed'>(
    'all'
  );

  // Tables
  const [tables, setTables] = useState<UnionTable[]>([]);

  // BBJ
  const [bbjPool, setBbjPool] = useState<BBJPool | null>(null);

  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  // ── Load Data ────────────────────────────────────────────
  const loadUnionData = useCallback(
    async (uId?: string) => {
      const targetUnion = uId || unionId;
      if (!targetUnion) return;
      try {
        setLoading(true);

        // Load union info + clubs
        const [{ data: unionData }, { data: unionClubs }] = await Promise.all([
          supabase.from('unions').select('*').eq('id', targetUnion).maybeSingle(),
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
          supabase
            .from('tournaments')
            .select('*, clubs(name)')
            .in('club_id', cIds)
            .order('start_time', { ascending: false })
            .limit(50),
          supabase
            .from('poker_tables')
            .select('*')
            .in('club_id', cIds)
            .order('current_players', { ascending: false }),
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

  // Realtime
  useEffect(() => {
    if (!unionId) return;
    const refresh = () => loadUnionData(unionId);
    const unsubs = [
      masterBus.subscribe('TOURNAMENT_REGISTERED', refresh),
      masterBus.subscribe('TOURNAMENT_STARTED', refresh),
      masterBus.subscribe('TOURNAMENT_COMPLETE', refresh),
      masterBus.subscribe('TABLE_UPDATED', refresh),
    ];
    return () => unsubs.forEach((u) => u());
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
  const handleRegister = async (tournamentId: string) => {
    if (!user) return;
    try {
      const { error } = await supabase.from('tournament_players').insert({
        tournament_id: tournamentId,
        user_id: user.id,
        status: 'registered',
      });
      if (error) throw error;
      masterBus.emit('TOURNAMENT_REGISTERED', { tournamentId, unionId: unionId || undefined });
      loadUnionData(unionId || undefined);
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  if (loading) return <PageSkeleton variant="dashboard" />;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>🎮 {unionName} — Games</h1>
        </div>
        <div className={styles.headerActions}>
          {unionId && (
            <Link to={`/unions/${unionId}`} className={styles.btnGhost}>
              🏛️ Union
            </Link>
          )}
          <Link to="/lobby" className={styles.btnGhost}>
            🏠 Lobby
          </Link>
          <button onClick={() => loadUnionData(unionId || undefined)} className={styles.btnGhost}>
            ↻ Refresh
          </button>
        </div>
      </header>

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
          <div className={styles.statLabel}>Players at Tables</div>
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
          🏆 Tournaments <span className={styles.tabBadge}>{tournaments.length}</span>
        </button>
        <button
          className={`${styles.tab} ${tab === 'tables' ? styles.tabActive : ''}`}
          onClick={() => setTab('tables')}
        >
          🎰 Tables <span className={styles.tabBadge}>{tables.length}</span>
        </button>
        <button
          className={`${styles.tab} ${tab === 'bbj' ? styles.tabActive : ''}`}
          onClick={() => setTab('bbj')}
        >
          💎 BBJ Pool
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
              <span className={styles.emptyIcon}>🏆</span>
              <span className={styles.emptyText}>No tournaments match the filter.</span>
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
                    <span>💰 {fmtChips(t.buy_in)}</span>
                    <span>
                      👥 {t.registered_count || 0}/{t.max_players || '∞'}
                    </span>
                    <span>🕐 {formatDate(t.start_time || null)}</span>
                    {t.prize_pool ? <span>🏆 {fmtChips(t.prize_pool)}</span> : null}
                  </div>
                  <div className={styles.tournActions}>
                    <Link to={`/tournaments/${t.id}`} className={styles.btnGhost}>
                      View Details
                    </Link>
                    {t.status?.toLowerCase() === 'registering' && (
                      <button onClick={() => handleRegister(t.id)} className={styles.btnRegister}>
                        Register
                      </button>
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
              <span className={styles.emptyIcon}>🎰</span>
              <span className={styles.emptyText}>No tables running across union clubs.</span>
            </div>
          ) : (
            <>
              {activeTables.length > 0 && (
                <>
                  <h3 className={styles.subsectionTitle}>
                    🟢 Active Tables ({activeTables.length})
                  </h3>
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
                    ⚪ Empty Tables ({emptyTables.length})
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
              <span className={styles.emptyIcon}>💎</span>
              <span className={styles.emptyText}>
                Bad Beat Jackpot is not enabled for this union.
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
                <h3>How the Bad Beat Jackpot Works</h3>
                <ul>
                  <li>A small percentage of each eligible pot is contributed to the BBJ pool</li>
                  <li>
                    When a qualifying hand occurs (e.g., Quad Jacks beaten), the pool is distributed
                  </li>
                  <li>
                    The loser (bad beat) receives the largest share, followed by the winner, and
                    remaining table players
                  </li>
                  <li>All clubs in the union participate in and benefit from the shared jackpot</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
