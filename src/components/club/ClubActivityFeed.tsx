/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ACTIVITY FEED — Real-time Club Events
 * Shows recent activity: joins, games, wins, announcements
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { resolveClubIdFilter } from '../../utils/clubIdResolver';
import { formatRelativeShort as formatTime } from '@/lib/date';
import styles from './ClubActivityFeed.module.css';

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
  data?: Record<string, any>;
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

  useEffect(() => {
    loadActivities();
    const cleanup = subscribeToActivities();
    return cleanup;
  }, [clubId]);

  const loadActivities = async () => {
    setLoading(true);
    try {
      // Resolve club UUID — clubId prop may be integer from URL params
      const { column: cCol, value: cVal } = resolveClubIdFilter(clubId);
      let resolvedUuid = clubId;
      if (cCol === 'club_id') {
        // Need to look up the actual UUID first
        const { data: clubRow } = await supabase
          .from('clubs')
          .select('id')
          .eq(cCol, cVal)
          .maybeSingle();
        if (clubRow) resolvedUuid = clubRow.id;
      }

      const { data, error } = await supabase
        .from('club_activity')
        .select(
          `
                    id,
                    activity_type,
                    message,
                    data,
                    created_at,
                    user_id,
                    profiles(display_name, avatar_url)
                `
        )
        .eq('club_id', resolvedUuid)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;

      const items: ActivityItem[] = (data || []).map((a: any) => ({
        id: a.id,
        type: a.activity_type,
        message: a.message,
        data: a.data,
        createdAt: a.created_at,
        userId: a.user_id,
        userName: a.profiles?.display_name,
        userAvatar: a.profiles?.avatar_url,
      }));

      if (!isMounted.current) return;
      setActivities(items);
      setVisibleItems(new Set());
      items.forEach((_, i) => {
        setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
      });
    } catch (error) {
      console.error('Failed to load activities:', error);
    }
    if (isMounted.current) setLoading(false);
  };

  const subscribeToActivities = () => {
    const channelKey = `club_activity:${clubId}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'club_activity',
          filter: `club_id=eq.${clubId}`,
        },
        async (payload) => {
          const newActivity = payload.new as any;

          // Fetch user profile
          let userName = undefined;
          let userAvatar = undefined;
          if (newActivity.user_id) {
            const { data: profile } = await supabase
              .from('profiles')
              .select('display_name, avatar_url')
              .eq('id', newActivity.user_id)
              .maybeSingle();
            userName = profile?.display_name;
            userAvatar = profile?.avatar_url;
          }

          setActivities((prev) =>
            [
              {
                id: newActivity.id,
                type: newActivity.activity_type,
                message: newActivity.message,
                data: newActivity.data,
                createdAt: newActivity.created_at,
                userId: newActivity.user_id,
                userName,
                userAvatar,
              },
              ...prev,
            ].slice(0, limit)
          );
        }
      )
      .subscribe();

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
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
        <h3> Activity</h3>
        {showFilter && (
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as ActivityType | 'all')}
            className={styles.filterSelect}
          >
            <option value="all">All Activity</option>
            <option value="member_join">New Members</option>
            <option value="table_start">Games</option>
            <option value="tournament_win">Tournament Wins</option>
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
