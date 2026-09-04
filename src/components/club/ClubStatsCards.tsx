/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB STATS CARDS — Quick Overview Stats
 * Shows key metrics for club performance.
 * Data source: ca_club_dashboard_stats RPC (single round-trip), either
 * preloaded by the parent (stats prop) or self-loaded.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { isUUID, resolveClubUUID } from '../../utils/clubIdResolver';
import { isAuthzError } from '../../utils/clubDashboard';
import { masterBus } from '../../core/MasterBus';
import styles from './ClubStatsCards.module.css';
import { reportError } from '../../utils/errorReporter';

export interface DailyPoint {
  d: string;
  hands: number;
  rake: number;
}

export interface DashboardStats {
  totalMembers: number;
  onlineNow: number;
  activeTables: number;
  totalTables: number;
  handsToday: number;
  rakeToday: number;
  weeklyGrowth: number;
  handsWeek: number;
  rakeWeek: number;
  seatedNow: number;
  dailySeries: DailyPoint[];
}

interface ClubStatsCardsProps {
  clubId: string;
  /**
   * Preloaded stats from the parent. Three states, not two:
   *   undefined  - no parent is loading these; the cards fetch for themselves;
   *   null       - the parent owns the read and it has not answered yet;
   *   object     - the parent's answer.
   * Until 2026-09-04 `null` was treated as `undefined`, so ClubDashboard,
   * which passes its own not-yet-loaded state, triggered a second
   * ca_club_dashboard_stats call on every mount (~910 ms and 132,855 buffers
   * each at the time) that the parent's answer then overwrote.
   */
  stats?: DashboardStats | null;
  /** The parent's read failed: say so instead of holding the skeleton. */
  failed?: boolean;
}

const EMPTY_STATS: DashboardStats = {
  totalMembers: 0,
  onlineNow: 0,
  activeTables: 0,
  totalTables: 0,
  handsToday: 0,
  rakeToday: 0,
  weeklyGrowth: 0,
  handsWeek: 0,
  rakeWeek: 0,
  seatedNow: 0,
  dailySeries: [],
};

/**
 * Inline 14-day sparkline. Rendered as a plain SVG path so the metric cards
 * gain trend context without pulling a chart library into this chunk.
 */
function Sparkline({ points, color }: { points: number[]; color: string }) {
  if (!points.length || points.every((p) => p === 0)) return null;
  const w = 100;
  const h = 22;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const d = points
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${(h - ((p - min) / span) * h).toFixed(2)}`
    )
    .join(' ');
  return (
    <svg
      width="100%"
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ display: 'block', marginTop: 6, opacity: 0.85 }}
    >
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export default function ClubStatsCards({
  clubId,
  stats: statsProp,
  failed = false,
}: ClubStatsCardsProps) {
  const selfLoading = statsProp === undefined;
  const [stats, setStats] = useState<DashboardStats>(statsProp || EMPTY_STATS);
  const [loading, setLoading] = useState(!statsProp);
  const isMounted = useIsMounted();
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Parent-driven mode: mirror the prop whenever it changes. A null prop
  // means the parent is still reading, so the skeleton stays up.
  useEffect(() => {
    if (statsProp) {
      setStats(statsProp);
      setLoading(false);
    } else if (statsProp === null) {
      setLoading(true);
    }
  }, [statsProp]);

  // Self-loading mode: only when no parent owns the read at all.
  useEffect(() => {
    if (!selfLoading) return;
    loadStats();

    const reload = () => {
      loadStats();
    };

    const unsubscribes = [
      masterBus.subscribeDebounced('CLUB_JOINED', reload, 1000),
      masterBus.subscribeDebounced('CLUB_LEFT', reload, 1000),
      masterBus.subscribeDebounced('TABLE_CREATED', reload, 1000),
      masterBus.subscribeDebounced('TABLE_LEFT', reload, 1000),
      masterBus.subscribeDebounced('TABLE_SEATED', reload, 1000),
      masterBus.subscribeDebounced('CLUB_UPDATED', reload, 1000),
      masterBus.subscribeDebounced('TABLE_UPDATED', reload, 1000),
      masterBus.subscribeDebounced('TABLE_CLOSED', reload, 1000),
    ];

    return () => {
      unsubscribes.forEach((unsub) => unsub());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId, selfLoading]);

  const loadStats = async () => {
    setLoading(true);
    try {
      // Resolve integer clubId to UUID for the RPC. resolveClubUUID returns
      // its input unchanged when it cannot resolve; a non-uuid would throw
      // 22P02 against the uuid-typed parameter, so bail instead.
      const resolvedId = await resolveClubUUID(clubId);
      if (!isUUID(resolvedId)) {
        if (isMounted.current) setLoading(false);
        return;
      }

      const { data, error } = await supabase.rpc('ca_club_dashboard_stats', {
        p_club_id: resolvedId,
      });
      if (error) throw error;

      if (data && isMounted.current) {
        setStats({
          totalMembers: data.total_members || 0,
          onlineNow: data.online_now || 0,
          activeTables: data.active_tables || 0,
          totalTables: data.total_tables || 0,
          handsToday: data.hands_today || 0,
          rakeToday: Number(data.rake_today) || 0,
          weeklyGrowth: data.new_this_week || 0,
          handsWeek: Number(data.hands_week) || 0,
          rakeWeek: Number(data.rake_week) || 0,
          seatedNow: data.seated_now || 0,
          dailySeries: Array.isArray(data.daily_series)
            ? data.daily_series.map((p: any) => ({
                d: String(p.d),
                hands: Number(p.hands) || 0,
                rake: Number(p.rake) || 0,
              }))
            : [],
        });
      }
    } catch (error: any) {
      // The membership gate raising 42501 is an expected outcome for a
      // non-member, not a fault worth reporting — the parent shows its own
      // Members Only state.
      if (!isAuthzError(error)) {
        reportError(error, 'ClubStatsCards.Failed_to_load_club_stats');
      }
    } finally {
      if (isMounted.current) setLoading(false);
    }
  };

  const formatInt = (num: number): string => {
    return Math.trunc(num).toLocaleString('en-US');
  };

  const formatChips = (num: number): string => {
    return (Math.trunc(num * 100) / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  const statCards: Array<{
    label: string;
    value: string;
    icon: React.ReactNode;
    color: string;
    sub?: string;
    spark?: number[];
  }> = [
    {
      label: 'Total Members',
      value: formatInt(stats.totalMembers),
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="9" cy="8" r="3.5" stroke="#3b82f6" strokeWidth="1.5" />
          <path
            d="M2 20c0-3.5 3-6.5 7-6.5s7 3 7 6.5"
            stroke="#3b82f6"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="17" cy="7" r="2.5" stroke="#3b82f6" strokeWidth="1.2" opacity="0.5" />
          <path
            d="M17 12c3 0 5.5 2 5.5 5"
            stroke="#3b82f6"
            strokeWidth="1.2"
            strokeLinecap="round"
            opacity="0.5"
          />
        </svg>
      ),
      color: '#3b82f6',
    },
    {
      label: 'Online Now',
      value: formatInt(stats.onlineNow),
      sub: stats.seatedNow > 0 ? `${formatInt(stats.seatedNow)} seated at tables` : undefined,
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="4" fill="#10b981">
            <animate attributeName="r" values="3;5;3" dur="2s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite" />
          </circle>
          <circle
            cx="12"
            cy="12"
            r="9"
            stroke="#10b981"
            strokeWidth="1.5"
            fill="none"
            opacity="0.25"
          >
            <animate attributeName="r" values="7;10;7" dur="2s" repeatCount="indefinite" />
          </circle>
        </svg>
      ),
      color: '#10b981',
    },
    {
      label: 'Active Tables',
      value: formatInt(stats.activeTables),
      sub:
        stats.totalTables > stats.activeTables
          ? `${formatInt(stats.totalTables)} total`
          : undefined,
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="3" width="8" height="8" rx="2" stroke="#fbbf24" strokeWidth="1.5" />
          <rect x="13" y="3" width="8" height="8" rx="2" stroke="#fbbf24" strokeWidth="1.5" />
          <rect x="3" y="13" width="8" height="8" rx="2" stroke="#fbbf24" strokeWidth="1.5" />
          <rect
            x="13"
            y="13"
            width="8"
            height="8"
            rx="2"
            stroke="#fbbf24"
            strokeWidth="1.5"
            opacity="0.4"
          />
        </svg>
      ),
      color: '#fbbf24',
    },
    {
      // Every hand the engine finished today, tournament hands included
      // (club_hand_daily). The rake beside it is the ledger's cash rake
      // (ca_club_rake_daily), which is why the two are labelled apart.
      label: 'Hands Dealt Today',
      value: formatInt(stats.handsToday),
      sub: stats.handsWeek > 0 ? `${formatInt(stats.handsWeek)} this week` : undefined,
      spark: stats.dailySeries.map((p) => p.hands),
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path
            d="M4 17L10 11L14 15L20 7"
            stroke="#a855f7"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M16 7H20V11"
            stroke="#a855f7"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      color: '#a855f7',
    },
    {
      label: 'Cash Rake Today',
      value: formatChips(stats.rakeToday),
      sub: stats.rakeWeek > 0 ? `${formatChips(stats.rakeWeek)} this week` : undefined,
      spark: stats.dailySeries.map((p) => p.rake),
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="#f59e0b" strokeWidth="1.5" />
          <text
            x="8"
            y="16"
            fontSize="12"
            fontWeight="700"
            fill="#f59e0b"
            fontFamily="Rajdhani, monospace"
          >
            $
          </text>
        </svg>
      ),
      color: '#f59e0b',
    },
    {
      label: 'New This Week',
      value: `+${stats.weeklyGrowth}`,
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 4V20M5 11L12 4L19 11"
            stroke="#22c55e"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      color: '#22c55e',
    },
  ];

  useEffect(() => {
    if (!loading) {
      // Clear previous stagger timers before starting new ones
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = statCards.map((_, i) =>
        setTimeout(() => {
          if (isMounted.current) {
            setVisibleItems((prev) => new Set(prev).add(i));
          }
        }, i * 60)
      );
    }
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  if (failed && !statsProp) {
    return <p className={styles.unavailable}>The Club Metrics Could Not Be Loaded</p>;
  }

  if (loading) {
    return (
      <div className={styles.grid}>
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className={`${styles.card} ${styles.loading}`} />
        ))}
      </div>
    );
  }

  return (
    <div className={styles.grid}>
      {statCards.map((stat, i) => (
        <div
          key={i}
          className={styles.card}
          style={
            {
              '--accent-color': stat.color,
              opacity: visibleItems.has(i) ? 1 : 0,
              transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            } as React.CSSProperties
          }
        >
          <span
            className={styles.iconWrap}
            style={{ background: `color-mix(in srgb, ${stat.color} 12%, transparent)` }}
          >
            {stat.icon}
          </span>
          <span className={styles.value}>{stat.value}</span>
          <span className={styles.label}>{stat.label}</span>
          {stat.sub && (
            <span
              style={{
                fontSize: '0.68rem',
                color: 'var(--text-secondary, #8a8f98)',
                marginTop: 2,
              }}
            >
              {stat.sub}
            </span>
          )}
          {stat.spark && <Sparkline points={stat.spark} color={stat.color} />}
        </div>
      ))}
    </div>
  );
}
