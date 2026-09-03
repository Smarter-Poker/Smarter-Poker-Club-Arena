/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND HISTORY PAGE — Browse All Hands with Pagination & Export
 * ═══════════════════════════════════════════════════════════════════════════════
 * Full-page hand history browser with filters, pagination, and export
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { handHistoryService } from '../services/HandHistoryService';
import type { HandRecord } from '../services/HandHistoryService';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { exportToCSV } from '../lib/export';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import HandReplay from '../components/replay/HandReplay';
import { ShareHand, type ShareableHand } from '../components/table/ShareHand';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useIsMounted } from '../hooks/useIsMounted';
import { retryFetch } from '../utils/retryFetch';
import './HandHistoryPage.css';
import { reportError } from '../utils/errorReporter';
import CasinoSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import { filterHandsByStatsDrilldown, readStatsDrilldown } from '../lib/handHistoryDrilldown';

// ── SWR Cache ──
const HH_CACHE_KEY = 'hh_cache_';
function getCachedHands(userId: string): HandRecord[] | null {
  try {
    const raw = sessionStorage.getItem(HH_CACHE_KEY + userId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function setCachedHands(userId: string, data: HandRecord[]) {
  try {
    sessionStorage.setItem(HH_CACHE_KEY + userId, JSON.stringify(data.slice(0, 50)));
  } catch {
    /* quota */
  }
}

type HistoryFilter = 'all' | 'won' | 'lost' | 'big-pots';

/* The original `game_type.includes('PLO') ? 'PLO4' : 'NLH'` labelled every
   variant in the estate as one of two things, on a hand the recipient reads as
   a record.

   The first correction (2026-08-23) added PLO5 and PLO6 and was STILL wrong for
   three of the variants actually running: `plo8` contains "PLO" so it was
   shared as PLO4, and `short_deck` and `pineapple` fell through to NLH.
   Checking the live catalogue before writing the mapping, rather than after,
   would have caught it: nlh, plo4, plo5, plo6, plo8, short_deck, pineapple.

   `ofc_pineapple` was retired the same day (migration
   20260823_retire_ofc_pineapple_variant.sql): it was never a game this
   platform dealt, only a mislabel on Crazy Pineapple tables.

   Order still matters: PLO8 must be tested before the PLO catch-all. */
function toShareVariant(gameType: string | undefined): ShareableHand['variant'] {
  const g = (gameType || '').toUpperCase();
  if (g.includes('PINEAPPLE')) return 'Crazy Pineapple';
  if (g.includes('SHORT')) return 'Short Deck';
  if (g.includes('PLO8')) return 'PLO8';
  if (g.includes('PLO6')) return 'PLO6';
  if (g.includes('PLO5')) return 'PLO5';
  if (g.includes('PLO')) return 'PLO4';
  return 'NLH';
}

export default function HandHistoryPage() {
  useEffect(() => {
    document.title = 'Hand History | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuthUser();
  const drilldownKey = searchParams.toString();
  const statsDrilldown = useMemo(
    () => readStatsDrilldown(new URLSearchParams(drilldownKey)),
    [drilldownKey]
  );
  const hasStatsDrilldown = Object.keys(statsDrilldown).length > 0;
  const toast = useToast();
  useVisibilityRefresh(() => loadHands(true));
  const [hands, setHands] = useState<HandRecord[]>([]);
  const [loading, setLoading] = useState(true);
  /* A failed fetch is not an empty history. Without this the page showed
     "No Hands Recorded Yet" over a query that errored - the toast that
     said otherwise vanished after a few seconds, the lie stayed. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [selectedHand, setSelectedHand] = useState<HandRecord | null>(null);
  const [showReplay, setShowReplay] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [shareHand, setShareHand] = useState<ShareableHand | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [visibleHandCards, setVisibleHandCards] = useState(new Set<number>());
  const PAGE_SIZE = 25;
  const isMounted = useIsMounted();
  const loadingRef = useRef(false);
  const loadHandsRef = useRef(
    async (reset?: boolean, overridePage?: number, getIsMounted?: () => boolean) => {}
  );

  // SWR: show cached hands instantly on mount
  useEffect(() => {
    if (!user?.id || hasStatsDrilldown) return;
    const cached = getCachedHands(user.id);
    if (cached && cached.length > 0) {
      setHands(cached);
      setLoading(false);
    }
  }, [user?.id, hasStatsDrilldown]);

  /* Safety timeout: prevent an infinite skeleton if auth/Supabase hangs.
     This used to drop `loading` and nothing else, so a slow-but-healthy fetch
     rendered the empty state - "No Hands Recorded Yet" - while the request was
     still in flight. It now surfaces as a failure the page can retry, which is
     what a five-second wait actually means. */
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!isMounted.current) return;
      setLoading((wasLoading) => {
        if (wasLoading) setLoadFailed(true);
        return false;
      });
    }, 5000);
    return () => clearTimeout(timeout);
  }, []);

  // Stagger hand cards on render
  useEffect(() => {
    setVisibleHandCards(new Set());
    const timers = hands.map((_, i) =>
      setTimeout(() => setVisibleHandCards((prev) => new Set([...prev, i])), i * 40)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [hands.length]);

  useEffect(() => {
    let isMounted = true;
    if (user?.id) {
      loadHands(true, undefined, () => isMounted);
    }
    return () => {
      isMounted = false;
    };
  }, [user?.id, filter, drilldownKey]);

  // ── Realtime backstop ──
  // Removed postgres_changes subscription on public.hand_history (Phase 2 cost
  // cut): the table is being dropped from the supabase_realtime publication to
  // save egress. The three existing refresh paths cover this page fully:
  //   • useVisibilityRefresh → refetch on tab-focus (line 57)
  //   • masterBus 'HAND_COMPLETED' → refetch when engine finishes a hand
  //   • masterBus 'TABLE_CREATED' → refetch on cross-table sync
  // External writers (admin insertions, back-fills) appear on the next focus.

  // Keep loadHandsRef in sync so bus listeners always call the latest version
  useEffect(() => {
    loadHandsRef.current = loadHands;
  });

  // ── Bus Listener: debounced refresh when engine completes a hand ──
  // Debounced at 1s in case multiple HAND_COMPLETED events fire in quick
  // succession (e.g., multi-table rapid-fire finishes).
  useEffect(() => {
    const unsub = masterBus.subscribeDebounced(
      'HAND_COMPLETED',
      () => {
        loadHandsRef.current(true);
      },
      1000
    );
    // Phase 4: Cross-page sync (ported from World Hub hand-histories.js)
    const unsub2 = masterBus.subscribeDebounced(
      'TABLE_CREATED',
      () => loadHandsRef.current(true),
      500
    );
    return () => {
      unsub();
      unsub2();
    };
  }, []);

  const loadHands = async (reset = false, overridePage?: number, getIsMounted?: () => boolean) => {
    if (!user?.id) return;
    // Dedup: prevent concurrent reset-loads (pagination loads always proceed)
    if (reset && loadingRef.current) return;
    if (reset) loadingRef.current = true;
    const currentPage = reset ? 1 : (overridePage ?? page);
    if (reset) {
      if (!getIsMounted || getIsMounted()) {
        setLoading(true);
        setPage(1);
      }
    } else {
      if (!getIsMounted || getIsMounted()) setLoadingMore(true);
    }

    if (!getIsMounted || getIsMounted()) setLoadFailed(false);
    try {
      try {
        const data = await retryFetch(
          () => handHistoryService.getPlayerHands(user.id, PAGE_SIZE * currentPage),
          { maxRetries: 2, isMountedRef: isMounted }
        );

        if (getIsMounted && !getIsMounted()) return;
        let filtered = data;
        if (filter === 'won') {
          filtered = data.filter((h) => {
            const player = h.players.find((p) => p.user_id === user.id);
            return player && player.result > 0;
          });
        } else if (filter === 'lost') {
          filtered = data.filter((h) => {
            const player = h.players.find((p) => p.user_id === user.id);
            return player && player.result < 0;
          });
        } else if (filter === 'big-pots') {
          filtered = data.filter((h) => h.main_pot >= 1000);
        }
        filtered = filterHandsByStatsDrilldown(filtered, statsDrilldown, user.id);

        setHands(filtered);
        setHasMore(data.length === PAGE_SIZE * currentPage);
        // Update SWR cache with latest data
        if (reset && user?.id && !hasStatsDrilldown) setCachedHands(user.id, filtered);
      } catch (error) {
        reportError(error, 'HandHistoryPage.Failed_to_load_hands');
        if (!getIsMounted || getIsMounted()) {
          toast.error('Failed to load hand history');
          // The toast goes away. The page must not go on claiming the history
          // is empty once it is gone.
          if (reset) setLoadFailed(true);
        }
      }
      if (!getIsMounted || getIsMounted()) {
        setLoading(false);
        setLoadingMore(false);
      }
    } finally {
      if (reset) loadingRef.current = false;
    }
  };

  const loadMore = () => {
    const nextPage = page + 1;
    setPage(nextPage);
    loadHands(false, nextPage);
  };

  // Stats summary
  const stats = useMemo(() => {
    const wins = hands.filter((h) => {
      const p = h.players.find((pl) => pl.user_id === user?.id);
      return p && p.result > 0;
    }).length;
    const losses = hands.filter((h) => {
      const p = h.players.find((pl) => pl.user_id === user?.id);
      return p && p.result < 0;
    }).length;
    const totalPL = hands.reduce((sum, h) => {
      const p = h.players.find((pl) => pl.user_id === user?.id);
      return sum + (p?.result || 0);
    }, 0);
    const biggestPot = hands.reduce((max, h) => Math.max(max, h.main_pot || 0), 0);
    return { wins, losses, totalPL, biggestPot };
  }, [hands, user?.id]);

  const handleExport = () => {
    const exportData = hands.map((h) => {
      const p = h.players.find((pl) => pl.user_id === user?.id);
      return {
        date: h.played_at,
        table: h.table_name,
        stakes: h.stakes,
        pot: h.main_pot,
        result: p?.result || 0,
        players: h.players.length,
      };
    });
    exportToCSV(exportData, 'hand-history.csv');
    // It exports the LOADED hands, not the whole history. Say so.
    toast.success(`Exported ${exportData.length} Loaded Hands`);
  };

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffDays === 0) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return `${diffDays} days ago`;
    }
    return date.toLocaleDateString();
  };

  const getPlayerResult = (hand: HandRecord): number => {
    const player = hand.players.find((p) => p.user_id === user?.id);
    return player?.result || 0;
  };

  const openReplay = (hand: HandRecord) => {
    setSelectedHand(hand);
    setShowReplay(true);
  };

  // Send hand to Jarvis for GTO analysis
  const analyzeWithJarvis = (hand: HandRecord) => {
    // Build hand summary for analysis
    const player = hand.players.find((p) => p.user_id === user?.id);
    const handSummary = {
      id: hand.id,
      table: hand.table_name,
      stakes: hand.stakes,
      pot: hand.main_pot,
      result: player?.result || 0,
      players: hand.players.length,
      playedAt: hand.played_at,
      heroCards: (player as any)?.hole_cards || (player as any)?.holeCards || 'Unknown',
    };

    // Open Jarvis analysis in new tab with hand data
    try {
      const encodedData = encodeURIComponent(JSON.stringify(handSummary));
      const url = `https://smarter.poker/hub/jarvis?hand=${encodedData}`;
      window.open(url, '_blank');
      toast.info('Opening Jarvis analysis...');
    } catch (err) {
      reportError(err, 'HandHistoryPage.Failed_to_send_hand_to_Jarvis');
      toast.error('Failed to analyze hand');
    }
  };

  return (
    <div className="hand-history-page" data-arena-surface="play">
      <CasinoSurfaceHeader
        eyebrow="Play & Review / Hands"
        title="Hand Archive"
        description="Filter, Replay, Export, Share, Or Send Loaded Hands Into Jarvis Analysis While The Existing Hand-History Service Remains The Record Authority."
        artPath="assets/club-buttons/lobby/lobby-command-chassis-v2.png"
        status="HAND INDEX // SYNCHRONIZED"
        metrics={[
          { label: 'Loaded', value: hands.length },
          { label: 'Won', value: stats.wins, tone: 'live' },
          { label: 'Biggest Pot', value: stats.biggestPot.toLocaleString(), tone: 'attention' },
        ]}
      />
      {/* Filters — Pill Chips (Initiative 5) */}
      <div className="hh-filters">
        {(['all', 'won', 'lost', 'big-pots'] as HistoryFilter[]).map((f) => (
          <button
            key={f}
            className={`hh-filter-chip ${filter === f ? 'active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All Hands' : f === 'won' ? 'Won' : f === 'lost' ? 'Lost' : 'Big Pots'}
          </button>
        ))}
      </div>

      {hasStatsDrilldown && (
        <div className="hh-stats-drilldown" role="status">
          <span>
            Showing Stats Evidence
            {statsDrilldown.variant ? ` · ${statsDrilldown.variant.toUpperCase()}` : ''}
            {statsDrilldown.position ? ` · ${statsDrilldown.position}` : ''}
            {statsDrilldown.bigBlind ? ` · ${statsDrilldown.bigBlind} BB` : ''}
          </span>
          <button type="button" onClick={() => navigate('/hand-history', { replace: true })}>
            Clear Evidence Filter
          </button>
        </div>
      )}

      {/* Stats Summary */}
      {!loading && hands.length > 0 && (
        <div className="hh-summary">
          <div className="summary-stat">
            <span className="stat-value">{hands.length}</span>
            <span className="stat-label">Hands</span>
          </div>
          <div className="summary-stat positive">
            <span className="stat-value">{stats.wins}</span>
            <span className="stat-label">Won</span>
          </div>
          <div className="summary-stat negative">
            <span className="stat-value">{stats.losses}</span>
            <span className="stat-label">Lost</span>
          </div>
          <div className={`summary-stat ${stats.totalPL >= 0 ? 'positive' : 'negative'}`}>
            <span className="stat-value">
              {stats.totalPL >= 0 ? '+' : ''}
              {stats.totalPL.toLocaleString()}
            </span>
            <span className="stat-label">P/L</span>
          </div>
          <div className="summary-stat">
            <span className="stat-value">{stats.biggestPot.toLocaleString()}</span>
            <span className="stat-label">Biggest Pot</span>
          </div>
          <button
            className="export-btn"
            onClick={handleExport}
            aria-label="Export The Loaded Hands To CSV"
          >
            {' '}
            Export
          </button>
        </div>
      )}

      {/* These figures cover the hands LOADED, not the account lifetime.
          "Biggest Pot" read as an all-time record while meaning "the biggest of
          the 25 on screen", which is the kind of number a player repeats. */}
      {!loading && hands.length > 0 && (
        <div className="hh-summary-scope">
          Across The {hands.length} Hands Loaded{hasMore ? ', Load More For A Fuller Picture' : ''}
        </div>
      )}

      {/* Hands List */}
      <div className="hands-list">
        {loading ? (
          <PageSkeleton variant="list" />
        ) : loadFailed && hands.length === 0 ? (
          <div className="empty-state" style={{ padding: '48px 24px', textAlign: 'center' }}>
            <p style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
              Could Not Load Your Hand History
            </p>
            <p style={{ fontSize: 13, opacity: 0.6, marginBottom: 16 }}>
              This Is A Loading Problem, Not An Empty History.
            </p>
            <button className="load-more-btn" onClick={() => loadHands(true)}>
              Retry
            </button>
          </div>
        ) : hands.length === 0 ? (
          <div className="empty-state" style={{ padding: '48px 24px', textAlign: 'center' }}>
            <span
              className="empty-icon"
              style={{ fontSize: 48, display: 'block', marginBottom: 12, opacity: 0.5 }}
            >
              ♠♥♦♣
            </span>
            <p style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>No Hands Recorded Yet</p>
            <p style={{ fontSize: 13, opacity: 0.6, margin: 0 }}>
              Play Some Poker And Your Hand History Will Appear Here.
            </p>
          </div>
        ) : (
          hands.map((hand, index) => {
            const result = getPlayerResult(hand);
            return (
              <div
                key={hand.id}
                className="hand-card"
                onClick={() => openReplay(hand)}
                style={{
                  opacity: visibleHandCards.has(index) ? 1 : 0,
                  transform: visibleHandCards.has(index) ? 'translateY(0)' : 'translateY(8px)',
                  transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                }}
              >
                <div className="hand-header">
                  <span className="table-name">{hand.table_name}</span>
                  <span className="hand-date">{formatDate(hand.played_at)}</span>
                </div>
                <div className="hand-body">
                  <div className="pot-info">
                    <span className="pot-label">Pot</span>
                    <span className="pot-value">{hand.main_pot.toLocaleString()}</span>
                  </div>
                  <div className={`result-badge ${result >= 0 ? 'win' : 'loss'}`}>
                    {result >= 0 ? '▲' : '▼'} {result >= 0 ? '+' : ''}
                    {result.toLocaleString()}
                  </div>
                </div>
                <div className="hand-footer">
                  <span className="stakes">{hand.stakes}</span>
                  <span className="players">{hand.players.length} Players</span>
                  <button
                    className="analyze-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      analyzeWithJarvis(hand);
                    }}
                  >
                    Analyze
                  </button>
                  <button
                    className="share-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      const winnerSeats = hand.players
                        .filter((p) => p.is_winner)
                        .map((p) => p.seat);
                      setShareHand({
                        id: hand.id,
                        tableName: hand.table_name,
                        variant: toShareVariant(hand.game_type),
                        stakes: hand.stakes,
                        timestamp: new Date(hand.played_at).getTime(),
                        // 2026-08-20: this was `buttonSeat: 0` with a comment
                        // pointing at the positions it never actually read, and
                        // `stack: 1000` for every seat. Both were presented to
                        // whoever received the shared hand as fact. The button
                        // IS derivable — HandPlayer.position carries 'BTN' — and
                        // the stack simply is not stored, so it is now omitted
                        // rather than invented.
                        buttonSeat: hand.players.find((p) => p.position === 'BTN')?.seat ?? 0,
                        players: hand.players.map((p, i) => ({
                          seat: p.seat || i,
                          name: p.username || `Player ${i + 1}`,
                          isHero: p.user_id === user?.id,
                          isWinner: p.is_winner,
                        })),
                        preflop: [],
                        potTotal: hand.main_pot,
                        /* This divided the pot evenly between the winners,
                           which is wrong on every split pot and on every hand
                           with a side pot - and it was sent to whoever received
                           the shared hand as fact. It sat directly beneath the
                           2026-08-20 comment fixing the same invention for
                           buttonSeat and stack. The row has always carried the
                           real per-winner amount; the service now surfaces it. */
                        winners: hand.winners.length
                          ? hand.winners
                              .map((w) => ({
                                seat: hand.players.find((p) => p.user_id === w.user_id)?.seat ?? -1,
                                amount: w.amount,
                              }))
                              .filter((w) => w.seat >= 0)
                          : winnerSeats.map((seat) => ({ seat, amount: 0 })),
                      });
                      setShowShare(true);
                    }}
                  >
                    Share
                  </button>
                  <button className="replay-btn">▶ Replay</button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Load More Button */}
      {!loading && hasMore && hands.length > 0 && (
        <button className="load-more-btn" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading...' : 'Load More Hands'}
        </button>
      )}

      {/* Replay Modal */}
      {showReplay && selectedHand && (
        <div className="replay-modal-overlay" onClick={() => setShowReplay(false)}>
          <div className="replay-modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowReplay(false)}>
              ✕
            </button>
            <HandReplay handId={selectedHand.id} onClose={() => setShowReplay(false)} />
          </div>
        </div>
      )}

      {/* Share Modal */}
      {showShare && shareHand && (
        <ShareHand
          isOpen={showShare}
          onClose={() => setShowShare(false)}
          hand={shareHand}
          clubName="Club Arena"
        />
      )}
    </div>
  );
}
