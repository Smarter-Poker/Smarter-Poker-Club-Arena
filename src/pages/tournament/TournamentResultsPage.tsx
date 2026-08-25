/**
 * ♠ CLUB ARENA — Tournament Results History Page
 * Shows completed tournaments with final standings, prizes, and stats.
 */

import { useState, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../../components/common/Toast';
import './TournamentDetails.css';

import { useIsMounted } from '../../hooks/useIsMounted';
import { reportError } from '../../utils/errorReporter';
import {
  biggestEarner,
  bountyBeatTheChampion,
  sortResults,
  totalPayout,
  type ResultSort,
} from '../../utils/tournamentPayout';
import {
  MysteryBountyService,
  formatCents,
  playerTotalsFromAwards,
  type MysteryBountyLeaderboardRow,
  type MysteryBountyPlayerTotals,
} from '../../services/MysteryBountyService';

interface CompletedTournament {
  id: string;
  name: string;
  variant: string;
  tournament_type: string;
  game_type: string;
  buy_in_amount: number;
  buy_in_fee: number;
  prize_pool: number;
  current_players: number;
  max_players: number | null;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  is_xmtt: boolean;
  is_bounty: boolean;
  is_pko: boolean;
  is_mystery_bounty: boolean;
  spin_multiplier: number | null;
}

/**
 * One finisher's row.
 *
 * Dan section 37: the categories stay SEPARATE in the record. `prize` is the
 * placement prize and nothing else; `bounty_winnings` is every bounty this
 * player collected (the flat bounty paid before the mystery phase opens AND the
 * chests paid after it); `total` is the sum, computed at render and never
 * stored back over either half.
 *
 * Sections 42 and 44 are the reason the total is a first-class column rather
 * than something a reader adds up: in a mystery bounty event a player who
 * finished 14th can out-earn the champion, and a table that only shows the
 * placement prize reports the champion as the biggest winner of the night when
 * they were not.
 */
interface TournamentResult {
  user_id: string;
  username: string;
  position: number | null;
  /** Placement prize ONLY. */
  prize: number;
  /** Every bounty collected, in the same whole-chip units as `prize`. */
  bounty_winnings: number;
  /** Knockouts that paid. */
  bounties_collected: number;
  status: string;
}

interface HandHistoryRecord {
  id: string;
  hand_number: number;
  small_blind: number;
  big_blind: number;
  pot_size: number;
  game_variant: string;
  community_cards: string[];
  winners: { userId: string; amount: number }[];
  players: { userId: string; username: string; seat: number; stack: number; cards: string[] }[];
  created_at: string;
}

export default function TournamentResultsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuthUser();
  const toast = useToast();
  const [tournaments, setTournaments] = useState<CompletedTournament[]>([]);
  const [selectedTournament, setSelectedTournament] = useState<CompletedTournament | null>(null);
  const [visibleResults, setVisibleResults] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<TournamentResult[]>([]);
  const deepLinkedRef = useRef(false);
  const [handHistory, setHandHistory] = useState<HandHistoryRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'mine'>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<'standings' | 'hands'>('standings');
  /**
   * Sections 42 and 44. Default is FINISH, because a tournament result is a
   * place. "Total Payout" is the second view precisely so the fact that a lower
   * finisher can top the money list is visible rather than implied.
   */
  const [resultSort, setResultSort] = useState<ResultSort>('finish');
  /** Mystery bounty split for the selected event. Empty for every other format. */
  const [mysteryBoard, setMysteryBoard] = useState<MysteryBountyLeaderboardRow[]>([]);
  const [mysteryTotals, setMysteryTotals] = useState<Map<string, MysteryBountyPlayerTotals>>(
    () => new Map()
  );

  // Refs to avoid stale closures
  const loadTournamentsRef = useRef<() => void>(() => {});
  const loadResultsRef = useRef<() => void>(() => {});
  const loadHandHistoryRef = useRef<() => void>(() => {});
  const isMounted = useIsMounted();

  // Load completed tournaments
  const loadTournaments = async () => {
    setIsLoading(true);
    try {
      let query = supabase
        .from('tournaments')
        .select(
          'id, name, variant, tournament_type, game_type, buy_in_amount, buy_in_fee, prize_pool, current_players, max_players, status, started_at, ended_at, is_xmtt, is_bounty, is_pko, is_mystery_bounty, spin_multiplier'
        )
        .eq('status', 'COMPLETED')
        .order('ended_at', { ascending: false })
        .limit(100);

      if (typeFilter !== 'all') {
        if (typeFilter === 'xmtt') {
          query = query.eq('is_xmtt', true);
        } else {
          query = query.eq('variant', typeFilter);
        }
      }

      const { data } = await query;
      if (!isMounted.current) return;
      if (!data) return;
      let completedList = data as CompletedTournament[];

      // If "mine" filter, only show tournaments user participated in
      if (filter === 'mine' && user?.id) {
        const { data: myEntries } = await supabase
          .from('tournament_players')
          .select('tournament_id')
          .eq('user_id', user.id)
          .limit(5000);

        if (!isMounted.current) return;
        const myTournamentIds = new Set((myEntries || []).map((e) => e.tournament_id));
        completedList = completedList.filter((t) => myTournamentIds.has(t.id));
      }

      setTournaments(completedList);
    } catch (err) {
      if (!isMounted.current) return;
      reportError(err, 'TournamentResultsPage.Failed_to_load_tournament_results');
      toast?.error('Failed to load tournament results');
    }
    if (isMounted.current) setIsLoading(false);
  };

  useEffect(() => {
    loadTournamentsRef.current = loadTournaments;
  }, [filter, typeFilter, user?.id]);

  useEffect(() => {
    loadTournaments();
  }, [filter, typeFilter, user?.id]);

  // ── DEEP LINK: Auto-select tournament from ?id= query parameter ──
  useEffect(() => {
    if (deepLinkedRef.current) return; // Only process once
    const tournamentId = searchParams.get('id');
    if (!tournamentId) return;

    // If we already have tournaments loaded, select from them
    const found = tournaments.find((t) => t.id === tournamentId);
    if (found) {
      setSelectedTournament(found);
      deepLinkedRef.current = true;
      return;
    }

    // If not in list yet (might still be COMPLETING), load it directly
    if (tournaments.length > 0 && !found) {
      // Tournament list loaded but ID not found — try direct load
      (async () => {
        const { data } = await supabase
          .from('tournaments')
          .select(
            'id, name, variant, tournament_type, game_type, buy_in_amount, buy_in_fee, prize_pool, current_players, max_players, status, started_at, ended_at, is_xmtt, is_bounty, is_pko, is_mystery_bounty, spin_multiplier'
          )
          .eq('id', tournamentId)
          .maybeSingle();
        if (!isMounted.current) return;
        if (!data) return;
        setSelectedTournament(data as CompletedTournament);
        deepLinkedRef.current = true;
      })();
    }
  }, [tournaments, searchParams]);

  // Load results for selected tournament
  const loadResults = async () => {
    if (!selectedTournament) {
      setResults([]);
      return;
    }

    try {
      const { data } = await supabase
        .from('tournament_players')
        /* bounty_winnings / bounties_collected are the record of record for
           EVERY bounty format, mystery included: fn_mystery_bounty_pay updates
           both as it credits a chest. Reading them here means the results table
           is right for a plain KO event and a PKO as well, and the mystery
           split below is an extra breakdown rather than the only source. */
        .select('user_id, username, position, prize, bounty_winnings, bounties_collected, status')
        .eq('tournament_id', selectedTournament!.id)
        .order('position', { ascending: true, nullsFirst: false })
        .limit(1000);

      if (isMounted.current) {
        setResults(
          (data || []).map((r) => ({
            user_id: String((r as { user_id: string }).user_id),
            username: String((r as { username: string | null }).username ?? 'Player'),
            position: (r as { position: number | null }).position ?? null,
            prize: Number((r as { prize: number | null }).prize) || 0,
            bounty_winnings: Number((r as { bounty_winnings: number | null }).bounty_winnings) || 0,
            bounties_collected:
              Number((r as { bounties_collected: number | null }).bounties_collected) || 0,
            status: String((r as { status: string | null }).status ?? ''),
          }))
        );
      }
    } catch (err) {
      reportError(err, 'TournamentResultsPage.loadResults_error');
    }
  };

  /**
   * The MYSTERY half, broken out (section 37).
   *
   * `tournament_players.bounty_winnings` is the total of every bounty a player
   * collected, and in a mystery event that includes the flat bounties paid
   * during late registration, before the chests opened. This second read says
   * how much of it came out of a chest, and it comes from the RPCs rather than
   * the tables, which have RLS on with no select policy.
   */
  const loadMysteryBounty = async () => {
    const t = selectedTournament;
    if (!t || !t.is_mystery_bounty) {
      setMysteryBoard([]);
      setMysteryTotals(new Map());
      return;
    }
    try {
      const [board, awards] = await Promise.all([
        MysteryBountyService.getLeaderboard(t.id),
        MysteryBountyService.getAllAwards(t.id),
      ]);
      if (!isMounted.current) return;
      setMysteryBoard(board);
      setMysteryTotals(playerTotalsFromAwards(awards.rows));
    } catch (err) {
      reportError(err, 'TournamentResultsPage.loadMysteryBounty_error');
    }
  };

  // Load hand history for selected tournament
  const loadHandHistory = async () => {
    if (!selectedTournament) {
      setHandHistory([]);
      return;
    }

    try {
      const { data } = await supabase
        .from('hand_history')
        .select(
          'id, hand_number, small_blind, big_blind, pot_size, game_variant, community_cards, winners, players, created_at'
        )
        .eq('tournament_id', selectedTournament!.id)
        .order('hand_number', { ascending: false })
        .limit(100);

      if (isMounted.current) setHandHistory((data || []) as HandHistoryRecord[]);
    } catch (err) {
      reportError(err, 'TournamentResultsPage.loadHandHistory_error');
    }
  };

  useEffect(() => {
    loadResultsRef.current = loadResults;
  }, [selectedTournament?.id]);

  useEffect(() => {
    loadResults();
  }, [selectedTournament?.id]);

  useEffect(() => {
    void loadMysteryBounty();
  }, [selectedTournament?.id, selectedTournament?.is_mystery_bounty]);

  useEffect(() => {
    loadHandHistoryRef.current = loadHandHistory;
  }, [selectedTournament?.id]);

  useEffect(() => {
    loadHandHistory();
  }, [selectedTournament?.id]);

  // Stagger animation for results
  useEffect(() => {
    if (results.length === 0) return;
    setVisibleResults(new Set());
    results.forEach((result, index) => {
      setTimeout(() => {
        setVisibleResults((prev) => new Set(prev).add(result.user_id));
      }, index * 60);
    });
  }, [results]);

  // Subscribe to tournament results/standings updates
  useEffect(() => {
    const channelKey = 'tournament-results-updates';

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel.on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'tournaments',
        /* DB LOAD PASS 2026-08-24: unfiltered, this delivered every update to
           every tournament on the platform — blind-level ticks, player-count
           changes, prize-pool movement, across thousands of live events — to a
           page that lists COMPLETED tournaments only. `status=eq.COMPLETED` is
           the list's own query predicate, so it is the correct scope. */
        filter: 'status=eq.COMPLETED',
      },
      () => {
        // When tournament is updated (status change, prize pool finalized, etc.)
        loadTournamentsRef.current();
      }
    );

    /* Player results are only ever rendered for the SELECTED tournament, so
       there is nothing to listen for until one is selected — and when one is,
       `tournament_id` scopes it exactly. This used to be an unfiltered
       subscription to the whole tournament_players table (every registration,
       elimination and chip update, platform-wide) discarded by a client-side
       id comparison after delivery. */
    if (selectedTournament?.id) {
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_players',
          filter: `tournament_id=eq.${selectedTournament.id}`,
        },
        () => {
          // When player results are updated (position, prize finalized, etc.)
          loadResultsRef.current();
        }
      );
    }

    channel.subscribe((status: string, err?: Error) => {
      if (status === 'CHANNEL_ERROR') {
        if (err) reportError(err?.message || err, 'TournamentResultsPage._Realtime_channel_error');
      }
      if (status === 'TIMED_OUT') {
        console.warn('[TournamentResultsPage] Realtime channel timed out');
      }
    });

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [selectedTournament?.id]);

  const formatDuration = (startedAt: string | null, endedAt: string | null) => {
    if (!startedAt || !endedAt) return '-';
    const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hrs}h ${remainMins}m`;
  };

  const getOrdinalPosition = (pos: number | null): string => {
    if (!pos) return '-';
    if (pos === 1) return '1st';
    if (pos === 2) return '2nd';
    if (pos === 3) return '3rd';
    return `${pos}th`;
  };

  const formatAmount = (n: number) => {
    const truncated = Math.trunc(n * 100) / 100;
    // Show decimals only if there are sub-unit fractions
    if (truncated === Math.trunc(truncated)) {
      return Math.trunc(truncated).toLocaleString('en-US');
    }
    return truncated.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  const getVariantLabel = (t: CompletedTournament) => {
    if (t.is_xmtt) return 'XMTT';
    if (t.is_mystery_bounty) return 'Mystery Bounty';
    if (t.is_pko) return 'PKO';
    if (t.is_bounty) return 'Bounty';
    if (t.variant === 'spin') return 'Spin';
    if (t.variant === 'sng') return 'SNG';
    return t.variant === 'freezeout' ? 'Freezeout' : t.variant || 'MTT';
  };

  const getMyResult = (t: CompletedTournament) => {
    if (!user?.id) return null;
    return results.find((r) => r.user_id === user.id && selectedTournament?.id === t.id);
  };

  /** Leaderboard rows by user, so a row lookup is not a linear scan per render. */
  const mysteryBoardByUser = useMemo(() => {
    const m = new Map<string, MysteryBountyLeaderboardRow>();
    for (const row of mysteryBoard) m.set(row.userId, row);
    return m;
  }, [mysteryBoard]);

  /**
   * The finishers, ordered, and who actually took the most money.
   *
   * The rules live in src/utils/tournamentPayout.ts and are pinned by
   * tests/unit/tournamentPayout.test.ts, because section 44 is the one a layout
   * change loses silently: sort or highlight on the placement prize alone and
   * the table names the wrong person as the winner of the night.
   */
  const finishers = results.filter((r) => r.position !== null && r.position !== undefined);
  const sortedResults = sortResults(finishers, resultSort);
  const topEarner = biggestEarner(finishers);
  const championWasOutEarned = bountyBeatTheChampion(finishers);

  return (
    <div
      className="tournament-details"
      style={{
        padding: '16px',
        // inline padding shorthand was wiping the stylesheet's bottom-nav clearance
        paddingBottom: 'var(--bottom-nav-clearance, 74px)',
        maxWidth: '100%',
        overflowX: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button
          onClick={() => navigate(-1)}
          style={{
            background: 'none',
            border: 'none',
            color: '#10b981',
            fontSize: '20px',
            cursor: 'pointer',
            minWidth: 44,
            minHeight: 44,
            touchAction: 'manipulation',
          }}
        >
          ←
        </button>
        <h2 style={{ margin: 0, color: '#fff', fontSize: '18px' }}>Tournament Results</h2>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <button
          onClick={() => setFilter('all')}
          style={{
            padding: '6px 14px',
            borderRadius: '16px',
            border: 'none',
            fontSize: '12px',
            cursor: 'pointer',
            minHeight: 44,
            touchAction: 'manipulation',
            background: filter === 'all' ? '#10b981' : '#1e293b',
            color: filter === 'all' ? '#000' : '#94a3b8',
          }}
        >
          All
        </button>
        <button
          onClick={() => setFilter('mine')}
          style={{
            padding: '6px 14px',
            borderRadius: '16px',
            border: 'none',
            fontSize: '12px',
            cursor: 'pointer',
            minHeight: 44,
            touchAction: 'manipulation',
            background: filter === 'mine' ? '#10b981' : '#1e293b',
            color: filter === 'mine' ? '#000' : '#94a3b8',
          }}
        >
          My Results
        </button>

        <span style={{ width: '1px', background: '#334155', margin: '0 4px' }} />

        {[
          'all',
          'freezeout',
          'bounty',
          'progressive_bounty',
          'mystery_bounty',
          'sng',
          'spin',
          'xmtt',
        ].map((t) => (
          <button
            key={t}
            onClick={() => setTypeFilter(t)}
            style={{
              padding: '6px 10px',
              borderRadius: '16px',
              border: 'none',
              fontSize: '11px',
              cursor: 'pointer',
              minHeight: 44,
              touchAction: 'manipulation',
              background: typeFilter === t ? '#3b82f6' : '#1e293b',
              color: typeFilter === t ? '#fff' : '#64748b',
            }}
          >
            {t === 'all'
              ? 'All Types'
              : t === 'progressive_bounty'
                ? 'PKO'
                : t === 'mystery_bounty'
                  ? 'Mystery'
                  : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', color: '#64748b', padding: '40px' }}>
          Loading Results...
        </div>
      ) : tournaments.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#64748b', padding: '40px' }}>
          No Completed Tournaments Found
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {tournaments.map((t) => (
            <div
              key={t.id}
              onClick={() => setSelectedTournament(selectedTournament?.id === t.id ? null : t)}
              style={{
                background: selectedTournament?.id === t.id ? '#1e293b' : '#0f172a',
                border: `1px solid ${selectedTournament?.id === t.id ? '#10b981' : '#1e293b'}`,
                borderRadius: '8px',
                padding: '12px',
                cursor: 'pointer',
                transition: 'border-color 0.2s',
              }}
            >
              {/* Tournament Header */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '6px',
                }}
              >
                <div>
                  <span style={{ color: '#fff', fontSize: '14px', fontWeight: 600 }}>{t.name}</span>
                  <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                    <span
                      style={{
                        background: '#1e293b',
                        color: '#10b981',
                        padding: '2px 8px',
                        borderRadius: '10px',
                        fontSize: '10px',
                      }}
                    >
                      {getVariantLabel(t)}
                    </span>
                    <span
                      style={{
                        background: '#1e293b',
                        color: '#3b82f6',
                        padding: '2px 8px',
                        borderRadius: '10px',
                        fontSize: '10px',
                      }}
                    >
                      {t.game_type}
                    </span>
                    {t.spin_multiplier && (
                      <span
                        style={{
                          background: '#7c3aed',
                          color: '#fff',
                          padding: '2px 8px',
                          borderRadius: '10px',
                          fontSize: '10px',
                        }}
                      >
                        {t.spin_multiplier}x
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ color: '#10b981', fontSize: '14px', fontWeight: 600 }}>
                    {formatAmount(t.prize_pool)} Prize Pool
                  </div>
                  <div style={{ color: '#64748b', fontSize: '11px' }}>
                    {t.current_players} Entries · {formatDuration(t.started_at, t.ended_at)}
                  </div>
                </div>
              </div>

              <div style={{ color: '#475569', fontSize: '11px' }}>
                Buy-In: {formatAmount(t.buy_in_amount)} + {formatAmount(t.buy_in_fee)} · Entries:{' '}
                {t.current_players} · Duration: {formatDuration(t.started_at, t.ended_at)} · Ended:{' '}
                {t.ended_at ? new Date(t.ended_at).toLocaleDateString() : '-'}
              </div>

              {/* Expanded Results — Tabs */}
              {selectedTournament?.id === t.id &&
                (results.length > 0 || handHistory.length > 0) && (
                  <div
                    style={{
                      marginTop: '12px',
                      borderTop: '1px solid #1e293b',
                      paddingTop: '12px',
                    }}
                  >
                    {/* Tab Buttons */}
                    <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
                      <button
                        onClick={() => setActiveTab('standings')}
                        style={{
                          padding: '6px 12px',
                          borderRadius: '6px',
                          border: 'none',
                          fontSize: '12px',
                          cursor: 'pointer',
                          background: activeTab === 'standings' ? '#10b981' : '#1e293b',
                          color: activeTab === 'standings' ? '#000' : '#94a3b8',
                          fontWeight: activeTab === 'standings' ? 600 : 400,
                        }}
                      >
                        Standings
                      </button>
                      <button
                        onClick={() => setActiveTab('hands')}
                        style={{
                          padding: '6px 12px',
                          borderRadius: '6px',
                          border: 'none',
                          fontSize: '12px',
                          cursor: 'pointer',
                          background: activeTab === 'hands' ? '#10b981' : '#1e293b',
                          color: activeTab === 'hands' ? '#000' : '#94a3b8',
                          fontWeight: activeTab === 'hands' ? 600 : 400,
                        }}
                      >
                        Hand History ({handHistory.length})
                      </button>
                    </div>

                    {/* Standings Tab */}
                    {activeTab === 'standings' && results.length > 0 && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          flexWrap: 'wrap',
                          marginBottom: '8px',
                        }}
                      >
                        <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 600 }}>
                          Final Standings
                        </div>
                        {/* Sections 42 and 44: the money order is a real view,
                            not a footnote, because in a bounty event it is
                            frequently not the same order as the finish. */}
                        <div style={{ display: 'flex', gap: 4 }}>
                          {(['finish', 'total'] as ResultSort[]).map((s) => (
                            <button
                              key={s}
                              onClick={() => setResultSort(s)}
                              style={{
                                padding: '4px 10px',
                                borderRadius: 6,
                                border: 'none',
                                fontSize: 11,
                                cursor: 'pointer',
                                minHeight: 32,
                                touchAction: 'manipulation',
                                background: resultSort === s ? '#3b82f6' : '#1e293b',
                                color: resultSort === s ? '#fff' : '#64748b',
                              }}
                            >
                              {s === 'finish' ? 'By Finish' : 'By Total Payout'}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Section 44: say it out loud when the champion was not the
                        biggest earner, rather than leaving a reader to notice. */}
                    {activeTab === 'standings' && championWasOutEarned && topEarner && (
                      <div
                        style={{
                          fontSize: 11,
                          color: '#6fdcff',
                          border: '1px solid rgba(111,220,255,0.35)',
                          background: 'rgba(111,220,255,0.08)',
                          borderRadius: 6,
                          padding: '6px 8px',
                          marginBottom: 8,
                        }}
                      >
                        Biggest Total Payout: {topEarner.username} (
                        {getOrdinalPosition(topEarner.position)}) With{' '}
                        {formatAmount(totalPayout(topEarner))}, More Than The Champion
                      </div>
                    )}
                    {/* Column key. Kept above the rows because every row is a
                        four-number line and a phone has no room for headers on
                        each one. */}
                    {activeTab === 'standings' && results.length > 0 && (
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0,1fr) 62px 46px 62px 68px',
                          gap: 6,
                          fontSize: 9,
                          color: '#475569',
                          textTransform: 'uppercase',
                          letterSpacing: 0.4,
                          padding: '0 8px 4px',
                        }}
                      >
                        <span>Finish And Player</span>
                        <span style={{ textAlign: 'right' }}>Prize</span>
                        <span style={{ textAlign: 'right' }}>KOs</span>
                        <span style={{ textAlign: 'right' }}>Bounty</span>
                        <span style={{ textAlign: 'right' }}>Total</span>
                      </div>
                    )}
                    {activeTab === 'standings' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {sortedResults.map((r) => {
                          const isMe = r.user_id === user?.id;
                          const posColor =
                            r.position === 1
                              ? '#6fdcff'
                              : r.position === 2
                                ? '#94a3b8'
                                : r.position === 3
                                  ? '#d97706'
                                  : '#475569';
                          const total = totalPayout(r);
                          /* The server's own aggregate first (section 69);
                               the award-derived totals supply the one thing it
                               cannot know, the LARGEST single chest. */
                          const awardTotals = mysteryTotals.get(r.user_id);
                          const boardRow = mysteryBoardByUser.get(r.user_id);
                          const mysteryCount =
                            boardRow?.bountiesWon ?? awardTotals?.bountiesWon ?? 0;
                          const mysteryCents =
                            boardRow?.earningsCents ?? awardTotals?.earningsCents ?? 0;
                          const mysteryLargest = awardTotals?.largestCents ?? 0;
                          const isTopEarner =
                            !!topEarner && topEarner.user_id === r.user_id && total > 0;
                          /* Sections 42 and 44 in one grid: the four money
                               columns are separate and the TOTAL is the widest
                               and the brightest, so a 14th place with a jackpot
                               reads as the bigger night that it was. */
                          const rowStyle: CSSProperties = {
                            display: 'grid',
                            gridTemplateColumns: 'minmax(0,1fr) 62px 46px 62px 68px',
                            gap: 6,
                            alignItems: 'center',
                            padding: '6px 8px',
                            borderRadius: '6px',
                            background: isMe
                              ? 'rgba(16, 185, 129, 0.1)'
                              : isTopEarner
                                ? 'rgba(111, 220, 255, 0.07)'
                                : 'transparent',
                            border: isMe
                              ? '1px solid rgba(16, 185, 129, 0.3)'
                              : isTopEarner
                                ? '1px solid rgba(111, 220, 255, 0.3)'
                                : '1px solid transparent',
                          };
                          return (
                            <div
                              key={r.user_id}
                              className={`${visibleResults.has(r.user_id) ? 'fadeInUp' : 'hidden'}`}
                              style={
                                visibleResults.has(r.user_id)
                                  ? rowStyle
                                  : { ...rowStyle, opacity: 0, transform: 'translateY(8px)' }
                              }
                            >
                              <div style={{ minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  <span
                                    style={{
                                      color: posColor,
                                      fontSize: '13px',
                                      fontWeight: 700,
                                      minWidth: '28px',
                                    }}
                                  >
                                    {getOrdinalPosition(r.position)}
                                  </span>
                                  <span
                                    style={{
                                      color: isMe ? '#10b981' : '#cbd5e1',
                                      fontSize: '13px',
                                      overflowWrap: 'anywhere',
                                      minWidth: 0,
                                    }}
                                  >
                                    {r.username}
                                    {isMe && (
                                      <span
                                        style={{
                                          fontSize: '10px',
                                          color: '#10b981',
                                          marginLeft: '4px',
                                        }}
                                      >
                                        (You)
                                      </span>
                                    )}
                                  </span>
                                </div>
                                {/* Section 37: the MYSTERY share of the bounty
                                      column, broken out where there is one. The
                                      rest of the bounty column is the flat
                                      bounty paid before the chests opened. */}
                                {mysteryCents > 0 && (
                                  <div
                                    style={{
                                      fontSize: 10,
                                      color: '#6fdcff',
                                      marginTop: 2,
                                      overflowWrap: 'anywhere',
                                    }}
                                  >
                                    {mysteryCount.toLocaleString('en-US')} Mystery (
                                    {formatCents(mysteryCents)}), Largest{' '}
                                    {formatCents(mysteryLargest)}
                                  </div>
                                )}
                              </div>
                              <span
                                style={{
                                  color: r.prize > 0 ? '#10b981' : '#475569',
                                  fontSize: '12px',
                                  fontWeight: r.prize > 0 ? 600 : 400,
                                  textAlign: 'right',
                                }}
                              >
                                {r.prize > 0 ? formatAmount(r.prize) : '-'}
                              </span>
                              <span
                                style={{
                                  color: r.bounties_collected > 0 ? '#cbd5e1' : '#475569',
                                  fontSize: '12px',
                                  textAlign: 'right',
                                }}
                              >
                                {r.bounties_collected > 0
                                  ? r.bounties_collected.toLocaleString('en-US')
                                  : '-'}
                              </span>
                              <span
                                style={{
                                  color: r.bounty_winnings > 0 ? '#6fdcff' : '#475569',
                                  fontSize: '12px',
                                  fontWeight: r.bounty_winnings > 0 ? 600 : 400,
                                  textAlign: 'right',
                                }}
                              >
                                {r.bounty_winnings > 0 ? formatAmount(r.bounty_winnings) : '-'}
                              </span>
                              <span
                                style={{
                                  color: total > 0 ? '#10b981' : '#475569',
                                  fontSize: '13px',
                                  fontWeight: 800,
                                  textAlign: 'right',
                                }}
                              >
                                {total > 0 ? formatAmount(total) : '-'}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Hand History Tab */}
                    {activeTab === 'hands' && (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '4px',
                          maxHeight: '400px',
                          overflowY: 'auto',
                        }}
                      >
                        {handHistory.length === 0 ? (
                          <div
                            style={{
                              color: '#64748b',
                              fontSize: '12px',
                              padding: '8px',
                              textAlign: 'center',
                            }}
                          >
                            No Hands Recorded
                          </div>
                        ) : (
                          handHistory.map((hand) => (
                            <div
                              key={hand.id}
                              style={{
                                padding: '8px',
                                borderRadius: '6px',
                                background: '#0f172a',
                                border: '1px solid #1e293b',
                                fontSize: '11px',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  marginBottom: '4px',
                                }}
                              >
                                <span style={{ color: '#10b981', fontWeight: 600 }}>
                                  Hand #{hand.hand_number}
                                </span>
                                <span style={{ color: '#64748b' }}>
                                  {new Date(hand.created_at).toLocaleTimeString()}
                                </span>
                              </div>
                              <div style={{ color: '#94a3b8', fontSize: '10px' }}>
                                {hand.game_variant} · {hand.small_blind}/{hand.big_blind} · Pot:{' '}
                                {formatAmount(hand.pot_size)}
                              </div>
                              {hand.winners.length > 0 && (
                                <div
                                  style={{ color: '#10b981', fontSize: '10px', marginTop: '4px' }}
                                >
                                  Winners: {hand.winners.map((w) => w.amount).join(', ')}
                                </div>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
