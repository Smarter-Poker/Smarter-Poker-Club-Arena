/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE - XMTT (Cross-Club Multi-Table Tournament) Lobby
 *  Ported from World Hub native page → Club Arena TSX
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE CONSOLE (#ClubArenaConsole, 2026-09-08). The page was a two-column split
 * of rounded cards: a coloured status pill per row, a four-cell detail GRID, a
 * gold value, a green value and four gradient buttons. It is Dan's approved
 * spade master now - one console for the lobby head and its filters, one per
 * tournament, one for the detail pane - and every figure prints as a row on the
 * black glass, label in the master's lit blue on the left, value in silver on
 * the right, with an engraved rule between rows. The status is a word in the
 * well's painted pill slot rather than a coloured chip, and the two money
 * actions are the plates painted into the foot.
 *
 * Nothing about what the page DOES has changed: the club resolution, the
 * 30-second poll, the realtime and visibility refreshes, the shared
 * registration hook that owns the one buy-in confirmation, the waitlist calls
 * and the error banner are all exactly as they were.
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
import { compactChips, fmtChips } from '../utils/format';
// Whole-number tournament money (Dan 2026-08-20).
import { formatBuyIn, money, totalBuyIn } from '../utils/buyIn';
import { reportError } from '../utils/errorReporter';
import { clubGamesOrFilter } from '../utils/unionScope';
import { resolveClubUUID } from '../utils/clubIdResolver';

import { safeErrorMessage } from '../utils/safeErrorMessage';
import { useTournamentRegistration } from '../hooks/useTournamentRegistration';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import { resolvePageClubId } from '../utils/resolvePageClubId';
import {
  SpadeConsole,
  type ConsoleInk,
  type PlateButtonProps,
} from '../components/console/SpadeConsole';

const formatDate = (ts: string | null) => {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

/**
 * The status, as a word in the master's own ink. It used to be a rounded chip
 * with its own background and an amber that is not a house colour.
 */
const STATUS_INK: Record<string, { ink: ConsoleInk; label: string }> = {
  registering: { ink: 'green', label: 'Reg Open' },
  running: { ink: 'blue', label: 'Running' },
  completed: { ink: 'muted', label: 'Complete' },
  cancelled: { ink: 'red', label: 'Cancelled' },
};

function statusInk(status: string): { ink: ConsoleInk; label: string } {
  return STATUS_INK[status] ?? { ink: 'muted', label: status?.toUpperCase() || '-' };
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

  /** The two plates a listed tournament offers. Both, or neither. */
  const platesFor = (t: Tournament): { secondary: PlateButtonProps; primary: PlateButtonProps } => {
    const atCapacity = (t.registered_count || 0) >= (t.max_players || Infinity) && !!t.max_players;

    if (t.status !== 'registering') {
      return {
        secondary: {
          label: 'Details',
          onClick: (e) => {
            e.stopPropagation();
            setSelectedTournament(t.id);
            loadDetail(t.id);
          },
        },
        primary: { label: statusInk(t.status).label, ink: 'muted', disabled: true },
      };
    }

    if (atCapacity) {
      const inLine = waitlistPositions[t.id];
      return {
        secondary: {
          label: 'Details',
          onClick: (e) => {
            e.stopPropagation();
            setSelectedTournament(t.id);
            loadDetail(t.id);
          },
        },
        primary: inLine
          ? {
              label: waitlistProcessing === t.id ? 'Working...' : 'Leave Waitlist',
              ink: 'red',
              disabled: waitlistProcessing === t.id,
              onClick: (e) => {
                e.stopPropagation();
                handleLeaveWaitlist(t.id);
              },
            }
          : {
              label: waitlistProcessing === t.id ? 'Joining...' : 'Join Waitlist',
              ink: 'white',
              disabled: waitlistProcessing === t.id,
              onClick: (e) => {
                e.stopPropagation();
                handleJoinWaitlist(t.id);
              },
            },
      };
    }

    return {
      secondary: {
        label: 'Unregister',
        ink: 'red',
        onClick: (e) => {
          e.stopPropagation();
          handleUnregister(t.id);
        },
      },
      primary: {
        label: isRegisteringMtt ? 'Working...' : 'Register',
        ink: 'white',
        disabled: isRegisteringMtt,
        onClick: (e) => {
          e.stopPropagation();
          handleRegister(t.id);
        },
      },
    };
  };

  return (
    <div className={styles.page}>
      {/* ── The lobby head: title, filters, and the two ways out ─────────── */}
      <SpadeConsole
        as="section"
        className={styles.head}
        eyebrow="Cross Club"
        title="XMTT Lobby"
        subtitle="Multi-Table Tournaments"
        pill={`${filtered.length}`}
        pillInk="blue"
        foot="foot"
      >
        <nav className={styles.filters} aria-label="Tournament Filters">
          {(['all', 'registering', 'running', 'completed'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              className={`${styles.filter} ${filter === f ? styles.filterActive : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
              {f !== 'all' &&
                ` (${tournaments.filter((t) => String(t.status).toLowerCase() === f).length})`}
            </button>
          ))}
        </nav>

        <p className={styles.links}>
          <Link to="/tournaments" className={`${styles.link} sc-ink--blue`}>
            All Tournaments
          </Link>
          <Link to="/" className={`${styles.link} sc-ink--blue`}>
            Lobby
          </Link>
        </p>

        {actionError && (
          <div className={styles.error} role="alert">
            <span className={styles.actionError}>{actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className={`${styles.link} sc-ink--muted`}
            >
              Dismiss
            </button>
          </div>
        )}
      </SpadeConsole>

      {/* ── The tournaments ──────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <SpadeConsole
          as="div"
          className={styles.card}
          eyebrow="Cross Club"
          title="No Tournaments"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center">No MTT Tournaments Found For This Filter.</p>
          <p className={styles.links}>
            <Link to="/" className={`${styles.link} sc-ink--blue`}>
              Go To Lobby
            </Link>
          </p>
        </SpadeConsole>
      ) : (
        filtered.map((t) => {
          const s = statusInk(t.status);
          const inLine = waitlistPositions[t.id];
          return (
            <SpadeConsole
              key={t.id}
              as="div"
              className={`${styles.card} ${selectedTournament === t.id ? styles.cardSelected : ''}`}
              eyebrow="Tournament"
              title={t.name || 'Tournament'}
              pill={s.label}
              pillInk={s.ink}
              onClick={() => {
                setSelectedTournament(t.id);
                loadDetail(t.id);
              }}
              style={{ cursor: 'pointer' }}
              plates={platesFor(t)}
            >
              <div className={styles.rows}>
                <div className={styles.row}>
                  <span className="sc-label sc-ink--blue">Buy-In</span>
                  {/* The advertised buy-in is the TOTAL (prize + fee), as whole
                      chips, and EXACT: it is what the server charges.
                      buy_in_amount alone understated it by the fee and could
                      print a decimal on legacy rows. */}
                  <span className={`${styles.value} sc-ink--silver`}>
                    {money(totalBuyIn(t.buy_in, t.buy_in_fee))}
                  </span>
                </div>
                <div className={styles.row}>
                  <span className="sc-label sc-ink--blue">Entries</span>
                  <span className={`${styles.value} sc-ink--silver`}>
                    {(t.registered_count || 0).toLocaleString()}
                    {t.max_players ? ` / ${t.max_players.toLocaleString()}` : ' / Open'}
                  </span>
                </div>
                <div className={styles.row}>
                  <span className="sc-label sc-ink--blue">Starts</span>
                  <span className={`${styles.value} sc-ink--silver`}>
                    {formatDate(t.start_time || t.created_at)}
                  </span>
                </div>
                {inLine ? (
                  <div className={styles.row}>
                    <span className="sc-label sc-ink--blue">Waitlist</span>
                    <span className={`${styles.value} sc-ink--gold`}>Position {inLine}</span>
                  </div>
                ) : null}
              </div>
            </SpadeConsole>
          );
        })
      )}

      {/* ── The detail pane ──────────────────────────────────────────────── */}
      {selectedTournament && (
        <SpadeConsole
          as="div"
          className={styles.card}
          eyebrow="Tournament"
          title={detail?.tournament?.name || 'Tournament Details'}
          pill={detail ? statusInk(detail.tournament?.status).label : undefined}
          pillInk={detail ? statusInk(detail.tournament?.status).ink : 'muted'}
          foot="foot"
        >
          {detailLoading ? (
            <p className="sc-copy sc-copy--center">Loading Details...</p>
          ) : detail ? (
            <>
              <div className={styles.rows}>
                <div className={styles.row}>
                  <span className="sc-label sc-ink--blue">Buy-In</span>
                  <span className={`${styles.value} sc-ink--silver`}>
                    {formatBuyIn(detail.tournament?.buy_in ?? 0, detail.tournament?.buy_in_fee)}
                  </span>
                </div>
                <div className={styles.row}>
                  <span className="sc-label sc-ink--blue">Prize Pool</span>
                  <span className={`${styles.value} sc-ink--gold`}>
                    {compactChips(detail.tournament?.prize_pool || 0)}
                  </span>
                </div>
                <div className={styles.row}>
                  <span className="sc-label sc-ink--blue">Registered</span>
                  <span className={`${styles.value} sc-ink--silver`}>
                    {(detail.registrations?.length || 0).toLocaleString()}
                  </span>
                </div>
              </div>

              <h4 className={`${styles.sectionTitle} sc-ink--silver`}>Registered Players</h4>
              <div className={styles.rows}>
                {(detail.registrations || []).length === 0 ? (
                  <p className="sc-copy sc-copy--center">No Registrations Yet</p>
                ) : (
                  (detail.registrations || []).map((r, i) => (
                    <div key={r.user_id || i} className={styles.row}>
                      <span className={`${styles.player} sc-ink--silver`}>
                        {r.display_name || r.username || 'Player'}
                      </span>
                      <span className={`${styles.value} sc-ink--blue`}>
                        {fmtChips(r.chips ?? 0)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <p className="sc-copy sc-copy--center">Select A Tournament</p>
          )}
        </SpadeConsole>
      )}
    </div>
  );
}
