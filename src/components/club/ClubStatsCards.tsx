/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB STATS CARDS — Quick Overview Stats
 * Shows key metrics for club performance
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { masterBus } from '../../core/MasterBus';
import styles from './ClubStatsCards.module.css';
import { reportError } from '../../utils/errorReporter';

interface ClubStats {
  totalMembers: number;
  onlineNow: number;
  activeTables: number;
  handsToday: number;
  rakeToday: number;
  weeklyGrowth: number;
}

interface ClubStatsCardsProps {
  clubId: string;
}

export default function ClubStatsCards({ clubId }: ClubStatsCardsProps) {
  const [stats, setStats] = useState<ClubStats>({
    totalMembers: 0,
    onlineNow: 0,
    activeTables: 0,
    handsToday: 0,
    rakeToday: 0,
    weeklyGrowth: 0,
  });
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // statCards moved after format function declarations (see below)

  useEffect(() => {
    loadStats();

    // Ensure Club Stats stay fresh when users join/leave or tables start/stop
    // NOTE: Bus-only subscriptions — no Supabase realtime channel needed here.
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
      masterBus.subscribeDebounced('TABLE_DELETED', reload, 1000),
    ];

    return () => {
      unsubscribes.forEach((unsub) => unsub());
    };
  }, [clubId]);

  const loadStats = async () => {
    setLoading(true);
    try {
      // Resolve integer clubId to UUID for FK queries
      const resolvedId = await resolveClubUUID(clubId);

      // Get member count (all non-banned members)
      const { count: memberCount } = await supabase
        .from('club_members')
        .select('user_id', { count: 'exact', head: true })
        .eq('club_id', resolvedId)
        .not('status', 'in', '("banned","suspended")');

      // Get active tables — tables use status 'running' or 'waiting', not 'active'
      const { count: tableCount } = await supabase
        .from('tables')
        .select('id', { count: 'exact', head: true })
        .eq('club_id', resolvedId)
        .in('status', ['running', 'waiting', 'active']);

      // Get today's stats
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      let handsToday = 0;
      let rakeToday = 0;

      // Try club_daily_stats first (may not exist yet — graceful fallback to 0)
      const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD for DATE column
      const { data: todayStats, error: statsErr } = await supabase
        .from('club_daily_stats')
        .select('hands_played, rake_collected')
        .eq('club_id', resolvedId)
        .eq('stat_date', todayStr)
        .maybeSingle();

      // Silently skip if table doesn't exist (PGRST205 / 42P01)
      if (todayStats && !statsErr) {
        handsToday = todayStats.hands_played || 0;
        rakeToday = todayStats.rake_collected || 0;
      }

      // Count online members — those active within last 15 minutes
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const { count: onlineCount } = await supabase
        .from('club_members')
        .select('user_id', { count: 'exact', head: true })
        .eq('club_id', resolvedId)
        .gte('last_active', fifteenMinAgo);

      // Get weekly growth (compare to last week)
      const weekAgo = new Date(Date.now() - 7 * 86400000);
      const { count: newMembers } = await supabase
        .from('club_members')
        .select('user_id', { count: 'exact', head: true })
        .eq('club_id', resolvedId)
        .gte('created_at', weekAgo.toISOString());

      setStats({
        totalMembers: memberCount || 0,
        onlineNow: onlineCount || 0,
        activeTables: tableCount || 0,
        handsToday: handsToday,
        rakeToday: rakeToday,
        weeklyGrowth: newMembers || 0,
      });
    } catch (error) {
      reportError(error, 'ClubStatsCards.Failed_to_load_club_stats');
    }
    if (isMounted.current) setLoading(false);
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

  const statCards = [
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
      label: 'Hands Today',
      value: formatInt(stats.handsToday),
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
      label: 'Rake Today',
      value: formatChips(stats.rakeToday),
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="#f59e0b" strokeWidth="1.5" />
          <text
            x="8"
            y="16"
            fontSize="12"
            fontWeight="700"
            fill="#f59e0b"
            fontFamily="Orbitron, monospace"
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
  }, [loading]);

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
        </div>
      ))}
    </div>
  );
}
