/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — TOURNAMENT LOBBY (the page shell)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This file used to be the whole lobby: eight inline tab blocks, four clocks,
 * two polls of the same table and about 2,000 lines. The tabs now live in
 * `src/components/tournament/details/`, each one taking the single prop shape
 * declared in `details/types.ts`. What is left here is the shell and nothing
 * else:
 *
 *   [header] [tabs] [title] [content] [footer]
 *
 * ── THE SHELL DOES NOT SCROLL ─────────────────────────────────────────────
 *
 * Dan asked for Detail on one screen. That is a layout property, not a content
 * diet: the shell is a 100dvh flex column, `content` is the only child that
 * grows, and it carries `min-height: 0` because a flex child otherwise refuses
 * to shrink below its content and the page grows a scrollbar anyway. Each tab
 * scrolls INSIDE that box (the shared `.tl-scroll` class), so the header, the
 * tab strip and the footer never move.
 *
 * ── THE FOOTER IS A FLEX CHILD, NOT A FIXED BAR ───────────────────────────
 *
 * It was `position: fixed; bottom: var(--bottom-nav-clearance, 74px)`. This
 * route renders no bottom nav (App.tsx mounts TournamentDetails bare), so those
 * 74px were a dead gap under the buttons — the gap in Dan's screenshot. As the
 * last child of a full-height flex column the footer is flush to the bottom by
 * construction: there is no offset left to be wrong, and no clearance for the
 * content to have to match.
 *
 * ── WHAT THIS FILE STILL OWNS ─────────────────────────────────────────────
 *
 * The tournament row, the entry list and the table list, kept fresh over
 * realtime and handed to every tab. Registration, unregistration, the sign-up
 * modal and the share action. Nothing that a tab can answer for itself.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { tournamentService } from '../../services/TournamentService';
import { WalletService } from '../../services/WalletService';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import type { BlindLevel, Tournament } from '../../types/database.types';
import { useAuthUser } from '../../hooks/useAuthUser';
import './TournamentDetails.css';
import { useToast } from '../../components/common/Toast';
import PageErrorBoundary from '../../components/common/PageErrorBoundary';
import { FinalTableOverlay } from '../../components/tournament/FinalTableOverlay';
import MysteryBountyCelebration from '../../components/tournament/MysteryBountyCelebration';
import DetailOverviewTab from '../../components/tournament/details/DetailOverviewTab';
import BlindsTab from '../../components/tournament/details/BlindsTab';
import RankingTab from '../../components/tournament/details/RankingTab';
import EntriesTab from '../../components/tournament/details/EntriesTab';
import UnionsTab from '../../components/tournament/details/UnionsTab';
import TablesTab from '../../components/tournament/details/TablesTab';
import RewardsTab from '../../components/tournament/details/RewardsTab';
import type {
  NormalisedBlindLevel,
  TournamentEntry,
  TournamentTable,
  TournamentTabProps,
} from '../../components/tournament/details/types';
import { blindLevelMinutes } from '../../components/lobby/tournamentFigures';
import { reportError } from '../../utils/errorReporter';
import { formatBuyIn, money, totalBuyIn } from '../../utils/buyIn';
import { useTournamentRegistration } from '../../hooks/useTournamentRegistration';

/**
 * SEVEN TABS. Dan 2026-08-25, verbatim: "CHIPS SHOULD BE CALLED 'RANKING'" and
 * "RANKING SHOULD BE DELETED, AS WE CONVERTED 'CHIPS' TO RANKING." The old
 * `chips` tab is the one that survived, under the name Ranking; the old
 * `ranking` tab (a TournamentStandings wrapper) is gone.
 */
export type TabId = 'detail' | 'blinds' | 'ranking' | 'entries' | 'unions' | 'tables' | 'rewards';

const TAB_IDS: readonly TabId[] = [
  'detail',
  'blinds',
  'ranking',
  'entries',
  'unions',
  'tables',
  'rewards',
];

const TABS: { id: TabId; label: string }[] = [
  { id: 'detail', label: 'Detail' },
  { id: 'blinds', label: 'Blinds' },
  { id: 'ranking', label: 'Ranking' },
  { id: 'entries', label: 'Entries' },
  { id: 'unions', label: 'Unions' },
  { id: 'tables', label: 'Tables' },
  { id: 'rewards', label: 'Rewards' },
];

/**
 * Ids that used to exist and can still be asked for — from a bookmark, a shared
 * link, or anything that stored a tab id before the rename. `chips` IS Ranking
 * now, so it must land there rather than on a blank page; `payouts` was in the
 * union before the Rewards tab absorbed it. Anything else, including an empty
 * string, opens Detail.
 */
const LEGACY_TAB_IDS: Record<string, TabId> = {
  chips: 'ranking',
  payouts: 'rewards',
};

/** The only way a tab id enters this component. Never throws, never returns junk. */
export function normaliseTabId(raw: string | null | undefined): TabId {
  const key = (raw || '').trim().toLowerCase();
  if ((TAB_IDS as readonly string[]).includes(key)) return key as TabId;
  return LEGACY_TAB_IDS[key] ?? 'detail';
}

/** Ordinal suffix helper (1st, 2nd, 3rd...) */
function getOrdinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

/**
 * Dan 2026-08-19: `tournamentIdOverride` lets this page render OUTSIDE its own
 * route — MultiTablePage embeds it in a lobby tab so a seated player can
 * browse and register for a tournament while their other tables keep dealing.
 * Route usage is unchanged: without the prop the id comes from useParams.
 */
export default function TournamentDetails({
  tournamentIdOverride,
}: { tournamentIdOverride?: string } = {}) {
  const { register: registerMtt } = useTournamentRegistration();

  const { tournamentId: routeTournamentId } = useParams<{ tournamentId: string }>();
  const tournamentId = tournamentIdOverride || routeTournamentId;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuthUser();
  const toast = useToast();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  // A `?tab=` deep link is read once, through the normaliser, so a stale
  // `?tab=chips` opens Ranking instead of rendering nothing at all.
  const [activeTab, setActiveTab] = useState<TabId>(() => normaliseTabId(searchParams.get('tab')));
  const [entries, setEntries] = useState<TournamentEntry[]>([]);
  const [isRegistered, setIsRegistered] = useState(false);
  /** Fires the auto-open-my-table navigation exactly once per tournament. */
  const autoOpenedTableRef = useRef(false);
  const [tables, setTables] = useState<TournamentTable[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showSignUpModal, setShowSignUpModal] = useState(false);

  const [walletBalance, setWalletBalance] = useState<number>(0);
  const [lateRegCountdown, setLateRegCountdown] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);

  const lateRegTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  /**
   * MEASURE THE SPACE, DO NOT GUESS IT.
   *
   * The shell has to be exactly as tall as what is left after the chrome
   * around it, or the "no scroll" layout is a lie. That chrome is not a
   * constant: AppLayout puts GlobalHeader above this route, may put a club
   * announcement banner and an offline banner under it, and `<main>` adds its
   * own padding — and `--header-height` disagrees with itself across the three
   * token files (44px in one, 56px in two) before you even get to a header
   * that wraps onto a second line.
   *
   * So take the number from the DOM: the distance from the top of the document
   * to the top of this element is everything above it, and the container's
   * bottom padding is everything below. `scrollY` is added back because a
   * viewport-relative `top` shrinks the moment anything scrolls, and this must
   * converge rather than feed back on itself.
   *
   * This is also what makes the MultiTablePage embed right, where the space is
   * a tab panel and not the viewport at all.
   */
  useEffect(() => {
    const el = shellRef.current;
    if (!el || typeof window === 'undefined') return;

    const measure = () => {
      const above = el.getBoundingClientRect().top + window.scrollY;
      const parent = el.parentElement;
      const below = parent ? parseFloat(getComputedStyle(parent).paddingBottom || '0') || 0 : 0;
      // A floor, so a mis-measure during a transition can never collapse the
      // lobby to nothing — a short page is recoverable, a zero-height one is not.
      const avail = Math.max(320, window.innerHeight - above - below);
      const next = `${Math.round(avail)}px`;
      // Write only on a real change. The ResizeObserver below watches the
      // parent, and this write changes the parent's height, so an
      // unconditional write is a resize loop waiting for a browser that does
      // not de-duplicate it. `above` does not depend on our own height, so the
      // value converges after one pass and this guard ends the cycle there.
      if (el.style.getPropertyValue('--details-h') !== next) {
        el.style.setProperty('--details-h', next);
      }
    };

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null;
    if (ro && el.parentElement) ro.observe(el.parentElement);

    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      ro?.disconnect();
    };
  }, [isLoading, tournament?.id]);

  useEffect(() => {
    let isMounted = true;
    if (tournamentId) {
      loadTournament(() => isMounted);
    }
    if (user?.id) {
      loadWalletBalance();
    }
    return () => {
      isMounted = false;
      if (lateRegTimerRef.current) clearInterval(lateRegTimerRef.current);
    };
  }, [tournamentId, user?.id]);

  const loadWalletBalance = async () => {
    if (!user?.id) return;
    try {
      const balance = await WalletService.getPlayerBalance(user.id);
      setWalletBalance(balance);
    } catch (e) {
      reportError(e, 'TournamentDetails.loadWalletBalance');
      /* ignore */
    }
  };

  // ── Late-reg level-based status. Drives the footer's Late Register button. ──
  useEffect(() => {
    if (lateRegTimerRef.current) clearInterval(lateRegTimerRef.current);
    const lateRegLevels =
      (tournament as any)?.late_reg_levels || (tournament as any)?.late_reg_mins || 0;
    if (tournament?.status !== 'RUNNING' || !lateRegLevels) return;

    const tick = () => {
      const currentLevel = (tournament as any)?.current_level || 0;
      if (currentLevel >= lateRegLevels) {
        setLateRegCountdown('');
        if (lateRegTimerRef.current) clearInterval(lateRegTimerRef.current);
        return;
      }
      const levelsRemaining = lateRegLevels - currentLevel;
      setLateRegCountdown(`${levelsRemaining} level${levelsRemaining !== 1 ? 's' : ''} remaining`);
    };
    tick();
    // Check every 10 seconds for level updates
    lateRegTimerRef.current = setInterval(tick, 10000);
    return () => {
      if (lateRegTimerRef.current) clearInterval(lateRegTimerRef.current);
    };
  }, [
    tournament?.status,
    (tournament as any)?.current_level,
    (tournament as any)?.late_reg_levels,
  ]);

  /**
   * Dan 2026-08-19: registering for a tournament must TAKE YOU TO IT the moment
   * it starts. Until now the page only rendered a manual "go to table" link
   * once the entry flipped to 'playing' — a registered player watching the
   * countdown was left sitting on the details screen while their table dealt
   * without them, blinding off.
   *
   * The realtime subscription below already streams both the tournament status
   * and this player's tournament_players row, so the moment the engine seats
   * them (a table_id appears) we open that table. Guarded by a ref so it fires
   * exactly once per tournament — re-navigating on every realtime tick would
   * trap the player on the table route and break the back button.
   */
  useEffect(() => {
    if (tournament?.status !== 'RUNNING') return;
    if (!user?.id) return;
    if (autoOpenedTableRef.current) return;

    const myEntry = entries.find((e) => e.user_id === user.id);
    if (!myEntry?.table_id) return;
    // Only seat-bound states: an eliminated or finished player must never be
    // yanked into a table they are no longer sitting at.
    if (myEntry.status !== 'playing' && myEntry.status !== 'registered') return;

    autoOpenedTableRef.current = true;
    navigate(`/table/${myEntry.table_id}`);
  }, [tournament?.status, entries, user?.id, navigate]);

  // ── Realtime subscription: live tournament updates ──
  useEffect(() => {
    if (!tournamentId) return;

    const channelKey = `tournament-${tournamentId}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournaments',
          filter: `id=eq.${tournamentId}`,
        },
        (payload) => {
          if (payload.eventType === 'UPDATE' && payload.new) {
            setTournament((prev) => (prev ? { ...prev, ...payload.new } : null));
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_players',
          filter: `tournament_id=eq.${tournamentId}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT' && payload.new) {
            // New player registered
            const newPlayer = payload.new as {
              id: string;
              user_id: string;
              username?: string | null;
              chips?: number;
              status: string;
              position?: number | null;
              table_id?: string | null;
              registered_at?: string | null;
              rebuys?: number | null;
              add_on?: boolean | null;
            };
            setEntries((prev) => [
              ...prev,
              {
                id: newPlayer.id,
                user_id: newPlayer.user_id,
                username: newPlayer.username || 'Player',
                avatar_url: null,
                // BUG FIX: do NOT read tournament.starting_chips here — this
                // handler is in a closure that captured `tournament` at the time
                // the effect ran (tournamentId dep), which may be null if the
                // subscription was set up before loadTournament completed.
                // Use newPlayer.chips if present; the next loadTournament() call
                // (triggered by TOURNAMENT_UPDATED) will hydrate the full entry.
                chips: newPlayer.chips || 0,
                position: newPlayer.position || undefined,
                status: newPlayer.status as TournamentEntry['status'],
                table_id: newPlayer.table_id || null,
                created_at: newPlayer.registered_at ?? null,
                rebuys: Number(newPlayer.rebuys) || 0,
                add_ons: newPlayer.add_on ? 1 : 0,
              },
            ]);
          } else if (payload.eventType === 'UPDATE' && payload.new) {
            // Player status or chips updated
            const updatedPlayer = payload.new as {
              id: string;
              user_id: string;
              username?: string | null;
              chips?: number;
              status: string;
              position?: number | null;
              table_id?: string | null;
              rebuys?: number | null;
              add_on?: boolean | null;
            };
            setEntries((prev) =>
              prev.map((e) =>
                e.id === updatedPlayer.id
                  ? {
                      ...e,
                      chips: updatedPlayer.chips,
                      status: updatedPlayer.status as TournamentEntry['status'],
                      position: updatedPlayer.position || undefined,
                      table_id:
                        updatedPlayer.table_id !== undefined ? updatedPlayer.table_id : e.table_id,
                      rebuys:
                        updatedPlayer.rebuys != null ? Number(updatedPlayer.rebuys) || 0 : e.rebuys,
                      add_ons:
                        updatedPlayer.add_on != null ? (updatedPlayer.add_on ? 1 : 0) : e.add_ons,
                    }
                  : e
              )
            );
          } else if (payload.eventType === 'DELETE' && payload.old) {
            // Player unregistered or eliminated
            setEntries((prev) => prev.filter((e) => e.id !== (payload.old as any).id));
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tables',
          filter: `tournament_id=eq.${tournamentId}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT' && payload.new) {
            const t = payload.new as any;
            setTables((prev) => [
              ...prev,
              {
                id: t.id,
                name: t.name || `Table ${prev.length + 1}`,
                status: t.status,
                max_players: t.max_players,
                current_players: t.current_players || 0,
                small_blind: t.small_blind,
                big_blind: t.big_blind,
              },
            ]);
          } else if (payload.eventType === 'UPDATE' && payload.new) {
            const t = payload.new as any;
            setTables((prev) =>
              prev.map((tbl) =>
                tbl.id === t.id
                  ? {
                      ...tbl,
                      current_players: t.current_players,
                      small_blind: t.small_blind,
                      big_blind: t.big_blind,
                      status: t.status,
                    }
                  : tbl
              )
            );
          } else if (payload.eventType === 'DELETE' && payload.old) {
            setTables((prev) => prev.filter((tbl) => tbl.id !== (payload.old as any).id));
          }
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'TournamentDetails._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[TournamentDetails] Realtime channel timed out');
        }
      });

    // ── Bus event subscriptions for faster local updates ──
    const unsubElim = masterBus.subscribeDebounced(
      'PLAYER_ELIMINATED',
      (event) => {
        if (event.payload.tournamentId !== tournamentId) return;
        // Immediately update entries list when a player is eliminated
        setEntries((prev) =>
          prev.map((e) =>
            e.user_id === event.payload.userId
              ? { ...e, status: 'eliminated' as const, position: event.payload.position }
              : e
          )
        );
        // BUG FIX: guard against undefined position — getOrdinal(undefined) would
        // produce "undefinedth" which reads as a broken toast message.
        const pos = event.payload.position;
        const posText = pos != null ? `${pos}${getOrdinal(pos)} place` : 'eliminated';
        toast.info(`${event.payload.username} ${posText}`);
      },
      300
    );

    const unsubMerge = masterBus.subscribeDebounced(
      'TABLE_MERGED',
      (event) => {
        if (event.payload.tournamentId !== tournamentId) return;
        // Remove the closed source table from the tables list
        setTables((prev) => prev.filter((t) => t.id !== event.payload.sourceTableId));
        toast.info(`Table merged - ${event.payload.playersMoved} players moved`);
      },
      300
    );

    // ── Blind level changes: update tournament state immediately ──
    const unsubBlind = masterBus.subscribeDebounced(
      'BLIND_LEVEL_CHANGE',
      (event) => {
        if (event.payload.tournamentId !== tournamentId) return;
        setTournament((prev: any) =>
          prev ? { ...prev, current_level: event.payload.level } : prev
        );
      },
      300
    );

    // ── Tournament break notifications ──
    const unsubBreak = masterBus.subscribeDebounced(
      'TOURNAMENT_BREAK',
      (event) => {
        if (event.payload.tournamentId !== tournamentId) return;
        toast.info('Tournament break - play resumes shortly');
      },
      300
    );

    const unsubBreakEnd = masterBus.subscribeDebounced(
      'TOURNAMENT_BREAK_END',
      (event) => {
        if (event.payload.tournamentId !== tournamentId) return;
        toast.info('Break over - play resuming');
      },
      300
    );

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
      unsubElim();
      unsubMerge();
      unsubBlind();
      unsubBreak();
      unsubBreakEnd();
    };
  }, [tournamentId]);

  // ── Refresh wallet balance when BALANCE_UPDATED fires ──
  useEffect(() => {
    if (!user?.id) return;
    const unsub = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        loadWalletBalance();
      },
      500
    );
    return () => unsub();
  }, [user?.id]);

  // ── Refresh tournament data when tournament is updated ──
  useMasterBusSubscription(
    'TOURNAMENT_UPDATED',
    () => {
      if (tournamentId) {
        loadTournament();
      }
    },
    { debounce: 500 }
  );

  // Re-check registration status when user hydrates after tournament loaded
  useEffect(() => {
    if (user && tournament && entries.length > 0) {
      const registered = entries.some((e) => e.user_id === user.id);
      setIsRegistered(registered);
    }
  }, [user, tournament, entries]);

  const loadTournament = async (getIsMounted?: () => boolean) => {
    if (!tournamentId) return;
    if (!getIsMounted || getIsMounted()) setIsLoading(true);
    try {
      const data = await tournamentService.getTournament(tournamentId);
      if (getIsMounted && !getIsMounted()) return;
      setTournament(data);

      if (data) {
        /**
         * ONE query, everything the tab contract promises.
         *
         * This used to fetch seven columns and hardcode `avatar_url: null`, so
         * Ranking drew initials for a whole field and Entries could show
         * neither a registration time nor a rebuy count from props. The three
         * added columns are on the row already (no join), and the profiles
         * embed rides `fk_tournament_players_user_id_profiles` — one join for
         * the whole list, not one request per player.
         *
         * `add_on` is a BOOLEAN in production, not a count; the contract field
         * is `add_ons: number`, so it collapses to 0 or 1 here rather than
         * pretending the database records how many.
         */
        const { data: playersData, error } = await supabase
          .from('tournament_players')
          .select(
            'id, user_id, username, chips, status, position, table_id, registered_at, rebuys, add_on, profile:profiles!user_id(player_number, avatar_url:arena_avatar_url)'
          )
          .eq('tournament_id', data.id)
          .order('registered_at', { ascending: true });

        if (getIsMounted && !getIsMounted()) return;

        if (!error && playersData) {
          setEntries(
            playersData.map((e: Record<string, unknown>): TournamentEntry => {
              // A `!inner`-less embed is an object, but PostgREST types it as
              // an array in some shapes. Accept both rather than guess.
              const rawProfile = e.profile as
                | { player_number?: string | null; avatar_url?: string | null }
                | { player_number?: string | null; avatar_url?: string | null }[]
                | null
                | undefined;
              const profile = Array.isArray(rawProfile) ? rawProfile[0] : rawProfile;
              return {
                id: String(e.id),
                user_id: String(e.user_id),
                username: (e.username as string) || 'Player',
                avatar_url: profile?.avatar_url || null,
                player_code: profile?.player_number || null,
                chips: (e.chips as number) || data.starting_chips,
                position: (e.position as number) || undefined,
                status: e.status as TournamentEntry['status'],
                table_id: (e.table_id as string | null) || null,
                created_at: (e.registered_at as string | null) ?? null,
                rebuys: Number(e.rebuys) || 0,
                add_ons: e.add_on ? 1 : 0,
              };
            })
          );

          // Check if current user is registered
          if (user) {
            const isUserRegistered = playersData.some(
              (e: { user_id: string }) => e.user_id === user.id
            );
            setIsRegistered(isUserRegistered);
          }
        } else {
          setEntries([]);
        }

        // Fetch tournament tables
        if (data.status === 'RUNNING') {
          const { data: tablesData } = await supabase
            .from('tables')
            .select('id, name, status, max_players, current_players, small_blind, big_blind')
            .eq('tournament_id', data.id);
          if (!getIsMounted || getIsMounted()) {
            setTables((tablesData || []) as TournamentTable[]);
          }
        }
      }
    } catch (error) {
      reportError(error, 'TournamentDetails.Failed_to_load_tournament');
      if (!getIsMounted || getIsMounted()) toast.error('Failed to load tournament details');
    }
    if (!getIsMounted || getIsMounted()) setIsLoading(false);
  };

  const handleRegister = () => {
    if (!tournament) return;
    setShowSignUpModal(false);
    registerMtt(
      {
        id: tournament.id,
        name: tournament.name,
        buy_in_amount: tournament.buy_in_amount,
        buy_in_fee: tournament.buy_in_fee,
      },
      () => {
        setIsRegistered(true);
        setTimeout(() => loadTournament(), 50);
      }
    );
  };

  const handleUnregister = async () => {
    if (isProcessing || !tournament) return;
    if (!user) {
      toast.error('Loading your profile... please try again in a moment');
      return;
    }
    setIsProcessing(true);

    try {
      await tournamentService.unregisterPlayer(tournament.id, user.id);
      setIsRegistered(false);
      toast.success('Unregistered - buy-in refunded to your wallet');
      // Defer reload so the UI updates instantly (fixes INP)
      setTimeout(() => loadTournament(), 50);
    } catch (error) {
      reportError(error, 'TournamentDetails.Unregistration_failed');
      const msg = (error as Error).message || 'Unknown error';
      toast.error(`Unregister failed: ${msg}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const formatDate = (date: string | null | undefined) => {
    if (!date) return 'TBD';
    return new Date(date)
      .toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
      .replace(',', '');
  };

  /**
   * Share this tournament. 2026-08-20: both the ID chip's "⊞" and the footer
   * "Share" rendered with NO onClick at all — visible, enabled, and inert on a
   * live routed page. Web Share where available, clipboard everywhere else;
   * `navigator.share?.()` on its own silently does nothing on desktop Chrome and
   * Firefox, which is most of the people looking at a tournament page.
   */
  const shareTournament = useCallback(async () => {
    const url = `${window.location.origin}/tournaments/${tournament?.id ?? ''}`;
    const title = tournament?.name || 'Tournament';
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast?.success?.('Tournament link copied');
    } catch (err) {
      // AbortError just means the player dismissed the share sheet.
      if (err instanceof Error && err.name === 'AbortError') return;
      toast?.error?.('Could not share this tournament');
    }
  }, [tournament?.id, tournament?.name, toast]);

  /**
   * The stored structure carries the level length under THREE spellings, and
   * this mapper used to read the seconds one FIRST:
   *
   *     Number(b.duration ?? b.durationMinutes ?? b.duration_minutes ?? 0)
   *
   * Every Spin stores `duration: 180` (seconds), so every Spin level arrived at
   * the tabs as 180 MINUTES — `NormalisedBlindLevel.duration` is contractually
   * minutes. blindLevelMinutes() is the one reader that gets the precedence
   * right: canonical spellings win, seconds are converted, and an absent value
   * is 0 rather than a guess.
   */
  const blindLevels = useMemo<NormalisedBlindLevel[]>(() => {
    const raw =
      typeof tournament?.blind_structure === 'string'
        ? (() => {
            try {
              return JSON.parse(tournament.blind_structure as string);
            } catch {
              return [];
            }
          })()
        : tournament?.blind_structure || [];
    if (!Array.isArray(raw)) return [];
    const rows = raw as BlindLevel[];
    return rows.map((row, i) => {
      const b = row as unknown as Record<string, unknown>;
      const level = Number(b.level ?? i + 1);
      return {
        level,
        smallBlind: Number(b.smallBlind ?? b.small_blind ?? 0),
        bigBlind: Number(b.bigBlind ?? b.big_blind ?? 0),
        ante: Number(b.ante ?? 0),
        duration: blindLevelMinutes(rows, level),
        isBreak: Boolean(b.isBreak ?? b.is_break ?? false),
      };
    });
  }, [tournament?.blind_structure]);

  /**
   * The tab contract, built once. Every tab takes exactly this and nothing
   * else, so switching tabs is a render, not a refetch.
   */
  const tabProps = useMemo<TournamentTabProps | null>(
    () =>
      tournament
        ? { tournament, entries, tables, blindLevels, currentUserId: user?.id, isRegistered }
        : null,
    [tournament, entries, tables, blindLevels, user?.id, isRegistered]
  );

  if (isLoading) {
    return (
      <div className="tournament-details loading">
        <div className="loader-spinner" />
        <p>Loading Tournament...</p>
      </div>
    );
  }

  // tabProps is null exactly when `tournament` is null, so this one guard
  // covers both and TypeScript keeps its narrowing all the way down.
  if (!tournament || !tabProps) {
    return (
      <div className="tournament-details error">
        <h2>Tournament Not Found</h2>
        <Link to="/clubs" className="btn btn-primary">
          Back To Clubs
        </Link>
      </div>
    );
  }

  return (
    <PageErrorBoundary pageName="TournamentDetails">
      <div className="tournament-details" ref={shellRef}>
        {/* Header */}
        <div className="details-header">
          <h1>Game Details</h1>
        </div>

        {/* Tabs */}
        <div className="details-tabs" role="tablist" aria-label="Tournament sections">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Title strip. The name, the short id, the share button and the price.
            Everything else that used to sit here — FREEZEOUT / REBUY / ADD-ON,
            the bounty line, MULTI-DAY, XMTT, SPIN, the parity tag row and EARLY
            BIRD — is rendered as badges by DetailOverviewTab. Printing both
            said the same thing twice and cost about 120px of the one screen. */}
        <div className="details-title">
          <div className="tournament-title">
            <h2>{tournament.name}</h2>
            <span className="tournament-id">ID:{tournament.id.slice(0, 8)}</span>
            <button
              className="qr-btn"
              type="button"
              onClick={() => void shareTournament()}
              aria-label="Share this tournament"
            >
              ⊞
            </button>
          </div>
          <div className="tournament-desc">
            {/* Whole chips only (Dan 2026-08-20) - formatBuyIn leads with the
                total the player actually pays and never prints a decimal. */}
            <p className="tournament-buyin">
              {formatBuyIn(tournament.buy_in_amount, tournament.buy_in_fee)} CHIPS BUY-IN
            </p>
            {/* Owner-written short description (2026-08-22). No tab renders it. */}
            {(tournament as any).short_description && (
              <p className="tournament-blurb">{(tournament as any).short_description}</p>
            )}
          </div>
        </div>

        {/* The only part of the shell that grows. See the header comment. */}
        <div className="details-content" role="tabpanel">
          {activeTab === 'detail' && <DetailOverviewTab {...tabProps} />}
          {activeTab === 'blinds' && <BlindsTab {...tabProps} />}
          {activeTab === 'ranking' && <RankingTab {...tabProps} />}
          {activeTab === 'entries' && <EntriesTab {...tabProps} />}
          {activeTab === 'unions' && <UnionsTab {...tabProps} />}
          {activeTab === 'tables' && <TablesTab {...tabProps} />}
          {activeTab === 'rewards' && <RewardsTab {...tabProps} />}
        </div>

        {/* Footer Actions */}
        <div className="details-footer">
          <button className="btn btn-share" type="button" onClick={() => void shareTournament()}>
            Share
          </button>
          {(() => {
            const myEntry = entries.find((e) => e.user_id === user?.id);

            if (tournament.status === 'RUNNING') {
              if (myEntry?.status === 'playing' && myEntry.table_id) {
                return (
                  <Link to={`/table/${myEntry.table_id}`} className="btn btn-enter-table">
                    ENTER TABLE
                  </Link>
                );
              }
              if (myEntry?.status === 'registered') {
                return <span className="tournament-status-badge running">WAITING FOR SEAT...</span>;
              }
              if (myEntry?.status === 'eliminated') {
                return <span className="tournament-status-badge cancelled">ELIMINATED</span>;
              }
              if (!isRegistered && lateRegCountdown) {
                return (
                  <button
                    className="btn btn-register late-reg"
                    type="button"
                    onClick={() => setShowSignUpModal(true)}
                  >
                    Late Register ({lateRegCountdown})
                  </button>
                );
              }
              return <span className="tournament-status-badge running">In Progress</span>;
            }

            if (tournament.status === 'COMPLETED') {
              return <span className="tournament-status-badge completed">Completed</span>;
            }
            if (tournament.status === 'CANCELLED') {
              return <span className="tournament-status-badge cancelled">Cancelled</span>;
            }

            if (isRegistered) {
              return (
                <button
                  className="btn btn-unregister"
                  type="button"
                  onClick={handleUnregister}
                  disabled={isProcessing}
                >
                  {isProcessing ? 'Processing...' : 'Unregister'}
                </button>
              );
            }

            return (
              <button
                className="btn btn-register"
                type="button"
                onClick={() => setShowSignUpModal(true)}
              >
                Register
              </button>
            );
          })()}
        </div>

        {/* Sign Up Modal */}
        {showSignUpModal && (
          <div className="modal-overlay" onClick={() => setShowSignUpModal(false)}>
            <div className="signup-modal" onClick={(e) => e.stopPropagation()}>
              <button
                className="modal-close"
                type="button"
                onClick={() => setShowSignUpModal(false)}
              >
                ✕
              </button>
              <h2>Sign Up</h2>
              {/* One line, not three.
                  This asked the player to read "Buy-in 18", "Rake 1.8" and
                  "Total 19.8" and work out for themselves which number leaves
                  their wallet — on the confirmation step, the one screen where
                  the charge must be unambiguous. It is a single row now, in the
                  same notation the rest of the app uses: "20 (18 + 2)". */}
              <div className="signup-row total">
                <span className="signup-label">Entry Fee:</span>
                <span className="signup-value">
                  {formatBuyIn(tournament.buy_in_amount, tournament.buy_in_fee)}
                </span>
              </div>
              {(tournament as any).is_bounty && (
                <div className="signup-row">
                  <span className="signup-label">Bounty:</span>
                  <span className="signup-value signup-value--bounty">
                    {money((tournament as any).bounty_amount || 0)} Chips
                    {(tournament as any).is_pko && ' (PKO)'}
                    {(tournament as any).is_mystery_bounty && ' (Mystery)'}
                  </span>
                </div>
              )}
              <div className="signup-row">
                <span className="signup-label">Start Time:</span>
                <span className="signup-value">{formatDate(tournament.start_time)}</span>
              </div>
              <div className="signup-row signup-row--balance">
                <span className="signup-label">Your Balance:</span>
                <span
                  className={`signup-value ${
                    walletBalance >= totalBuyIn(tournament.buy_in_amount, tournament.buy_in_fee)
                      ? 'signup-value--ok'
                      : 'signup-value--short'
                  }`}
                >
                  {money(walletBalance)} Chips
                </span>
              </div>
              {walletBalance < totalBuyIn(tournament.buy_in_amount, tournament.buy_in_fee) && (
                <p className="signup-note signup-note--short">
                  Insufficient Balance. Please Add Chips Via Your Cashier.
                </p>
              )}
              <p className="signup-note">Cannot Unregister Within 1 Minute Of The Start Time</p>
              <div className="signup-actions">
                <button
                  className="btn btn-cancel"
                  type="button"
                  onClick={() => setShowSignUpModal(false)}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-confirm"
                  type="button"
                  onClick={handleRegister}
                  disabled={
                    isProcessing ||
                    walletBalance < totalBuyIn(tournament.buy_in_amount, tournament.buy_in_fee)
                  }
                >
                  {isProcessing ? 'Processing...' : 'Confirm'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Mystery bounty celebration. Mounted on the tournament surface itself,
          not inside a tab, because Dan asked for "all players AND observers" —
          somebody watching the lobby with no entry has to see the pull too, and
          they might be on any tab when it happens. */}
      {tournamentId && <MysteryBountyCelebration tournamentId={tournamentId} />}

      {/* Final Table Overlay */}
      {tournament.status === 'RUNNING' && tournamentId && (
        <FinalTableOverlay
          tournamentId={tournamentId}
          tournamentName={tournament.name || 'Tournament'}
          prizePool={tournament.prize_pool || 0}
        />
      )}
    </PageErrorBoundary>
  );
}

export { TournamentDetails };
