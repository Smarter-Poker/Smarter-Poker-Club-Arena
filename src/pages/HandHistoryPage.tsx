/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND ARCHIVE — every hand you played, across every table  #SMARTERCASINOREALISM
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The cross-table view (`/hand-history`, also `/history` and `/hands`). A live
 * table's Previous Hand shows that table's hands; this shows all of them,
 * newest first, paged.
 *
 * 2026-09-04 (Previous Hand second sweep). This page rendered the raw service
 * row directly - a fourth hand shape - and shared a hand with NO action history
 * and NO board (`preflop: []`); every card was titled "Table" because the
 * service hard-coded the name; Load More re-downloaded every earlier page; a
 * five-second timer declared a healthy slow load a failure; a session cache
 * seeded the list with stale hands; and the Jarvis link put the viewer's hole
 * cards in a URL query string. Each of those is gone. Every card here is the
 * same `HandRecord` the table's panel renders, built through the same adapter,
 * expanding into the same `HandDetailView`, sharing through the same
 * `panelHandToShareable`.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { handHistoryService } from '../services/HandHistoryService';
import type { HandRecord as ServiceHandRecord } from '../services/HandHistoryService';
import type { HandRecord } from '../components/table/HandHistoryPanel';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { exportToCSV } from '../lib/export';
import { masterBus } from '../core/MasterBus';
import HandReplay from '../components/replay/HandReplay';
import HandDetailView from '../components/handdetail/HandDetailView';
import { ShareHand, type ShareableHand } from '../components/table/ShareHand';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useIsMounted } from '../hooks/useIsMounted';
import { retryFetch } from '../utils/retryFetch';
import './HandHistoryPage.css';
import { reportError } from '../utils/errorReporter';
import CasinoSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import { filterHandsByStatsDrilldown, readStatsDrilldown } from '../lib/handHistoryDrilldown';
import { adaptServiceHandToPanel, panelHandToShareable } from '../lib/handHistoryAdapter';
import { gameTypeLabel, money } from '../utils/handFormat';

type HistoryFilter = 'all' | 'won' | 'lost' | 'big-pots';
const PAGE_SIZE = 25;
const FILTERS: Array<{ id: HistoryFilter; label: string }> = [
  { id: 'all', label: 'All Hands' },
  { id: 'won', label: 'Won' },
  { id: 'lost', label: 'Lost' },
  { id: 'big-pots', label: 'Big Pots' },
];

function formatDate(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);
  if (diffDays === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} Days Ago`;
  return date.toLocaleDateString();
}

function signed(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${money(Math.abs(n))}`;
}

export default function HandHistoryPage() {
  useEffect(() => {
    document.title = 'Hand History | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuthUser();
  const userId = user?.id ?? null;
  const drilldownKey = searchParams.toString();
  const statsDrilldown = useMemo(
    () => readStatsDrilldown(new URLSearchParams(drilldownKey)),
    [drilldownKey]
  );
  const hasStatsDrilldown = Object.keys(statsDrilldown).length > 0;
  /* DEEP LINK (Phase 1, 2026-09-05): `/hand-history?hand=<id>` opens ON that
     hand - expanded and scrolled to - fetching it by id when it is not on the
     first page. The id is the hand_history row id the modal's Copy Link and a
     dispute carry; RLS decides whether the viewer may read it. */
  const linkedHandId = searchParams.get('hand');
  const toast = useToast();
  const isMounted = useIsMounted();

  /* The record as loaded, in play order. Filters apply to this list on screen
     and never refetch; the scope line says how many hands they cover. */
  const [rows, setRows] = useState<ServiceHandRecord[]>([]);
  const [loading, setLoading] = useState(true);
  /* A failed fetch is not an empty history. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [replayId, setReplayId] = useState<string | null>(null);
  const [shareHand, setShareHand] = useState<ShareableHand | null>(null);
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const loadingRef = useRef(false);
  /* A linked hand not on the loaded page, fetched by id and shown first. */
  const [linkedRow, setLinkedRow] = useState<ServiceHandRecord | null>(null);
  const [linkedState, setLinkedState] = useState<'idle' | 'loading' | 'missing'>('idle');
  const linkedScrolledRef = useRef<string | null>(null);

  const loadFirstPage = useCallback(async () => {
    if (!userId) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setLoadFailed(false);
    try {
      const data = await retryFetch(() => handHistoryService.getPlayerHands(userId, PAGE_SIZE), {
        maxRetries: 2,
        isMountedRef: isMounted,
      });
      if (!isMounted.current) return;
      setRows(data);
      setHasMore(data.length === PAGE_SIZE);
    } catch (error) {
      reportError(error, 'HandHistoryPage.Failed_to_load_hands');
      if (!isMounted.current) return;
      toast.error('Could Not Load Hand History');
      setLoadFailed(true);
    } finally {
      loadingRef.current = false;
      if (isMounted.current) setLoading(false);
    }
  }, [userId, isMounted, toast]);

  const loadMore = useCallback(async () => {
    if (!userId || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await retryFetch(
        () => handHistoryService.getPlayerHands(userId, PAGE_SIZE, { offset: rows.length }),
        { maxRetries: 2, isMountedRef: isMounted }
      );
      if (!isMounted.current) return;
      setRows((prev) => {
        const seen = new Set(prev.map((h) => h.id));
        return [...prev, ...data.filter((h) => !seen.has(h.id))];
      });
      setHasMore(data.length === PAGE_SIZE);
    } catch (error) {
      reportError(error, 'HandHistoryPage.Failed_to_load_more');
      if (isMounted.current) toast.error('Could Not Load More Hands');
    } finally {
      if (isMounted.current) setLoadingMore(false);
    }
  }, [userId, rows.length, loadingMore, isMounted, toast]);

  const loadFirstPageRef = useRef(loadFirstPage);
  loadFirstPageRef.current = loadFirstPage;

  useEffect(() => {
    if (userId) void loadFirstPage();
  }, [userId, loadFirstPage]);

  useVisibilityRefresh(() => loadFirstPageRef.current());

  // Refresh when a hand finishes anywhere, debounced for rapid multi-table finishes.
  useEffect(() => {
    const unsub = masterBus.subscribeDebounced(
      'HAND_COMPLETED',
      () => void loadFirstPageRef.current(),
      1000
    );
    const unsub2 = masterBus.subscribeDebounced(
      'TABLE_CREATED',
      () => void loadFirstPageRef.current(),
      500
    );
    return () => {
      unsub();
      unsub2();
    };
  }, []);

  // The linked hand: on the page already, or fetched by id.
  useEffect(() => {
    if (!linkedHandId || !userId) {
      setLinkedRow(null);
      setLinkedState('idle');
      return;
    }
    if (rows.some((r) => r.id === linkedHandId)) {
      setLinkedRow(null);
      setLinkedState('idle');
      return;
    }
    if (loading) return;
    // Already fetched by id; a Load More changing `rows` is not a reason to refetch.
    if (linkedRow?.id === linkedHandId) return;
    let alive = true;
    setLinkedState('loading');
    (async () => {
      try {
        const row = await handHistoryService.getHand(linkedHandId);
        if (!alive) return;
        setLinkedRow(row);
        setLinkedState(row ? 'idle' : 'missing');
      } catch (e) {
        if (!alive) return;
        reportError(e, 'HandHistoryPage.linked_hand');
        setLinkedState('missing');
      }
    })();
    return () => {
      alive = false;
    };
  }, [linkedHandId, userId, rows, loading, linkedRow]);

  /* The view model: the same record the table's panel renders, through the
     same adapter. Filters and the stats drill-down apply on top. A linked hand
     fetched by id leads the list regardless of the filter, so the link lands. */
  const hands: HandRecord[] = useMemo(() => {
    if (!userId) return [];
    let list = filterHandsByStatsDrilldown(rows, statsDrilldown, userId);
    if (filter === 'won')
      list = list.filter((h) => (h.players.find((p) => p.user_id === userId)?.result ?? 0) > 0);
    else if (filter === 'lost')
      list = list.filter((h) => (h.players.find((p) => p.user_id === userId)?.result ?? 0) < 0);
    else if (filter === 'big-pots')
      list = list.filter((h) => h.replay.potTotal >= 100 * (h.replay.bigBlind || 1));
    if (linkedHandId) {
      const onPage = rows.find((r) => r.id === linkedHandId);
      const lead = onPage ?? linkedRow;
      if (lead && !list.some((h) => h.id === lead.id)) list = [lead, ...list];
    }
    return list.map((h) => adaptServiceHandToPanel(h, userId));
  }, [rows, filter, statsDrilldown, userId, linkedHandId, linkedRow]);

  // Open and scroll to the linked hand once it is on screen.
  useEffect(() => {
    if (!linkedHandId || linkedScrolledRef.current === linkedHandId) return;
    if (!hands.some((h) => h.id === linkedHandId)) return;
    linkedScrolledRef.current = linkedHandId;
    setExpandedId(linkedHandId);
    const el = document.getElementById(`hand-${linkedHandId}`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [linkedHandId, hands]);

  const idSignature = hands.map((h) => h.id).join('|');
  useEffect(() => {
    const ids = idSignature ? idSignature.split('|') : [];
    const timers = ids.map((id, i) =>
      setTimeout(
        () => setVisible((prev) => (prev[id] ? prev : { ...prev, [id]: true })),
        Math.min(i, 12) * 40
      )
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [idSignature]);

  const stats = useMemo(() => {
    let wins = 0;
    let losses = 0;
    let net = 0;
    let biggestPot = 0;
    let vpip = 0;
    for (const h of hands) {
      const me = h.replay.players.find((p) => p.userId === userId);
      if (!me) continue;
      if (me.net > 0) wins += 1;
      if (me.net < 0) losses += 1;
      net += me.net;
      biggestPot = Math.max(biggestPot, h.replay.potTotal);
      const pre = h.replay.streets.find((s) => s.key === 'preflop');
      if (
        pre?.rows.some(
          (r) => r.userId === userId && ['call', 'bet', 'raise', 'all_in'].includes(r.verb)
        )
      )
        vpip += 1;
    }
    return {
      wins,
      losses,
      net: Math.round(net * 100) / 100,
      biggestPot,
      vpipPct: hands.length ? Math.round((vpip / hands.length) * 100) : 0,
    };
  }, [hands, userId]);

  const handleExport = () => {
    const exportData = hands.map((h) => {
      const me = h.replay.players.find((p) => p.userId === userId);
      return {
        date: new Date(h.timestamp).toISOString(),
        table: h.tableName || '',
        game: gameTypeLabel(h.replay.gameVariant) || h.gameType,
        stakes: h.blinds,
        hand_number: h.handNumber,
        pot: h.replay.potTotal,
        rake: h.rake,
        result: me?.net ?? 0,
        players: h.players.length,
        boards: h.replay.boards.length,
      };
    });
    exportToCSV(exportData, 'hand-history.csv');
    // It exports the LOADED hands, not the whole history. Say so.
    toast.success(`Exported ${exportData.length} Loaded Hands`);
  };

  /**
   * Jarvis analysis. The hand travels by ID: the analysis page reads the
   * record itself, under the viewer's own session. The old link serialised the
   * viewer's HOLE CARDS into the query string - into browser history and every
   * referer header on the way.
   */
  const analyzeWithJarvis = (hand: HandRecord) => {
    try {
      const summary = {
        id: hand.id,
        table: hand.tableName || '',
        stakes: hand.blinds,
        pot: hand.replay.potTotal,
        result: hand.replay.players.find((p) => p.userId === userId)?.net ?? 0,
        players: hand.players.length,
        playedAt: new Date(hand.timestamp).toISOString(),
      };
      const path = `/hub/jarvis?hand=${encodeURIComponent(JSON.stringify(summary))}`;
      // Dan 2026-09-05: with a live table open, Jarvis opens in a hub tab
      // beside the game (the strip can see it, swipe reaches it); otherwise
      // the browser tab it has always been.
      if (Number(document.body?.dataset.caLiveTables ?? '0') > 0) {
        masterBus.emit('OPEN_HUB_TAB', { path, requestedBy: userId ?? undefined });
      } else {
        window.open(`https://smarter.poker${path}`, '_blank', 'noopener');
      }
      toast.info('Opening Jarvis Analysis');
    } catch (err) {
      reportError(err, 'HandHistoryPage.Failed_to_send_hand_to_Jarvis');
      toast.error('Could Not Open Jarvis Analysis');
    }
  };

  const heroId = userId || '';

  return (
    <div className="hand-history-page__hand-history-page" data-arena-surface="play">
      <CasinoSurfaceHeader
        eyebrow="Play & Review / Hands"
        title="Hand Archive"
        description="Every Hand You Played, Across Every Table, Newest First. Expand A Hand For The Full Rundown, Replay It, Share It, Or Send It To Jarvis."
        artPath="assets/club-buttons/lobby/lobby-command-chassis-v2.png"
        status="HAND RECORD // LIVE"
        metrics={[
          { label: 'Loaded', value: hands.length },
          { label: 'Won', value: stats.wins, tone: 'live' },
          { label: 'Biggest Pot', value: money(stats.biggestPot), tone: 'attention' },
        ]}
      />

      <div className="hh-filters" role="group" aria-label="Filter Loaded Hands">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`hh-filter-chip${filter === f.id ? ' active' : ''}`}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {linkedHandId && linkedState === 'missing' && (
        <div className="hh-stats-drilldown" role="status">
          <span>
            That Hand Is Not In Your Record. Hands Are Readable By The Players Dealt Into Them.
          </span>
          <button type="button" onClick={() => navigate('/hand-history', { replace: true })}>
            Show All Hands
          </button>
        </div>
      )}

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

      {!loading && hands.length > 0 && (
        <>
          <div className="hh-summary" aria-label={`Across The ${hands.length} Hands Loaded`}>
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
            <div
              className={`summary-stat ${stats.net > 0 ? 'positive' : stats.net < 0 ? 'negative' : ''}`}
            >
              <span className="stat-value">{signed(stats.net)}</span>
              <span className="stat-label">Net</span>
            </div>
            <div className="summary-stat">
              <span className="stat-value">{stats.vpipPct}%</span>
              <span className="stat-label">VPIP</span>
            </div>
            <div className="summary-stat">
              <span className="stat-value">{money(stats.biggestPot)}</span>
              <span className="stat-label">Biggest Pot</span>
            </div>
            <button
              type="button"
              className="hand-history-page__export-btn"
              onClick={handleExport}
              aria-label="Export The Loaded Hands To CSV"
            >
              Export
            </button>
          </div>
          {/* These figures cover the hands LOADED, not the account lifetime. */}
          <div className="hh-summary-scope">
            Across The {hands.length} Hands Loaded
            {hasMore ? ', Load More For A Fuller Picture' : ''}
          </div>
        </>
      )}

      <div className="hands-list" aria-busy={loading}>
        {loading ? (
          <PageSkeleton variant="list" />
        ) : loadFailed && hands.length === 0 ? (
          <div className="hh-empty">
            <p className="hh-empty__title">Could Not Load Your Hand History</p>
            <p className="hh-empty__body">This Is A Loading Problem, Not An Empty History.</p>
            <button type="button" className="load-more-btn" onClick={() => void loadFirstPage()}>
              Retry
            </button>
          </div>
        ) : hands.length === 0 ? (
          <div className="hh-empty">
            <span className="hh-empty__suits" aria-hidden="true">
              ♠♥♦♣
            </span>
            <p className="hh-empty__title">
              {rows.length > 0 ? 'No Loaded Hands Match This Filter' : 'No Hands Recorded Yet'}
            </p>
            <p className="hh-empty__body">
              {rows.length > 0
                ? 'Load More Hands Or Choose Another Filter.'
                : 'Play Some Poker And Your Hand History Will Appear Here.'}
            </p>
          </div>
        ) : (
          hands.map((hand) => {
            const me = hand.replay.players.find((p) => p.userId === userId);
            const net = me?.net ?? 0;
            const expanded = expandedId === hand.id;
            const variant = gameTypeLabel(hand.replay.gameVariant) || hand.gameType;
            const runs = hand.replay.boards.length;
            return (
              <article
                key={hand.id}
                id={`hand-${hand.id}`}
                className={`hand-card${expanded ? ' hand-card--expanded' : ''}${visible[hand.id] ? ' hand-card--in' : ''}${
                  hand.id === linkedHandId ? ' hand-card--linked' : ''
                }`}
              >
                <button
                  type="button"
                  className="hand-card__summary"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : hand.id)}
                >
                  <div className="hand-header">
                    <span className="table-name">{hand.tableName || 'Table'}</span>
                    <span className="hand-num">#{hand.handNumber}</span>
                    <span className="hand-date">{formatDate(hand.timestamp)}</span>
                  </div>
                  <div className="hand-body">
                    <div className="pot-info">
                      <span className="pot-label">Pot</span>
                      <span className="hand-history-page__pot-value">
                        {money(hand.replay.potTotal)}
                      </span>
                      {hand.rake > 0 && <span className="pot-rake">Rake {money(hand.rake)}</span>}
                    </div>
                    <div className="hand-tags">
                      <span className="hand-tag">{variant}</span>
                      {runs > 1 && (
                        <span className="hand-tag">
                          {hand.bombPot ? 'Bomb Pot' : runs >= 3 ? 'Run 3x' : 'Run 2x'}
                        </span>
                      )}
                      {hand.replay.hiLo && <span className="hand-tag">Hi-Lo</span>}
                      {!hand.wentToShowdown && (
                        <span className="hand-tag hand-tag--quiet">No Showdown</span>
                      )}
                    </div>
                    <div className={`result-badge ${net > 0 ? 'win' : net < 0 ? 'loss' : 'flat'}`}>
                      {signed(net)}
                    </div>
                  </div>
                  <div className="hand-footer">
                    <span className="stakes">{hand.blinds}</span>
                    <span className="players">{hand.players.length} Players</span>
                    <span className="hand-card__chevron" aria-hidden="true">
                      {expanded ? '▴' : '▾'}
                    </span>
                  </div>
                </button>

                {expanded && (
                  <div className="hand-card__detail">
                    <HandDetailView model={hand.replay} currentUserId={heroId} badge={variant} />
                    <div className="hand-card__actions">
                      <button
                        type="button"
                        className="analyze-btn"
                        onClick={() => analyzeWithJarvis(hand)}
                      >
                        Analyze
                      </button>
                      <button
                        type="button"
                        className="share-btn"
                        onClick={() =>
                          setShareHand(panelHandToShareable(hand, hand.tableName || 'Club Arena'))
                        }
                      >
                        Share
                      </button>
                      <button
                        type="button"
                        className="replay-btn"
                        onClick={() => setReplayId(hand.id)}
                      >
                        Replay
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>

      {!loading && hasMore && rows.length > 0 && (
        <button
          type="button"
          className="load-more-btn"
          onClick={() => void loadMore()}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading' : 'Load More Hands'}
        </button>
      )}

      {replayId && (
        <div className="replay-modal-overlay" onClick={() => setReplayId(null)}>
          <div
            className="replay-modal-content"
            role="dialog"
            aria-modal="true"
            aria-label="Hand Replay"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="modal-close"
              aria-label="Close"
              onClick={() => setReplayId(null)}
            >
              ✕
            </button>
            <HandReplay handId={replayId} onClose={() => setReplayId(null)} />
          </div>
        </div>
      )}

      {shareHand && (
        <ShareHand
          isOpen
          onClose={() => setShareHand(null)}
          hand={shareHand}
          clubName="Club Arena"
        />
      )}
    </div>
  );
}
