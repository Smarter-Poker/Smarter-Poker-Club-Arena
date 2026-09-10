/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE - XMTT (Cross-Club Multi-Table Tournament) Lobby
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
import { tournamentService, tournamentUnregisterSuccessText } from '../services/TournamentService';
import PageSkeleton from '../components/common/PageSkeleton';
import styles from './XMTTPage.module.css';

import { useIsMounted } from '../hooks/useIsMounted';
import { fmt, formatTableChips } from '../utils/format';
// Whole-number tournament money (Dan 2026-08-20).
import { formatBuyIn, money, totalBuyIn } from '../utils/buyIn';
import { reportError } from '../utils/errorReporter';
import { clubGamesOrFilter } from '../utils/unionScope';
import { resolveClubUUID } from '../utils/clubIdResolver';

import { safeErrorMessage } from '../utils/safeErrorMessage';
import { useTournamentRegistration } from '../hooks/useTournamentRegistration';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import { resolvePageClubId } from '../utils/resolvePageClubId';

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
  const c = map[status] || { bg: '#3A3B3C', color: '#B0B3B8', label: status?.toUpperCase() || '-' };
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
  /** The PRIZE half of the split. Never render it alone - see totalBuyIn. */
  buy_in: number;
  buy_in_fee?: number | null;
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
    /**
     * The player's live stack.
     *
     * This used to read `chip_count` with a `starting_chips` fallback, and
     * rendered 0 for every player in the list. Both names are wrong:
     * `tournament_players.chip_count` sits beside `chips` and has never been
     * written by anything - 0 on all 13,623 rows registered in the 24h before
     * this fix - and `starting_chips` is not a column of `tournament_players`
     * at all, it lives on `tournaments`. So `chip_count || starting_chips || 0`
     * was `0 || undefined || 0`.
     *
     * `chips` is the column the engine actually writes, and it was already in
     * the `select('*')` this page issues.
     */
    chips?: number;
  }>;
}

export default function XMTTPage() {
  const { register: registerMtt, isRegistering: isRegisteringMtt } = useTournamentRegistration();

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

  const mountedRef = useIsMounted();
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadTournaments = useCallback(
    async (cId?: string) => {
      const targetClub = cId || clubId;
      if (!targetClub) return;
      try {
        // P2-2: this filter was triple-broken. (1) The URL param may be the
        // 6-digit integer club code, and eq('club_id', <int>) on a uuid
        // column matches nothing. (2) Union tournaments carry the union
        // container as club_id, so a plain club filter hid every union MTT.
        // (3) The type filter used the SELECT alias 'type' (not a real
        // column) with lowercase values - tournament_type holds 'MTT'.
        const uuid = await resolveClubUUID(targetClub);
        let query = supabase
          .from('tournaments')
          .select(
            'id, name, status, type:tournament_type, buy_in:buy_in_amount, buy_in_fee, max_players, registered_count:current_players, start_time, created_at, prize_pool, club_id, is_bounty, bounty_amount, is_pko, is_mystery_bounty'
          )
          .or(await clubGamesOrFilter(uuid))
          .order('start_time', { ascending: false });

        // Filter to MTT types (real column name, real uppercase values)
        query = query.in('tournament_type', ['MTT', 'XMTT']);

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
        supabase
          .from('tournaments')
          .select(
            'id, name, status, type:tournament_type, buy_in:buy_in_amount, buy_in_fee, max_players, registered_count:current_players, start_time, created_at, prize_pool, is_bounty, bounty_amount, is_pko, is_mystery_bounty'
          )
          .eq('id', tournamentId)
          .maybeSingle(),
        supabase
          .from('tournament_players')
          .select(`*, profiles(${PLAYER_NAME_COLUMNS})`)
          .eq('tournament_id', tournamentId),
      ]);
      if (mountedRef.current && tourn) {
        setDetail({
          tournament: tourn as Tournament,
          registrations: (regs || []).map((r: any) => ({
            user_id: r.user_id,
            display_name: playerDisplayName(r.profiles),
            username: r.profiles?.username,
            chips: r.chips,
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
      /* Two faults here, both removed by the shared resolver:

         1. The no-param fallback was `.limit(1)` with NO `.order()` — "a"
            membership rather than "the" one, so a multi-club player could get
            a different club's events on consecutive loads.
         2. The param was stored RAW and un-resolved, leaving a slug or a
            6-digit code in `clubId` state for later queries to choke on. The
            resolver always hands back a UUID. */
      const qClub = searchParams.get('club') || searchParams.get('clubId');
      const targetClub = qClub
        ? await resolvePageClubId({ routeClubId: qClub, allowFallback: false })
        : await resolvePageClubId({ userId: user.id });
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
      masterBus.subscribeDebounced('TOURNAMENT_REGISTERED', refresh, 500),
      // Phase 4: Cross-page sync (ported from World Hub xmtt.js)
      masterBus.subscribeDebounced('TOURNAMENT_CANCELLED', refresh, 500),
      // TOURNAMENT_LEVEL_CHANGE removed 2026-08-28: nothing emits it on the
      // client bus - BlindsTab documents that it is DELIBERATELY not emitted
      // (levels arrive on the snapshot), so this refresh never fired.
      // Phase 13: Waitlist position changes trigger tournament card refresh
      masterBus.subscribeDebounced('WAITLIST_POSITION_CHANGED', refresh, 500),
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
  /**
   * Dan 2026-08-25 (binding): one confirmation per buy-in - and this page had
   * ZERO. It called `tournamentService.registerPlayer` directly, so an XMTT
   * entry was a single unconfirmed tap that debited the wallet, while
   * `registerMtt` sat destructured and unused at the top of the file.
   *
   * Routed through the shared hook, which owns the Sign Up card, the
   * double-tap guard and the seat lookup. `club_id` matters here: an XMTT
   * spans clubs, and the balance the card shows must be read against the club
   * that actually pays for the seat, not whichever club is ambient.
   */
  const handleRegister = async (tournamentId: string) => {
    if (!user || !clubId) return;
    const t = tournaments.find((x) => x.id === tournamentId);
    if (!t) {
      setActionError('That Tournament Is No Longer Listed');
      return;
    }
    await registerMtt(
      {
        id: t.id,
        name: t.name,
        // This page aliases the column as `buy_in` in its select.
        buy_in_amount: Number((t as any).buy_in ?? (t as any).buy_in_amount ?? 0),
        buy_in_fee: Number(t.buy_in_fee ?? 0),
        start_time: (t as any).start_time ?? null,
        /* The player's OWN club, never the row's `club_id`: a union tournament
           carries the union container in that column (see the note at the top
           of loadTournaments), and handing a union id to the balance RPC reads
           a wallet that does not exist. */
        club_id: clubId,
        bounty_amount: (t as any).is_bounty ? (t as any).bounty_amount || 0 : 0,
        is_pko: !!(t as any).is_pko,
        is_mystery_bounty: !!(t as any).is_mystery_bounty,
        status: t.status,
      },
      () => {
        loadTournaments(clubId);
        if (selectedTournament === tournamentId) loadDetail(tournamentId);
      }
    );
  };

  const handleUnregister = async (tournamentId: string) => {
    if (!user || !clubId) return;
    try {
      // unregisterPlayer handles buy-in refund, status validation, CAS deletion, and rollback
      const result = await tournamentService.unregisterPlayer(tournamentId, user.id);
      toast.success(tournamentUnregisterSuccessText(result));
      loadTournaments(clubId);
      if (selectedTournament === tournamentId) loadDetail(tournamentId);
    } catch (err: any) {
      setActionError(safeErrorMessage(err));
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setActionError(null), 5000);
    }
  };

  // Waitlist state
  const [waitlistPositions, setWaitlistPositions] = useState<Record<string, number | null>>({});
  const [waitlistProcessing, setWaitlistProcessing] = useState<string | null>(null);

  // Load existing waitlist positions on mount for full-capacity tournaments
  useEffect(() => {
    if (!user || tournaments.length === 0) return;
    const fullTournaments = tournaments.filter(
      (t) => t.max_players && (t.registered_count || 0) >= t.max_players
    );
    if (fullTournaments.length === 0) return;

    fullTournaments.forEach(async (t) => {
      try {
        const result = await tournamentService.getTournamentWaitlistPosition(t.id, user.id);
        if (result) {
          setWaitlistPositions((prev) => ({ ...prev, [t.id]: result.position }));
        }
      } catch (e) {
        reportError(e, 'XMTTPage.setWaitlistPositions');
        // Non-critical - position just won't show
      }
    });
  }, [user?.id, tournaments.length]);

  const handleJoinWaitlist = async (tournamentId: string) => {
    if (!user) return;
    setWaitlistProcessing(tournamentId);
    try {
      const { position } = await tournamentService.joinTournamentWaitlist(tournamentId, user.id);
      setWaitlistPositions((prev) => ({ ...prev, [tournamentId]: position }));
    } catch (err: any) {
      setActionError(safeErrorMessage(err));
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setActionError(null), 5000);
    } finally {
      setWaitlistProcessing(null);
    }
  };

  const handleLeaveWaitlist = async (tournamentId: string) => {
    if (!user) return;
    setWaitlistProcessing(tournamentId);
    try {
      await tournamentService.leaveTournamentWaitlist(tournamentId, user.id);
      setWaitlistPositions((prev) => ({ ...prev, [tournamentId]: null }));
    } catch (err: any) {
      setActionError(safeErrorMessage(err));
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setActionError(null), 5000);
    } finally {
      setWaitlistProcessing(null);
    }
  };

  const filtered =
    filter === 'all'
      ? tournaments
      : tournaments.filter((t) => String(t.status).toLowerCase() === filter);

  if (loading) return <PageSkeleton variant="dashboard" />;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>XMTT Tournament Lobby</h1>
        <div className={styles.headerActions}>
          <Link to="/tournaments" className={styles.btnGhost}>
            All Tournaments
          </Link>
          <Link to="/" className={styles.btnGhost}>
            Lobby
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
            {f !== 'all' &&
              ` (${tournaments.filter((t) => String(t.status).toLowerCase() === f).length})`}
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
              <span className={styles.emptyIcon}>★</span>
              <span className={styles.emptyText}>No MTT Tournaments Found For This Filter.</span>
              <Link to="/" className={styles.btnPrimary} style={{ marginTop: 12 }}>
                Go To Lobby
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
                  {/* The advertised buy-in is the TOTAL (prize + fee), as whole
                      chips. buy_in_amount alone understated it by the fee and
                      could print a decimal on legacy rows. */}
                  <span> Buy-In: {money(totalBuyIn(t.buy_in, t.buy_in_fee))}</span>
                  <span>
                    {t.registered_count || 0} / {t.max_players || '∞'}
                  </span>
                  <span> {formatDate(t.start_time || t.created_at)}</span>
                </div>
                {t.status === 'registering' && (
                  <div className={styles.tournActions}>
                    {/* Register/Unregister - show when not at capacity */}
                    {(t.registered_count || 0) < (t.max_players || Infinity) && (
                      <>
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
                      </>
                    )}
                    {/* Waitlist - show when at capacity */}
                    {(t.registered_count || 0) >= (t.max_players || Infinity) && t.max_players && (
                      <>
                        {waitlistPositions[t.id] ? (
                          <>
                            <span
                              style={{ color: '#F5A623', fontSize: '0.75rem', fontWeight: 600 }}
                            >
                              Position #{waitlistPositions[t.id]}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleLeaveWaitlist(t.id);
                              }}
                              disabled={waitlistProcessing === t.id}
                              className={styles.btnUnregister}
                            >
                              {waitlistProcessing === t.id ? '...' : 'Leave Waitlist'}
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleJoinWaitlist(t.id);
                            }}
                            disabled={waitlistProcessing === t.id}
                            className={styles.btnRegister}
                          >
                            {waitlistProcessing === t.id ? 'Joining...' : 'Join Waitlist'}
                          </button>
                        )}
                      </>
                    )}
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
              <div className={styles.detailLoading}>Loading Details...</div>
            ) : detail ? (
              <>
                <h3 className={styles.detailTitle}>
                  {detail.tournament?.name || 'Tournament Details'}
                </h3>
                <div className={styles.detailGrid}>
                  <div>
                    <div className={styles.detailLabel}>Buy-In</div>
                    <div className={styles.detailValueGold}>
                      {formatBuyIn(detail.tournament?.buy_in ?? 0, detail.tournament?.buy_in_fee)}
                    </div>
                  </div>
                  <div>
                    <div className={styles.detailLabel}>Prize Pool</div>
                    <div className={styles.detailValueGreen}>
                      {money(detail.tournament?.prize_pool || 0)}
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
                    <div className={styles.noPlayers}>No Registrations Yet</div>
                  ) : (
                    (detail.registrations || []).map((r, i) => (
                      <div key={r.user_id || i} className={styles.playerRow}>
                        <span>{r.display_name || r.username || 'Player'}</span>
                        <span className={styles.playerChips}>{formatTableChips(r.chips ?? 0)}</span>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : (
              <div className={styles.noSelection}>Select A Tournament</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
