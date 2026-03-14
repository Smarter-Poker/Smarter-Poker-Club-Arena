/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — XMTT (Cross-Club Multi-Table Tournament) Lobby
 *  Ported from World Hub native page → Club Arena TSX
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { masterBus } from '../core/MasterBus';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { tournamentService } from '../services/TournamentService';
import PageSkeleton from '../components/common/PageSkeleton';
import styles from './XMTTPage.module.css';

const fmt = (n: number) => Number(n || 0).toLocaleString();
const fmtChips = (n: number) => {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return fmt(v);
};
const formatDate = (ts: string | null) => {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    registering: { bg: '#31A24C22', color: '#31A24C', label: 'REG OPEN' },
    running: { bg: '#F5A62322', color: '#F5A623', label: 'RUNNING' },
    completed: { bg: '#3A3B3C', color: '#B0B3B8', label: 'COMPLETE' },
    cancelled: { bg: '#FA383E22', color: '#FA383E', label: 'CANCELLED' },
  };
  const c = map[status] || { bg: '#3A3B3C', color: '#B0B3B8', label: status?.toUpperCase() || '—' };
  return (
    <span className={styles.statusBadge} style={{ background: c.bg, color: c.color }}>
      {c.label}
    </span>
  );
}

interface Tournament {
  id: string;
  name: string;
  status: string;
  type?: string;
  buy_in: number;
  max_players: number;
  registered_count?: number;
  start_time?: string;
  created_at: string;
  prize_pool?: number;
}

interface TournamentDetail {
  tournament: Tournament;
  registrations: Array<{
    user_id: string;
    display_name?: string;
    username?: string;
    chip_count?: number;
    starting_chips?: number;
  }>;
}

export default function XMTTPage() {
  const { user } = useAuthUser();
  const toast = useToast();
  const [searchParams] = useSearchParams();

  const [clubId, setClubId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [filter, setFilter] = useState<'all' | 'registering' | 'running' | 'completed'>('all');
  const [selectedTournament, setSelectedTournament] = useState<string | null>(null);
  const [detail, setDetail] = useState<TournamentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  const loadTournaments = useCallback(
    async (cId?: string) => {
      const targetClub = cId || clubId;
      if (!targetClub) return;
      try {
        let query = supabase
          .from('tournaments')
          .select('*')
          .eq('club_id', targetClub)
          .order('start_time', { ascending: false });

        // Filter to MTT types
        query = query.in('type', ['mtt', 'xmtt']);

        const { data, error } = await query;
        if (error) throw error;
        if (mountedRef.current) setTournaments(data || []);
      } catch (err: any) {
        console.warn('[XMTT] Load fail:', err.message);
      }
    },
    [clubId]
  );

  const loadDetail = useCallback(async (tournamentId: string, _cId?: string) => {
    try {
      setDetailLoading(true);
      const [{ data: tourn }, { data: regs }] = await Promise.all([
        supabase.from('tournaments').select('*').eq('id', tournamentId).maybeSingle(),
        supabase
          .from('tournament_players')
          .select('*, profiles(display_name, username)')
          .eq('tournament_id', tournamentId),
      ]);
      if (mountedRef.current) {
        setDetail({
          tournament: tourn,
          registrations: (regs || []).map((r: any) => ({
            user_id: r.user_id,
            display_name: r.profiles?.display_name,
            username: r.profiles?.username,
            chip_count: r.chip_count,
            starting_chips: r.starting_chips,
          })),
        });
      }
    } catch (err: any) {
      console.warn('[XMTT] Detail fail:', err.message);
    } finally {
      if (mountedRef.current) setDetailLoading(false);
    }
  }, []);

  // Init
  useEffect(() => {
    if (!user) return;
    let isMounted = true;
    const init = async () => {
      const qClub = searchParams.get('club') || searchParams.get('clubId');
      let targetClub = qClub;
      if (!targetClub) {
        const { data: mem } = await supabase
          .from('club_members')
          .select('club_id')
          .eq('user_id', user.id)
          .limit(1)
          .maybeSingle();
        targetClub = mem?.club_id || null;
      }
      if (targetClub && isMounted) {
        setClubId(targetClub);
        await loadTournaments(targetClub);
        setLoading(false);
      } else if (isMounted) {
        toast.error('No club found.');
        setLoading(false);
      }
    };
    init();
    return () => {
      isMounted = false;
    };
  }, [user, searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-poll every 30s
  useEffect(() => {
    if (!clubId) return;
    const iv = setInterval(() => loadTournaments(clubId), 30000);
    return () => clearInterval(iv);
  }, [clubId, loadTournaments]);

  // Realtime refresh
  useEffect(() => {
    if (!clubId) return;
    const refresh = () => {
      loadTournaments(clubId);
      if (selectedTournament) loadDetail(selectedTournament);
    };
    const unsubs = [
      masterBus.subscribe('TOURNAMENT_REGISTERED', refresh),
      masterBus.subscribe('TOURNAMENT_STARTED', refresh),
      masterBus.subscribe('TOURNAMENT_COMPLETE', refresh),
      // Phase 4: Cross-page sync (ported from World Hub xmtt.js)
      masterBus.subscribe('TOURNAMENT_CANCELLED', refresh),
      masterBus.subscribe('TOURNAMENT_LEVEL_CHANGE', refresh),
    ];
    return () => unsubs.forEach((u) => u());
  }, [clubId, selectedTournament, loadTournaments, loadDetail]);

  // Visibility refresh
  useVisibilityRefresh(async () => {
    if (!clubId) return;
    loadTournaments(clubId);
    if (selectedTournament) loadDetail(selectedTournament);
  });

  // Register / Unregister
  const handleRegister = async (tournamentId: string) => {
    if (!user || !clubId) return;
    try {
      // registerPlayer handles buy-in deduction, escrow, duplicate check, and event emission
      await tournamentService.registerPlayer(
        tournamentId,
        user.id,
        user.display_name || user.username || 'Player'
      );
      loadTournaments(clubId);
      if (selectedTournament === tournamentId) loadDetail(tournamentId);
    } catch (err: any) {
      setActionError(err.message);
      setTimeout(() => setActionError(null), 5000);
    }
  };

  const handleUnregister = async (tournamentId: string) => {
    if (!user || !clubId) return;
    try {
      // unregisterPlayer handles buy-in refund, status validation, CAS deletion, and rollback
      await tournamentService.unregisterPlayer(tournamentId, user.id);
      loadTournaments(clubId);
      if (selectedTournament === tournamentId) loadDetail(tournamentId);
    } catch (err: any) {
      setActionError(err.message);
      setTimeout(() => setActionError(null), 5000);
    }
  };

  const filtered = filter === 'all' ? tournaments : tournaments.filter((t) => t.status === filter);

  if (loading) return <PageSkeleton variant="dashboard" />;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>🏆 XMTT Tournament Lobby</h1>
        <div className={styles.headerActions}>
          <Link to="/tournaments" className={styles.btnGhost}>
            📋 All Tournaments
          </Link>
          <Link to="/lobby" className={styles.btnGhost}>
            🏠 Lobby
          </Link>
        </div>
      </header>

      {/* Filters */}
      <nav className={styles.tabNav}>
        {(['all', 'registering', 'running', 'completed'] as const).map((f) => (
          <button
            key={f}
            className={`${styles.tab} ${filter === f ? styles.tabActive : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            {f !== 'all' && ` (${tournaments.filter((t) => t.status === f).length})`}
          </button>
        ))}
      </nav>

      {actionError && (
        <div className={styles.actionError}>
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className={styles.dismissBtn}>
            ✕
          </button>
        </div>
      )}

      <div className={styles.splitLayout}>
        {/* Tournament List */}
        <div className={styles.listPanel}>
          {filtered.length === 0 ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>🏆</span>
              <span className={styles.emptyText}>No MTT tournaments found for this filter.</span>
              <Link to="/lobby" className={styles.btnPrimary} style={{ marginTop: 12 }}>
                🏠 Go to Lobby
              </Link>
            </div>
          ) : (
            filtered.map((t) => (
              <div
                key={t.id}
                className={`${styles.tournCard} ${selectedTournament === t.id ? styles.tournCardSelected : ''}`}
                onClick={() => {
                  setSelectedTournament(t.id);
                  loadDetail(t.id);
                }}
              >
                <div className={styles.tournCardHeader}>
                  <span className={styles.tournName}>{t.name || 'Tournament'}</span>
                  <StatusBadge status={t.status} />
                </div>
                <div className={styles.tournMeta}>
                  <span>💰 Buy-in: {fmtChips(t.buy_in)}</span>
                  <span>
                    👥 {t.registered_count || 0} / {t.max_players || '∞'}
                  </span>
                  <span>🕐 {formatDate(t.start_time || t.created_at)}</span>
                </div>
                {t.status === 'registering' && (
                  <div className={styles.tournActions}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRegister(t.id);
                      }}
                      className={styles.btnRegister}
                    >
                      Register
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleUnregister(t.id);
                      }}
                      className={styles.btnUnregister}
                    >
                      Unregister
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Detail Panel */}
        {selectedTournament && (
          <div className={styles.detailPanel}>
            {detailLoading ? (
              <div className={styles.detailLoading}>Loading details...</div>
            ) : detail ? (
              <>
                <h3 className={styles.detailTitle}>
                  {detail.tournament?.name || 'Tournament Details'}
                </h3>
                <div className={styles.detailGrid}>
                  <div>
                    <div className={styles.detailLabel}>Buy-In</div>
                    <div className={styles.detailValueGold}>
                      {fmtChips(detail.tournament?.buy_in)}
                    </div>
                  </div>
                  <div>
                    <div className={styles.detailLabel}>Prize Pool</div>
                    <div className={styles.detailValueGreen}>
                      {fmtChips(detail.tournament?.prize_pool || 0)}
                    </div>
                  </div>
                  <div>
                    <div className={styles.detailLabel}>Status</div>
                    <StatusBadge status={detail.tournament?.status} />
                  </div>
                  <div>
                    <div className={styles.detailLabel}>Players</div>
                    <div className={styles.detailValue}>{detail.registrations?.length || 0}</div>
                  </div>
                </div>
                <h4 className={styles.playerListTitle}>Registered Players</h4>
                <div className={styles.playerList}>
                  {(detail.registrations || []).length === 0 ? (
                    <div className={styles.noPlayers}>No registrations yet</div>
                  ) : (
                    (detail.registrations || []).map((r, i) => (
                      <div key={r.user_id || i} className={styles.playerRow}>
                        <span>{r.display_name || r.username || 'Player'}</span>
                        <span className={styles.playerChips}>
                          {fmtChips(r.chip_count || r.starting_chips || 0)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : (
              <div className={styles.noSelection}>Select a tournament</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
