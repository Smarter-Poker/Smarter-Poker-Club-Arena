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
import { isUUID, resolveClubUUID } from '../../utils/clubIdResolver';
import { isAuthzError } from '../../utils/clubDashboard';
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
  // Keyed by activity id, NOT by list index: the rendered list is the FILTERED
  // array, so index-keyed visibility left rows stuck at opacity 0 whenever a
  // filter shifted their position — selecting a filter blanked the feed.
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
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
      // Resolve club UUID — clubId prop may be an integer club code from URL.
      // resolveClubUUID returns its input unchanged when it cannot resolve, and
      // feeding a non-uuid to a uuid-typed RPC throws 22P02, so bail instead.
      const resolvedUuid = await resolveClubUUID(clubId);
      if (!isUUID(resolvedUuid)) {
        if (isMounted.current) setActivities([]);
        return;
      }

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
        setVisibleIds(new Set());
        staggerTimersRef.current.forEach((t) => clearTimeout(t));
        staggerTimersRef.current = items.map((item, i) =>
          setTimeout(() => {
            if (isMounted.current) {
              setVisibleIds((prev) => new Set(prev).add(item.id));
            }
          }, i * 60)
        );
      } else {
        // Silent refresh — show everything immediately, no re-stagger
        setVisibleIds(new Set(items.map((item) => item.id)));
      }
    } catch (error: any) {
      // A non-member hitting the membership gate is an expected outcome, not
      // an error worth reporting — the parent renders its own Members Only
      // state. Anything else is a genuine failure.
      if (!isAuthzError(error)) {
        reportError(error, 'ClubActivityFeed.Failed_to_load_activities');
      }
      if (isMounted.current) setActivities([]);
    } finally {
      // MUST be finally. These two lines used to sit after the try/catch, so
      // the early `return` on an unresolvable club id skipped them: loadingRef
      // stayed true forever, every later call bailed at the in-flight guard,
      // and the feed sat on "Loading activity..." permanently.
      loadingRef.current = false;
      if (isMounted.current && withSpinner) setLoading(false);
    }
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
          <div className={styles.loading}>Loading Activity...</div>
        ) : filteredActivities.length === 0 ? (
          <div className={styles.empty}>No Activity Yet</div>
        ) : (
          filteredActivities.map((activity) => (
            <div
              key={activity.id}
              className={styles.item}
              style={{
                opacity: visibleIds.has(activity.id) ? 1 : 0,
                transform: visibleIds.has(activity.id) ? 'translateY(0)' : 'translateY(8px)',
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
