/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ACTIVITY FEED — Recent Club Events
 * Shows recent activity: member joins, big pots, announcements, table starts.
 * Data source: ca_club_activity RPC, which synthesizes the feed from
 * club_members / hand_history / club_announcements / tables (the standalone
 * club_activity table was never created — the old query returned nothing).
 * Refreshes on club-scoped bus events and a 60s poll while visible.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { formatRelativeShort as formatTime } from '@/lib/date';
import styles from './ClubActivityFeed.module.css';
import { reportError } from '../../utils/errorReporter';

export type ActivityType =
  | 'member_join'
  | 'member_leave'
  | 'table_start'
  | 'table_end'
  | 'tournament_win'
  | 'big_hand'
  | 'announcement'
  | 'agent_action'
  | 'payout';

interface ActivityItem {
  id: string;
  type: ActivityType;
  message: string;
  createdAt: string;
  userId?: string;
  userName?: string;
  userAvatar?: string;
}

interface ClubActivityFeedProps {
  clubId: string;
  limit?: number;
  showFilter?: boolean;
}

const POLL_INTERVAL_MS = 60_000;

export default function ClubActivityFeed({
  clubId,
  limit = 20,
  showFilter = false,
}: ClubActivityFeedProps) {
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ActivityType | 'all'>('all');
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const isMounted = useIsMounted();

  // Track stagger timeouts for cleanup on unmount
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const loadingRef = useRef(false);

  useEffect(() => {
    loadActivities(true);

    // Bus events that imply new activity
    const reload = () => loadActivities(false);
    const unsubs = [
      masterBus.subscribeDebounced('CLUB_JOINED', reload, 2000),
      masterBus.subscribeDebounced('CLUB_LEFT', reload, 2000),
      masterBus.subscribeDebounced('TABLE_CREATED', reload, 2000),
      masterBus.subscribeDebounced('HAND_COMPLETED', reload, 5000),
      masterBus.subscribeDebounced('ANNOUNCEMENT_CHANGED', reload, 2000),
    ];

    // Gentle poll — only when the tab is visible
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadActivities(false);
      }
    }, POLL_INTERVAL_MS);

    return () => {
      unsubs.forEach((unsub) => unsub());
      clearInterval(interval);
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId, limit]);

  const loadActivities = async (withSpinner: boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (withSpinner) setLoading(true);
    try {
      // Resolve club UUID — clubId prop may be an integer club code from URL
      const resolvedUuid = await resolveClubUUID(clubId);

      const { data, error } = await supabase.rpc('ca_club_activity', {
        p_club_id: resolvedUuid,
        p_limit: limit,
      });

      if (error) throw error;

      const items: ActivityItem[] = (data || []).map((a: any) => ({
        id: a.id,
        type: a.activity_type as ActivityType,
        message: a.message,
        createdAt: a.created_at,
        userId: a.user_id,
        userName: a.display_name,
        userAvatar: a.avatar_url,
      }));

      if (!isMounted.current) return;
      setActivities(items);
      if (withSpinner) {
        setVisibleItems(new Set());
        staggerTimersRef.current.forEach((t) => clearTimeout(t));
        staggerTimersRef.current = items.map((_, i) =>
          setTimeout(() => {
            if (isMounted.current) {
              setVisibleItems((prev) => new Set(prev).add(i));
            }
          }, i * 60)
        );
      } else {
        // Silent refresh — show everything immediately, no re-stagger
        setVisibleItems(new Set(items.map((_, i) => i)));
      }
    } catch (error) {
      reportError(error, 'ClubActivityFeed.Failed_to_load_activities');
    }
    loadingRef.current = false;
    if (isMounted.current && withSpinner) setLoading(false);
  };

  const getActivityIcon = (type: ActivityType): string => {
    switch (type) {
      case 'member_join':
        return '+';
      case 'member_leave':
        return '-';
      case 'table_start':
        return '♦';
      case 'table_end':
        return '●';
      case 'tournament_win':
        return 'T';
      case 'big_hand':
        return '♠';
      case 'announcement':
        return '✱';
      case 'agent_action':
        return '★';
      case 'payout':
        return '◉';
      default:
        return '○';
    }
  };

  const filteredActivities =
    filter === 'all' ? activities : activities.filter((a) => a.type === filter);

  return (
    <div className={styles.feed}>
      <div className={styles.header}>
        <h3>Activity</h3>
        {showFilter && (
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as ActivityType | 'all')}
            className={styles.filterSelect}
          >
            <option value="all">All Activity</option>
            <option value="member_join">New Members</option>
            <option value="table_start">Tables</option>
            <option value="big_hand">Big Hands</option>
            <option value="announcement">Announcements</option>
          </select>
        )}
      </div>

      <div className={styles.list}>
        {loading ? (
          <div className={styles.loading}>Loading activity...</div>
        ) : filteredActivities.length === 0 ? (
          <div className={styles.empty}>No activity yet</div>
        ) : (
          filteredActivities.map((activity, i) => (
            <div
              key={activity.id}
              className={styles.item}
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className={styles.icon}>{getActivityIcon(activity.type)}</span>
              <div className={styles.content}>
                {activity.userName && <span className={styles.userName}>{activity.userName} </span>}
                <span className={styles.message}>{activity.message}</span>
              </div>
              <span className={styles.time}>{formatTime(activity.createdAt)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
