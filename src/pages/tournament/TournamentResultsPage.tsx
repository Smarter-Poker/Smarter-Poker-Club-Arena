/**
 * ♠ CLUB ARENA — Tournament Results History Page
 * Shows completed tournaments with final standings, prizes, and stats.
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../../components/common/Toast';
import './TournamentDetails.css';

import { useIsMounted } from '../../hooks/useIsMounted';
import { reportError } from '../../utils/errorReporter';

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

interface TournamentResult {
  user_id: string;
  username: string;
  position: number | null;
  prize: number;
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
        .select('user_id, username, position, prize, status')
        .eq('tournament_id', selectedTournament!.id)
        .order('position', { ascending: true, nullsFirst: false })
        .limit(1000);

      if (isMounted.current) setResults((data || []) as TournamentResult[]);
    } catch (err) {
      reportError(err, 'TournamentResultsPage.loadResults_error');
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
    channel
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'tournaments',
        },
        (payload) => {
          // When tournament is updated (status change, prize pool finalized, etc.)
          loadTournamentsRef.current();
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_players',
        },
        (payload) => {
          // When player results are updated (position, prize finalized, etc.)
          const newTournamentId = (payload.new as any)?.tournament_id;
          const oldTournamentId = (payload.old as any)?.tournament_id;
          if (
            selectedTournament?.id === newTournamentId ||
            selectedTournament?.id === oldTournamentId
          ) {
            loadResultsRef.current();
          }
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err)
            reportError(err?.message || err, 'TournamentResultsPage._Realtime_channel_error');
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
    if (!startedAt || !endedAt) return '—';
    const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hrs}h ${remainMins}m`;
  };

  const getOrdinalPosition = (pos: number | null): string => {
    if (!pos) return '—';
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

  return (
    <div className="tournament-details" style={{ padding: '16px', maxWidth: '100%' }}>
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
          Loading results...
        </div>
      ) : tournaments.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#64748b', padding: '40px' }}>
          No completed tournaments found
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
                    {t.current_players} entries · {formatDuration(t.started_at, t.ended_at)}
                  </div>
                </div>
              </div>

              <div style={{ color: '#475569', fontSize: '11px' }}>
                Buy-in: {formatAmount(t.buy_in_amount)} + {formatAmount(t.buy_in_fee)} · Entries:{' '}
                {t.current_players} · Duration: {formatDuration(t.started_at, t.ended_at)} · Ended:{' '}
                {t.ended_at ? new Date(t.ended_at).toLocaleDateString() : '—'}
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
                          fontSize: '12px',
                          color: '#94a3b8',
                          marginBottom: '8px',
                          fontWeight: 600,
                        }}
                      >
                        Final Standings
                      </div>
                    )}
                    {activeTab === 'standings' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {results
                          .filter((r) => r.position !== null && r.position !== undefined)
                          .sort((a, b) => (a.position || 999) - (b.position || 999))
                          .map((r) => {
                            const isMe = r.user_id === user?.id;
                            const posColor =
                              r.position === 1
                                ? '#fbbf24'
                                : r.position === 2
                                  ? '#94a3b8'
                                  : r.position === 3
                                    ? '#d97706'
                                    : '#475569';
                            return (
                              <div
                                key={r.user_id}
                                className={`${visibleResults.has(r.user_id) ? 'fadeInUp' : 'hidden'}`}
                                style={
                                  visibleResults.has(r.user_id)
                                    ? {
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        padding: '6px 8px',
                                        borderRadius: '6px',
                                        background: isMe
                                          ? 'rgba(16, 185, 129, 0.1)'
                                          : 'transparent',
                                        border: isMe
                                          ? '1px solid rgba(16, 185, 129, 0.3)'
                                          : '1px solid transparent',
                                      }
                                    : {
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        padding: '6px 8px',
                                        borderRadius: '6px',
                                        background: isMe
                                          ? 'rgba(16, 185, 129, 0.1)'
                                          : 'transparent',
                                        border: isMe
                                          ? '1px solid rgba(16, 185, 129, 0.3)'
                                          : '1px solid transparent',
                                        opacity: 0,
                                        transform: 'translateY(8px)',
                                      }
                                }
                              >
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
                                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                                  <span
                                    style={{
                                      color: r.prize > 0 ? '#10b981' : '#475569',
                                      fontSize: '13px',
                                      fontWeight: r.prize > 0 ? 600 : 400,
                                    }}
                                  >
                                    {r.prize > 0 ? `${formatAmount(r.prize)}` : '—'}
                                  </span>
                                </div>
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
                            No hands recorded
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
