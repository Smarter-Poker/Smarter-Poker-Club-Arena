/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND HISTORY PAGE — Browse All Hands with Pagination & Export
 * ═══════════════════════════════════════════════════════════════════════════════
 * Full-page hand history browser with filters, pagination, and export
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { handHistoryService } from '../services/HandHistoryService';
import type { HandRecord } from '../services/HandHistoryService';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { exportToCSV } from '../lib/export';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import HandReplay from '../components/replay/HandReplay';
import ReplayActions from '../components/table/ReplayActions';
import HandReplayPlayer from '../components/table/HandReplayPlayer';
import HandHistoryModal from '../components/club/HandHistoryModal';
import { ShareHand, type ShareableHand } from '../components/table/ShareHand';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useIsMounted } from '../hooks/useIsMounted';
import { retryFetch } from '../utils/retryFetch';
import './HandHistoryPage.css';

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

export default function HandHistoryPage() {
  useEffect(() => {
    document.title = 'Hand History | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  useVisibilityRefresh(() => loadHands(true));
  const [hands, setHands] = useState<HandRecord[]>([]);
  const [loading, setLoading] = useState(true);
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

  // SWR: show cached hands instantly on mount
  useEffect(() => {
    if (!user?.id) return;
    const cached = getCachedHands(user.id);
    if (cached && cached.length > 0) {
      setHands(cached);
      setLoading(false);
    }
  }, [user?.id]);

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
  }, [user?.id, filter]);

  // ── Realtime subscription: refresh hands on new entries ──
  useEffect(() => {
    if (!user?.id) return;

    const channelKey = `hand-history-${user.id}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'hand_history',
          filter: `player_ids=cs.{${user.id}}`,
        },
        () => {
          // New hand added for this user, refresh the hand list
          loadHands(true);
        }
      )
      .subscribe();

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [user?.id]);

  // ── Bus Listener: debounced refresh when engine completes a hand ──
  // Debounced at 1s to coalesce with postgres_changes subscription above
  // (both fire for the same hand — bus fires immediately, postgres 100-2000ms later)
  useEffect(() => {
    const unsub = masterBus.subscribeDebounced(
      'HAND_COMPLETED',
      () => {
        loadHands(true);
      },
      1000
    );
    // Phase 4: Cross-page sync (ported from World Hub hand-histories.js)
    const unsub2 = masterBus.subscribeDebounced('TABLE_CREATED', () => loadHands(true), 500);
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

        setHands(filtered);
        setHasMore(data.length === PAGE_SIZE * currentPage);
        // Update SWR cache with latest data
        if (reset && user?.id) setCachedHands(user.id, filtered);
      } catch (error) {
        console.error('Failed to load hands:', error);
        if (!getIsMounted || getIsMounted()) toast.error('Failed to load hand history');
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
    toast.success('Hand history exported!');
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
      console.error('Failed to send hand to Jarvis:', err);
      toast.error('Failed to analyze hand');
    }
  };

  return (
    <div className="hand-history-page">
      {/* Filters — Pill Chips (Initiative 5) */}
      <div className="hh-filters">
        {(['all', 'won', 'lost', 'big-pots'] as HistoryFilter[]).map((f) => (
          <button
            key={f}
            className={`hh-filter-chip ${filter === f ? 'active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all'
              ? 'All Hands'
              : f === 'won'
                ? '✅ Won'
                : f === 'lost'
                  ? '❌ Lost'
                  : '🔥 Big Pots'}
          </button>
        ))}
      </div>

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
            aria-label="Export hand history data"
          >
            {' '}
            Export
          </button>
        </div>
      )}

      {/* Hands List */}
      <div className="hands-list">
        {loading ? (
          <PageSkeleton variant="list" />
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
              Play some poker and your hand history will appear here.
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
                  <span className="players">{hand.players.length} players</span>
                  <button
                    className="analyze-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      analyzeWithJarvis(hand);
                    }}
                  >
                    🧠 Analyze
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
                        variant: (hand.game_type?.includes('PLO')
                          ? 'PLO4'
                          : 'NLH') as ShareableHand['variant'],
                        stakes: hand.stakes,
                        timestamp: new Date(hand.played_at).getTime(),
                        buttonSeat: 0, // Default, actual info in players' positions
                        players: hand.players.map((p, i) => ({
                          seat: p.seat || i,
                          name: p.username || `Player ${i + 1}`,
                          stack: 1000, // Default stack
                          isHero: p.user_id === user?.id,
                          isWinner: p.is_winner,
                        })),
                        preflop: [],
                        potTotal: hand.main_pot,
                        winners: winnerSeats.map((seat) => ({
                          seat,
                          amount: hand.main_pot / (winnerSeats.length || 1),
                        })),
                      });
                      setShowShare(true);
                    }}
                  >
                    📤 Share
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
