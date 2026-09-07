import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { useToast } from '../../components/common/Toast';
import './AnalyticsDashboard.css';

import { useIsMounted } from '../../hooks/useIsMounted';
import { reportError } from '../../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface PositionStat {
  position: string;
  hands_played: number;
  hands_won: number;
  total_profit: number;
  vpip_count: number;
  pfr_count: number;
  vpip_pct: number; // Computed client-side from vpip_count / hands_played
}

interface VipLedgerEntry {
  id: string;
  user_id: string;
  amount: number;
  transaction_type: string;
  description?: string;
  created_at: string;
}

interface ClubAggregate {
  totalHands: number;
  totalRake: number;
  activePlayers: number;
  totalVipPointsIssued: number;
  livePlayersNow: number; // Enhancement #9: real-time count
}

type TimeRange = '24h' | '7d' | '30d' | 'all';

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION COLORS (consistent across the chart)
// ═══════════════════════════════════════════════════════════════════════════════

const POSITION_COLORS: Record<string, string> = {
  BTN: 'linear-gradient(90deg, #22c55e, #16a34a)',
  CO: 'linear-gradient(90deg, #3b82f6, #2563eb)',
  HJ: 'linear-gradient(90deg, #a855f7, #9333ea)',
  MP: 'linear-gradient(90deg, #f59e0b, #d97706)',
  UTG: 'linear-gradient(90deg, #ef4444, #dc2626)',
  SB: 'linear-gradient(90deg, #06b6d4, #0891b2)',
  BB: 'linear-gradient(90deg, #ec4899, #db2777)',
};

const ALL_POSITIONS = ['BTN', 'CO', 'HJ', 'MP', 'UTG', 'SB', 'BB'];

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: '24h', label: '24 Hours' },
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
  { value: 'all', label: 'All Time' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function getTimeRangeCutoff(range: TimeRange): string | null {
  if (range === 'all') return null;
  const now = new Date();
  if (range === '24h') now.setHours(now.getHours() - 24);
  else if (range === '7d') now.setDate(now.getDate() - 7);
  else if (range === '30d') now.setDate(now.getDate() - 30);
  return now.toISOString();
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function AnalyticsDashboard() {
  const [positionStats, setPositionStats] = useState<PositionStat[]>([]);
  const [vipLedger, setVipLedger] = useState<VipLedgerEntry[]>([]);
  const [aggregate, setAggregate] = useState<ClubAggregate>({
    totalHands: 0,
    totalRake: 0,
    activePlayers: 0,
    totalVipPointsIssued: 0,
    livePlayersNow: 0,
  });
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [timeRange, setTimeRange] = useState<TimeRange>('all'); // Enhancement #1
  const [isLoading, setIsLoading] = useState(true); // Enhancement #7
  const mountedRef = useIsMounted();
  const toast = useToast();

  // Cleanup on unmount

  // ── Data loaders ────────────────────────────────────────────────────────

  const loadPositionStats = useCallback(async () => {
    try {
      let query = supabase
        .from('player_position_stats')
        .select('position, hands_played, hands_won, total_profit, vpip_count, pfr_count')
        .order('hands_played', { ascending: false })
        .limit(200);

      const cutoff = getTimeRangeCutoff(timeRange);
      if (cutoff) {
        query = query.gte('updated_at', cutoff);
      }

      const { data, error } = await query;

      if (!error && data && mountedRef.current) {
        const byPosition = new Map<string, PositionStat>();
        for (const row of data) {
          const existing = byPosition.get(row.position);
          if (existing) {
            existing.hands_played += row.hands_played || 0;
            existing.hands_won += row.hands_won || 0;
            existing.total_profit += row.total_profit || 0;
            existing.vpip_count += row.vpip_count || 0;
            existing.pfr_count += row.pfr_count || 0;
            existing.vpip_pct =
              existing.hands_played > 0
                ? Math.round((existing.vpip_count / existing.hands_played) * 100)
                : 0;
          } else {
            const hp = row.hands_played || 0;
            const vc = row.vpip_count || 0;
            byPosition.set(row.position, {
              position: row.position,
              hands_played: hp,
              hands_won: row.hands_won || 0,
              total_profit: row.total_profit || 0,
              vpip_count: vc,
              pfr_count: row.pfr_count || 0,
              vpip_pct: hp > 0 ? Math.round((vc / hp) * 100) : 0,
            });
          }
        }
        setPositionStats(Array.from(byPosition.values()));
      }
    } catch (err) {
      reportError(err, 'AnalyticsDashboard.Error_loading_position_stats');
      toast.error('Failed to load position stats');
    }
  }, [timeRange]);

  /** One row of `fn_admin_platform_aggregates` (migration 20260902). */
  interface PlatformAggregateRow {
    total_hands: number | string | null;
    active_players: number | string | null;
    total_rake: number | string | null;
    vip_diamonds: number | string | null;
    live_players: number | string | null;
  }

  const loadVipLedger = useCallback(async () => {
    try {
      /* Same wrong table as the aggregate below: `diamond_ledger` has 0 rows
         and no writer, so this operator-facing feed was permanently empty and
         said so as though it were a fact about the platform. `type` is
         selected beside `transaction_type` because the latter is NULL on ~774
         of ~1,540 rows (reconciliation and signup_bonus rows carry their kind
         in the older column) — the same trap DiamondWalletModal documents. */
      let query = supabase
        .from('diamond_transactions')
        .select('id, user_id, amount, type, transaction_type, created_at')
        .order('created_at', { ascending: false })
        .limit(20);

      const cutoff = getTimeRangeCutoff(timeRange);
      if (cutoff) {
        query = query.gte('created_at', cutoff);
      }

      const { data, error } = await query;

      /* supabase-js RESOLVES with `{ data: null, error }` rather than
         throwing, so `if (!error && data)` swallowed every failure into a
         silent empty feed. Rethrow into the catch below, which reports and
         tells the operator. */
      if (error) throw error;

      if (data && mountedRef.current) {
        setVipLedger(
          data.map((row) => ({
            ...row,
            transaction_type: row.transaction_type || row.type || '',
          }))
        );
      }
    } catch (err) {
      reportError(err, 'AnalyticsDashboard.Error_loading_VIP_ledger');
      toast.error('Failed to load VIP ledger');
    }
  }, [timeRange]);

  /**
   * ── THESE FOUR NUMBERS WERE NOT MEASUREMENTS ───────────────────────────
   *
   * What this used to do, and why each part was wrong:
   *
   *   totalHands / activePlayers — reduced in the browser over
   *     `.limit(5000)` with NO `.order()`, against a `player_position_stats`
   *     table holding 5,919 rows. So they summed an arbitrary subset and could
   *     differ between two refreshes a second apart. True hands: 23,031,984.
   *
   *   totalRake — `0.05 * hands_played`. Not rake. A constant times the same
   *     truncated hand count, rounded to two decimals so it looked measured.
   *     `rake_records` (1,681,381 rows, 4,792,230.11 chips) was never read.
   *
   *   totalVipPointsIssued — summed `diamond_ledger`, a table with **0 rows**
   *     and no writer. The live ledger is `diamond_transactions`.
   *
   *   livePlayersNow — filtered `.is('horse_id', null)`. That is an exclusion
   *     of horses, which CLAUDE.md 10.5 forbids ("COUNTS everywhere a human
   *     counts"). When this was first written (2026-09-02) the filter excluded
   *     nothing, because `table_seats.horse_id` was NULL on every row — and
   *     the note here said it "would have started under-reporting the floor
   *     the day anything backfilled that column". THAT DAY CAME: the
   *     2026-09-05 backfill stamped 1,285 live horse seats, and a separate fix
   *     landed the same week removing the filter for exactly that reason. The
   *     RPC below never had the filter. A dormant filter that wakes up when its
   *     column is populated is precisely the shape 10.5 is about.
   *
   * Raising the limit could not fix this — the honest query is an aggregate
   * over 1.68M rake rows, which belongs in the database. `fn_admin_platform_
   * aggregates` (migration 20260902) does all five in one admin-gated round
   * trip, counting horses deliberately.
   */
  const loadAggregates = useCallback(async () => {
    try {
      const cutoff = getTimeRangeCutoff(timeRange);
      /* The generated Supabase types are a nightly snapshot and do not yet
         carry this function's row shape, so the result arrives as `{}`. The
         shape is fixed by the migration's RETURNS TABLE clause
         (20260902_admin_platform_aggregates.sql) and every field is passed
         through Number() below, so a drift shows up as 0 rather than as a
         crash. Re-narrow this once the manifest refreshes. */
      const { data, error } = await supabase
        .rpc('fn_admin_platform_aggregates', { p_since: cutoff ?? null })
        .maybeSingle<PlatformAggregateRow>();

      /* An admin dashboard that renders zeros on a failed read is worse than
         one that renders an error: zero is a claim about the business. */
      if (error) throw error;

      if (mountedRef.current && data) {
        setAggregate({
          totalHands: Number(data.total_hands ?? 0),
          totalRake: Math.round(Number(data.total_rake ?? 0) * 100) / 100,
          activePlayers: Number(data.active_players ?? 0),
          totalVipPointsIssued: Number(data.vip_diamonds ?? 0),
          livePlayersNow: Number(data.live_players ?? 0),
        });
      }
    } catch (err) {
      reportError(err, 'AnalyticsDashboard.Error_loading_aggregates');
      toast.error('Failed to load analytics data');
    }
  }, [timeRange]);

  const refreshAll = useCallback(async () => {
    setIsLoading(true);
    await Promise.all([loadPositionStats(), loadVipLedger(), loadAggregates()]);
    if (mountedRef.current) {
      setLastRefresh(new Date());
      setIsLoading(false);
    }
  }, [loadPositionStats, loadVipLedger, loadAggregates]);

  // ── Mount & Bus listeners ───────────────────────────────────────────────

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const interval = setInterval(refreshAll, 30_000);
    return () => clearInterval(interval);
  }, [refreshAll]);

  // Debounced refresh helper
  useEffect(() => {
    const debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Create a ref to store the timer for cleanup
    const cleanupRef = { timer: null as ReturnType<typeof setTimeout> | null };

    return () => {
      if (cleanupRef.timer) clearTimeout(cleanupRef.timer);
    };
  }, []);

  // Bus listeners
  const debouncedRefreshRef = { timer: null as ReturnType<typeof setTimeout> | null };
  const debouncedRefresh = useCallback(() => {
    if (debouncedRefreshRef.timer) clearTimeout(debouncedRefreshRef.timer);
    debouncedRefreshRef.timer = setTimeout(refreshAll, 5000);
  }, [refreshAll]);

  useMasterBusSubscription('HAND_COMPLETED', debouncedRefresh);
  useMasterBusSubscription('BALANCE_UPDATED', refreshAll, { debounce: 2000 });
  useMasterBusSubscription('CHIPS_DISTRIBUTED', refreshAll, { debounce: 2000 });
  useMasterBusSubscription('SETTLEMENT_COMPLETED', refreshAll, { debounce: 1000 });
  useMasterBusSubscription('MILESTONE_UNLOCKED', refreshAll, { debounce: 1000 });
  useMasterBusSubscription('COMPONENT_CRASH', (payload) => {
    if (payload && payload.componentName) {
      toast.error(`Crash: ${payload.componentName}`);
    }
  });
  useMasterBusSubscription('SESSION_STATS_UPDATE', debouncedRefresh);

  // ── Enhancement #5: CSV Export ─────────────────────────────────────────

  const handleExportCSV = useCallback(() => {
    // Position Stats CSV
    const posHeader = 'Position,Hands Played,Hands Won,Total Profit,VPIP %,PFR Count\n';
    const posRows = positionStats
      .map(
        (s) =>
          `${s.position},${s.hands_played},${s.hands_won},${s.total_profit},${s.vpip_pct},${s.pfr_count}`
      )
      .join('\n');

    // VIP Ledger CSV
    const vipHeader = '\n\nVIP Ledger\nTime,Type,Amount,Description\n';
    const vipRows = vipLedger
      .map(
        (e) =>
          `${new Date(e.created_at).toLocaleString()},${e.transaction_type},${e.amount},"${e.description || ''}"`
      )
      .join('\n');

    const csvContent =
      'Club Analytics Export - ' +
      new Date().toLocaleString() +
      '\n\nPosition Stats\n' +
      posHeader +
      posRows +
      vipHeader +
      vipRows;

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `club-analytics-${timeRange}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }, [positionStats, vipLedger, timeRange]);

  // ── Computed values ─────────────────────────────────────────────────────

  const maxHandsPlayed = Math.max(1, ...positionStats.map((s) => s.hands_played));

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="analytics-dashboard">
      <header className="analytics-header">
        <h1>Club Analytics Dashboard</h1>
        <p>
          Real-Time Player Position Stats And VIP Economy Overview
          <span className="refresh-indicator">
            <span className="refresh-dot" />
            Live - Updated {lastRefresh.toLocaleTimeString()}
          </span>
        </p>

        {/* Enhancement #1: Time Range Selector */}
        <div className="analytics-controls">
          <div className="time-range-selector">
            {TIME_RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`range-btn ${timeRange === opt.value ? 'active' : ''}`}
                onClick={() => setTimeRange(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Enhancement #5: CSV Export */}
          <button
            className="export-btn"
            onClick={handleExportCSV}
            disabled={positionStats.length === 0 && vipLedger.length === 0}
          >
            Export CSV
          </button>
        </div>
      </header>

      {/* ── Summary Cards ───────────────────────────────────────────────── */}
      <div className="analytics-summary">
        {isLoading ? (
          <>
            <div className="summary-card skeleton-card">
              <div className="skeleton-pulse" />
            </div>
            <div className="summary-card skeleton-card">
              <div className="skeleton-pulse" />
            </div>
            <div className="summary-card skeleton-card">
              <div className="skeleton-pulse" />
            </div>
            <div className="summary-card skeleton-card">
              <div className="skeleton-pulse" />
            </div>
            <div className="summary-card skeleton-card">
              <div className="skeleton-pulse" />
            </div>
          </>
        ) : (
          <>
            <div className="summary-card">
              <div className="label">Total Hands Tracked</div>
              <div className="value text-blue">{aggregate.totalHands.toLocaleString()}</div>
            </div>
            <div className="summary-card">
              <div className="label">Active Players</div>
              <div className="value text-green">{aggregate.activePlayers.toLocaleString()}</div>
            </div>
            <div className="summary-card">
              <div className="label">Est. Total Rake</div>
              <div className="value text-amber">${aggregate.totalRake.toLocaleString()}</div>
            </div>
            <div className="summary-card">
              <div className="label">VIP Points Issued</div>
              <div className="value text-purple">
                {aggregate.totalVipPointsIssued.toLocaleString()}
              </div>
            </div>
            {/* Enhancement #9: Live Players Now */}
            <div className="summary-card live-card">
              <div className="label">Live Players Now</div>
              <div className="value text-cyan">
                <span className="live-dot" />
                {aggregate.livePlayersNow}
              </div>
            </div>
            {/* Enhancement #9: Total P/L across all positions */}
            {(() => {
              const totalPL = positionStats.reduce((sum, s) => sum + (s.total_profit || 0), 0);
              return (
                <div className="summary-card">
                  <div className="label">Total P/L (All Positions)</div>
                  <div className={`value ${totalPL >= 0 ? 'text-green' : 'text-red'}`}>
                    {totalPL >= 0 ? '+' : ''}
                    {totalPL.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </div>

      {/* ── Charts Grid ─────────────────────────────────────────────────── */}
      <div className="analytics-grid">
        {/* Position Win Rate Chart */}
        <div className="chart-card">
          <h3>Win Rate By Position</h3>
          {isLoading ? (
            <div className="skeleton-bars">
              {ALL_POSITIONS.map((p) => (
                <div key={p} className="skeleton-bar">
                  <div className="skeleton-pulse" />
                </div>
              ))}
            </div>
          ) : positionStats.length > 0 ? (
            <div className="position-bars">
              {ALL_POSITIONS.map((pos) => {
                const stat = positionStats.find((s) => s.position === pos);
                const winRate = stat
                  ? Math.round((stat.hands_won / Math.max(1, stat.hands_played)) * 100)
                  : 0;
                const barWidth = stat ? Math.round((stat.hands_played / maxHandsPlayed) * 100) : 0;

                return (
                  <div key={pos} className="position-bar-row">
                    <span className="position-label">{pos}</span>
                    <div className="bar-track">
                      <div
                        className="bar-fill"
                        style={{
                          width: `${Math.max(barWidth, 5)}%`,
                          background: POSITION_COLORS[pos] || '#6366f1',
                        }}
                      >
                        <span>{winRate}%</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">
              <div className="icon">▲</div>
              <p>No Position Stats Yet. Data Populates As Hands Are Dealt.</p>
            </div>
          )}
        </div>

        {/* VPIP by Position */}
        <div className="chart-card">
          <h3>VPIP % By Position</h3>
          {isLoading ? (
            <div className="skeleton-bars">
              {ALL_POSITIONS.map((p) => (
                <div key={p} className="skeleton-bar">
                  <div className="skeleton-pulse" />
                </div>
              ))}
            </div>
          ) : positionStats.length > 0 ? (
            <div className="position-bars">
              {ALL_POSITIONS.map((pos) => {
                const stat = positionStats.find((s) => s.position === pos);
                const vpip = stat?.vpip_pct || 0;

                return (
                  <div key={pos} className="position-bar-row">
                    <span className="position-label">{pos}</span>
                    <div className="bar-track">
                      <div
                        className="bar-fill"
                        style={{
                          width: `${Math.max(vpip, 3)}%`,
                          background: POSITION_COLORS[pos] || '#6366f1',
                        }}
                      >
                        <span>{vpip}%</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">
              <div className="icon">◎</div>
              <p>VPIP Data Populates As Hands Are Dealt.</p>
            </div>
          )}
        </div>
      </div>

      {/* ── VIP Points Ledger ───────────────────────────────────────────── */}
      <h2 className="section-header">Recent VIP Points Activity</h2>
      {isLoading ? (
        <div className="chart-card">
          <div className="skeleton-table">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="skeleton-row">
                <div className="skeleton-pulse" />
              </div>
            ))}
          </div>
        </div>
      ) : vipLedger.length > 0 ? (
        <div className="chart-card">
          <table className="vip-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {vipLedger.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    {new Date(entry.created_at).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td>
                    <span className={`vip-type-badge ${entry.transaction_type}`}>
                      {(entry.transaction_type || 'unknown').toUpperCase()}
                    </span>
                  </td>
                  <td
                    style={{
                      color: entry.amount >= 0 ? '#22c55e' : '#ef4444',
                      fontWeight: 600,
                    }}
                  >
                    {entry.amount >= 0 ? '+' : ''}
                    {entry.amount.toLocaleString()}
                  </td>
                  <td style={{ color: '#94a3b8' }}>{entry.description || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-card">
          <div className="empty-state">
            <div className="icon">◆</div>
            <p>No VIP Points Transactions Yet.</p>
          </div>
        </div>
      )}
    </div>
  );
}
