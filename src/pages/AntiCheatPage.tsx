/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Anti-Cheat Dashboard
 *  5 Tabs: Overview | Flags | Events | Collusion | Anomalies
 *  Ported from World Hub native page → Club Arena TSX
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { masterBus } from '../core/MasterBus';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PageSkeleton from '../components/common/PageSkeleton';
import { confirmDialog } from '../components/common/confirmDialog';
import styles from './AntiCheatPage.module.css';
import { useIsMounted } from '../hooks/useIsMounted';
import { retryFetch } from '../utils/retryFetch';
import { exportToCSV } from '../lib/export';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { fmt, fmtChips, timeAgo } from '../utils/format';
import { reportError } from '../utils/errorReporter';

type Severity = 'critical' | 'high' | 'medium' | 'low';

const SEVERITY_MAP: Record<Severity, { bg: string; color: string; label: string }> = {
  critical: { bg: 'rgba(228,30,63,0.15)', color: '#FA383E', label: 'Critical' },
  high: { bg: 'rgba(245,166,35,0.15)', color: '#F5A623', label: 'High' },
  medium: { bg: 'rgba(247,197,42,0.15)', color: '#F7C52A', label: 'Medium' },
  low: { bg: 'rgba(69,153,255,0.15)', color: '#4599FF', label: 'Low' },
};

function SeverityBadge({ severity }: { severity: string }) {
  const sev = SEVERITY_MAP[severity as Severity] || SEVERITY_MAP.low;
  return (
    <span className={styles.severityBadge} style={{ background: sev.bg, color: sev.color }}>
      {sev.label}
    </span>
  );
}

// ── Types ───────────────────────────────────────────────────
interface AntiCheatFlag {
  id: string;
  player_id: string;
  club_id: string;
  flag_type: string;
  severity: string;
  status: string;
  details: Record<string, unknown> | null;
  flagged_at: string;
  reviewed_by?: string;
  review_notes?: string;
  player?: { display_name?: string };
}

interface AntiCheatEvent {
  id: string;
  player_id: string | null;
  event_type: string;
  details: Record<string, unknown> | null;
  created_at: string;
  player?: { display_name?: string };
}

interface CollusionPair {
  dumper_id: string;
  receiver_id: string;
  hands_together: number;
  chip_flow_ratio: number;
  net_chips_transferred: number;
  severity: string;
}

interface Anomaly {
  hand_id: string;
  player_id: string;
  hand_rank: string;
  pot_total: number;
  completed_at: string;
  severity: string;
}

interface Stats {
  open_flags: number;
  blocks_24h: number;
  active_sessions: number;
  by_severity: Record<string, number>;
  by_type: Record<string, number>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function AntiCheatPage() {
  const { user } = useAuthUser();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  /**
   * THE ROUTE PARAM WINS.
   *
   * This page resolved its club from ?club= or, failing that, whichever
   * club_members row came back first - which is right for the legacy global
   * URL and wrong the moment it is opened from a club's own operations rail.
   * Phase 7 gives it clubs/:clubId/anti-cheat, so the club being looked at is
   * now stated in the URL and must take precedence over a guess.
   */
  const { clubId: routeClubId } = useParams<{ clubId?: string }>();

  // ── State ─────────────────────────────────────────────
  const [tab, setTab] = useState<'overview' | 'flags' | 'events' | 'collusion' | 'anomalies'>(
    'overview'
  );
  const [loading, setLoading] = useState(true);
  const [clubId, setClubId] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  // Overview
  const [stats, setStats] = useState<Stats | null>(null);

  // Flags
  const [flags, setFlags] = useState<AntiCheatFlag[]>([]);
  const [flagsLoaded, setFlagsLoaded] = useState(false);
  const [flagFilter, setFlagFilter] = useState('open');

  // Events
  const [events, setEvents] = useState<AntiCheatEvent[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);

  // Collusion
  const [collusionPairs, setCollusionPairs] = useState<CollusionPair[]>([]);
  const [collusionLoaded, setCollusionLoaded] = useState(false);
  const [analyzedHands, setAnalyzedHands] = useState(0);

  // Anomalies
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [anomaliesLoaded, setAnomaliesLoaded] = useState(false);

  // Review Modal
  const [reviewTarget, setReviewTarget] = useState<AntiCheatFlag | null>(null);
  const [reviewStatus, setReviewStatus] = useState('reviewed');
  const [reviewNotes, setReviewNotes] = useState('');

  const mountedRef = useIsMounted();

  const loadingRef = useRef(false);

  // ── Load Stats ──────────────────────────────────────────
  const loadStats = useCallback(
    async (cId?: string) => {
      const targetClub = cId || clubId;
      if (!targetClub) return;
      if (loadingRef.current) return;
      loadingRef.current = true;
      try {
        setLoading(true);
        const { data, error } = await retryFetch(
          () =>
            supabase
              .rpc('get_anti_cheat_stats', {
                p_club_id: targetClub,
              })
              .then((r) => r),
          { maxRetries: 2, isMountedRef: mountedRef }
        );
        if (error) throw error;
        if (mountedRef.current) setStats(data || null);
      } catch (err: unknown) {
        console.warn(
          '[AntiCheat] Stats load failed:',
          err instanceof Error ? err.message : String(err)
        );
        // Fallback: build stats from flags table
        if (mountedRef.current) {
          setStats({
            open_flags: 0,
            blocks_24h: 0,
            active_sessions: 0,
            by_severity: {},
            by_type: {},
          });
        }
      } finally {
        loadingRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    },
    [clubId]
  );

  // ── Load Flags ──────────────────────────────────────────
  const loadFlags = useCallback(
    async (status?: string) => {
      if (!clubId) return;
      try {
        let query = supabase
          .from('anti_cheat_flags')
          .select('*, player_id')
          .eq('club_id', clubId)
          .order('flagged_at', { ascending: false })
          .limit(50);

        const filterStatus = status || flagFilter;
        if (filterStatus !== 'all') {
          query = query.eq('status', filterStatus);
        }

        const { data, error } = await query;
        if (error) throw error;

        // Batch-fetch player profiles (no FK hint needed)
        if (data && data.length > 0) {
          const playerIds = [
            ...new Set(data.map((f: AntiCheatFlag) => f.player_id).filter(Boolean)),
          ];
          const playerNames: Record<string, string> = {};
          if (playerIds.length > 0) {
            try {
              const { data: profiles } = await supabase
                .from('profiles')
                .select('id, display_name')
                .in('id', playerIds);
              if (profiles) {
                for (const p of profiles)
                  playerNames[p.id] = p.display_name || p.id.substring(0, 8);
              }
            } catch (e) {
              reportError(e, 'AntiCheatPage.Set');
              /* non-critical */
            }
          }
          if (mountedRef.current) {
            setFlags(
              data.map((f: AntiCheatFlag) => ({
                ...f,
                player: { display_name: playerNames[f.player_id] },
              }))
            );
            setFlagsLoaded(true);
          }
        } else if (mountedRef.current) {
          setFlags([]);
          setFlagsLoaded(true);
        }
      } catch (err: unknown) {
        console.warn(
          '[AntiCheat] Flags load failed:',
          err instanceof Error ? err.message : String(err)
        );
        if (mountedRef.current) {
          setFlags([]);
          setFlagsLoaded(true);
        }
      }
    },
    [clubId, flagFilter]
  );

  // ── Load Events ──────────────────────────────────────────
  const loadEvents = useCallback(async () => {
    if (!clubId) return;
    try {
      const { data, error } = await supabase
        .from('anti_cheat_events')
        .select('*, player_id')
        .eq('club_id', clubId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;

      // Batch-fetch player profiles (no FK hint needed)
      if (data && data.length > 0) {
        const playerIds = [
          ...new Set(data.map((e: AntiCheatEvent) => e.player_id).filter(Boolean)),
        ];
        const playerNames: Record<string, string> = {};
        if (playerIds.length > 0) {
          try {
            const { data: profiles } = await supabase
              .from('profiles')
              .select('id, display_name')
              .in('id', playerIds);
            if (profiles) {
              for (const p of profiles) playerNames[p.id] = p.display_name || p.id.substring(0, 8);
            }
          } catch (e) {
            reportError(e, 'AntiCheatPage.Set');
            /* non-critical */
          }
        }
        if (mountedRef.current) {
          setEvents(
            data.map((e: AntiCheatEvent) => ({
              ...e,
              player: { display_name: e.player_id ? playerNames[e.player_id] : undefined },
            }))
          );
          setEventsLoaded(true);
        }
      } else if (mountedRef.current) {
        setEvents([]);
        setEventsLoaded(true);
      }
    } catch (err: unknown) {
      console.warn(
        '[AntiCheat] Events load failed:',
        err instanceof Error ? err.message : String(err)
      );
      if (mountedRef.current) {
        setEvents([]);
        setEventsLoaded(true);
      }
    }
  }, [clubId]);

  // ── Load Collusion ──────────────────────────────────────
  const loadCollusion = useCallback(async () => {
    if (!clubId) return;
    try {
      const { data, error } = await retryFetch(
        () =>
          supabase
            .rpc('detect_collusion_pairs', {
              p_club_id: clubId,
              p_threshold: 0.75,
              p_min_hands: 5,
            })
            .then((r) => r),
        { maxRetries: 2, isMountedRef: mountedRef }
      );
      if (error) throw error;
      if (mountedRef.current) {
        setCollusionPairs(data?.pairs || data || []);
        setAnalyzedHands(data?.analyzed_hands || 0);
        setCollusionLoaded(true);
      }
    } catch (err: unknown) {
      console.warn(
        '[AntiCheat] Collusion load failed:',
        err instanceof Error ? err.message : String(err)
      );
      if (mountedRef.current) {
        setCollusionPairs([]);
        setCollusionLoaded(true);
      }
    }
  }, [clubId]);

  // ── Load Anomalies ──────────────────────────────────────
  const loadAnomalies = useCallback(async () => {
    if (!clubId) return;
    try {
      const { data, error } = await retryFetch(
        () =>
          supabase
            .rpc('detect_suspicious_plays', {
              p_club_id: clubId,
              p_limit: 500,
            })
            .then((r) => r),
        { maxRetries: 2, isMountedRef: mountedRef }
      );
      if (error) throw error;
      if (mountedRef.current) {
        setAnomalies(data || []);
        setAnomaliesLoaded(true);
      }
    } catch (err: unknown) {
      console.warn(
        '[AntiCheat] Anomalies load failed:',
        err instanceof Error ? err.message : String(err)
      );
      if (mountedRef.current) {
        setAnomalies([]);
        setAnomaliesLoaded(true);
      }
    }
  }, [clubId]);

  // ── Initial Load ──────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    let isMounted = true;

    const init = async () => {
      const qClub = routeClubId || searchParams.get('club') || searchParams.get('clubId');
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
        loadStats(targetClub);
      } else if (isMounted) {
        toast.error('No club found.');
        setLoading(false);
      }
    };

    init();
    return () => {
      isMounted = false;
    };
  }, [user, searchParams, routeClubId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Lazy Tab Loading ──────────────────────────────────────
  useEffect(() => {
    if (!clubId) return;
    if (tab === 'flags' && !flagsLoaded) loadFlags();
    if (tab === 'events' && !eventsLoaded) loadEvents();
    if (tab === 'collusion' && !collusionLoaded) loadCollusion();
    if (tab === 'anomalies' && !anomaliesLoaded) loadAnomalies();
  }, [
    tab,
    clubId,
    flagsLoaded,
    eventsLoaded,
    collusionLoaded,
    anomaliesLoaded,
    loadFlags,
    loadEvents,
    loadCollusion,
    loadAnomalies,
  ]);

  // ── Reload flags when filter changes ──────────────────────
  useEffect(() => {
    if (flagsLoaded && clubId) loadFlags(flagFilter);
  }, [flagFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Visibility Refresh ────────────────────────────────────
  useVisibilityRefresh(async () => {
    if (!clubId) return;
    loadStats(clubId);
  });

  // ── Realtime Listeners (debounced) ─────────────────────────
  useEffect(() => {
    if (!clubId) return;

    const unsubs = [
      // ANTI_CHEAT_FLAG_CREATED listener removed 2026-08-28: nothing emits it
      // on the client bus (flags are created server-side), so it never fired.
      masterBus.subscribeDebounced(
        'PLAYER_KICKED',
        () => {
          loadStats(clubId);
        },
        500
      ),
      // Phase 4: Cross-page sync (ported from World Hub anti-cheat.js)
      masterBus.subscribeDebounced('TABLE_CREATED', () => loadStats(clubId), 500),
      masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', () => loadStats(clubId), 500),
    ];

    return () => unsubs.forEach((u) => u());
  }, [clubId, loadStats]);

  // ── Supabase Realtime — cross-user WebSocket updates ──
  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;
    const channelKey = `anti-cheat-${clubId}`;

    const setupRealtime = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted) return;

      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'anti_cheat_flags',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => {
            loadStats(clubId);
            setFlagsLoaded(false);
          }
        )
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'anti_cheat_events',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => setEventsLoaded(false)
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'AntiCheatPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[AntiCheatPage] Realtime channel timed out');
          }
        });
    };

    setupRealtime().catch((e) => console.warn('[AntiCheatPage] Realtime setup failed:', e));

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId, loadStats]);

  // ── Actions ────────────────────────────────────────────────
  const reviewFlag = async () => {
    if (!reviewTarget || !clubId) return;
    setProcessing(true);
    try {
      const { error } = await supabase
        .from('anti_cheat_flags')
        .update({
          status: reviewStatus,
          reviewed_by: user?.id,
          review_notes: reviewNotes || null,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', reviewTarget.id);
      if (error) throw error;

      toast.success(`Flag ${reviewStatus} successfully.`);
      setReviewTarget(null);
      setReviewNotes('');
      setFlagsLoaded(false);
      loadFlags();
      loadStats(clubId);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessing(false);
    }
  };

  const kickPlayer = async (playerId: string, tableId?: string) => {
    if (
      !(await confirmDialog({
        title: 'Remove Player',
        message: 'Remove this player from the table for anti-cheat violation?',
        confirmText: 'Remove',
        variant: 'danger',
      }))
    )
      return;
    setProcessing(true);
    try {
      if (tableId) {
        const { error } = await supabase
          .from('table_seats')
          .update({ left_at: new Date().toISOString(), status: 'kicked' })
          .eq('user_id', playerId)
          .eq('table_id', tableId)
          .is('left_at', null);
        if (error) throw error;
      }

      // Log the kick event (non-blocking but warn on failure)
      const { error: logError } = await supabase.from('anti_cheat_events').insert({
        club_id: clubId,
        player_id: playerId,
        event_type: 'player_kicked',
        details: { reason: 'Anti-cheat violation - removed by admin', table_id: tableId },
      });
      if (logError) console.warn('[AntiCheat] Failed to log kick event:', logError.message);

      toast.success('Player removed.');
      masterBus.emit('PLAYER_KICKED', { clubId: clubId ?? '', userId: playerId });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessing(false);
    }
  };

  // ── Refresh All ────────────────────────────────────────────
  const handleRefresh = () => {
    if (!clubId) return;
    loadStats(clubId);
    setFlagsLoaded(false);
    setEventsLoaded(false);
    setCollusionLoaded(false);
    setAnomaliesLoaded(false);
  };

  // ── Loading ────────────────────────────────────────────────
  if (loading && !stats) {
    return <PageSkeleton variant="dashboard" />;
  }

  return (
    <div className={styles.page}>
      {/* ── Page Header ──────────────────────────────── */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>
            Anti-Cheat Dashboard
            {stats && stats.open_flags > 0 && (
              <span className={styles.badgeRed}>{stats.open_flags} Open</span>
            )}
          </h1>
        </div>
        <div className={styles.headerActions}>
          <Link to="/" className={styles.btnGhost}>
            Lobby
          </Link>
          <Link to="/admin" className={styles.btnGhost}>
            ⚙ Admin
          </Link>
          <button onClick={handleRefresh} className={styles.btnGhost}>
            ↻ Refresh
          </button>
          <button
            className={styles.btnGhost}
            onClick={() => {
              try {
                if (tab === 'flags' && flags.length > 0) {
                  exportToCSV(flags, 'anti_cheat_flags.csv', [
                    { key: 'severity', label: 'Severity' },
                    { key: 'flag_type', label: 'Type' },
                    { key: 'status', label: 'Status' },
                    { key: 'player_id', label: 'Player ID' },
                    { key: 'flagged_at', label: 'Flagged At' },
                  ]);
                } else if (tab === 'events' && events.length > 0) {
                  exportToCSV(events, 'anti_cheat_events.csv', [
                    { key: 'event_type', label: 'Type' },
                    { key: 'player_id', label: 'Player ID' },
                    { key: 'created_at', label: 'Time' },
                  ]);
                } else if (tab === 'collusion' && collusionPairs.length > 0) {
                  exportToCSV(collusionPairs, 'collusion_pairs.csv', [
                    { key: 'dumper_id', label: 'Dumper ID' },
                    { key: 'receiver_id', label: 'Receiver ID' },
                    { key: 'hands_together', label: 'Hands Together' },
                    { key: 'chip_flow_ratio', label: 'Flow Ratio' },
                    { key: 'net_chips_transferred', label: 'Net Chips' },
                    { key: 'severity', label: 'Severity' },
                  ]);
                } else if (tab === 'anomalies' && anomalies.length > 0) {
                  exportToCSV(anomalies, 'anomalies.csv', [
                    { key: 'player_id', label: 'Player ID' },
                    { key: 'hand_rank', label: 'Hand Rank' },
                    { key: 'pot_total', label: 'Pot' },
                    { key: 'severity', label: 'Severity' },
                    { key: 'completed_at', label: 'Time' },
                  ]);
                } else {
                  toast.info?.('No data to export from this tab');
                }
              } catch (e) {
                reportError(e, 'AntiCheatPage');
                /* silent */
              }
            }}
          >
            Export
          </button>
        </div>
      </header>

      {/* ── Review Flag Modal ────────────────────────── */}
      {reviewTarget && (
        <div className={styles.modalOverlay} onClick={() => !processing && setReviewTarget(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 className={styles.modalTitle}>Review Flag</h2>
            <div className={styles.modalBody}>
              <div className={styles.reviewHeader}>
                <SeverityBadge severity={reviewTarget.severity} />
                <span className={styles.flagType}>{reviewTarget.flag_type}</span>
              </div>
              <p className={styles.reviewPlayer}>
                Player:{' '}
                {reviewTarget.player?.display_name ||
                  reviewTarget.player_id?.substring(0, 8) ||
                  '-'}
              </p>
              {reviewTarget.details && (
                <pre className={styles.detailsBlock}>
                  {JSON.stringify(reviewTarget.details, null, 2)}
                </pre>
              )}
            </div>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Action</label>
              <select
                className={styles.formSelect}
                value={reviewStatus}
                onChange={(e) => setReviewStatus(e.target.value)}
              >
                <option value="reviewed">Mark Reviewed</option>
                <option value="dismissed">Dismiss</option>
                <option value="actioned">Actioned</option>
              </select>
            </div>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Notes (Optional)</label>
              <input
                className={styles.formInput}
                placeholder="Add Review Notes..."
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
              />
            </div>
            <div className={styles.modalActions}>
              <button
                onClick={() => setReviewTarget(null)}
                className={styles.btnGhost}
                disabled={processing}
              >
                Cancel
              </button>
              <button onClick={reviewFlag} className={styles.btnPrimary} disabled={processing}>
                {processing ? 'Submitting...' : 'Submit Review'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Tabs ──────────────────────────────────────── */}
      <nav className={styles.tabNav}>
        {[
          { id: 'overview' as const, label: 'Overview' },
          { id: 'flags' as const, label: 'Flags', badge: stats?.open_flags || 0 },
          { id: 'events' as const, label: 'Events' },
          { id: 'collusion' as const, label: 'Collusion' },
          { id: 'anomalies' as const, label: 'Anomalies' },
        ].map((t) => (
          <button
            key={t.id}
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.badge ? <span className={styles.tabBadge}>{t.badge}</span> : null}
          </button>
        ))}
      </nav>

      {/* ═══════════════ TAB: OVERVIEW ════════════════ */}
      {tab === 'overview' && (
        <div className={styles.section}>
          {!stats ? (
            <PageSkeleton variant="list" />
          ) : (
            <>
              <div className={styles.statsGrid}>
                <div className={styles.statCard}>
                  <div className={styles.statValueRed}>{fmt(stats.open_flags)}</div>
                  <div className={styles.statLabel}>Open Flags</div>
                </div>
                <div className={styles.statCard}>
                  <div className={styles.statValueGold}>{fmt(stats.blocks_24h)}</div>
                  <div className={styles.statLabel}>Blocks (24H)</div>
                </div>
                <div className={styles.statCard}>
                  <div className={styles.statValueGreen}>{fmt(stats.active_sessions)}</div>
                  <div className={styles.statLabel}>Active Sessions</div>
                </div>
              </div>

              {/* Severity Breakdown */}
              {Object.keys(stats.by_severity || {}).length > 0 && (
                <div className={styles.subsection}>
                  <h3 className={styles.subsectionTitle}>Flags By Severity</h3>
                  <div className={styles.statsGrid}>
                    {Object.entries(stats.by_severity).map(([sev, count]) => {
                      const st = SEVERITY_MAP[sev as Severity] || {};
                      return (
                        <div
                          key={sev}
                          className={styles.statCard}
                          style={{ borderLeft: `3px solid ${st.color || '#6B7280'}` }}
                        >
                          <div className={styles.statValue} style={{ color: st.color }}>
                            {fmt(count)}
                          </div>
                          <div className={styles.statLabel} style={{ textTransform: 'capitalize' }}>
                            {sev}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Flags by Type */}
              {Object.keys(stats.by_type || {}).length > 0 && (
                <div className={styles.subsection}>
                  <h3 className={styles.subsectionTitle}>Flags By Type</h3>
                  <div className={styles.tableScroll}>
                    <table className={styles.dataTable}>
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(stats.by_type)
                          .sort((a, b) => b[1] - a[1])
                          .map(([type, count]) => (
                            <tr key={type}>
                              <td style={{ fontWeight: 600 }}>{type}</td>
                              <td>{fmt(count)}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {stats.open_flags === 0 && (
                <div className={styles.emptyState}>
                  <span className={styles.emptyIcon}>✓</span>
                  <span className={styles.emptyText}>No Open Flags - Club Is Clean!</span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ═══════════════ TAB: FLAGS ═══════════════════ */}
      {tab === 'flags' && (
        <div className={styles.section}>
          <div className={styles.filterBar}>
            {['open', 'reviewed', 'dismissed', 'actioned', 'all'].map((f) => (
              <button
                key={f}
                className={flagFilter === f ? styles.btnPrimary : styles.btnGhost}
                onClick={() => setFlagFilter(f)}
                style={{ textTransform: 'capitalize' }}
              >
                {f}
              </button>
            ))}
          </div>

          {!flagsLoaded ? (
            <PageSkeleton variant="list" />
          ) : flags.length === 0 ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>▸</span>
              <span className={styles.emptyText}>No Flags Match The Filter "{flagFilter}"</span>
            </div>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.dataTable}>
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Type</th>
                    <th>Player</th>
                    <th>Time</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {flags.map((f) => (
                    <tr key={f.id}>
                      <td>
                        <SeverityBadge severity={f.severity} />
                      </td>
                      <td style={{ fontWeight: 600 }}>{f.flag_type}</td>
                      <td>{f.player?.display_name || f.player_id?.substring(0, 8) || '-'}</td>
                      <td className={styles.timeCell}>{timeAgo(f.flagged_at)}</td>
                      <td>
                        <span
                          className={`${styles.statusBadge} ${f.status === 'open' ? styles.statusOpen : ''}`}
                        >
                          {f.status}
                        </span>
                      </td>
                      <td>
                        <div className={styles.actionBtns}>
                          {f.status === 'open' && (
                            <button
                              onClick={() => {
                                setReviewTarget(f);
                                setReviewStatus('reviewed');
                                setReviewNotes('');
                              }}
                              className={styles.btnSmallGold}
                            >
                              Review
                            </button>
                          )}
                          <button
                            onClick={() => kickPlayer(f.player_id)}
                            className={styles.btnSmallDanger}
                            disabled={processing}
                          >
                            Kick
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════ TAB: EVENTS ══════════════════ */}
      {tab === 'events' && (
        <div className={styles.section}>
          {!eventsLoaded ? (
            <PageSkeleton variant="list" />
          ) : events.length === 0 ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>▦</span>
              <span className={styles.emptyText}>No Anti-Cheat Events Recorded Yet</span>
            </div>
          ) : (
            <>
              <h3 className={styles.subsectionTitle}>Recent Events ({events.length})</h3>
              <div className={styles.tableScroll}>
                <table className={styles.dataTable}>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Player</th>
                      <th>Details</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((ev, i) => (
                      <tr key={ev.id || i}>
                        <td>
                          <span
                            className={`${styles.eventTypeBadge} ${
                              ev.event_type.includes('kicked')
                                ? styles.eventDanger
                                : ev.event_type.includes('blocked')
                                  ? styles.eventWarning
                                  : ''
                            }`}
                          >
                            {ev.event_type}
                          </span>
                        </td>
                        <td>
                          {ev.player?.display_name || ev.player_id?.substring(0, 8) || 'System'}
                        </td>
                        <td className={styles.detailsCell}>
                          {ev.details ? JSON.stringify(ev.details).substring(0, 80) : '-'}
                        </td>
                        <td className={styles.timeCell}>{timeAgo(ev.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ═══════════════ TAB: COLLUSION ═══════════════ */}
      {tab === 'collusion' && (
        <div className={styles.section}>
          {!collusionLoaded ? (
            <PageSkeleton variant="list" />
          ) : (
            <>
              <div className={styles.statsGrid}>
                <div className={styles.statCard}>
                  <div className={styles.statValueBlue}>{fmt(analyzedHands)}</div>
                  <div className={styles.statLabel}>Hands Analyzed</div>
                </div>
                <div className={styles.statCard}>
                  <div className={styles.statValueRed}>{fmt(collusionPairs.length)}</div>
                  <div className={styles.statLabel}>Suspicious Pairs</div>
                </div>
                <div className={styles.statCard}>
                  <div
                    className={styles.statValue}
                    style={{
                      color:
                        collusionPairs.filter((p) => p.severity === 'critical').length > 0
                          ? '#FA383E'
                          : '#31A24C',
                    }}
                  >
                    {fmt(collusionPairs.filter((p) => p.severity === 'critical').length)}
                  </div>
                  <div className={styles.statLabel}>Critical</div>
                </div>
              </div>

              {collusionPairs.length === 0 ? (
                <div className={styles.emptyState}>
                  <span className={styles.emptyIcon}>✓</span>
                  <span className={styles.emptyText}>
                    No Suspicious Chip-Dumping Patterns Detected Across {fmt(analyzedHands)} Hands
                  </span>
                </div>
              ) : (
                <>
                  <h3 className={styles.subsectionTitle}>Suspected Collusion Pairs</h3>
                  <p className={styles.subsectionDesc}>
                    Players With One-Directional Chip Flow Above 75% Threshold
                  </p>
                  <div className={styles.tableScroll}>
                    <table className={styles.dataTable}>
                      <thead>
                        <tr>
                          <th>Severity</th>
                          <th>Dumper → Receiver</th>
                          <th>Hands</th>
                          <th>Flow Ratio</th>
                          <th>Net Chips</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {collusionPairs.map((pair, i) => (
                          <tr key={i}>
                            <td>
                              <SeverityBadge severity={pair.severity} />
                            </td>
                            <td>
                              <span className={styles.collusionFlow}>
                                <span className={styles.dumper}>
                                  {pair.dumper_id.substring(0, 8)}
                                </span>
                                <span className={styles.arrow}>→</span>
                                <span className={styles.receiver}>
                                  {pair.receiver_id.substring(0, 8)}
                                </span>
                              </span>
                            </td>
                            <td style={{ fontWeight: 600 }}>{fmt(pair.hands_together)}</td>
                            <td>
                              <span
                                style={{
                                  fontWeight: 700,
                                  color:
                                    pair.chip_flow_ratio >= 0.9
                                      ? '#FA383E'
                                      : pair.chip_flow_ratio >= 0.85
                                        ? '#F5A623'
                                        : '#F7C52A',
                                }}
                              >
                                {(pair.chip_flow_ratio * 100).toFixed(1)}%
                              </span>
                            </td>
                            <td style={{ fontWeight: 700, color: '#F7C52A' }}>
                              {fmtChips(pair.net_chips_transferred)}
                            </td>
                            <td>
                              <div className={styles.actionBtns}>
                                <button
                                  onClick={() => kickPlayer(pair.dumper_id)}
                                  className={styles.btnSmallDanger}
                                  disabled={processing}
                                >
                                  Kick Dumper
                                </button>
                                <button
                                  onClick={() => kickPlayer(pair.receiver_id)}
                                  className={styles.btnSmallDanger}
                                  disabled={processing}
                                >
                                  Kick Receiver
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* ═══════════════ TAB: ANOMALIES ═══════════════ */}
      {tab === 'anomalies' && (
        <div className={styles.section}>
          {!anomaliesLoaded ? (
            <PageSkeleton variant="list" />
          ) : (
            <>
              <div className={styles.statsGrid}>
                <div className={styles.statCard}>
                  <div className={styles.statValueRed}>{fmt(anomalies.length)}</div>
                  <div className={styles.statLabel}>Anomalies Found</div>
                </div>
                <div className={styles.statCard}>
                  <div className={styles.statValue} style={{ color: '#FA383E' }}>
                    {fmt(anomalies.filter((a) => a.severity === 'critical').length)}
                  </div>
                  <div className={styles.statLabel}>Critical</div>
                </div>
                <div className={styles.statCard}>
                  <div className={styles.statValueGold}>
                    {fmt(anomalies.filter((a) => a.severity === 'high').length)}
                  </div>
                  <div className={styles.statLabel}>High</div>
                </div>
              </div>

              {anomalies.length === 0 ? (
                <div className={styles.emptyState}>
                  <span className={styles.emptyIcon}>◎</span>
                  <span className={styles.emptyText}>
                    No Suspicious Plays Detected - All Hands Look Clean!
                  </span>
                </div>
              ) : (
                <>
                  <h3 className={styles.subsectionTitle}>Suspicious Plays</h3>
                  <p className={styles.subsectionDesc}>
                    Players Who Folded Strong Hands On The River (Possible Chip-Dumping Signal)
                  </p>
                  <div className={styles.tableScroll}>
                    <table className={styles.dataTable}>
                      <thead>
                        <tr>
                          <th>Severity</th>
                          <th>Player</th>
                          <th>Action</th>
                          <th>Hand Rank</th>
                          <th>Pot Size</th>
                          <th>Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {anomalies.map((a, i) => (
                          <tr key={`${a.hand_id}-${a.player_id}-${i}`}>
                            <td>
                              <SeverityBadge severity={a.severity} />
                            </td>
                            <td>{a.player_id.substring(0, 8)}</td>
                            <td>
                              <span className={styles.foldedBadge}>Folded Strong Hand</span>
                            </td>
                            <td className={styles.handRank}>
                              {String(a.hand_rank).replace(/_/g, ' ')}
                            </td>
                            <td style={{ fontWeight: 600 }}>{fmtChips(a.pot_total)}</td>
                            <td className={styles.timeCell}>{timeAgo(a.completed_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
